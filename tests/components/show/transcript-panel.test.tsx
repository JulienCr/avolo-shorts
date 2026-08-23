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
import { installPointerEventPolyfill } from '../../fixtures/pointer-event'

// **`PointerEvent` n'existe pas sous `jsdom`.** Les cases à cocher de la
// relecture des propositions du modèle (Base UI `Checkbox`) en dispatchent
// un synthétique à la validation, quel que soit le mécanisme du clic.
installPointerEventPolyfill()

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

const LINES: TranscriptLine[] = [
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
function transcriptResponse(body: unknown = LINES): Rule {
  return { when: (u, m) => m === 'GET' && u.endsWith('/transcript'), body }
}

/** Répond à `POST .../transcript` — la correction. */
function correctionResponse(body: unknown, status = 200): Rule {
  return { when: (u, m) => m === 'POST' && u.endsWith('/transcript'), body, status }
}

/** Répond à `POST .../run`. */
function runResponse(body: unknown, status = 202): Rule {
  return { when: (u, m) => m === 'POST' && u.endsWith('/run'), body, status }
}

/** Répond à `POST .../transcript/correction` — la proposition du modèle. */
function proposeResponse(body: unknown, status = 200): Rule {
  return { when: (u, m) => m === 'POST' && u.endsWith('/transcript/correction'), body, status }
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
    stubFetch([transcriptResponse()])
    render(<TranscriptTrigger projectId="cqlp" />, { wrapper })

    await userEvent.setup().click(screen.getByRole('button', { name: /voir le transcript/i }))

    expect(replaceMock).toHaveBeenCalledWith('/projects/cqlp?vue=gardes&transcript=1', { scroll: false })
  })

  it('ouvre par un `SheetTrigger` réel, pas un bouton qui bascule un booléen à côté', async () => {
    // La primitive ne peut garantir le retour du focus à la fermeture
    // (`src/components/clip/transcript-drawer.tsx:53-55,133-140`) que si le
    // bouton d'ouverture est son propre déclencheur. (relevé par Copilot)
    stubFetch([transcriptResponse()])
    render(<TranscriptTrigger projectId="cqlp" />, { wrapper })

    const button = screen.getByRole('button', { name: /voir le transcript/i })
    expect(button.getAttribute('data-slot')).toBe('sheet-trigger')
  })
})

