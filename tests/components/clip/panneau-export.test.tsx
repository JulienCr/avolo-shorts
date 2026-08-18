// @vitest-environment jsdom

/**
 * Le panneau d'export — la sortie du tunnel.
 *
 * Ce qu'il doit dire, et que rien ne disait : combien de fichiers le ratio
 * choisi va produire, que le rendu travaille pendant dix à soixante secondes,
 * qu'un `skipped: true` est un succès, et qu'une variante 9:16 absente sur un
 * clip déjà en 9:16 n'est pas un rendu manquant.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Clip } from '@/core/edl'
import type { ClipOutputs, ExportResult } from '@/lib/api'
import { PanneauExport } from '@/components/clip/panneau-export'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function clip(champs: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    projectId: 'p1',
    segments: [{ start: 0, end: 20 }],
    ratio: '1:1',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'La chute',
    description: 'Une impro qui part en vrille #impro',
    status: 'kept',
    pass: 1,
    ...champs,
  }
}

const riennEstProduit: ClipOutputs = {
  mp4Url: null,
  variant9x16Url: null,
  variant9x16Due: true,
  textsUrl: null,
}

function reponse(corps: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => corps } as Response
}

function monter(props: Partial<Parameters<typeof PanneauExport>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const enveloppe = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const complet = {
    clip: clip(),
    outputs: riennEstProduit,
    ratio: '1:1' as const,
    duree: 20,
    enregistrement: 'enregistre' as const,
    onBranding: vi.fn(),
    ...props,
  }
  const rendu = render(<PanneauExport {...complet} />, { wrapper: enveloppe })
  return { ...complet, rerender: rendu.rerender, props: complet }
}

const boutonExporter = () => screen.getByRole('button', { name: /exporter/i })

describe('avant l’export', () => {
  it('annonce deux vidéos quand le ratio n’est pas 9:16', () => {
    // C'est la seule conséquence du choix de ratio qui ne se voyait nulle part,
    // alors qu'elle change ce qu'on aura à publier.
    monter({ ratio: '1:1' })
    expect(screen.getByText('c1.mp4')).toBeTruthy()
    expect(screen.getByText('c1-9x16.mp4')).toBeTruthy()
    expect(screen.getByText('c1.txt')).toBeTruthy()
  })

  it('n’annonce qu’une vidéo quand le ratio est déjà 9:16', () => {
    monter({ ratio: '9:16' })
    expect(screen.getByText('c1.mp4')).toBeTruthy()
    expect(screen.queryByText('c1-9x16.mp4')).toBeNull()
  })

  it('résout « auto » comme le rendu le résoudra', () => {
    // `resolveRatio('auto')` vaut 9:16 en itération 0 : annoncer une variante
    // ferait attendre un fichier que l'export ne produira pas.
    monter({ ratio: 'auto' })
    expect(screen.queryByText('c1-9x16.mp4')).toBeNull()
  })

  it('avertit d’un titre vide sans empêcher le rendu', () => {
    monter({ clip: clip({ title: '' }) })
    expect(screen.getByText(/première ligne vide/i)).toBeTruthy()
    expect(boutonExporter().getAttribute('aria-disabled')).toBeNull()
  })
})

describe('les raisons de ne pas pouvoir exporter', () => {
  it('reste atteignable au clavier, la raison écrite à côté', async () => {
    // `disabled` sort du parcours de tabulation : un utilisateur au clavier ne
    // découvre jamais le bouton, donc jamais sa raison (spec §4.4).
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    monter({ enregistrement: 'en-attente' })

    const bouton = boutonExporter()
    expect(bouton.getAttribute('aria-disabled')).toBe('true')
    expect(bouton.hasAttribute('disabled')).toBe(false)
    expect(screen.getByText(/enregistrement/i)).toBeTruthy()

    fireEvent.click(bouton)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuse un clip dont tous les mots ont été retirés', () => {
    monter({ duree: 0 })
    expect(boutonExporter().getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText(/rien à rendre/i)).toBeTruthy()
  })
})

describe('pendant l’export', () => {
  it('devient un indicateur de travail, et n’offre pas d’annulation', async () => {
    // La requête dure de dix secondes à une minute. Un bouton muet passe pour
    // cassé, et un bouton d'annulation qui ne ferait qu'ignorer la réponse
    // mentirait : le rendu ffmpeg ne s'interrompt pas proprement.
    let libérer: (r: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (libérer = resolve))),
    )
    monter()

    fireEvent.click(boutonExporter())
    await waitFor(() => expect(boutonExporter().getAttribute('aria-busy')).toBe('true'))
    expect(screen.getByText(/dix secondes à une minute/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /annuler/i })).toBeNull()

    libérer(reponse({ mp4: 'c1.mp4', variant9x16: 'c1-9x16.mp4', texts: 'c1.txt', skipped: false }))
    await waitFor(() => expect(boutonExporter().getAttribute('aria-busy')).toBeNull())
  })
})

describe('après l’export', () => {
  it('dit qu’un `skipped` est un succès, pas un échec', async () => {
    const fait: ExportResult = {
      clip: clip({ status: 'exported' }),
      mp4: 'c1.mp4',
      variant9x16: 'c1-9x16.mp4',
      texts: 'c1.txt',
      skipped: true,
    }
    vi.stubGlobal('fetch', vi.fn(async () => reponse(fait)))
    monter()

    fireEvent.click(boutonExporter())
    await waitFor(() => expect(screen.getByText(/rien n’a été refait/i)).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('survit à une réponse sans clip', async () => {
    // Une passe de repérage qui se termine pendant le rendu réécrit le jeu de
    // clips : la route sérialise alors un corps sans ce champ. Lire
    // `clip.status` dessus ferait échouer un export par ailleurs réussi.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reponse({ mp4: 'c1.mp4', variant9x16: null, texts: 'c1.txt', skipped: false }),
      ),
    )
    monter({ ratio: '9:16' })

    fireEvent.click(boutonExporter())
    await waitFor(() => expect(screen.getByText(/rendu terminé/i)).toBeTruthy())
  })

  it('retire l’annonce quand le montage a changé depuis', async () => {
    // « Rendu terminé » décrit ce qui vient d'avoir lieu. Une coupe plus tard,
    // les fichiers sur le disque ne décrivent plus ce clip-ci, et laisser
    // l'annonce affirmerait le contraire.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reponse({ mp4: 'c1.mp4', variant9x16: 'c1-9x16.mp4', texts: 'c1.txt', skipped: false }),
      ),
    )
    const { rerender, props } = monter()
    fireEvent.click(boutonExporter())
    await waitFor(() => expect(screen.getByText(/rendu terminé/i)).toBeTruthy())

    rerender(<PanneauExport {...props} duree={14} />)
    expect(screen.queryByText(/rendu terminé/i)).toBeNull()
  })

  it('montre l’échec avec le code que le serveur a rendu', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reponse({ error: 'Aucune marque exploitable' }, 422)))
    monter()

    fireEvent.click(boutonExporter())
    const alerte = await screen.findByRole('alert')
    expect(alerte.textContent).toContain('422')
    expect(alerte.textContent).toContain('Aucune marque exploitable')
  })

  it('lit les fichiers sur place', () => {
    monter({
      outputs: {
        mp4Url: '/api/clips/c1/renders/c1.mp4',
        variant9x16Url: '/api/clips/c1/renders/c1-9x16.mp4',
        variant9x16Due: true,
        textsUrl: '/api/clips/c1/renders/c1.txt',
      },
    })
    expect(screen.getByLabelText(/rendu 1:1/i).getAttribute('src')).toBe(
      '/api/clips/c1/renders/c1.mp4',
    )
    expect(screen.getByLabelText(/variante 9:16/i).getAttribute('src')).toBe(
      '/api/clips/c1/renders/c1-9x16.mp4',
    )
  })

  it('ne montre pas de case vide quand la variante n’existera jamais', () => {
    // `variant9x16Due` sépare deux `null` qui ne veulent pas dire la même chose.
    // Afficher « rendu manquant » ici le ferait sur le clip le mieux livré.
    monter({
      ratio: '9:16',
      outputs: {
        mp4Url: '/api/clips/c1/renders/c1.mp4',
        variant9x16Url: null,
        variant9x16Due: false,
        textsUrl: '/api/clips/c1/renders/c1.txt',
      },
    })
    expect(screen.getByText(/déjà en 9:16/i)).toBeTruthy()
    expect(screen.queryByText(/pas encore produite/i)).toBeNull()
  })

  it('dit qu’une variante due manque encore', () => {
    monter({
      outputs: {
        mp4Url: '/api/clips/c1/renders/c1.mp4',
        variant9x16Url: null,
        variant9x16Due: true,
        textsUrl: null,
      },
    })
    expect(screen.getByText(/pas encore produite/i)).toBeTruthy()
  })
})

describe('le ré-export', () => {
  it('demande confirmation en nommant les fichiers qu’il écrase', async () => {
    const fetch = vi.fn(async (url: string, options: RequestInit) => {
      void url
      void options
      return reponse({ mp4: 'c1.mp4', variant9x16: 'c1-9x16.mp4', texts: 'c1.txt', skipped: false })
    })
    vi.stubGlobal('fetch', fetch)
    monter({
      clip: clip({ status: 'exported' }),
      outputs: {
        mp4Url: '/api/clips/c1/renders/c1.mp4',
        variant9x16Url: '/api/clips/c1/renders/c1-9x16.mp4',
        variant9x16Due: true,
        textsUrl: '/api/clips/c1/renders/c1.txt',
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /ré-exporter/i }))
    const boîte = await screen.findByRole('alertdialog')
    expect(boîte.textContent).toContain('c1.mp4')
    expect(boîte.textContent).toContain('c1-9x16.mp4')
    expect(fetch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /écraser/i }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({ force: true })
  })
})

describe('les textes et les marques', () => {
  it('copie exactement ce que le `.txt` porte', async () => {
    const écrire = vi.fn(async (texte: string) => {
      void texte
    })
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: écrire },
      configurable: true,
    })
    monter()

    fireEvent.click(screen.getByRole('button', { name: /copier/i }))
    await waitFor(() => expect(écrire).toHaveBeenCalledTimes(1))
    expect(écrire.mock.calls[0][0]).toContain('Titre : La chute')
    expect(écrire.mock.calls[0][0]).toContain('Mots-dièse : #impro')
  })

  it('repasse à « Copier » dès que les textes changent', async () => {
    // Sinon le bouton affirme « Copié » sur un texte que le presse-papiers ne
    // porte pas.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    })
    const { rerender, props } = monter()
    fireEvent.click(screen.getByRole('button', { name: /copier/i }))
    await screen.findByRole('button', { name: /copié/i })

    rerender(<PanneauExport {...props} clip={clip({ title: 'Un autre titre' })} />)
    expect(screen.getByRole('button', { name: /copier/i })).toBeTruthy()
  })

  it('expose l’échappatoire des marques, qui n’était atteignable qu’en curl', () => {
    // Depuis l'issue #37, un clip dont `branding` vaut `true` refuse de se rendre
    // quand aucune marque n'est exploitable, et le message recommande de le
    // passer à `false`.
    const { onBranding } = monter()
    const case_ = screen.getByRole('checkbox', { name: /marques/i })
    expect(case_.getAttribute('aria-checked') ?? String((case_ as HTMLInputElement).checked)).toMatch(
      /true/,
    )
    fireEvent.click(case_)
    expect(onBranding).toHaveBeenCalledWith(false)
  })
})
