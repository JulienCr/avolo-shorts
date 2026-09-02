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
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_DESCRIPTION_FOOTER, DEFAULT_SCHEDULE_HOURS, FRAMING_SETTINGS_DEFAULTS, HOOK_DEFAULTS } from '@/lib/api'
import type { Clip, ClipDetail, ExportResult, PatchClipResult, RunPlan, Settings } from '@/lib/api'
import {
  keys,
  useClip,
  useClipRevision,
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
    footer: true,
    title: 'Un titre',
    description: '',
    status: 'exported',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
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
    footer: true,
    title: 'Un titre',
    description: '',
    status: 'kept',
    pass: 1,
    hookText: 'Une accroche du modèle',
    hookBadge: 'DÉFI 10',
    hookStyle: {},
    framingStyle: {},
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
    footer: true,
    title: 'Un titre',
    description: '',
    status: 'kept',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
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

  /**
   * **Le vrai mécanisme de l'issue #252 : deux écritures sur le *même* champ,
   * pas deux champs différents.** `useStyleWrites` (`src/components/clip/
   * style-writes.ts`) construit chaque patch de style en fusionnant sur
   * `base.current`, mis à jour de façon synchrone à chaque geste — donc le
   * second geste envoie toujours la fusion cumulative, `splitMinShotMs`
   * compris, sans jamais redemander l'ancien. Si le premier reprend après et
   * écrit sans relire l'état, son `...patch` ne porte que sa propre valeur et
   * remplace `framingStyle` en bloc, effaçant ce que le second venait
   * d'ajouter.
   */
  it('garde la fusion cumulative du second geste sur le même champ', async () => {
    const id = 'c-252-same-field'
    const { client, envelope } = harness()
    const before = framing({ ratio: '16:9', shots: [shot(0, 20, '16:9', 0.5)] })
    client.setQueryData<ClipDetail>(keys.clip(id), detail(before))

    let resolveFirstCancel!: () => void
    const firstCancelPending = new Promise<void>((resolve) => {
      resolveFirstCancel = resolve
    })
    // `mockImplementationOnce` n'intercepte que le tout premier appel de
    // `cancelQueries`, tous gestes confondus : celui du premier geste sur les
    // candidats. Son second appel, sur le clip, tourne avec l'implémentation
    // réelle une fois repris (après `resolveFirstCancel()`) — un seul délai
    // suffit à tenir le premier geste suspendu le temps que le second, qui
    // n'a plus rien à annuler, le dépasse et écrive le cache.
    const cancelSpy = vi.spyOn(client, 'cancelQueries')
    cancelSpy.mockImplementationOnce(() => firstCancelPending)

    // La valeur gagnante, telle que `useStyleWrites` l'aurait construite pour
    // le second geste : `base.current` portait déjà `splitMinShotMs` au
    // moment de ce commit-ci.
    const cumulative = { splitMinShotMs: 400, sizeFloorPermille: 120 }
    const winner: PatchClipResult = {
      applied: true,
      clip: { ...clip!, framingStyle: cumulative },
      outputs: { mp4Url: null, mp4Due: true, variant9x16Url: null, variant9x16Due: true, textsUrl: null },
      framing: before,
      seq: 2,
    }
    // Le serveur a déjà appliqué le second geste sur ce même champ quand le
    // premier arrive : il l'écarte et rend le clip gagnant, sur le modèle du
    // test « adopte aussi le cadrage d'une écriture écartée » ci-dessus.
    const discarded: PatchClipResult = { ...winner, applied: false }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string)
        const isSecondGesture = 'sizeFloorPermille' in (body.framingStyle ?? {})
        return response(isSecondGesture ? winner : discarded)
      }),
    )

    const { result } = renderHook(() => usePatchClip(), { wrapper: envelope })

    let firstPromise!: Promise<PatchClipResult>
    act(() => {
      firstPromise = result.current.mutateAsync({
        clipId: id,
        projectId: 'p1',
        patch: { framingStyle: { splitMinShotMs: 400 } },
      })
    })
    await act(async () => {
      await result.current.mutateAsync({
        clipId: id,
        projectId: 'p1',
        patch: { framingStyle: cumulative },
      })
    })

    resolveFirstCancel()
    await act(async () => {
      await firstPromise
    })

    expect(client.getQueryData<ClipDetail>(keys.clip(id))?.clip.framingStyle).toEqual(cumulative)
  })

  /**
   * **Le contrôle négatif que l'écart de granularité rend nécessaire.** Le
   * serveur (`putClipOrdered`, `src/server/db.ts`) départage champ par champ,
   * jamais sur la ligne entière — un garde qui écarterait le clip *entier*
   * dès qu'un geste plus récent l'a touché perdrait ici l'écriture optimiste
   * d'un champ que ce geste plus récent n'a même pas approché.
   */
  it('garde l’écriture optimiste du plus ancien sur un champ disjoint', async () => {
    const id = 'c-252-disjoint'
    const { client, envelope } = harness()
    const before = framing({ ratio: '16:9', shots: [shot(0, 20, '16:9', 0.5)] })
    client.setQueryData<ClipDetail>(keys.clip(id), detail(before))

    let resolveFirstCancel!: () => void
    const firstCancelPending = new Promise<void>((resolve) => {
      resolveFirstCancel = resolve
    })
    const cancelSpy = vi.spyOn(client, 'cancelQueries')
    cancelSpy.mockImplementationOnce(() => firstCancelPending)

    const framingResult: PatchClipResult = {
      applied: true,
      clip: { ...clip!, framingStyle: { splitMinShotMs: 400 } },
      outputs: { mp4Url: null, mp4Due: true, variant9x16Url: null, variant9x16Due: true, textsUrl: null },
      framing: before,
      seq: 1,
    }
    const hookResult: PatchClipResult = {
      applied: true,
      clip: { ...clip!, hookStyle: { textColor: 'red' } },
      outputs: { mp4Url: null, mp4Due: true, variant9x16Url: null, variant9x16Due: true, textsUrl: null },
      framing: before,
      seq: 2,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string)
        return response('framingStyle' in body ? framingResult : hookResult)
      }),
    )

    const { result } = renderHook(() => usePatchClip(), { wrapper: envelope })

    let firstPromise!: Promise<PatchClipResult>
    act(() => {
      firstPromise = result.current.mutateAsync({
        clipId: id,
        projectId: 'p1',
        patch: { framingStyle: { splitMinShotMs: 400 } },
      })
    })
    await act(async () => {
      await result.current.mutateAsync({ clipId: id, projectId: 'p1', patch: { hookStyle: { textColor: 'red' } } })
    })

    resolveFirstCancel()
    await act(async () => {
      await firstPromise
    })

    const cache = client.getQueryData<ClipDetail>(keys.clip(id))
    expect(cache?.clip.hookStyle).toEqual({ textColor: 'red' })
    expect(cache?.clip.framingStyle).toEqual({ splitMinShotMs: 400 })
  })
})

