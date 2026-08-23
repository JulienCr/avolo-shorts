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

import { HOOK_DEFAULTS } from '@/lib/api'
import type { ClipDetail, ExportResult, PatchClipResult, RunPlan, Settings } from '@/lib/api'
import {
  keys,
  useCreateProject,
  useExporter,
  usePatchClip,
  useRegenerateHook,
  useSaveSettings,
  useSettings,
  useStopAnalysis,
} from '@/lib/queries'
import { framing, shot } from '../fixtures/framing'

/** Une réponse HTTP, réduite à ce que `@/lib/api` en lit. */
function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
  } as Response
}

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const invalid = vi.spyOn(client, 'invalidateQueries')
  const envelope = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, invalid, envelope }
}

const exportComplete: ExportResult = {
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
    hookText: '',
    hookBadge: '',
    hookStyle: {},
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
    vi.stubGlobal('fetch', vi.fn(async () => response(exportComplete)))
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useExporter(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate({ clipId: 'c1' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.clip('c1') })
  })

  it('invalide aussi les listes de candidats, que le statut alimente', async () => {
    // Un export pose `exported`, et ce statut vit dans la même liste que les
    // comptes du fil de tri, la phase du projet et le clip suivant à monter.
    // Sans cette invalidation, la carte reste sur « gardé » tant que la liste
    // est en cache. Par préfixe, faute de connaître le projet ici — et une
    // liste inactive ne se recharge pas, elle est seulement marquée périmée.
    vi.stubGlobal('fetch', vi.fn(async () => response(exportComplete)))
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useExporter(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate({ clipId: 'c1' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.tousCandidats })
  })

  it('traite `skipped: true` comme un succès', async () => {
    // C'est la réponse la plus fréquente dès qu'on rouvre un clip déjà exporté :
    // rien n'a été refait, tout est en place. La traiter comme une erreur ferait
    // passer un export réussi pour un échec.
    vi.stubGlobal('fetch', vi.fn(async () => response({ ...exportComplete, skipped: true })))
    const { envelope } = harness()
    const { result } = renderHook(() => useExporter(), { wrapper: envelope })

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
    const withoutClip = { ...exportComplete }
    delete withoutClip.clip
    vi.stubGlobal('fetch', vi.fn(async () => response(withoutClip)))
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useExporter(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate({ clipId: 'c1' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.clip).toBeUndefined()
    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.clip('c1') })
  })

  it('remonte l’échec du serveur, avec son message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'ffmpeg a rendu 1' }, 500)))
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useExporter(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate({ clipId: 'c1' })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('ffmpeg a rendu 1')
    expect(invalid).not.toHaveBeenCalled()
  })
})

describe('useRegenerateHook', () => {
  const regenerated: ExportResult['clip'] = {
    id: 'c1',
    projectId: 'p1',
    segments: [{ start: 0, end: 20 }],
    ratio: '1:1',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'Un titre',
    description: '',
    status: 'kept',
    pass: 1,
    hookText: 'Une accroche du modèle',
    hookBadge: 'DÉFI 10',
    hookStyle: {},
  }

  it('fusionne hookText et hookBadge, rien d’autre', async () => {
    // La règle documentée au-dessus de `useRegenerateHook` : écraser
    // `detail.clip` en entier remettrait en place les champs qu'un `PATCH`
    // concurrent a fait avancer pendant l'appel LLM.
    vi.stubGlobal('fetch', vi.fn(async () => response({ clip: regenerated })))
    const { client, envelope } = harness()
    client.setQueryData<ClipDetail>(keys.clip('c1'), {
      clip: { ...regenerated, hookText: '', hookBadge: '', title: 'Titre concurrent' },
      project: { id: 'p1', title: 'La scène du 15 juin', durationSec: 5940, createdAt: '2026-06-15T10:00:00Z' },
      lines: [],
      proxyUrl: null,
      outputs: { mp4Url: null, mp4Due: true, variant9x16Url: null, variant9x16Due: true, textsUrl: null },
      framing: { ratio: '1:1', shots: [], rejectedOverrides: [], origin: 'computed' },
    })
    const { result } = renderHook(() => useRegenerateHook(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate('c1')
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const detail = client.getQueryData<ClipDetail>(keys.clip('c1'))
    expect(detail?.clip.hookText).toBe('Une accroche du modèle')
    expect(detail?.clip.hookBadge).toBe('DÉFI 10')
    expect(detail?.clip.title).toBe('Titre concurrent')
  })

  /**
   * **Relevé par Copilot sur la PR #121.** La régénération peut désormais
   * périmer un export (`discardRenderStale`) : le statut peut redescendre
   * d'`exported` à `kept`, et les sorties disparaître. La fusion ci-dessus ne
   * porte que `hookText`/`hookBadge`, donc c'est cette invalidation qui relit
   * le statut et les sorties à jour.
   */
  it('invalide le clip et la liste des candidats, que le statut et les sorties peuvent avoir changé', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ clip: regenerated })))
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useRegenerateHook(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate('c1')
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.clip('c1') })
    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.candidats('p1') })
  })
})

