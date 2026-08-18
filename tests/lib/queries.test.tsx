// @vitest-environment jsdom

/**
 * Ce que ces tests regardent, ce sont les **règles de fraîcheur** — quand
 * redemander quoi —, pas la provenance des données : `@/lib/api` fait son
 * travail pour de vrai ici, seul `fetch` est remplacé.
 *
 * Les deux mutations ajoutées ferment deux parcours orphelins : l'export, qui
 * s'affichait comme une étiquette sans jamais pouvoir être déclenché, et la
 * création d'un projet, qui se faisait en `curl`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExportResult, RunPlan, Réglages } from '@/lib/api'
import {
  cles,
  useArrêter,
  useCreerProjet,
  useExporter,
  useRéglages,
  useÉcrireRéglages,
} from '@/lib/queries'

/** Une réponse HTTP, réduite à ce que `@/lib/api` en lit. */
function reponse(corps: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => corps,
  } as Response
}

function harnais() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const invalide = vi.spyOn(client, 'invalidateQueries')
  const enveloppe = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, invalide, enveloppe }
}

const exportComplet: ExportResult = {
  clip: {
    id: 'c1',
    projectId: 'p1',
    segments: [{ start: 0, end: 20 }],
    ratio: '1:1',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'Un titre',
    description: '',
    status: 'exported',
    pass: 1,
  },
  mp4: 'c1.mp4',
  variant9x16: 'c1-9x16.mp4',
  texts: 'c1.txt',
  skipped: false,
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useExporter', () => {
  it('invalide le clip, parce que l’export ne rend que des noms de fichiers', async () => {
    // `ExportResult` porte des noms ; ce sont les `ClipOutputs` de
    // `GET /api/clips/:id` qui portent les URL lisibles par un `<video>`.
    vi.stubGlobal('fetch', vi.fn(async () => reponse(exportComplet)))
    const { invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useExporter(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ clipId: 'c1' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalide).toHaveBeenCalledWith({ queryKey: cles.clip('c1') })
  })

  it('invalide aussi les listes de candidats, que le statut alimente', async () => {
    // Un export pose `exported`, et ce statut vit dans la même liste que les
    // comptes du fil de tri, la phase du projet et le clip suivant à monter.
    // Sans cette invalidation, la carte reste sur « gardé » tant que la liste
    // est en cache. Par préfixe, faute de connaître le projet ici — et une
    // liste inactive ne se recharge pas, elle est seulement marquée périmée.
    vi.stubGlobal('fetch', vi.fn(async () => reponse(exportComplet)))
    const { invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useExporter(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ clipId: 'c1' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalide).toHaveBeenCalledWith({ queryKey: cles.tousCandidats })
  })

  it('traite `skipped: true` comme un succès', async () => {
    // C'est la réponse la plus fréquente dès qu'on rouvre un clip déjà exporté :
    // rien n'a été refait, tout est en place. La traiter comme une erreur ferait
    // passer un export réussi pour un échec.
    vi.stubGlobal('fetch', vi.fn(async () => reponse({ ...exportComplet, skipped: true })))
    const { enveloppe } = harnais()
    const { result } = renderHook(() => useExporter(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ clipId: 'c1' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.skipped).toBe(true)
    expect(result.current.isError).toBe(false)
  })

  it('ne bronche pas quand la réponse ne porte pas de clip', async () => {
    // Une passe de repérage qui se termine pendant les dix à soixante secondes
    // du rendu réécrit le jeu de clips : `renderClip` prévoit que le clip ait
    // disparu à la relecture, et la route sérialise alors un corps sans ce
    // champ. Lire `clip.status` sans garde y planterait un export réussi.
    const sansClip = { ...exportComplet }
    delete sansClip.clip
    vi.stubGlobal('fetch', vi.fn(async () => reponse(sansClip)))
    const { invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useExporter(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ clipId: 'c1' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.clip).toBeUndefined()
    expect(invalide).toHaveBeenCalledWith({ queryKey: cles.clip('c1') })
  })

  it('remonte l’échec du serveur, avec son message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reponse({ error: 'ffmpeg a rendu 1' }, 500)))
    const { invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useExporter(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ clipId: 'c1' })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('ffmpeg a rendu 1')
    expect(invalide).not.toHaveBeenCalled()
  })
})

describe('useCreerProjet', () => {
  const plan: RunPlan = { projectId: 'p1', plan: ['audio', 'transcript'] }

  it('invalide la liste des projets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reponse(plan, 202)))
    const { invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useCreerProjet(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate('2025-06-15-cqlp.mp4')
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalide).toHaveBeenCalledWith({ queryKey: cles.projets })
  })

  it('rend le plan, et laisse la redirection à l’écran', async () => {
    // La réponse est un 202 : elle confirme que l'analyse est acceptée et
    // lancée, pas qu'elle est faite. Où l'on va ensuite est une décision
    // d'écran, pas de hook.
    vi.stubGlobal('fetch', vi.fn(async () => reponse(plan, 202)))
    const { enveloppe } = harnais()
    const { result } = renderHook(() => useCreerProjet(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate('2025-06-15-cqlp.mp4')
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(plan)
  })

  it('remonte le message du serveur quand le Drive ne répond pas', async () => {
    // Le 503 sur un Drive muet a son propre texte, déjà écrit côté serveur :
    // l'écran le reprend tel quel plutôt que d'en composer un depuis une
    // exception.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reponse({ error: 'le dossier des replays n’est pas monté' }, 503)),
    )
    const { invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useCreerProjet(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate('2025-06-15-cqlp.mp4')
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('le dossier des replays n’est pas monté')
    expect(invalide).not.toHaveBeenCalled()
  })
})

describe('les réglages', () => {
  const réglages: Réglages = {
    selection: {
      minutesParClip: 6,
      fenetresParClip: 2,
      clipsMinimum: 6,
      fenetresMinimum: 10,
      clipsMaximum: 0,
    },
  }

  it('se lisent sans interrogation en boucle', async () => {
    const appel = vi.fn(async () => reponse(réglages))
    vi.stubGlobal('fetch', appel)
    const { enveloppe } = harnais()
    const { result } = renderHook(() => useRéglages(), { wrapper: enveloppe })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(réglages)
    expect(appel).toHaveBeenCalledWith('/api/settings', expect.anything())
  })

  /**
   * **La réponse remplace le cache, elle ne l'invalide pas.** La route rend les
   * réglages *résultants*, champs non touchés compris : invalider ferait une
   * seconde requête pour obtenir exactement le corps qu'on vient de recevoir.
   */
  it('remplacent le cache avec la réponse plutôt que de la redemander', async () => {
    const après: Réglages = { selection: { ...réglages.selection, minutesParClip: 4 } }
    vi.stubGlobal('fetch', vi.fn(async () => reponse(après)))
    const { client, invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useÉcrireRéglages(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ selection: { minutesParClip: 4 } })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(client.getQueryData(cles.reglages)).toEqual(après)
    expect(invalide).not.toHaveBeenCalled()
  })

  /**
   * **Changer un réglage ne recalcule rien** (retour d'usage §6.1). Invalider
   * les projets ou les candidats laisserait croire le contraire : l'écran
   * rechargerait des listes que rien n'a touchées, et l'utilisateur y lirait un
   * effet qui n'existe pas.
   */
  it('n’invalident ni les projets ni les candidats', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reponse(réglages)))
    const { invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useÉcrireRéglages(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ selection: { clipsMaximum: 12 } })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalide).not.toHaveBeenCalled()
  })

  it('remontent le refus du serveur sur une valeur hors bornes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reponse({ error: 'Réglage selection.minutesParClip : un entier supérieur…' }, 400),
      ),
    )
    const { enveloppe } = harnais()
    const { result } = renderHook(() => useÉcrireRéglages(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ selection: { minutesParClip: 0 } })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toContain('Réglage selection.minutesParClip')
  })
})