/**
 * `Timeline` bâtit la clé de cache-busting de sa planche sur cette révision
 * (issue #280) : `onMutate` écrit l'optimiste dans le même cache que
 * `clip.segments`, de façon synchrone, au départ du `PATCH` — avant que le
 * serveur ait répondu. Ces tests pincent la fenêtre que ça laissait ouverte,
 * et l'amendement qui l'a suivie : un compteur qui avancerait sur toute
 * écriture confirmée busterait le cache sur un champ sans rapport.
 */
describe('useClipRevision (issue #280)', () => {
  function clipOf(id: string, segments: { start: number; end: number }[] = [{ start: 0, end: 20 }]): Clip {
    return {
      id,
      projectId: 'p1',
      segments,
      ratio: 'auto',
      cropX: 0.5,
      captions: true,
      branding: true,
      footer: true,
      title: 'Un titre',
      description: '',
      status: 'kept',
      pass: 1,
      hookText: '',
      hookBadge: '',
      hookStyle: {},
      framingStyle: {},
    }
  }

  function seedAndRender(id: string) {
    const { client, envelope } = harness()
    client.setQueryData<ClipDetail>(keys.clip(id), {
      clip: clipOf(id),
      project: { id: 'p1', title: 'p1', durationSec: 60, createdAt: '' },
      lines: [],
      proxyUrl: null,
      outputs: { mp4Url: null, mp4Due: true, variant9x16Url: null, variant9x16Due: true, textsUrl: null },
      framing: framing({ shots: [shot(0, 20, '1:1', 0.5)] }),
    })
    return {
      client,
      ...renderHook(
        () => {
          useClip(id) // amorce la révision confirmée, comme en production
          return { patch: usePatchClip(), confirmed: useClipRevision(id) }
        },
        { wrapper: envelope },
      ),
    }
  }

  it('n’avance pas tant que le PATCH n’a pas de réponse — la fenêtre optimiste elle-même', () => {
    const id = 'c-280-inflight'
    let resolveFetch!: (r: Response) => void
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    vi.stubGlobal('fetch', vi.fn(() => pending))
    const { result } = seedAndRender(id)

    act(() => {
      void result.current.patch
        .mutateAsync({ clipId: id, projectId: 'p1', patch: { segments: [{ start: 0, end: 30 }] } })
        .catch(() => {})
    })
    // `onMutate` a déjà écrit l'optimiste dans le cache que lit `useClip` ;
    // la révision **confirmée**, elle, ne doit pas avoir bougé.
    expect(result.current.confirmed.revision).toBe(0)

    act(() => {
      resolveFetch(
        response({
          applied: true,
          clip: clipOf(id, [{ start: 0, end: 30 }]),
          outputs: { mp4Url: null, mp4Due: true, variant9x16Url: null, variant9x16Due: true, textsUrl: null },
          framing: framing({ shots: [shot(0, 30, '1:1', 0.5)] }),
          seq: 1,
        } satisfies PatchClipResult),
      )
    })

    return waitFor(() => expect(result.current.confirmed.revision).toBe(1))
  })

  it('n’avance pas sur un champ sans rapport avec les bornes', async () => {
    const id = 'c-280-unrelated'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({
          applied: true,
          clip: clipOf(id),
          outputs: { mp4Url: null, mp4Due: true, variant9x16Url: null, variant9x16Due: true, textsUrl: null },
          framing: framing({ shots: [shot(0, 20, '1:1', 0.5)] }),
          seq: 1,
        } satisfies PatchClipResult),
      ),
    )
    const { result } = seedAndRender(id)

    await act(async () => {
      await result.current.patch.mutateAsync({ clipId: id, projectId: 'p1', patch: { branding: false } })
    })

    expect(result.current.confirmed.revision).toBe(0)
  })

  it('avance quand les bornes confirmées par le serveur changent réellement', async () => {
    const id = 'c-280-moved'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({
          applied: true,
          clip: clipOf(id, [{ start: 0, end: 15 }]),
          outputs: { mp4Url: null, mp4Due: true, variant9x16Url: null, variant9x16Due: true, textsUrl: null },
          framing: framing({ shots: [shot(0, 15, '1:1', 0.5)] }),
          seq: 1,
        } satisfies PatchClipResult),
      ),
    )
    const { result } = seedAndRender(id)

    await act(async () => {
      await result.current.patch.mutateAsync({ clipId: id, projectId: 'p1', patch: { segments: [{ start: 0, end: 15 }] } })
    })

    expect(result.current.confirmed.revision).toBe(1)
  })

  it('notifie un abonné déjà monté à l’amorçage (relevé par Copilot et par Aristarque)', () => {
    // `Child` imbriqué dans `Parent` reproduit l'ordre réel : l'abonnement
    // de `useClipRevision` s'installe avant l'amorçage de `useClip`, ses
    // effets partant en premier.
    const id = 'c-280-mount-order'
    const { client, envelope } = harness()
    client.setQueryData<ClipDetail>(keys.clip(id), {
      clip: clipOf(id, [{ start: 5, end: 25 }]),
      project: { id: 'p1', title: 'p1', durationSec: 60, createdAt: '' },
      lines: [],
      proxyUrl: null,
      outputs: { mp4Url: null, mp4Due: true, variant9x16Url: null, variant9x16Due: true, textsUrl: null },
      framing: framing({ shots: [shot(0, 20, '1:1', 0.5)] }),
    })

    function Child() {
      const { bounds } = useClipRevision(id)
      return <div data-testid="bounds">{bounds ? `${bounds.start}-${bounds.end}` : 'vide'}</div>
    }
    function Parent() {
      useClip(id)
      return <Child />
    }
    render(<Parent />, { wrapper: envelope })

    expect(screen.getByTestId('bounds').textContent).toBe('5-25')
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
    publication: {
      instagram: 'auto',
      facebook: 'auto',
      tiktok: 'auto',
      youtube: 'auto',
      scheduleHours: DEFAULT_SCHEDULE_HOURS,
      autoPublish: true,
      descriptionFooter: DEFAULT_DESCRIPTION_FOOTER,
    },
    framing: { ...FRAMING_SETTINGS_DEFAULTS },
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
      publication: { ...settings.publication },
      framing: { ...settings.framing },
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
   * effet qui n'existe pas. La disponibilité de publication fait exception —
   * `publication.<plateforme>` en change la valeur affichée, et seul un patch
   * qui touche cette famille l'invalide, vérifié séparément ci-dessous.
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

  /**
   * **La disponibilité de publication dépend désormais du réglage** :
   * `adapterFor` lit `publication.<plateforme>` pour choisir le connecteur, et
   * `publicationAvailability` (`@/server/publication`) résout la disponibilité
   * depuis ce même adaptateur. Sans invalidation, l'écran garderait l'état de
   * l'ancien connecteur jusqu'aux 30 s de `staleTime`.
   */
  it('invalide la disponibilité de publication quand ce réglage change, et seulement lui', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(settings)))
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useSaveSettings(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate({ publication: { instagram: 'upload-post' } })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalid).toHaveBeenCalledTimes(1)
    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.publicationAvailability })
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