describe('usePatchClip', () => {
  const clip: ExportResult['clip'] = {
    id: 'c1',
    projectId: 'p1',
    segments: [{ start: 0, end: 20 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'Un titre',
    description: '',
    status: 'kept',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
  }

  const detail = (framing: ClipDetail['framing']): ClipDetail => ({
    clip: clip!,
    project: { id: 'p1', title: 'p1', durationSec: 60, createdAt: '' },
    lines: [],
    proxyUrl: null,
    outputs: { mp4Url: null, mp4Due: true, variant9x16Url: null, variant9x16Due: true, textsUrl: null },
    framing,
  })

  /**
   * **Le cadrage se recalcule sur les segments et n'est pas stocké**, donc
   * retirer un passage peut le changer sans qu'aucun geste de cadrage n'ait eu
   * lieu. Le serveur le renvoie sur chaque `PATCH` exprès ; ne pas l'adopter
   * laisserait le rectangle, l'aperçu et le panneau d'export sur le cadrage
   * d'avant la coupe jusqu'à la prochaine navigation — pendant que l'export
   * utiliserait déjà le nouveau. Le publier sans l'adopter déplace le mensonge
   * au lieu de le refermer. (relevé par Codex)
   */
  it('adopte le cadrage que le serveur renvoie, pas seulement le clip', async () => {
    const { client, envelope } = harness()
    const before = framing({ ratio: '16:9', shots: [shot(0, 20, '16:9', 0.5)] })
    const after = framing({ ratio: '1:1', shots: [shot(0, 12, '1:1', 0.3)] })
    client.setQueryData<ClipDetail>(keys.clip('c1'), detail(before))

    const patchResult: PatchClipResult = {
      applied: true,
      clip: { ...clip!, segments: [{ start: 0, end: 12 }] },
      outputs: { mp4Url: null, mp4Due: true, variant9x16Url: null, variant9x16Due: false, textsUrl: null },
      framing: after,
      seq: 1,
    }
    vi.stubGlobal('fetch', vi.fn(async () => response(patchResult)))

    const { result } = renderHook(() => usePatchClip(), { wrapper: envelope })
    await act(async () => {
      await result.current.mutateAsync({
        clipId: 'c1',
        projectId: 'p1',
        patch: { segments: [{ start: 0, end: 12 }] },
      })
    })

    const cache = client.getQueryData<ClipDetail>(keys.clip('c1'))
    expect(cache?.framing).toEqual(after)
    expect(cache?.clip.segments).toEqual([{ start: 0, end: 12 }])
  })

  /**
   * **Le même geste que `applied` soit vrai ou faux.** Refusée, l'écriture rend
   * le clip *gagnant* et le cadrage qui va avec : c'est l'état de la base, et
   * c'est le seul par lequel l'écran peut se remettre d'accord.
   */
  it('adopte aussi le cadrage d’une écriture écartée', async () => {
    const { client, envelope } = harness()
    const before = framing({ ratio: '16:9', shots: [shot(0, 20, '16:9', 0.5)] })
    const winner = framing({ ratio: '4:5', shots: [shot(0, 20, '4:5', 0.7)] })
    client.setQueryData<ClipDetail>(keys.clip('c1'), detail(before))

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({
          applied: false,
          clip,
          outputs: { mp4Url: null, mp4Due: true, variant9x16Url: null, variant9x16Due: true, textsUrl: null },
          framing: winner,
          seq: 9,
        } satisfies PatchClipResult),
      ),
    )

    const { result } = renderHook(() => usePatchClip(), { wrapper: envelope })
    await act(async () => {
      await result.current.mutateAsync({ clipId: 'c1', projectId: 'p1', patch: { cropX: 0.1 } })
    })

    expect(client.getQueryData<ClipDetail>(keys.clip('c1'))?.framing).toEqual(winner)
  })
})

describe('useCreateProject', () => {
  const plan: RunPlan = { projectId: 'p1', shot: ['audio', 'transcript'] }

  it('invalide la liste des projets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(plan, 202)))
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useCreateProject(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate('2025-06-15-cqlp.mp4')
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.projets })
  })

  it('rend le plan, et laisse la redirection à l’écran', async () => {
    // La réponse est un 202 : elle confirme que l'analyse est acceptée et
    // lancée, pas qu'elle est faite. Où l'on va ensuite est une décision
    // d'écran, pas de hook.
    vi.stubGlobal('fetch', vi.fn(async () => response(plan, 202)))
    const { envelope } = harness()
    const { result } = renderHook(() => useCreateProject(), { wrapper: envelope })

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
      vi.fn(async () => response({ error: 'le dossier des replays n’est pas monté' }, 503)),
    )
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useCreateProject(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate('2025-06-15-cqlp.mp4')
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('le dossier des replays n’est pas monté')
    expect(invalid).not.toHaveBeenCalled()
  })
})