describe('useArrêter', () => {
  /**
   * **L'état du projet et la bibliothèque s'invalident quoi qu'il arrive.** Les
   * deux n'interrogent en boucle que tant que quelque chose tourne : sans cette
   * invalidation, une liste ouverte dans un autre onglet garderait l'analyse
   * arrêtée pour vivante, et son sondage s'arrêterait sur cet état-là.
   */
  it('invalide le projet et la bibliothèque', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reponse({ arrêtée: true })))
    const { invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useArrêter(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate('p1')
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalide).toHaveBeenCalledWith({ queryKey: cles.projet('p1') })
    expect(invalide).toHaveBeenCalledWith({ queryKey: cles.projets })
    // Les candidats, non : un arrêt ne produit rien, la liste est celle d'avant.
    expect(invalide).not.toHaveBeenCalledWith({ queryKey: cles.candidats('p1') })
  })

  /**
   * `arrêtée: false` n'est pas un échec : rien ne tournait. L'écran n'a rien à
   * dire de plus que ce que l'état rafraîchi montre déjà.
   */
  it('traite « rien ne tournait » comme un succès', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reponse({ arrêtée: false })))
    const { enveloppe } = harnais()
    const { result } = renderHook(() => useArrêter(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate('p1')
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ arrêtée: false })
  })

  /** Et même en échec, l'état du projet se recharge : c'est là qu'on saura. */
  it('invalide aussi quand la requête échoue', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reponse({ error: 'Projet inconnu' }, 404)))
    const { invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useArrêter(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate('p1')
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(invalide).toHaveBeenCalledWith({ queryKey: cles.projet('p1') })
  })
})

describe('les clés', () => {
  it('range chaque liste de candidats sous le préfixe commun', () => {
    // L'invalidation par préfixe de `useExporter` n'est correcte que tant que
    // les deux ne divergent pas : c'est cette ligne qui les tient ensemble.
    expect(cles.candidats('p1').slice(0, cles.tousCandidats.length)).toEqual([
      ...cles.tousCandidats,
    ])
  })
})
