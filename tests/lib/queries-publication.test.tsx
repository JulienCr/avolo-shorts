// @vitest-environment jsdom

/**
 * `usePublisher` et `usePublications` — fichier séparé de `queries.test.tsx`
 * à dessein, même règle que `queries-relance.test.tsx` : ce fichier est édité
 * en parallèle par une autre PR.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PublicationRow } from '@/lib/api'
import {
  keys,
  usePublicationAvailability,
  usePublicationRecordsByClip,
  usePublications,
  usePublisher,
} from '@/lib/queries'

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body } as Response
}

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const invalid = vi.spyOn(client, 'invalidateQueries')
  const envelope = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { invalid, envelope }
}

function row(fields: Partial<PublicationRow> = {}): PublicationRow {
  return {
    clipId: 'c1',
    platform: 'instagram',
    status: 'in_progress',
    remoteId: null,
    remoteUrl: null,
    requestId: 'r1',
    error: null,
    publishedFingerprint: null,
    createdAt: 1,
    updatedAt: 1,
    scheduledAt: null,
    ...fields,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('usePublisher', () => {
  it('poste les plateformes et `force` tels quels', async () => {
    const call = vi.fn(async () => response({ publications: [row()] }))
    vi.stubGlobal('fetch', call)
    const { envelope } = harness()
    const { result } = renderHook(() => usePublisher(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate({ clipId: 'c1', platforms: ['instagram', 'youtube'], force: true })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const [path, options] = call.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/clips/c1/publish')
    expect(JSON.parse(String(options.body))).toEqual({ platforms: ['instagram', 'youtube'], force: true })
  })

  it('invalide les publications du clip visé', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ publications: [row()] })))
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => usePublisher(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate({ clipId: 'c1', platforms: ['instagram'] })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.publications('c1') })
  })
})

describe('usePublications — la boucle s’arrête (issue #97, critère d’acceptation 4)', () => {
  it('sonde à deux secondes tant qu’une ligne est `in_progress`, puis s’arrête', async () => {
    vi.useFakeTimers()
    try {
      let settled = false
      const call = vi.fn(async () =>
        response({ publications: [row({ status: settled ? 'published' : 'in_progress' })] }),
      )
      vi.stubGlobal('fetch', call)
      const { envelope } = harness()
      const { result } = renderHook(() => usePublications('c1'), { wrapper: envelope })

      await vi.waitFor(() => expect(result.current.isSuccess).toBe(true))
      expect(call).toHaveBeenCalledTimes(1)

      // Toujours `in_progress` : la boucle redemande deux secondes plus tard.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      expect(call.mock.calls.length).toBeGreaterThanOrEqual(2)

      // Le prochain sondage rend un état terminal : la boucle doit s’arrêter là.
      settled = true
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      const callsAtSettle = call.mock.calls.length

      // **La preuve que ça s’arrête, pas seulement que ça démarre.** Sans
      // cette seconde avance, un `refetchInterval` qui ne rendrait jamais
      // `false` — la régression que ce test existe pour attraper — passerait
      // ce test tout aussi bien.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(call.mock.calls.length).toBe(callsAtSettle)
    } finally {
      vi.useRealTimers()
    }
  })
})

// issue #150 : ces trois requêtes ne distinguaient pas « charge encore » de
// « a échoué » — aucun test ne couvrait le second cas avant cette PR.
describe('usePublicationAvailability — panne réseau (issue #150)', () => {
  it('rend `isError` plutôt qu’une simple absence de données', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'panne' }, 500)))
    const { envelope } = harness()
    const { result } = renderHook(() => usePublicationAvailability(), { wrapper: envelope })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
  })

  it('le contrôle négatif : encore en vol ne se lit pas comme un échec', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const { envelope } = harness()
    const { result } = renderHook(() => usePublicationAvailability(), { wrapper: envelope })

    expect(result.current.isPending).toBe(true)
    expect(result.current.isError).toBe(false)
  })
})

describe('usePublications — panne réseau (issue #150)', () => {
  it('rend `isError` plutôt qu’une simple absence de données', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'panne' }, 500)))
    const { envelope } = harness()
    const { result } = renderHook(() => usePublications('c1'), { wrapper: envelope })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
  })

  it('le contrôle négatif : encore en vol ne se lit pas comme un échec', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const { envelope } = harness()
    const { result } = renderHook(() => usePublications('c1'), { wrapper: envelope })

    expect(result.current.isPending).toBe(true)
    expect(result.current.isError).toBe(false)
  })
})

describe('usePublicationRecordsByClip — distingue échec et absence (issue #150)', () => {
  it('range un clip en échec dans `failedClipIds`, jamais dans `byClip`', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'panne' }, 500)))
    const { envelope } = harness()
    const { result } = renderHook(() => usePublicationRecordsByClip(['c1']), { wrapper: envelope })

    await waitFor(() => expect(result.current.failedClipIds.has('c1')).toBe(true))
    expect(result.current.byClip.c1).toBeUndefined()
    expect(result.current.pendingClipIds.has('c1')).toBe(false)
  })

  it('le contrôle négatif : un clip encore en vol reste dans `pendingClipIds`, pas `failedClipIds`', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const { envelope } = harness()
    const { result } = renderHook(() => usePublicationRecordsByClip(['c1']), { wrapper: envelope })

    expect(result.current.pendingClipIds.has('c1')).toBe(true)
    expect(result.current.failedClipIds.has('c1')).toBe(false)
  })

  // Suggéré par Aristarque : le cas réel de la sélection groupée, un clip en
  // 200 et un autre en 500 dans le même appel, plutôt qu'un seul clip à la fois.
  it('répartit correctement un mélange succès/échec entre `byClip` et `failedClipIds`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/c-ok/')) return response({ publications: [row({ clipId: 'c-ok' })] })
        return response({ error: 'panne' }, 500)
      }),
    )
    const { envelope } = harness()
    const { result } = renderHook(() => usePublicationRecordsByClip(['c-ok', 'c-ko']), { wrapper: envelope })

    await waitFor(() => expect(result.current.failedClipIds.has('c-ko')).toBe(true))
    expect(result.current.byClip['c-ok']).toBeDefined()
    expect(result.current.byClip['c-ko']).toBeUndefined()
    expect(result.current.pendingClipIds.size).toBe(0)
  })
})
