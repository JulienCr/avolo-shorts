// @vitest-environment jsdom

/**
 * L'écran de projet, monté pour de vrai.
 *
 * `layoutProgress` est testée seule ailleurs, et c'est le bon endroit
 * pour l'invariant lui-même. **Mais les trois violations que les relectures ont
 * trouvées étaient dans le raccordement**, pas dans la règle : un panneau qui
 * mange la grille, un squelette qui passe pour une attente de neuf minutes, une
 * erreur qui en efface une autre. Ce fichier monte donc l'écran entier, avec ses
 * requêtes, pour regarder ce qui s'affiche en même temps que quoi.
 *
 * **C'est `ProjectScreen` qu'on monte, pas la route.** La route lit ses `params`
 * par `use()`, et sous `jsdom` une limite de Suspense ainsi tenue ne se relève
 * jamais : la promesse se tient, React ne rejoue pas, et le repli reste seul à
 * l'écran. Mesuré sur un composant de trois lignes avant de conclure.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CandidateClip, ProjectStatus } from '@/lib/api'
import { defaultPlatformAvailability } from '@/core/publication'
import { lireSessionReview, writeSessionReview } from '@/components/review/session'
import { installPointerEventPolyfill } from '../../fixtures/pointer-event'

// **`PointerEvent` n'existe pas sous `jsdom`.** Les cases de Base UI
// (sélection groupée, `PublishDialog`) en dispatchent un synthétique à la
// souris ; voir `tests/fixtures/pointer-event.ts`.
installPointerEventPolyfill()

// Le routeur n'existe pas hors d'une application Next montée. On ne teste pas
// la navigation ici — la vue dans l'URL a son propre test — mais l'écran ne
// peut pas se rendre sans ces deux hooks.
const replace = vi.fn()
let request = ''
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replace, push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(request),
}))

const { ProjectScreen } = await import('@/components/review/project-screen')
const { TooltipProvider } = await import('@/components/ui/tooltip')

function state(fields: Partial<ProjectStatus> = {}): ProjectStatus {
  return {
    project: { id: 'p1', title: 'La scène du 15 juin', durationSec: 5940, createdAt: '2026-08-18' },
    steps: {
      audio: true,
      transcript: true,
      correction: false,
      candidates: false,
      proxy: false,
      analysis: false,
      renders: false,
    },
    running: { step: 'candidates', progress: 0.5 },
    error: null,
    warning: null,
    selectionReport: null,
    stopped: false,
    sizeBytes: 4_300_000_000,
    everRan: true,
    ...fields,
  }
}

function candidate(n: number): CandidateClip {
  return {
    id: `c${n}`,
    projectId: 'p1',
    segments: [{ start: n * 100, end: n * 100 + 30 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: `Extrait ${n}`,
    description: '',
    status: 'candidate',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    preview: 'Ce qui se dit.',
    thumbnailUrl: null,
  }
}

/**
 * Le serveur, réduit à ses deux routes. `null` fait échouer la route concernée
 * — c'est ainsi qu'on distingue les origines d'erreur.
 */
function serve(project: ProjectStatus | null, candidates: CandidateClip[] | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      // `ReviewFeed` porte `PublishDialog`, qui interroge ces deux routes de
      // publication à chaque montage — indépendantes du projet et des
      // candidats de ce test.
      if (path.includes('/publication/availability')) {
        return { ok: true, status: 200, statusText: '', json: async () => defaultPlatformAvailability() } as Response
      }
      const [body, ok] = path.endsWith('/candidates')
        ? [candidates ?? { error: 'liste indisponible' }, candidates !== null]
        : [project ?? { error: 'projet introuvable' }, project !== null]
      return {
        ok,
        status: ok ? 200 : 500,
        statusText: '',
        json: async () => body,
      } as Response
    }),
  )
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const envelope = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  )
  return render(<ProjectScreen id="p1" />, { wrapper: envelope })
}

beforeEach(() => {
  replace.mockClear()
  request = ''
})

afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('l’écran de projet', () => {
  it('donne la page au panneau tant qu’il n’y a rien à trier', async () => {
    serve(state(), [])
    mount()

    await waitFor(() => expect(screen.getByText(/l’analyse est en cours/i)).toBeTruthy())
    expect(screen.queryByRole('tab', { name: /à trier/i })).toBeNull()
  })

  // Point A.3 du retour d'usage : un projet créé sans lancement (`everRan:
  // false`) affiche « Commencer l'analyse », pas « Reprendre l'analyse » — les
  // deux boutons visent les mêmes cibles, mais le libellé qui ment invite à
  // « reprendre » un travail qui n'a jamais commencé.
  it('propose « Commencer l’analyse » sur un projet créé sans lancement', async () => {
    serve(state({ running: null, everRan: false }), [])
    mount()

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'L’analyse n’a pas encore commencé.' })).toBeTruthy(),
    )
    expect(screen.getByRole('button', { name: /commencer l’analyse/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /reprendre l’analyse/i })).toBeNull()
  })

  it('rend la page à la grille dès qu’il y a quelque chose à trier', async () => {
    // Régime 2 : les propositions arrivent avant les images, et le panneau se
    // replie dans la barre d'application au lieu de manger la grille.
    serve(state({ steps: { ...state().steps, candidates: true }, running: { step: 'proxy', progress: 0.3 } }), [
      candidate(1),
    ])
    mount()

    await waitFor(() => expect(screen.getByRole('article', { name: 'Extrait 1' })).toBeTruthy())
    expect(screen.queryByText(/l’analyse est en cours/i)).toBeNull()
    // La bande, elle, reste : ce qui tourne doit rester lisible.
    expect(screen.getByRole('progressbar')).toBeTruthy()
  })

  it('offre la reprise sur un projet à l’arrêt dont il manque une étape', async () => {
    // **La même impasse que celle du panneau, mais avec une grille devant.** Un
    // redémarrage du serveur après le repérage et avant le proxy laisse
    // `running` à nul et la liste pleine : la grille passe donc devant — c'est
    // l'invariant —, mais la seule action offerte était « relancer le repérage »,
    // qui ne vise que `candidates` et ne reconstruit jamais le proxy. Le montage
    // restait désactivé sans aucun moyen d'avancer. (relevé par Codex)
    serve(
      state({
        steps: { ...state().steps, candidates: true, proxy: false, analysis: false },
        running: null,
      }),
      [candidate(1)],
    )
    mount()

    await waitFor(() => expect(screen.getByRole('article', { name: 'Extrait 1' })).toBeTruthy())
    expect(screen.getByRole('button', { name: /reprendre l’analyse/i })).toBeTruthy()
  })

  it('n’offre pas la reprise quand tout est là', async () => {
    // Un bouton qui ne reconstruit rien invite à un geste sans effet : le plan
    // reviendrait vide, et l'écran aurait promis du travail qui n'a pas lieu.
    serve(
      state({
        steps: { ...state().steps, candidates: true, proxy: true, analysis: true },
        running: null,
      }),
      [candidate(1)],
    )
    mount()

    await waitFor(() => expect(screen.getByRole('article', { name: 'Extrait 1' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /reprendre l’analyse/i })).toBeNull()
  })

  it('affiche le bandeau d’échec même quand le repérage a réussi (#140)', async () => {
    // **La régression que ce groupe corrige.** `candidates` tourne avant
    // `proxy`/`analysis` sur `TARGETS_INITIAL` (`src/server/run.ts`) : une
    // vraie panne de l'un des deux, survenant après un repérage réussi,
    // laissait `steps.candidates === true` — la garde d'avant cette PR
    // masquait alors le bandeau, alors que `error` porte une vraie panne de
    // pipeline, pas l'avertissement toléré de la correction (celui-là vit
    // dans `warning`, testé plus bas).
    serve(
      state({
        steps: { ...state().steps, candidates: true, proxy: false, analysis: false },
        running: null,
        error: 'ffmpeg a rendu 1',
      }),
      [candidate(1)],
    )
    mount()

    await waitFor(() => expect(screen.getByText('La dernière analyse a échoué.')).toBeTruthy())
    expect(screen.getByText('ffmpeg a rendu 1')).toBeTruthy()
  })

  it('affiche l’avertissement de correction tolérée, distinct de l’échec (#137)', async () => {
    serve(
      state({
        steps: { ...state().steps, candidates: true, proxy: true, analysis: true },
        running: null,
        error: null,
        warning: 'La correction automatique du transcript a échoué : modèle injoignable.',
      }),
      [candidate(1)],
    )
    mount()

    await waitFor(() =>
      expect(screen.getByText('La correction automatique du transcript a échoué.')).toBeTruthy(),
    )
    expect(screen.getByText(/modèle injoignable/)).toBeTruthy()
    expect(screen.queryByText('La dernière analyse a échoué.')).toBeNull()
  })

  it('reprend la vue de la session quand l’URL n’en nomme aucune', async () => {
    // Retour d'un clip par le fil d'Ariane : `chemin` rend `linkProject`, une URL
    // nue. Sans ce rattrapage la vue retombe sur « à trier », la carte gardée
    // n'y est pas, et le focus mémorisé n'a nulle part où se poser — le
    // round-trip que la conception décrit ne marchait pas. (relevé par Codex)
    writeSessionReview('p1', { returning: true, view: 'gardes', card: 'c1' })
    serve(state({ steps: { ...state().steps, candidates: true }, running: null }), [candidate(1)])
    mount()

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/projects/p1?vue=gardes', { scroll: false }))
  })

  it('recopie la vue de l’URL en session, pour le retour', async () => {
    // Sans cette écriture, le repli n'aurait jamais rien à lire : c'est la
    // moitié qu'on oublie quand on ajoute une restauration.
    request = 'vue=gardes'
    serve(state({ steps: { ...state().steps, candidates: true }, running: null }), [
      { ...candidate(1), status: 'kept' },
    ])
    mount()

    await waitFor(() => expect(lireSessionReview('p1').view).toBe('gardes'))
    // Et l'URL qui nomme sa vue reste souveraine : aucun rattrapage.
    expect(replace).not.toHaveBeenCalled()
  })

  it('ne laisse pas un projet introuvable sur un squelette éternel', async () => {
    // Troisième origine d'erreur, distincte des deux autres : ce n'est ni
    // l'analyse qui a échoué ni la liste qui ne charge pas, c'est l'état du
    // projet lui-même.
    serve(null, [])
    mount()

    await waitFor(() => expect(screen.getByText(/ne se charge pas/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /réessayer/i })).toBeTruthy()
  })

  it('laisse trier ce qui est chargé même si l’état du projet manque', async () => {
    // L'invariant : la phase choisit ce que l'écran met en avant, elle ne retire
    // jamais ce qui existe. Une requête d'état en échec ne doit pas emporter une
    // liste parfaitement utilisable.
    serve(null, [candidate(1)])
    mount()

    await waitFor(() => expect(screen.getByRole('article', { name: 'Extrait 1' })).toBeTruthy())
    expect(screen.getByText(/ne se charge pas/i)).toBeTruthy()
  })

  it('ne présente pas une liste inconnue comme une liste vide', async () => {
    // Le bandeau dit qu'on n'a pas pu charger les propositions ; « aucune
    // proposition » juste en dessous dirait le contraire. (relevé par Copilot)
    serve(state({ steps: { ...state().steps, candidates: true }, running: null }), null)
    mount()

    await waitFor(() => expect(screen.getByText(/ne se chargent pas/i)).toBeTruthy())
    expect(screen.queryByText(/aucune proposition/i)).toBeNull()
  })

  it('n’impose pas la vue mémorisée à une visite ordinaire', async () => {
    // La bibliothèque mène au projet par la même URL nue que le fil d'Ariane
    // d'un clip : sans marque de retour, on ne les distingue pas.
    writeSessionReview('p1', { view: 'gardes', card: 'c1' })
    serve(state({ steps: { ...state().steps, candidates: true }, running: null }), [candidate(1)])
    mount()

    await waitFor(() => expect(screen.getByRole('article', { name: 'Extrait 1' })).toBeTruthy())
    expect(replace).not.toHaveBeenCalled()
  })

  it('affiche les deux origines d’erreur à la fois', async () => {
    // « La seconde n'efface pas la première. »
    serve(state({ steps: { ...state().steps, candidates: true }, running: null, error: 'ffmpeg a rendu 1' }), null)
    mount()

    await waitFor(() => expect(screen.getByText('ffmpeg a rendu 1')).toBeTruthy())
    expect(screen.getByText(/les propositions ne se chargent pas/i)).toBeTruthy()
  })

  it('garde le lecteur quand la liste des propositions ne se charge pas', async () => {
    // **Le lecteur ne dépend pas des candidats.** Il vivait derrière la même
    // garde que le fil de tri, si bien qu'un `GET /candidates` en échec
    // l'emportait alors que le proxy et l'état du projet étaient parfaitement
    // disponibles. Le fil, lui, reste absent — une liste qui n'a pas pu se
    // charger n'est pas une liste vide. (relevé par Copilot)
    serve(
      state({ steps: { ...state().steps, candidates: true, proxy: true }, running: null }),
      null,
    )
    mount()

    await waitFor(() => expect(screen.getByTestId('show-player')).toBeTruthy())
    expect(screen.getByText(/les propositions ne se chargent pas/i)).toBeTruthy()
    expect(screen.queryByTestId('counts')).toBeNull()
  })

  it('publie plusieurs clips groupés, avec `force`, et affiche un échec partiel', async () => {
    // **Le chemin de publication groupée n'était exercé par aucun test
    // d'écran** : deux clips sélectionnés, un déjà publié sur Instagram (donc
    // `force` requis), le second en échec de connecteur — la modale doit
    // regrouper les plateformes par clip, transmettre `force`, et l'échec de
    // c2 ne doit ni empêcher c1 de partir ni disparaître en silence. (relevé
    // par Copilot)
    request = 'vue=gardes'
    const clips = [
      { ...candidate(1), status: 'exported' as const },
      { ...candidate(2), status: 'exported' as const },
    ]
    const availability = { ...defaultPlatformAvailability(), instagram: { available: true as const } }
    const publishCalls: { clipId: string; body: unknown }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        if (path.includes('/publication/availability')) {
          return { ok: true, status: 200, statusText: '', json: async () => availability } as Response
        }
        if (path.endsWith('/candidates')) {
          return { ok: true, status: 200, statusText: '', json: async () => clips } as Response
        }
        if (path.endsWith('/api/projects/p1')) {
          return {
            ok: true,
            status: 200,
            statusText: '',
            json: async () => state({ steps: { ...state().steps, candidates: true }, running: null }),
          } as Response
        }
        const publications = path.match(/\/api\/clips\/(c\d)\/publications$/)
        if (publications) {
          const clipId = publications[1]
          // c1 est déjà publié sur Instagram : le seul moyen de le publier à
          // nouveau est de cocher « republier explicitement », qui pose
          // `force`.
          const rows =
            clipId === 'c1'
              ? [
                  {
                    clipId,
                    platform: 'instagram',
                    status: 'published',
                    remoteId: 'r1',
                    remoteUrl: 'https://instagram.test/p/1',
                    requestId: null,
                    error: null,
                    publishedFingerprint: null,
                    createdAt: 0,
                    updatedAt: 0,
                  },
                ]
              : []
          return { ok: true, status: 200, statusText: '', json: async () => ({ publications: rows }) } as Response
        }
        const publish = path.match(/\/api\/clips\/(c\d)\/publish$/)
        if (publish) {
          const clipId = publish[1]
          const body: unknown = JSON.parse((init?.body as string) ?? '{}')
          publishCalls.push({ clipId, body })
          if (clipId === 'c2') {
            return {
              ok: false,
              status: 502,
              statusText: '',
              json: async () => ({ error: 'Upload Post a répondu 502 : indisponible.' }),
            } as Response
          }
          return {
            ok: true,
            status: 200,
            statusText: '',
            json: async () => ({
              publications: [
                {
                  clipId,
                  platform: 'instagram',
                  status: 'in_progress',
                  remoteId: null,
                  remoteUrl: null,
                  requestId: 'req1',
                  error: null,
                  publishedFingerprint: null,
                  createdAt: 0,
                  updatedAt: 0,
                },
              ],
            }),
          } as Response
        }
        return { ok: false, status: 404, statusText: '', json: async () => ({ error: 'route inconnue' }) } as Response
      }),
    )
    mount()

    await waitFor(() => expect(screen.getByRole('article', { name: 'Extrait 1' })).toBeTruthy())

    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: /Sélectionner « Extrait 1 »/ }))
    await user.click(screen.getByRole('checkbox', { name: /Sélectionner « Extrait 2 »/ }))
    fireEvent.click(screen.getByRole('button', { name: /Publier 2 clips/ }))

    // c1 est déjà publié sur Instagram : la seule plateforme disponible n'est
    // donc pas cochée par défaut (issue #97) tant que « republier
    // explicitement » ne l'est pas.
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Instagram' })).toBeTruthy())
    // Déjà `published` chez c1 : pas coché par défaut (issue #97).
    expect(screen.getByRole('checkbox', { name: 'Instagram' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Instagram' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Republier explicitement/ }))
    // `Suivant` reste désactivé tant que les enregistrements des deux clips
    // n'ont pas répondu (`recordsLoading`).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Suivant' })).not.toHaveProperty('disabled', true))
    fireEvent.click(screen.getByRole('button', { name: 'Suivant' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer et publier' }))

    await waitFor(() =>
      expect(screen.getByText('La publication groupée a rencontré une erreur.')).toBeTruthy(),
    )
    expect(screen.getByText(/Upload Post a répondu 502/)).toBeTruthy()

    // Les deux clips sont bien partis, groupés par clip. `force` ne vaut
    // `true` que pour c1, le seul déjà publié sur Instagram — c2 ne doit pas
    // perdre sa protection contre les doublons pour une plateforme qu'il
    // n'a jamais visée. (relevé par Copilot, passe 3)
    expect(publishCalls.map((c) => c.clipId).sort()).toEqual(['c1', 'c2'])
    const byClipId = Object.fromEntries(publishCalls.map((c) => [c.clipId, c.body]))
    expect(byClipId.c1).toMatchObject({ platforms: ['instagram'], force: true })
    expect(byClipId.c2).toMatchObject({ platforms: ['instagram'], force: false })
  })

  it('porte une seule région d’annonce, et polie', async () => {
    serve(state(), [])
    mount()

    // Muette d'abord — on ne sait rien —, puis un seul message, et un seul
    // endroit d'où il vienne.
    expect(screen.getByTestId('announcement').textContent).toBe('')
    await waitFor(() => expect(screen.getByTestId('announcement').textContent).toContain('Repérage'))
    expect(document.querySelectorAll('[aria-live="polite"]').length).toBe(1)
  })
})