describe('TranscriptPanel — lecture', () => {
  it('rend le transcript par phrase, avec son horodatage', async () => {
    stubFetch([transcriptResponse()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    expect(await screen.findByRole('button', { name: 'Bonjour' })).toBeTruthy()
    expect(screen.getByText('0:00:10')).toBeTruthy()
  })

  it("dit qu'il n'y a pas encore de transcript plutôt que de rendre une surface vide", async () => {
    stubFetch([transcriptResponse([])])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    expect(await screen.findByText(/n’a pas encore de transcript/)).toBeTruthy()
  })

  it("ne demande rien au serveur tant que le panneau n'est pas ouvert", () => {
    const call = stubFetch([transcriptResponse()])
    render(<TranscriptPanel projectId="cqlp" open={false} onOpenChange={vi.fn()} />, { wrapper })

    expect(call).not.toHaveBeenCalled()
  })
})

describe('TranscriptPanel — correction', () => {
  it('sélectionne un mot au clic et propose son texte à corriger', async () => {
    stubFetch([transcriptResponse()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Bonjour' }))

    const field = screen.getByPlaceholderText('Texte corrigé…') as HTMLInputElement
    expect(field.value).toBe('Bonjour')
  })

  it('porte la sélection au clavier, pas seulement à la couleur (aria-pressed)', async () => {
    stubFetch([transcriptResponse()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const hello = await screen.findByRole('button', { name: 'Bonjour' })
    expect(hello.getAttribute('aria-pressed')).toBe('false')

    await userEvent.setup().click(hello)

    expect(hello.getAttribute('aria-pressed')).toBe('true')
  })

  it('majuscule-clique étend la sélection à plusieurs mots, dans la même phrase', async () => {
    stubFetch([transcriptResponse()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    fireEvent.click(await screen.findByRole('button', { name: 'Bonjour' }))
    fireEvent.click(screen.getByRole('button', { name: 'à' }), { shiftKey: true })

    const field = screen.getByPlaceholderText('Texte corrigé…') as HTMLInputElement
    expect(field.value).toBe('Bonjour à')
  })

  it('envoie un empan de mots et son remplacement — jamais du texte libre', async () => {
    const call = stubFetch([
      transcriptResponse(),
      correctionResponse({
        line: {
          ...LINES[0],
          words: [{ word: 'Salut', start: 10, end: 10.6 }, LINES[0].words[1], LINES[0].words[2]],
        },
        clipsTouched: [],
      }),
    ])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Bonjour' }))
    const field = screen.getByPlaceholderText('Texte corrigé…')
    await user.clear(field)
    await user.type(field, 'Salut')
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
      if (method === 'GET' && url.endsWith('/transcript')) return response(LINES)
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
    unblock(response({ line: LINES[0], clipsTouched: [] }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Corriger' })).toBeNull())
  })

  it('dit que le texte a changé sous les yeux sur un 409', async () => {
    stubFetch([transcriptResponse(), correctionResponse({ error: 'Le texte a changé sous vos yeux.' }, 409)])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Bonjour' }))
    await user.click(screen.getByRole('button', { name: 'Corriger' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/changé sous vos yeux/)
  })

  it('nomme les clips touchés, pour rendre la conséquence explicite', async () => {
    stubFetch([
      transcriptResponse(),
      correctionResponse({ line: LINES[0], clipsTouched: [{ id: 'c1', title: 'Le canapé' }] }),
    ])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Bonjour' }))
    await user.click(screen.getByRole('button', { name: 'Corriger' }))

    expect(await screen.findByText(/Le canapé/)).toBeTruthy()
    expect(screen.getByText(/reflètent la correction qu’après un nouvel export/)).toBeTruthy()
  })

  it('efface le bandeau et la sélection ouverte quand une retranscription se termine', async () => {
    // `useProjet` doit d'abord voir `running` non nul, puis `null`, pour que
    // la transition se déclenche — comme la fin réelle d'une retranscription.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const localWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const runningStatus = {
      project: { id: 'cqlp', title: 'cqlp', durationSec: 100, createdAt: '2026-01-01' },
      steps: { proxy: true, audio: true, transcript: true, analysis: true, candidates: true, renders: false },
      running: { step: 'transcript', progress: 0.4 },
      error: null,
      stopped: false,
      selectionReport: null,
      sizeBytes: null,
    }
    stubFetch([
      transcriptResponse(),
      correctionResponse({ line: LINES[0], clipsTouched: [{ id: 'c1', title: 'Le canapé' }] }),
      { when: (u, m) => m === 'GET' && u.endsWith('/projects/cqlp'), body: runningStatus },
    ])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper: localWrapper })

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Bonjour' }))
    await user.click(screen.getByRole('button', { name: 'Corriger' }))
    expect(await screen.findByText(/Le canapé/)).toBeTruthy()

    await waitFor(() => expect(client.getQueryData(['projet', 'cqlp'])).toBeTruthy())

    client.setQueryData(['projet', 'cqlp'], { ...runningStatus, running: null })

    await waitFor(() => expect(screen.queryByText(/Le canapé/)).toBeNull())
  })
})

/** Une phrase de six mots, pour poser deux propositions dessus (une fusion, une simple). */
const LINE_L1: TranscriptLine = {
  id: 'l1',
  start: 20,
  end: 24,
  words: [
    { word: 'un', start: 20, end: 20.2 },
    { word: 'chat', start: 20.3, end: 20.6 },
    { word: 'noir', start: 20.7, end: 21 },
    { word: 'et', start: 21.1, end: 21.3 },
    { word: 'deux', start: 21.4, end: 21.7 },
    { word: 'chiens', start: 21.8, end: 22.2 },
  ],
}

describe('TranscriptPanel — correction par modèle', () => {
  it(
    'applique les propositions d’une même phrase de l’index le plus haut au plus bas, ' +
      'pour ne pas décaler l’ancre d’une correction pas encore envoyée (relevé par Copilot et Codex)',
    async () => {
      // Le serveur les rend dans l'ordre naturel (index croissant) : la fusion
      // (from=1..2) avant la correction simple (from=4). Appliquées telles
      // quelles, la fusion raccourcirait la phrase avant que la seconde ne
      // parte, décalant son ancre. Le composant doit les réordonner.
      const proposals = [
        {
          request: { lineId: 'l1', from: 1, to: 2, expected: ['chat', 'noir'], replacement: ['chaton'] },
          timecode: 20.3,
          original: 'chat noir',
          replacement: 'chaton',
        },
        {
          request: { lineId: 'l1', from: 4, to: 4, expected: ['deux'], replacement: ['trois'] },
          timecode: 21.4,
          original: 'deux',
          replacement: 'trois',
        },
      ]
      const correction = stubFetch([
        transcriptResponse([LINES[0], LINE_L1]),
        proposeResponse({ proposals, rejected: {} }),
        correctionResponse({ line: LINE_L1, clipsTouched: [] }),
      ])
      render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: /corriger automatiquement/i }))
      expect(await screen.findByText(/2 substitutions proposées/)).toBeTruthy()

      await user.click(screen.getByRole('button', { name: /valider 2 corrections/i }))

      await waitFor(() => {
        const posts = correction.mock.calls.filter(
          ([input, init]) => String(input).endsWith('/transcript') && (init as RequestInit | undefined)?.method === 'POST',
        )
        expect(posts).toHaveLength(2)
      })
      const posts = correction.mock.calls.filter(
        ([input, init]) => String(input).endsWith('/transcript') && (init as RequestInit | undefined)?.method === 'POST',
      )
      const bodies = posts.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { from: number })
      expect(bodies.map((b) => b.from)).toEqual([4, 1])
    },
  )

  it('préserve les exclusions après un envoi partiel', async () => {
    const proposals = [
      {
        request: { lineId: 'l0', from: 0, to: 0, expected: ['Bonjour'], replacement: ['Salut'] },
        timecode: 10,
        original: 'Bonjour',
        replacement: 'Salut',
      },
      {
        request: { lineId: 'l1', from: 4, to: 4, expected: ['deux'], replacement: ['trois'] },
        timecode: 21.4,
        original: 'deux',
        replacement: 'trois',
      },
    ]
    stubFetch([
      transcriptResponse([LINES[0], LINE_L1]),
      proposeResponse({ proposals, rejected: {} }),
      correctionResponse({ line: LINES[0], clipsTouched: [] }),
    ])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /corriger automatiquement/i }))
    expect(await screen.findByText(/2 substitutions proposées/)).toBeTruthy()

    // Décoche la seconde proposition (« deux » → « trois ») avant de valider.
    const checkboxes = screen.getAllByRole('checkbox')
    await user.click(checkboxes[1])
    await waitFor(() => expect(checkboxes[1].getAttribute('data-state')).not.toBe('checked'))
    await user.click(screen.getByRole('button', { name: /Valider 1 correction/i }))

    // La proposition décochée revient dans la liste restante : elle doit
    // rester décochée, pas repasser cochée par défaut.
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(1))
    expect(screen.getByRole('checkbox').getAttribute('data-state')).not.toBe('checked')
  })

  it('efface le résultat de la passe précédente quand une retranscription se termine', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const localWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const runningStatus = {
      project: { id: 'cqlp', title: 'cqlp', durationSec: 100, createdAt: '2026-01-01' },
      steps: { proxy: true, audio: true, transcript: true, analysis: true, candidates: true, renders: false },
      running: { step: 'transcript', progress: 0.4 },
      error: null,
      stopped: false,
      selectionReport: null,
      sizeBytes: null,
    }
    stubFetch([
      transcriptResponse(),
      proposeResponse({ proposals: [], rejected: {} }),
      { when: (u, m) => m === 'GET' && u.endsWith('/projects/cqlp'), body: runningStatus },
    ])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper: localWrapper })

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /corriger automatiquement/i }))
    expect(await screen.findByText(/0 substitution proposée/)).toBeTruthy()

    await waitFor(() => expect(client.getQueryData(['projet', 'cqlp'])).toBeTruthy())
    client.setQueryData(['projet', 'cqlp'], { ...runningStatus, running: null })

    await waitFor(() => expect(screen.queryByText(/substitution proposée/)).toBeNull())
  })
})