describe('les réglages', () => {
  const settings: Settings = {
    selection: {
      minutesPerClip: 6,
      windowsPerClip: 2,
      minimumClips: 6,
      minimumWindows: 10,
      maximumClips: 0,
    },
    ai: {
      selectionProvider: 'gemini',
      selectionModel: 'gemini-3.1-flash-lite',
      correctionProvider: 'gemini',
      correctionModel: 'gemini-3.1-flash-lite',
      hookProvider: 'gemini',
      hookModel: 'gemini-3.1-flash-lite',
      ollamaBaseUrl: '',
    },
    ingestion: { copySourceLocally: true },
    hook: { ...HOOK_DEFAULTS },
  }

  it('se lisent sans interrogation en boucle', async () => {
    const call = vi.fn(async () => response(settings))
    vi.stubGlobal('fetch', call)
    const { envelope } = harness()
    const { result } = renderHook(() => useSettings(), { wrapper: envelope })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(settings)
    expect(call).toHaveBeenCalledWith('/api/settings', expect.anything())
  })

  /**
   * **La réponse remplace le cache, elle ne l'invalide pas.** La route rend les
   * réglages *résultants*, champs non touchés compris : invalider ferait une
   * seconde requête pour obtenir exactement le corps qu'on vient de recevoir.
   */
  it('remplacent le cache avec la réponse plutôt que de la redemander', async () => {
    const after: Settings = {
      selection: { ...settings.selection, minutesPerClip: 4 },
      ai: { ...settings.ai },
      ingestion: { ...settings.ingestion },
      hook: { ...settings.hook },
    }
    vi.stubGlobal('fetch', vi.fn(async () => response(after)))
    const { client, invalid, envelope } = harness()
    const { result } = renderHook(() => useSaveSettings(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate({ selection: { minutesPerClip: 4 } })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(client.getQueryData(keys.settings)).toEqual(after)
    expect(invalid).not.toHaveBeenCalled()
  })

  /**
   * **Changer un réglage ne recalcule rien** (retour d'usage §6.1). Invalider
   * les projets ou les candidats laisserait croire le contraire : l'écran
   * rechargerait des listes que rien n'a touchées, et l'utilisateur y lirait un
   * effet qui n'existe pas.
   */
  it('n’invalident ni les projets ni les candidats', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(settings)))
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useSaveSettings(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate({ selection: { maximumClips: 12 } })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalid).not.toHaveBeenCalled()
  })

  it('remontent le refus du serveur sur une valeur hors bornes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({ error: 'Réglage selection.minutesPerClip : un entier supérieur…' }, 400),
      ),
    )
    const { envelope } = harness()
    const { result } = renderHook(() => useSaveSettings(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate({ selection: { minutesPerClip: 0 } })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toContain('Réglage selection.minutesPerClip')
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
    vi.stubGlobal('fetch', vi.fn(async () => response({ stopped: true })))
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useStopAnalysis(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate('p1')
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.projet('p1') })
    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.projets })
    // Les candidats, non : un arrêt ne produit rien, la liste est celle d'avant.
    expect(invalid).not.toHaveBeenCalledWith({ queryKey: keys.candidats('p1') })
  })

  /**
   * `arrêtée: false` n'est pas un échec : rien ne tournait. L'écran n'a rien à
   * dire de plus que ce que l'état rafraîchi montre déjà.
   */
  it('traite « rien ne tournait » comme un succès', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ stopped: false })))
    const { envelope } = harness()
    const { result } = renderHook(() => useStopAnalysis(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate('p1')
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ stopped: false })
  })

  /** Et même en échec, l'état du projet se recharge : c'est là qu'on saura. */
  it('invalide aussi quand la requête échoue', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'Projet inconnu' }, 404)))
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useStopAnalysis(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate('p1')
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.projet('p1') })
  })
})

describe('les clés', () => {
  it('range chaque liste de candidats sous le préfixe commun', () => {
    // L'invalidation par préfixe de `useExporter` n'est correcte que tant que
    // les deux ne divergent pas : c'est cette ligne qui les tient ensemble.
    expect(keys.candidats('p1').slice(0, keys.tousCandidats.length)).toEqual([
      ...keys.tousCandidats,
    ])
  })
})
