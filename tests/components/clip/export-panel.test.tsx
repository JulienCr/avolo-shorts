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
import { PanelExport } from '@/components/clip/export-panel'
import { framing, shot } from '../../fixtures/framing'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function clip(fields: Partial<Clip> = {}): Clip {
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
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    ...fields,
  }
}

const nothingIsProduced: ClipOutputs = {
  mp4Url: null,
  variant9x16Url: null,
  variant9x16Due: true,
  textsUrl: null,
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body } as Response
}

function mount(props: Partial<Parameters<typeof PanelExport>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const envelope = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const complete = {
    clip: clip(),
    outputs: nothingIsProduced,
    framing: framing(),
    duration: 20,
    autosave: 'enregistre' as const,
    fingerprint: 'empreinte-de-depart',
    writeInCurrent: false,
    writeInFailure: false,
    ...props,
  }
  const view = render(<PanelExport {...complete} />, { wrapper: envelope })
  return { ...complete, rerender: view.rerender, props: complete }
}

const buttonExporter = () => screen.getByRole('button', { name: /exporter/i })

describe('avant l’export', () => {
  it('annonce deux vidéos quand le ratio natif n’est pas 9:16', () => {
    // C'est la seule conséquence du choix de ratio qui ne se voyait nulle part,
    // alors qu'elle change ce qu'on aura à publier.
    mount({ framing: framing() })
    expect(screen.getByText('c1.mp4')).toBeTruthy()
    expect(screen.getByText('c1-9x16.mp4')).toBeTruthy()
    expect(screen.getByText('c1.txt')).toBeTruthy()
  })

  it('n’annonce qu’une vidéo quand le ratio natif est déjà 9:16', () => {
    mount({ framing: framing({ ratio: '9:16', shots: [shot(0, 20, '9:16', 0.5)] }) })
    expect(screen.getByText('c1.mp4')).toBeTruthy()
    expect(screen.queryByText('c1-9x16.mp4')).toBeNull()
  })

  /**
   * **Le panneau énonce le cadrage** (§3.5) : c'est la dernière surface avant la
   * livraison, et le seul endroit où l'automatique passerait en fraude si
   * personne ne l'y disait. Le ratio résolu, le nombre de plans, et les cadres
   * qu'ils prennent.
   */
  it('énonce le cadrage que l’export appliquera', () => {
    mount({
      framing: framing({
                shots: [shot(0, 10, '1:1', 0.4), shot(10, 20, '16:9', 0.5)],
      }),
    })
    expect(screen.getByText(/2 plans/)).toBeTruthy()
    expect(screen.getByText(/1:1, 16:9/)).toBeTruthy()
  })

  /**
   * **Un plan que personne n'a cadré, ni la machine ni l'humain**, mérite d'être
   * distinct des deux autres : ce n'est pas une décision, c'est celui qu'il faut
   * aller regarder avant de livrer.
   */
  it('signale les plans sur lesquels rien n’a été mesuré', () => {
    mount({
      framing: framing({
        shots: [shot(0, 10, '1:1', 0.4), shot(10, 20, '1:1', 0.5, 'default')],
      }),
    })
    expect(screen.getByText(/1 plan sans mesure/)).toBeTruthy()
  })

  it('n’en signale aucun quand tous ont été mesurés', () => {
    mount({ framing: framing() })
    expect(screen.queryByText(/sans mesure/)).toBeNull()
  })

  it('avertit d’un titre vide en disant ce que le fichier portera', () => {
    // Le rendu écrit « Titre : (sans titre) », pas une ligne vide : annoncer
    // l'inverse décrit un fichier qui n'existe pas. (relevé par Copilot)
    mount({ clip: clip({ title: '' }) })
    // Scopé à l'avertissement : la zone de textes porte le même « (sans titre) »,
    // et c'est justement ce qu'il annonce.
    expect(screen.getByText(/sortira avec/i).textContent).toContain('(sans titre)')
    expect(screen.queryByText(/première ligne vide/i)).toBeNull()
    expect(buttonExporter().getAttribute('aria-disabled')).toBeNull()
  })
})

