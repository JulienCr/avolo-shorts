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

const remplacer = vi.fn()
let requête = ''
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: remplacer, push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(requête),
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
const offsetHeightDÉpart = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const offsetWidthDÉpart = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })

function reponse(corps: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => corps } as Response
}

function enveloppe({ children }: { children: ReactNode }) {
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

type Règle = { quand: (url: string, méthode: string) => boolean; corps: unknown; statut?: number }

/** Un routeur de `fetch` minimal, par méthode et fragment d'URL. */
function stubFetch(règles: Règle[]) {
  const appel = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const méthode = init?.method ?? 'GET'
    const trouvée = règles.find((r) => r.quand(url, méthode))
    if (trouvée === undefined) throw new Error(`Aucune réponse simulée pour ${méthode} ${url}`)
    return reponse(trouvée.corps, trouvée.statut ?? 200)
  })
  vi.stubGlobal('fetch', appel)
  return appel
}

/** Sert `LIGNES` sur `GET .../transcript`. */
function lireTranscript(corps: unknown = LIGNES): Règle {
  return { quand: (u, m) => m === 'GET' && u.endsWith('/transcript'), corps }
}

/** Répond à `POST .../transcript` — la correction. */
function poserCorrection(corps: unknown, statut = 200): Règle {
  return { quand: (u, m) => m === 'POST' && u.endsWith('/transcript'), corps, statut }
}

/** Répond à `POST .../run`. */
function poserRun(corps: unknown, statut = 202): Règle {
  return { quand: (u, m) => m === 'POST' && u.endsWith('/run'), corps, statut }
}

function corpsEnvoyé(appel: ReturnType<typeof vi.fn>, index: number): unknown {
  const [, options] = appel.mock.calls[index] as unknown as [string, RequestInit]
  return JSON.parse(String(options.body))
}

afterAll(() => {
  if (offsetHeightDÉpart) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDÉpart)
  if (offsetWidthDÉpart) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidthDÉpart)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  requête = ''
  remplacer.mockClear()
})

describe('TranscriptTrigger', () => {
  it('pose `?transcript=1` sans effacer les autres paramètres', async () => {
    requête = 'vue=gardes'
    stubFetch([lireTranscript()])
    render(<TranscriptTrigger projectId="cqlp" />, { wrapper: enveloppe })

    await userEvent.setup().click(screen.getByRole('button', { name: /voir le transcript/i }))

    expect(remplacer).toHaveBeenCalledWith('/projects/cqlp?vue=gardes&transcript=1', { scroll: false })
  })
})

describe('TranscriptPanel — lecture', () => {
  it('rend le transcript par phrase, avec son horodatage', async () => {
    stubFetch([lireTranscript()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper: enveloppe })

    expect(await screen.findByRole('button', { name: 'Bonjour' })).toBeTruthy()
    expect(screen.getByText('0:00:10')).toBeTruthy()
  })

  it("dit qu'il n'y a pas encore de transcript plutôt que de rendre une surface vide", async () => {
    stubFetch([lireTranscript([])])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper: enveloppe })

    expect(await screen.findByText(/n’a pas encore de transcript/)).toBeTruthy()
  })

  it("ne demande rien au serveur tant que le panneau n'est pas ouvert", () => {
    const appel = stubFetch([lireTranscript()])
    render(<TranscriptPanel projectId="cqlp" open={false} onOpenChange={vi.fn()} />, { wrapper: enveloppe })

    expect(appel).not.toHaveBeenCalled()
  })
})

