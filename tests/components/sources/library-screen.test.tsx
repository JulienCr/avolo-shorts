// @vitest-environment jsdom

/**
 * L'écran de bibliothèque monté pour de vrai : la jointure, le sondage, et la
 * création d'un projet de bout en bout.
 *
 * `@/lib/api` fait son travail ici — seul `fetch` est remplacé, comme dans
 * `tests/lib/queries.test.tsx`. C'est ce qui fait que ces tests voient les
 * requêtes réellement émises, y compris celle qu'on cherche à **ne pas** émettre :
 * un `GET /api/projects/:id` par projet figerait le serveur, et c'est ce coût-là
 * qui avait fait retenir deux sections plutôt qu'une liste enrichie. La liste
 * unifiée ne le rouvre pas — elle apparie côté client ce que les deux requêtes
 * portent déjà.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LibraryScreen } from '@/components/sources/library-screen'
import { keySources } from '@/components/sources/use-sources'
import type { ProjectListItem, SourcesListing } from '@/lib/api'
import { useProjects } from '@/lib/queries'

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

beforeEach(() => push.mockReset())

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
  } as Response
}

const CQLP: ProjectListItem = {
  id: '2025-06-15-cqlp',
  title: '2025-06-15-cqlp',
  durationSec: 5_940,
  createdAt: '2025-06-15T19:04:00.000Z',
  running: null,
  runningAll: [],
  error: null,
  warning: null,
  stopped: false,
  everRan: true,
}

const SOURCES: SourcesListing = {
  sources: [
    {
      name: '2025-06-15-cqlp.mp4',
      sizeBytes: 4_300_000_000,
      modifiedAt: '2025-06-15T19:04:00.000Z',
      projectId: null,
      thumbnailUrl: '/api/sources/thumb?file=2025-06-15-cqlp.mp4',
    },
  ],
  editing: { available: true, cause: null, fstype: '9p', entries: 1 },
}

/** Un serveur réduit aux trois routes de cet écran. */
function server(
  responses: {
    projects?: () => Response
    sources?: () => Response
    /** Une promesse ici sert à retenir la réponse le temps de démonter la page. */
    creation?: () => Response | Promise<Response>
  } = {},
) {
  const calls: string[] = []
  const fake = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url === '/api/sources') return (responses.sources ?? (() => response(SOURCES)))()
    if (url === '/api/projects' && init?.method === 'POST') {
      return (responses.creation ?? (() => response({ projectId: CQLP.id, plan: [] }, 202)))()
    }
    if (url === '/api/projects') return (responses.projects ?? (() => response([])))()
    throw new Error(`Route inattendue : ${url}`)
  })
  vi.stubGlobal('fetch', fake)
  return calls
}

