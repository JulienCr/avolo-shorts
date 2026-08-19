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
import { cleSources } from '@/components/sources/use-sources'
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
  title: '2025-06-15-cqlp',
  durationSec: 5_940,
  createdAt: '2025-06-15T19:04:00.000Z',
  running: null,
  error: null,
  stopped: false,
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
  montage: { disponible: true, cause: null, fstype: '9p', entrées: 1 },
}

/** Un serveur réduit aux trois routes de cet écran. */
function serveur(
  reponses: {
    projets?: () => Response
    sources?: () => Response
    /** Une promesse ici sert à retenir la réponse le temps de démonter la page. */
    creation?: () => Response | Promise<Response>
  } = {},
) {
  const appels: string[] = []
  const faux = vi.fn(async (url: string, init?: RequestInit) => {
    appels.push(`${init?.method ?? 'GET'} ${url}`)
    if (url === '/api/sources') return (reponses.sources ?? (() => reponse(SOURCES)))()
    if (url === '/api/projects' && init?.method === 'POST') {
      return (reponses.creation ?? (() => reponse({ projectId: CQLP.id, plan: [] }, 202)))()
    }
    if (url === '/api/projects') return (reponses.projets ?? (() => reponse([])))()
    throw new Error(`Route inattendue : ${url}`)
  })
  vi.stubGlobal('fetch', faux)
  return appels
}