describe('TranscriptPanel — correction', () => {
  it('sélectionne un mot au clic et propose son texte à corriger', async () => {
    stubFetch([lireTranscript()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper: enveloppe })

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Bonjour' }))

    const champ = screen.getByPlaceholderText('Texte corrigé…') as HTMLInputElement
    expect(champ.value).toBe('Bonjour')
  })

  it('majuscule-clique étend la sélection à plusieurs mots, dans la même phrase', async () => {
    stubFetch([lireTranscript()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper: enveloppe })

    fireEvent.click(await screen.findByRole('button', { name: 'Bonjour' }))
    fireEvent.click(screen.getByRole('button', { name: 'à' }), { shiftKey: true })

    const champ = screen.getByPlaceholderText('Texte corrigé…') as HTMLInputElement
    expect(champ.value).toBe('Bonjour à')
  })

  it('envoie un empan de mots et son remplacement — jamais du texte libre', async () => {
    const appel = stubFetch([
      lireTranscript(),
      poserCorrection({
        line: {
          ...LIGNES[0],
          words: [{ word: 'Salut', start: 10, end: 10.6 }, LIGNES[0].words[1], LIGNES[0].words[2]],
        },
        clipsTouched: [],
      }),
    ])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper: enveloppe })

    const utilisateur = userEvent.setup()
    await utilisateur.click(await screen.findByRole('button', { name: 'Bonjour' }))
    const champ = screen.getByPlaceholderText('Texte corrigé…')
    await utilisateur.clear(champ)
    await utilisateur.type(champ, 'Salut')
    await utilisateur.click(screen.getByRole('button', { name: 'Corriger' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Salut' })).toBeTruthy())

    const index = appel.mock.calls.findIndex(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(corpsEnvoyé(appel, index)).toEqual({
      lineId: 'l0',
      from: 0,
      to: 0,
      expected: ['Bonjour'],
      replacement: ['Salut'],
    })
  })

  it('dit que le texte a changé sous les yeux sur un 409', async () => {
    stubFetch([lireTranscript(), poserCorrection({ error: 'Le texte a changé sous vos yeux.' }, 409)])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper: enveloppe })

    const utilisateur = userEvent.setup()
    await utilisateur.click(await screen.findByRole('button', { name: 'Bonjour' }))
    await utilisateur.click(screen.getByRole('button', { name: 'Corriger' }))

    const alerte = await screen.findByRole('alert')
    expect(alerte.textContent).toMatch(/changé sous vos yeux/)
  })

  it('nomme les clips touchés, pour rendre la conséquence explicite', async () => {
    stubFetch([
      lireTranscript(),
      poserCorrection({ line: LIGNES[0], clipsTouched: [{ id: 'c1', title: 'Le canapé' }] }),
    ])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper: enveloppe })

    const utilisateur = userEvent.setup()
    await utilisateur.click(await screen.findByRole('button', { name: 'Bonjour' }))
    await utilisateur.click(screen.getByRole('button', { name: 'Corriger' }))

    expect(await screen.findByText(/Le canapé/)).toBeTruthy()
    expect(screen.getByText(/reflètent la correction qu’après un nouvel export/)).toBeTruthy()
  })
})

describe('RetranscribeButton', () => {
  it('demande confirmation avant de retranscrire', async () => {
    stubFetch([lireTranscript()])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper: enveloppe })

    await userEvent.setup().click(await screen.findByRole('button', { name: /retranscrire l’émission/i }))

    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('vise `candidates` en forçant `transcript` — le graphe refait les deux', async () => {
    const appel = stubFetch([lireTranscript(), poserRun({ projectId: 'cqlp', plan: ['transcript', 'candidates'] })])
    render(<TranscriptPanel projectId="cqlp" open onOpenChange={vi.fn()} />, { wrapper: enveloppe })

    const utilisateur = userEvent.setup()
    await utilisateur.click(await screen.findByRole('button', { name: /retranscrire l’émission/i }))
    await utilisateur.click(await screen.findByRole('button', { name: /^retranscrire$/i }))

    await waitFor(() => expect(appel.mock.calls.some(([u]) => String(u).endsWith('/run'))).toBe(true))
    const index = appel.mock.calls.findIndex(([u]) => String(u).endsWith('/run'))
    expect(corpsEnvoyé(appel, index)).toEqual({ target: 'candidates', force: ['transcript'] })
  })
})