/** Le client est rendu avec l'enveloppe : il survit au démontage de l'écran. */
function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  // Nommée, et non anonyme : `react/display-name` refuse un composant sans nom,
  // et un composant sans nom est aussi une pile de rendu illisible quand un test
  // échoue.
  function Envelope({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return { client, Envelope }
}

function envelope() {
  return harness().Envelope
}

function renderScreen() {
  const { client, Envelope } = harness()
  const view = render(
    <Envelope>
      <LibraryScreen />
    </Envelope>,
  )
  return { client, ...view }
}

async function mount() {
  const rendered = renderScreen()
  await waitFor(() => expect(screen.getByText('2025-06-15-cqlp.mp4')).toBeTruthy())
  return rendered
}

describe('la bibliothèque unifiée', () => {
  it('ne montre qu’une carte pour une émission déjà analysée', async () => {
    // C'est le défaut que cet écran ferme : « Projets » et « Replays »
    // montraient la même émission deux fois, et rien ne disait que c'était la
    // même.
    server({
      projects: () => response([CQLP]),
      sources: () =>
        response({
          ...SOURCES,
          sources: [{ ...SOURCES.sources[0], projectId: CQLP.id }],
        }),
    })
    await mount()

    expect(screen.getAllByText('2025-06-15-cqlp.mp4')).toHaveLength(1)
    expect(screen.getByText('Analysée')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Projets' })).toBeNull()
  })

  it('ne demande jamais l’état d’un projet une requête à la fois', async () => {
    // `GET /api/projects/:id` exécute `readingPresence`, qui sonde le montage 9p
    // avec un délai de garde. Vingt et un appels prendraient les quatre fils du
    // vivier de libuv et figeraient l'analyse en cours.
    const calls = server({ projects: () => response([CQLP]) })
    await mount()

    expect(calls.filter((a) => a.startsWith('GET /api/projects/'))).toEqual([])
  })

  it('donne une carte à un projet dont le replay a disparu du Drive', async () => {
    // Sans elle, tout le travail fait dessus deviendrait inatteignable depuis
    // l'interface, sans qu'aucun écran ne le signale.
    server({ projects: () => response([{ ...CQLP, id: 'perdu', title: 'perdu' }]) })
    await mount()

    expect(screen.getByText('perdu')).toBeTruthy()
    expect(screen.getByText('Orpheline')).toBeTruthy()
  })
})

describe('la création', () => {
  it('crée le projet d’une émission neuve, puis y mène', async () => {
    // La redirection **est** la confirmation : une notification en plus dirait
    // deux fois la même chose.
    const calls = server()
    await mount()

    await userEvent.click(screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ }))

    await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/2025-06-15-cqlp'))
    expect(calls).toContain('POST /api/projects')
  })

  it('marque la source analysée dans le cache, sans redemander le dossier', async () => {
    // **Le `staleTime` de 30 s est un piège ici** : revenir de l'émission dans
    // la demi-minute qui suit rejouait la liste des sources telle qu'elle était
    // avant la création — `projectId: null` —, donc la carte reproposait de
    // lancer l'analyse. Un second clic pendant l'analyse rend alors un 409.
    //
    // On corrige le cache plutôt que de l'invalider : `GET /api/sources` sonde
    // le montage 9p sous délai de garde, et on connaît déjà la réponse.
    const calls = server()
    await mount()

    await userEvent.click(screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ }))

    await waitFor(() =>
      expect(screen.getByRole('link', { name: /2025-06-15-cqlp\.mp4/ })).toHaveProperty(
        'pathname',
        '/projects/2025-06-15-cqlp',
      ),
    )
    expect(calls.filter((a) => a === 'GET /api/sources')).toHaveLength(1)
  })

  it('marque la source même si l’on quitte la bibliothèque avant la réponse', async () => {
    // **Le chemin que les liens d'émission laissent ouvert exprès.** Une
    // création traverse un `lstat` 9p qui peut mettre plusieurs secondes, et on
    // peut très bien partir trier une autre émission pendant ce temps. TanStack
    // n'appelle alors plus les rappels passés à `mutate` — l'observateur est
    // démonté —, et la marque manquerait pendant les trente secondes du
    // `staleTime`, c'est-à-dire exactement la fenêtre du retour.
    let respond: (r: Response) => void = () => {}
    const deferred = new Promise<Response>((resolve) => {
      respond = resolve
    })
    server({ creation: () => deferred })
    const { client, unmount } = await mount()

    await userEvent.click(screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ }))
    unmount()
    respond(response({ projectId: CQLP.id, plan: [] }, 202))

    await waitFor(() =>
      expect(client.getQueryData<SourcesListing>(keySources)?.sources[0]?.projectId).toBe(CQLP.id),
    )
    // Mais on ne ramène personne de force sur un écran qu'il vient de quitter.
    expect(push).not.toHaveBeenCalled()
  })

  it('affiche le message du serveur quand la création échoue, et ne va nulle part', async () => {
    const serverMessage = 'Le dossier des replays ne répond pas. Rouvrir le lecteur côté Windows.'
    server({ creation: () => response({ error: serverMessage }, 503) })
    await mount()

    await userEvent.click(screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(serverMessage))
    expect(push).not.toHaveBeenCalled()
  })

  it('efface l’échec de création quand on rafraîchit la liste', async () => {
    // Sinon le message survit à ce qui l'a causé : sur une source disparue
    // entre l'affichage et le clic, on rafraîchit, la carte s'en va, et l'alerte
    // continue de nommer un fichier qui n'est plus là.
    server({ creation: () => response({ error: 'Aucun replay nommé "vieux.mp4".' }, 404) })
    await mount()

    await userEvent.click(screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: 'Rafraîchir' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

describe('les pannes', () => {
  it('affiche le message du serveur quand les émissions ne se listent pas', async () => {
    server({ sources: () => response({ error: 'REPLAY_DIR est absent.' }, 500) })
    renderScreen()

    await waitFor(() => expect(screen.getByText('REPLAY_DIR est absent.')).toBeTruthy())
  })

  it('ne fabrique aucun état quand la liste des projets ne se charge pas', async () => {
    // **Une liste de projets en panne n'est pas une liste vide.** Le repli sur
    // `[]` faisait passer chaque source portant un `projectId` par
    // `showState(null, true)` : les émissions déjà analysées s'affichaient
    // « Analyse en cours », un état concret déduit d'une absence d'information.
    // (relevé par Copilot)
    server({
      projects: () => response({ error: 'La base ne répond pas.' }, 500),
      sources: () =>
        response({
          ...SOURCES,
          sources: [{ ...SOURCES.sources[0], projectId: CQLP.id }],
        }),
    })
    renderScreen()

    await waitFor(() => expect(screen.getByText('La base ne répond pas.')).toBeTruthy())
    expect(screen.queryByText('Analyse en cours')).toBeNull()
    expect(screen.queryByText('2025-06-15-cqlp.mp4')).toBeNull()
    // **Et surtout pas le diagnostic de montage.** Une liste qu'on ne peut pas
    // construire n'est pas un dossier vide : les replays, eux, se sont chargés.
    // (relevé par Copilot)
    expect(screen.queryByText(/dossier des replays/i)).toBeNull()
    expect(screen.queryByText(/Aucune vidéo/i)).toBeNull()
  })

  it('dit le montage muet quand il n’y a ni replay ni projet', async () => {
    // Le pire cas — montage absent **et** aucun projet — n'affiche alors qu'une
    // phrase et le geste qui la répare.
    server({
      projects: () => response([]),
      sources: () =>
        response({
          sources: [],
          editing: { available: false, cause: 'absent', fstype: null, entries: 0 },
        }),
    })
    renderScreen()

    await waitFor(() =>
      expect(screen.getByText('Le dossier des replays n’existe pas à ce chemin.')).toBeTruthy(),
    )
  })
})

describe('useProjects, le sondage', () => {
  it('redemande la liste tant qu’une analyse tourne', async () => {
    // C'est ce qui rend supportable de lancer une analyse puis d'aller trier une
    // autre émission : l'état arrive tout seul.
    vi.useFakeTimers()
    const fake = vi.fn(async () =>
      response([{ ...CQLP, running: { step: 'transcript', progress: 0.4 } }]),
    )
    vi.stubGlobal('fetch', fake)

    const { result } = renderHook(() => useProjects(), { wrapper: envelope() })
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
    expect(result.current.data).toHaveLength(1)
    expect(fake).toHaveBeenCalledTimes(1)

    await act(async () => void (await vi.advanceTimersByTimeAsync(2_100)))
    expect(fake).toHaveBeenCalledTimes(2)
  })

  it('se tait dès que plus rien ne tourne', async () => {
    // Interroger en permanence une bibliothèque au repos ne renseignerait
    // personne, et le ferait à travers un serveur qui a mieux à faire.
    vi.useFakeTimers()
    const fake = vi.fn(async () => response([CQLP]))
    vi.stubGlobal('fetch', fake)

    renderHook(() => useProjects(), { wrapper: envelope() })
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
    expect(fake).toHaveBeenCalledTimes(1)

    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)))
    expect(fake).toHaveBeenCalledTimes(1)
  })
})