/** Le client est rendu avec l'enveloppe : il survit au démontage de l'écran. */
function harnais() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  // Nommée, et non anonyme : `react/display-name` refuse un composant sans nom,
  // et un composant sans nom est aussi une pile de rendu illisible quand un test
  // échoue.
  function Enveloppe({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return { client, Enveloppe }
}

function enveloppe() {
  return harnais().Enveloppe
}

function poser() {
  const { client, Enveloppe } = harnais()
  const vue = render(
    <Enveloppe>
      <LibraryScreen />
    </Enveloppe>,
  )
  return { client, ...vue }
}

async function monter() {
  const posé = poser()
  await waitFor(() => expect(screen.getByText('2025-06-15-cqlp.mp4')).toBeTruthy())
  return posé
}

describe('la bibliothèque unifiée', () => {
  it('ne montre qu’une carte pour une émission déjà analysée', async () => {
    // C'est le défaut que cet écran ferme : « Projets » et « Replays »
    // montraient la même émission deux fois, et rien ne disait que c'était la
    // même.
    serveur({
      projets: () => reponse([CQLP]),
      sources: () =>
        reponse({
          ...SOURCES,
          sources: [{ ...SOURCES.sources[0], projectId: CQLP.id }],
        }),
    })
    await monter()

    expect(screen.getAllByText('2025-06-15-cqlp.mp4')).toHaveLength(1)
    expect(screen.getByText('Analysée')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Projets' })).toBeNull()
  })

  it('ne demande jamais l’état d’un projet une requête à la fois', async () => {
    // `GET /api/projects/:id` exécute `relevéPrésence`, qui sonde le montage 9p
    // avec un délai de garde. Vingt et un appels prendraient les quatre fils du
    // vivier de libuv et figeraient l'analyse en cours.
    const appels = serveur({ projets: () => reponse([CQLP]) })
    await monter()

    expect(appels.filter((a) => a.startsWith('GET /api/projects/'))).toEqual([])
  })

  it('donne une carte à un projet dont le replay a disparu du Drive', async () => {
    // Sans elle, tout le travail fait dessus deviendrait inatteignable depuis
    // l'interface, sans qu'aucun écran ne le signale.
    serveur({ projets: () => reponse([{ ...CQLP, id: 'perdu', title: 'perdu' }]) })
    await monter()

    expect(screen.getByText('perdu')).toBeTruthy()
    expect(screen.getByText('Orpheline')).toBeTruthy()
  })
})

describe('la création', () => {
  it('crée le projet d’une émission neuve, puis y mène', async () => {
    // La redirection **est** la confirmation : une notification en plus dirait
    // deux fois la même chose.
    const appels = serveur()
    await monter()

    await userEvent.click(screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ }))

    await waitFor(() => expect(pousser).toHaveBeenCalledWith('/projects/2025-06-15-cqlp'))
    expect(appels).toContain('POST /api/projects')
  })

  it('marque la source analysée dans le cache, sans redemander le dossier', async () => {
    // **Le `staleTime` de 30 s est un piège ici** : revenir de l'émission dans
    // la demi-minute qui suit rejouait la liste des sources telle qu'elle était
    // avant la création — `projectId: null` —, donc la carte reproposait de
    // lancer l'analyse. Un second clic pendant l'analyse rend alors un 409.
    //
    // On corrige le cache plutôt que de l'invalider : `GET /api/sources` sonde
    // le montage 9p sous délai de garde, et on connaît déjà la réponse.
    const appels = serveur()
    await monter()

    await userEvent.click(screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ }))

    await waitFor(() =>
      expect(screen.getByRole('link', { name: /2025-06-15-cqlp\.mp4/ })).toHaveProperty(
        'pathname',
        '/projects/2025-06-15-cqlp',
      ),
    )
    expect(appels.filter((a) => a === 'GET /api/sources')).toHaveLength(1)
  })

  it('marque la source même si l’on quitte la bibliothèque avant la réponse', async () => {
    // **Le chemin que les liens d'émission laissent ouvert exprès.** Une
    // création traverse un `lstat` 9p qui peut mettre plusieurs secondes, et on
    // peut très bien partir trier une autre émission pendant ce temps. TanStack
    // n'appelle alors plus les rappels passés à `mutate` — l'observateur est
    // démonté —, et la marque manquerait pendant les trente secondes du
    // `staleTime`, c'est-à-dire exactement la fenêtre du retour.
    let repondre: (r: Response) => void = () => {}
    const differee = new Promise<Response>((resoudre) => {
      repondre = resoudre
    })
    serveur({ creation: () => differee })
    const { client, unmount } = await monter()

    await userEvent.click(screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ }))
    unmount()
    repondre(reponse({ projectId: CQLP.id, plan: [] }, 202))

    await waitFor(() =>
      expect(client.getQueryData<SourcesListing>(cleSources)?.sources[0]?.projectId).toBe(CQLP.id),
    )
    // Mais on ne ramène personne de force sur un écran qu'il vient de quitter.
    expect(pousser).not.toHaveBeenCalled()
  })

  it('affiche le message du serveur quand la création échoue, et ne va nulle part', async () => {
    const duServeur = 'Le dossier des replays ne répond pas. Rouvrir le lecteur côté Windows.'
    serveur({ creation: () => reponse({ error: duServeur }, 503) })
    await monter()

    await userEvent.click(screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(duServeur))
    expect(pousser).not.toHaveBeenCalled()
  })

  it('efface l’échec de création quand on rafraîchit la liste', async () => {
    // Sinon le message survit à ce qui l'a causé : sur une source disparue
    // entre l'affichage et le clic, on rafraîchit, la carte s'en va, et l'alerte
    // continue de nommer un fichier qui n'est plus là.
    serveur({ creation: () => reponse({ error: 'Aucun replay nommé "vieux.mp4".' }, 404) })
    await monter()

    await userEvent.click(screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: 'Rafraîchir' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

describe('les pannes', () => {
  it('affiche le message du serveur quand les émissions ne se listent pas', async () => {
    serveur({ sources: () => reponse({ error: 'REPLAY_DIR est absent.' }, 500) })
    poser()

    await waitFor(() => expect(screen.getByText('REPLAY_DIR est absent.')).toBeTruthy())
  })

  it('dit le montage muet quand il n’y a ni replay ni projet', async () => {
    // Le pire cas — montage absent **et** aucun projet — n'affiche alors qu'une
    // phrase et le geste qui la répare.
    serveur({
      projets: () => reponse([]),
      sources: () =>
        reponse({
          sources: [],
          montage: { disponible: false, cause: 'absent', fstype: null, entrées: 0 },
        }),
    })
    poser()

    await waitFor(() =>
      expect(screen.getByText('Le dossier des replays n’existe pas à ce chemin.')).toBeTruthy(),
    )
  })
})

describe('useProjets, le sondage', () => {
  it('redemande la liste tant qu’une analyse tourne', async () => {
    // C'est ce qui rend supportable de lancer une analyse puis d'aller trier une
    // autre émission : l'état arrive tout seul.
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