describe('les raisons de ne pas pouvoir exporter', () => {
  it('reste atteignable au clavier, la raison écrite à côté', async () => {
    // `disabled` sort du parcours de tabulation : un utilisateur au clavier ne
    // découvre jamais le bouton, donc jamais sa raison (spec §4.4).
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    mount({ autosave: 'en-attente' })

    const button = buttonExporter()
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(screen.getByText(/enregistrement/i)).toBeTruthy()

    fireEvent.click(button)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuse d’exporter pendant qu’une écriture est en vol', () => {
    // `autosave` ne suit que les segments, le ratio et le cadrage. Une
    // bascule des marques, un titre, une description partent par la même
    // mutation sans y figurer : exporter dans la foulée fait lire au rendu la
    // valeur d'avant, et produit un fichier qui contredit l'écran.
    // (relevé par Codex)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    mount({ writeInCurrent: true })

    const button = buttonExporter()
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.getByText(/en cours d’écriture/i)).toBeTruthy()
  })

  it('refuse d’exporter quand la dernière écriture a échoué', () => {
    mount({ writeInFailure: true })
    expect(buttonExporter().getAttribute('aria-disabled')).toBe('true')
  })

  it('n’ouvre pas non plus la confirmation de ré-export', () => {
    // Le garde-fou est sur le lancement ; sans le même sur l'ouverture, la boîte
    // s'ouvre, on confirme, et rien ne part — sans qu'une ligne le dise.
    mount({
      autosave: 'en-attente',
      outputs: {
        mp4Url: '/api/clips/c1/renders/c1.mp4',
        variant9x16Url: null,
        variant9x16Due: true,
        textsUrl: null,
      },
    })
    fireEvent.click(screen.getByRole('button', { name: /ré-exporter/i }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('refuse un clip dont tous les mots ont été retirés', () => {
    mount({ duration: 0 })
    expect(buttonExporter().getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText(/rien à rendre/i)).toBeTruthy()
  })
})

describe('pendant l’export', () => {
  it('devient un indicateur de travail, et n’offre pas d’annulation', async () => {
    // La requête dure de dix secondes à une minute. Un bouton muet passe pour
    // cassé, et un bouton d'annulation qui ne ferait qu'ignorer la réponse
    // mentirait : le rendu ffmpeg ne s'interrompt pas proprement.
    let release: (r: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    )
    mount()

    fireEvent.click(buttonExporter())
    await waitFor(() => expect(buttonExporter().getAttribute('aria-busy')).toBe('true'))
    expect(screen.getByText(/dix secondes à une minute/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /annuler/i })).toBeNull()

    release(response({ mp4: 'c1.mp4', variant9x16: 'c1-9x16.mp4', texts: 'c1.txt', skipped: false }))
    await waitFor(() => expect(buttonExporter().getAttribute('aria-busy')).toBeNull())
  })
})

describe('après l’export', () => {
  it('dit qu’un `skipped` est un succès, pas un échec', async () => {
    const done: ExportResult = {
      clip: clip({ status: 'exported' }),
      mp4: 'c1.mp4',
      variant9x16: 'c1-9x16.mp4',
      texts: 'c1.txt',
      skipped: true,
    }
    vi.stubGlobal('fetch', vi.fn(async () => response(done)))
    mount()

    fireEvent.click(buttonExporter())
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
        response({ mp4: 'c1.mp4', variant9x16: null, texts: 'c1.txt', skipped: false }),
      ),
    )
    mount({ framing: framing({ ratio: '9:16', shots: [shot(0, 20, '9:16', 0.5)] }) })

    fireEvent.click(buttonExporter())
    await waitFor(() => expect(screen.getByText(/rendu terminé/i)).toBeTruthy())
  })

  it('retire l’annonce quand le montage a changé depuis', async () => {
    // « Rendu terminé » décrit ce qui vient d'avoir lieu. Une coupe plus tard,
    // les fichiers sur le disque ne décrivent plus ce clip-ci, et laisser
    // l'annonce affirmerait le contraire.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({ mp4: 'c1.mp4', variant9x16: 'c1-9x16.mp4', texts: 'c1.txt', skipped: false }),
      ),
    )
    const { rerender, props } = mount()
    fireEvent.click(buttonExporter())
    await waitFor(() => expect(screen.getByText(/rendu terminé/i)).toBeTruthy())

    // Une coupe de **même durée** change le montage sans changer la durée :
    // l'empreinte porte donc l'état de rendu entier, pas un seul nombre.
    // (relevé par Copilot)
    rerender(<PanelExport {...props} fingerprint="une-autre-empreinte" />)
    expect(screen.queryByText(/rendu terminé/i)).toBeNull()
  })

  it('montre l’échec avec le code que le serveur a rendu', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'Aucune marque exploitable' }, 422)))
    mount()

    fireEvent.click(buttonExporter())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('422')
    expect(alert.textContent).toContain('Aucune marque exploitable')
  })

  it('lit les fichiers sur place', () => {
    mount({
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
    mount({
      framing: framing({ ratio: '9:16', shots: [shot(0, 20, '9:16', 0.5)] }),
      outputs: {
        mp4Url: '/api/clips/c1/renders/c1.mp4',
        variant9x16Url: null,
        variant9x16Due: false,
        textsUrl: '/api/clips/c1/renders/c1.txt',
      },
    })
    expect(screen.getByText(/ratio natif est déjà 9:16/i)).toBeTruthy()
    expect(screen.queryByText(/pas encore produite/i)).toBeNull()
  })

  it('dit qu’une variante due manque encore', () => {
    mount({
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
      return response({ mp4: 'c1.mp4', variant9x16: 'c1-9x16.mp4', texts: 'c1.txt', skipped: false })
    })
    vi.stubGlobal('fetch', fetch)
    mount({
      clip: clip({ status: 'exported' }),
      outputs: {
        mp4Url: '/api/clips/c1/renders/c1.mp4',
        variant9x16Url: '/api/clips/c1/renders/c1-9x16.mp4',
        variant9x16Due: true,
        textsUrl: '/api/clips/c1/renders/c1.txt',
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /ré-exporter/i }))
    const box = await screen.findByRole('alertdialog')
    expect(box.textContent).toContain('c1.mp4')
    expect(box.textContent).toContain('c1-9x16.mp4')
    expect(fetch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /écraser/i }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({ force: true })
  })
})

