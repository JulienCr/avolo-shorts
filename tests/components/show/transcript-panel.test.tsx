// @vitest-environment jsdom

/**
 * Le transcript entier de l'émission : l'ouvrir depuis l'URL, corriger un mot,
 * relancer la transcription.
 *
 * Les trois propriétés qui comptent : **l'ouverture pose `?transcript=1`**
 * sans effacer les autres paramètres, **une correction envoie un empan de
 * mots et son remplacement** — jamais du texte libre —, et **la relance de la
 * transcription passe par le graphe** (`target: 'candidates', force:
 * ['transcript']`), jamais par un appel dédié inventé pour l'occasion.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import type { TranscriptLine } from '@/lib/editing'

const replaceMock = vi.fn()
let query = ''
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(query),
}))

const { TranscriptPanel, TranscriptTrigger } = await import('@/components/show/transcript-panel')

/**
 * jsdom ne fait pas de mise en page : `offsetHeight`/`offsetWidth` valent
 * toujours 0, ce qui donne à `@tanstack/react-virtual` une fenêtre de hauteur
 * nulle — `calculateRange` s'arrête alors sur `outerSize === 0` et ne rend
 * jamais un seul mot, quel que soit le nombre de phrases. Poser une valeur non
 * nulle sur le prototype est la façon reconnue de tester une liste virtualisée
 * sous jsdom ; restaurée après coup pour ne pas fuir sur d'autres fichiers.
 */
const initialOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const initialOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body } as Response
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const LIGNES: TranscriptLine[] = [
  {
    id: 'l0',
    start: 10,
    end: 12,
    words: [
      { word: 'Bonjour', start: 10, end: 10.6 },
      { word: 'à', start: 10.7, end: 10.8 },
      { word: 'tous', start: 10.9, end: 12 },
    ],
  },
]

type Rule = { when: (url: string, method: string) => boolean; body: unknown; status?: number }

/** Un routeur de `fetch` minimal, par method et fragment d'URL. */
function stubFetch(rules: Rule[]) {
  const call = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const found = rules.find((r) => r.when(url, method))
    if (found === undefined) throw new Error(`Aucune réponse simulée pour ${method} ${url}`)
    return response(found.body, found.status ?? 200)
  })
  vi.stubGlobal('fetch', call)
  return call
}

/** Sert `LIGNES` sur `GET .../transcript`. */
function lireTranscript(body: unknown = LIGNES): Rule {
  return { when: (u, m) => m === 'GET' && u.endsWith('/transcript'), body }
}

/** Répond à `POST .../transcript` — la correction. */
function poserCorrection(body: unknown, status = 200): Rule {
  return { when: (u, m) => m === 'POST' && u.endsWith('/transcript'), body, status }
}

/** Répond à `POST .../run`. */
function poserRun(body: unknown, status = 202): Rule {
  return { when: (u, m) => m === 'POST' && u.endsWith('/run'), body, status }
}

function sentBody(call: ReturnType<typeof vi.fn>, index: number): unknown {
  const [, options] = call.mock.calls[index] as unknown as [string, RequestInit]
  return JSON.parse(String(options.body))
}

