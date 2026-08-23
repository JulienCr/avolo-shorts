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
import { keys, usePublications, usePublisher } from '@/lib/queries'

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