describe('RetranscribeButton', () => {
  it('demande confirmation avant de retranscrire', async () => {
    stubFetch([transcriptResponse()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    await userEvent.setup().click(await screen.findByRole('button', { name: /retranscrire l’émission/i }))

    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('vise `candidates` en forçant `transcript` — le graphe refait les deux', async () => {
    const call = stubFetch([transcriptResponse(), runResponse({ projectId: 'cqlp', plan: ['transcript', 'candidates'] })])
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
    stubFetch([transcriptResponse()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const hello = await screen.findByRole('button', { name: 'Bonjour' })
    const a = screen.getByRole('button', { name: 'à' })
    expect(hello.getAttribute('tabindex')).toBe('0')
    expect(a.getAttribute('tabindex')).toBe('-1')

    hello.focus()
    fireEvent.keyDown(hello, { key: 'ArrowRight' })

    expect(a.getAttribute('tabindex')).toBe('0')
    expect(hello.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(a)
  })

  it('Entrée sur le mot du curseur le sélectionne, comme un clic', async () => {
    stubFetch([transcriptResponse()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const hello = await screen.findByRole('button', { name: 'Bonjour' })
    hello.focus()
    fireEvent.keyDown(hello, { key: 'Enter' })

    const field = screen.getByPlaceholderText('Texte corrigé…') as HTMLInputElement
    expect(field.value).toBe('Bonjour')
  })

  it('demande un défilement quand le curseur vise un mot hors de la fenêtre rendue', async () => {
    // jsdom n'implémente pas `Element.scrollTo` (`typeof el.scrollTo ===
    // 'undefined'`, vérifié) : un bouchon suffit à prouver l'intention — que
    // le composant demande le défilement — sans dépendre d'un round-trip que
    // jsdom ne sait de toute façon pas simuler.
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo })
    try {
      const sixty: TranscriptLine[] = Array.from({ length: 60 }, (_, i) => ({
        id: `l${i}`,
        start: i * 10,
        end: i * 10 + 2,
        words: [{ word: `mot${i}`, start: i * 10, end: i * 10 + 1 }],
      }))
      stubFetch([transcriptResponse(sixty)])
      render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })
      const word0 = await screen.findByRole('button', { name: 'mot0' })
      word0.focus()
      scrollTo.mockClear()

      fireEvent.keyDown(word0, { key: 'End' })

      expect(scrollTo).toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
    }
  })

  it('le conteneur devient un arrêt de tabulation quand le mot du curseur sort du rendu', async () => {
    const sixty: TranscriptLine[] = Array.from({ length: 60 }, (_, i) => ({
      id: `l${i}`,
      start: i * 10,
      end: i * 10 + 2,
      words: [{ word: `mot${i}`, start: i * 10, end: i * 10 + 1 }],
    }))
    stubFetch([transcriptResponse(sixty)])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper })

    const word0 = await screen.findByRole('button', { name: 'mot0' })
    const container = document.querySelector('[data-surface-transcript-show]') as HTMLDivElement
    // Le mot du curseur (index 0) est rendu : ce conteneur n'est pas un
    // arrêt de tabulation, mot0 l'est.
    expect(container.getAttribute('tabindex')).toBe('-1')

    // Un défilement à la molette, hors de tout geste clavier de ce
    // composant : le mot du curseur sort de la fenêtre virtualisée.
    Object.defineProperty(container, 'scrollTop', { configurable: true, value: 5000, writable: true })
    fireEvent.scroll(container)

    await waitFor(() => expect(document.body.contains(word0)).toBe(false))
    expect(container.getAttribute('tabindex')).toBe('0')
  })
})
