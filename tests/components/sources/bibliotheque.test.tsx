// @vitest-environment jsdom

/**
 * L'écran de bibliothèque monté pour de vrai : les deux sections, le sondage,
 * et la création d'un projet de bout en bout.
 *
 * `@/lib/api` fait son travail ici — seul `fetch` est remplacé, comme dans
 * `tests/lib/queries.test.tsx`. C'est ce qui fait que ces tests voient les
 * requêtes réellement émises, y compris celle qu'on cherche à **ne pas** émettre :
 * un `GET /api/projects/:id` par projet figerait le serveur.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Bibliotheque from '@/app/page'
import type { ProjectListItem, SourcesListing } from '@/lib/api'
import { useProjets } from '@/lib/queries'

const pousser = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pousser, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

beforeEach(() => pousser.mockReset())

function reponse(corps: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => corps,
  } as Response
}

const CQLP: ProjectListItem = {
  id: '2025-06-15-cqlp',
  title: 'La scène du 15 juin',
  durationSec: 5_940,
  createdAt: '2025-06-15T19:04:00.000Z',
  running: null,
  error: null,
}

const SOURCES: SourcesListing = {
  sources: [
    {
      name: '2025-06-15-cqlp.mp4',
      sizeBytes: 4_300_000_000,
      modifiedAt: '2025-06-15T19:04:00.000Z',
      projectId: null,
    },
  ],
  montage: { disponible: true, fstype: '9p', entrées: 1 },
}

/** Un serveur réduit aux trois routes de cet écran. */
function serveur(
  reponses: {
    projets?: () => Response
    sources?: () => Response
    creation?: () => Response
  } = {},
) {
  const appels: string[] = []
  const faux = vi.fn(async (url: string, init?: RequestInit) => {
    appels.push(`${init?.method ?? 'GET'} ${url}`)
    if (url === '/api/sources') return (reponses.sources ?? (() => reponse(SOURCES)))()
    if (url === '/api/projects' && init?.method === 'POST') {
      return (reponses.creation ?? (() => reponse({ projectId: CQLP.id, plan: [] }, 202)))()
    }
    if (url === '/api/projects') return (reponses.projets ?? (() => reponse([CQLP])))()
    throw new Error(`Route inattendue : ${url}`)
  })
  vi.stubGlobal('fetch', faux)
  return appels
}

function enveloppe() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  // Nommée, et non anonyme : `react/display-name` refuse un composant sans nom,
  // et un composant sans nom est aussi une pile de rendu illisible quand un test
  // échoue.
  function Enveloppe({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return Enveloppe
}

async function monter() {
  const Enveloppe = enveloppe()
  render(
    <Enveloppe>
      <Bibliotheque />
    </Enveloppe>,
  )
  await waitFor(() => expect(screen.getByText('2025-06-15-cqlp.mp4')).toBeTruthy())
}

describe('la bibliothèque', () => {
  it('met les projets avant les replays', async () => {
    // Une émission par semaine arrive, et chacune se travaille en plusieurs
    // séances : ce qu'on ouvre le plus souvent est un projet déjà lancé.
    serveur()
    await monter()

    const titres = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(titres).toEqual(['Projets', 'Replays'])
  })

  it('ne demande jamais l’état d’un projet une requête à la fois', async () => {
    // `GET /api/projects/:id` exécute `relevéPrésence`, qui sonde le montage 9p
    // avec un délai de garde. Vingt et un appels prendraient les quatre fils du
    // vivier de libuv et figeraient l'analyse en cours.
    const appels = serveur()
    await monter()

    expect(appels.filter((a) => a.startsWith('GET /api/projects/'))).toEqual([])
  })

  it('crée le projet d’une source neuve, puis y mène', async () => {
    // La redirection **est** la confirmation : une notification en plus dirait
    // deux fois la même chose.
    const appels = serveur()
    await monter()

    await userEvent.click(screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ }))

    await waitFor(() => expect(pousser).toHaveBeenCalledWith('/projects/2025-06-15-cqlp'))
    expect(appels).toContain('POST /api/projects')
  })

  it('affiche le message du serveur quand la création échoue, et ne va nulle part', async () => {
    const duServeur = 'Le dossier des replays ne répond pas. Rouvrir le lecteur côté Windows.'
    serveur({ creation: () => reponse({ error: duServeur }, 503) })
    await monter()

    await userEvent.click(screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(duServeur))
    expect(pousser).not.toHaveBeenCalled()
  })

  it('affiche le message du serveur quand les replays ne se listent pas', async () => {
    serveur({ sources: () => reponse({ error: 'REPLAY_DIR est absent.' }, 500) })
    const Enveloppe = enveloppe()
    render(
      <Enveloppe>
        <Bibliotheque />
      </Enveloppe>,
    )

    await waitFor(() => expect(screen.getByText('REPLAY_DIR est absent.')).toBeTruthy())
  })

  it('efface la section des projets quand il n’y en a aucun', async () => {
    // Le pire cas — montage absent **et** aucun projet — n'affiche alors qu'une
    // phrase et le geste qui la répare.
    serveur({
      projets: () => reponse([]),
      sources: () =>
        reponse({ sources: [], montage: { disponible: false, fstype: null, entrées: 0 } }),
    })
    const Enveloppe = enveloppe()
    render(
      <Enveloppe>
        <Bibliotheque />
      </Enveloppe>,
    )

    await waitFor(() =>
      expect(screen.getByText('Le dossier des replays n’est pas monté.')).toBeTruthy(),
    )
    expect(screen.queryByRole('heading', { name: 'Projets' })).toBeNull()
  })
})

describe('useProjets, le sondage', () => {
  it('redemande la liste tant qu’une analyse tourne', async () => {
    // C'est ce qui rend supportable de lancer une analyse puis d'aller trier un
    // autre projet : l'état arrive tout seul.
    vi.useFakeTimers()
    const faux = vi.fn(async () =>
      reponse([{ ...CQLP, running: { step: 'transcript', progress: 0.4 } }]),
    )
    vi.stubGlobal('fetch', faux)

    const { result } = renderHook(() => useProjets(), { wrapper: enveloppe() })
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
    expect(result.current.data).toHaveLength(1)
    expect(faux).toHaveBeenCalledTimes(1)

    await act(async () => void (await vi.advanceTimersByTimeAsync(2_100)))
    expect(faux).toHaveBeenCalledTimes(2)
  })

  it('se tait dès que plus rien ne tourne', async () => {
    // Interroger en permanence une bibliothèque au repos ne renseignerait
    // personne, et le ferait à travers un serveur qui a mieux à faire.
    vi.useFakeTimers()
    const faux = vi.fn(async () => reponse([CQLP]))
    vi.stubGlobal('fetch', faux)

    renderHook(() => useProjets(), { wrapper: enveloppe() })
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
    expect(faux).toHaveBeenCalledTimes(1)

    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)))
    expect(faux).toHaveBeenCalledTimes(1)
  })
})