describe('les textes et les marques', () => {
  it('copie exactement ce que le `.txt` porte', async () => {
    const write = vi.fn(async (text: string) => {
      void text
    })
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    })
    mount()

    fireEvent.click(screen.getByRole('button', { name: /copier tout/i }))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(write.mock.calls[0][0]).toContain('Titre : La chute')
    expect(write.mock.calls[0][0]).toContain('Mots-dièse : #impro')
  })

  it('copie chacun des trois séparément', async () => {
    // **On ne colle jamais le fichier.** On colle un titre dans un champ, une
    // description dans un autre, des mots-dièse dans un troisième : un bloc
    // unique obligeait à sélectionner les trois morceaux à la main, ce qui est
    // exactement le geste que le bouton supprimait.
    const write = vi.fn(async (text: string) => {
      void text
    })
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    })
    mount()

    fireEvent.click(screen.getByRole('button', { name: /copier titre/i }))
    await waitFor(() => expect(write).toHaveBeenLastCalledWith('La chute'))

    fireEvent.click(screen.getByRole('button', { name: /copier mots-dièse/i }))
    await waitFor(() => expect(write).toHaveBeenLastCalledWith('#impro'))
  })

  it('refuse de copier un texte vide', () => {
    // Copier le vide efface le presse-papiers : le contraire du service rendu,
    // et cela ne se remarque qu'au moment de coller.
    mount({ clip: clip({ description: '' }) })
    expect(
      screen.getByRole('button', { name: /copier description/i }).hasAttribute('disabled'),
    ).toBe(true)
  })

  it('repasse à « Copier » dès que les textes changent', async () => {
    // Sinon le bouton affirme « Copié » sur un texte que le presse-papiers ne
    // porte pas.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    })
    const { rerender, props } = mount()
    fireEvent.click(screen.getByRole('button', { name: /^copier tout$/i }))
    await screen.findByRole('button', { name: /copier tout — copié/i })

    rerender(<PanelExport {...props} clip={clip({ title: 'Un autre titre' })} />)
    expect(screen.getByRole('button', { name: /^copier tout$/i })).toBeTruthy()
  })

  // **L'échappatoire des marques a déménagé dans la zone Image**, avec le ratio
  // et le cadrage : ce qu'elle décide est ce que l'image porte. Son test la suit,
  // dans `ecran-clip.test.tsx`.
})

describe('le bouton « Publier »', () => {
  it('se refuse avec sa raison quand le clip n’a pas de rendu disponible', () => {
    mount({ outputs: nothingIsProduced })
    const button = screen.getByRole('button', { name: /^publier$/i })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText(/Exporter avant de publier/)).toBeTruthy()
  })

  it('ouvre la modale de publication une fois le clip exporté', () => {
    mount({
      outputs: { ...nothingIsProduced, mp4Url: 'https://example.test/c1.mp4' },
    })
    const button = screen.getByRole('button', { name: /^publier$/i })
    expect(button.hasAttribute('aria-disabled')).toBe(false)

    fireEvent.click(button)
    expect(screen.getByRole('heading', { name: 'Publier « La chute »' })).toBeTruthy()
  })
})