afterAll(() => {
  if (initialOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', initialOffsetHeight)
  if (initialOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', initialOffsetWidth)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  query = ''
  replaceMock.mockClear()
})

describe('TranscriptTrigger', () => {
  it('pose `?transcript=1` sans effacer les autres paramètres', async () => {
    query = 'vue=gardes'
    stubFetch([lireTranscript()])
    render(<TranscriptTrigger projectId="cqlp" />, { wrapper })

    await userEvent.setup().click(screen.getByRole('button', { name: /voir le transcript/i }))

    expect(replaceMock).toHaveBeenCalledWith('/projects/cqlp?vue=gardes&transcript=1', { scroll: false })
  })
})

describe('TranscriptPanel — lecture', () => {
  it('rend le transcript par phrase, avec son horodatage', async () => {
    stubFetch([lireTranscript()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    expect(await screen.findByRole('button', { name: 'Bonjour' })).toBeTruthy()
    expect(screen.getByText('0:00:10')).toBeTruthy()
  })

  it("dit qu'il n'y a pas encore de transcript plutôt que de rendre une surface vide", async () => {
    stubFetch([lireTranscript([])])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    expect(await screen.findByText(/n’a pas encore de transcript/)).toBeTruthy()
  })

  it("ne demande rien au serveur tant que le panneau n'est pas ouvert", () => {
    const call = stubFetch([lireTranscript()])
    render(<TranscriptPanel projectId="cqlp" open={false} onOpenChange={vi.fn()} />, { wrapper })

    expect(call).not.toHaveBeenCalled()
  })
})

describe('TranscriptPanel — correction', () => {
  it('sélectionne un mot au clic et propose son texte à corriger', async () => {
    stubFetch([lireTranscript()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Bonjour' }))

    const champ = screen.getByPlaceholderText('Texte corrigé…') as HTMLInputElement
    expect(champ.value).toBe('Bonjour')
  })

  it('majuscule-clique étend la sélection à plusieurs mots, dans la même phrase', async () => {
    stubFetch([lireTranscript()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    fireEvent.click(await screen.findByRole('button', { name: 'Bonjour' }))
    fireEvent.click(screen.getByRole('button', { name: 'à' }), { shiftKey: true })

    const champ = screen.getByPlaceholderText('Texte corrigé…') as HTMLInputElement
    expect(champ.value).toBe('Bonjour à')
  })

  it('envoie un empan de mots et son remplacement — jamais du texte libre', async () => {
    const call = stubFetch([
      lireTranscript(),
      poserCorrection({
        line: {
          ...LIGNES[0],
          words: [{ word: 'Salut', start: 10, end: 10.6 }, LIGNES[0].words[1], LIGNES[0].words[2]],
        },
        clipsTouched: [],
      }),
    ])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Bonjour' }))
    const champ = screen.getByPlaceholderText('Texte corrigé…')
    await user.clear(champ)
    await user.type(champ, 'Salut')
    await user.click(screen.getByRole('button', { name: 'Corriger' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Salut' })).toBeTruthy())

    const index = call.mock.calls.findIndex(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(sentBody(call, index)).toEqual({
      lineId: 'l0',
      from: 0,
      to: 0,
      expected: ['Bonjour'],
      replacement: ['Salut'],
    })
  })

  it('ne double-envoie pas une correction pendant que la première est en vol', async () => {
    // Le POST reste en attente jusqu'à ce que le test le débloque : sans le
    // garde sur `correction.isPending`, un second clic pendant ce délai
    // partirait avant la réponse du premier. (relevé par Copilot et par
    // Aristarque)
    let unblock: (v: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => {
      unblock = resolve
    })
    const call = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.endsWith('/transcript')) return response(LIGNES)
      if (method === 'POST' && url.endsWith('/transcript')) return pending
      throw new Error(`Aucune réponse simulée pour ${method} ${url}`)
    })
    vi.stubGlobal('fetch', call)

    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Bonjour' }))
    const button = screen.getByRole('button', { name: 'Corriger' })
    await user.click(button)
    await user.click(button)
    await user.click(button)

    const posts = call.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    expect(posts).toHaveLength(1)

    // La réponse débloquée efface la sélection (`clearSelection` au succès) :
    // le button disparaît, plutôt que de rester visible et actionnable.
    unblock(response({ line: LIGNES[0], clipsTouched: [] }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Corriger' })).toBeNull())
  })

  it('dit que le texte a changé sous les yeux sur un 409', async () => {
    stubFetch([lireTranscript(), poserCorrection({ error: 'Le texte a changé sous vos yeux.' }, 409)])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Bonjour' }))
    await user.click(screen.getByRole('button', { name: 'Corriger' }))

    const alerte = await screen.findByRole('alert')
    expect(alerte.textContent).toMatch(/changé sous vos yeux/)
  })

  it('nomme les clips touchés, pour rendre la conséquence explicite', async () => {
    stubFetch([
      lireTranscript(),
      poserCorrection({ line: LIGNES[0], clipsTouched: [{ id: 'c1', title: 'Le canapé' }] }),
    ])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Bonjour' }))
    await user.click(screen.getByRole('button', { name: 'Corriger' }))

    expect(await screen.findByText(/Le canapé/)).toBeTruthy()
    expect(screen.getByText(/reflètent la correction qu’après un nouvel export/)).toBeTruthy()
  })
})

describe('RetranscribeButton', () => {
  it('demande confirmation avant de retranscrire', async () => {
    stubFetch([lireTranscript()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    await userEvent.setup().click(await screen.findByRole('button', { name: /retranscrire l’émission/i }))

    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('vise `candidates` en forçant `transcript` — le graphe refait les deux', async () => {
    const call = stubFetch([lireTranscript(), poserRun({ projectId: 'cqlp', plan: ['transcript', 'candidates'] })])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /retranscrire l’émission/i }))
    await user.click(await screen.findByRole('button', { name: /^retranscrire$/i }))

    await waitFor(() => expect(call.mock.calls.some(([u]) => String(u).endsWith('/run'))).toBe(true))
    const index = call.mock.calls.findIndex(([u]) => String(u).endsWith('/run'))
    expect(sentBody(call, index)).toEqual({ target: 'candidates', force: ['transcript'] })
  })
})

describe('la navigation au clavier', () => {
  /**
   * Trois propriétés vérifiées, pas supposées : une trace de tabulation sur
   * soixante phrases s'arrêtait au septième mot avant de sauter au bouton de
   * fermeture — la plupart des mots étaient structurellement inatteignables,
   * puisqu'un mot hors de la fenêtre virtualisée n'existe pas dans le DOM.
   * Et démonter le mot focalisé (au défilement) faisait retomber
   * `document.activeElement` sur `<body>`.
   */

  it('un seul mot est un arrêt de tabulation à la fois, et les flèches le déplacent', async () => {
    stubFetch([lireTranscript()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const bonjour = await screen.findByRole('button', { name: 'Bonjour' })
    const a = screen.getByRole('button', { name: 'à' })
    expect(bonjour.getAttribute('tabindex')).toBe('0')
    expect(a.getAttribute('tabindex')).toBe('-1')

    bonjour.focus()
    fireEvent.keyDown(bonjour, { key: 'ArrowRight' })

    expect(a.getAttribute('tabindex')).toBe('0')
    expect(bonjour.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(a)
  })

  it('Entrée sur le mot du curseur le sélectionne, comme un clic', async () => {
    stubFetch([lireTranscript()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const bonjour = await screen.findByRole('button', { name: 'Bonjour' })
    bonjour.focus()
    fireEvent.keyDown(bonjour, { key: 'Enter' })

    const champ = screen.getByPlaceholderText('Texte corrigé…') as HTMLInputElement
    expect(champ.value).toBe('Bonjour')
  })

  it('demande un défilement quand le curseur vise un mot hors de la fenêtre rendue', async () => {
    // jsdom n'implémente pas `Element.scrollTo` (`typeof el.scrollTo ===
    // 'undefined'`, vérifié) : un bouchon suffit à prouver l'intention — que
    // le composant demande le défilement — sans dépendre d'un round-trip que
    // jsdom ne sait de toute façon pas simuler.
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo })
    try {
      const soixante: TranscriptLine[] = Array.from({ length: 60 }, (_, i) => ({
        id: `l${i}`,
        start: i * 10,
        end: i * 10 + 2,
        words: [{ word: `mot${i}`, start: i * 10, end: i * 10 + 1 }],
      }))
      stubFetch([lireTranscript(soixante)])
      render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })
      const mot0 = await screen.findByRole('button', { name: 'mot0' })
      mot0.focus()
      scrollTo.mockClear()

      fireEvent.keyDown(mot0, { key: 'End' })

      expect(scrollTo).toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
    }
  })

  it('le conteneur devient un arrêt de tabulation quand le mot du curseur sort du rendu', async () => {
    const soixante: TranscriptLine[] = Array.from({ length: 60 }, (_, i) => ({
      id: `l${i}`,
      start: i * 10,
      end: i * 10 + 2,
      words: [{ word: `mot${i}`, start: i * 10, end: i * 10 + 1 }],
    }))
    stubFetch([lireTranscript(soixante)])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const mot0 = await screen.findByRole('button', { name: 'mot0' })
    const conteneur = document.querySelector('[data-surface-transcript-show]') as HTMLDivElement
    // Le mot du curseur (index 0) est rendu : le conteneur n'est pas un
    // arrêt de tabulation, mot0 l'est.
    expect(conteneur.getAttribute('tabindex')).toBe('-1')

    // Un défilement à la molette, hors de tout geste clavier de ce
    // composant : le mot du curseur sort de la fenêtre virtualisée.
    Object.defineProperty(conteneur, 'scrollTop', { configurable: true, value: 5000, writable: true })
    fireEvent.scroll(conteneur)

    await waitFor(() => expect(document.body.contains(mot0)).toBe(false))
    expect(conteneur.getAttribute('tabindex')).toBe('0')
  })
})
