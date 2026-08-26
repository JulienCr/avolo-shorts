// @vitest-environment jsdom

/**
 * `usePlanningPool`, `usePlanningSchedule`, `useSchedulePublication` et
 * `useUnschedulePublication` — fichier séparé de `queries.test.tsx`, même
 * règle que `queries-publication.test.tsx`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  keys,
  usePlanningPool,
  usePlanningSchedule,
  useSchedulePublication,
  useUnschedulePublication,
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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('usePlanningPool', () => {
  it('lit /api/planning/pool sans sondage', async () => {
    const call = vi.fn(async () => response({ clips: [] }))
    vi.stubGlobal('fetch', call)
    const { envelope } = harness()
    const { result } = renderHook(() => usePlanningPool(), { wrapper: envelope })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const [path] = call.mock.calls[0] as unknown as [string]
    expect(path).toBe('/api/planning/pool')
  })
})

describe('usePlanningSchedule', () => {
  it('porte les bornes dans la clé, et dans la requête', async () => {
    const call = vi.fn(async () => response({ entries: [] }))
    vi.stubGlobal('fetch', call)
    const { envelope } = harness()
    const { result } = renderHook(() => usePlanningSchedule(1_000, 2_000), { wrapper: envelope })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const [path] = call.mock.calls[0] as unknown as [string]
    expect(path).toBe('/api/planning/schedule?from=1000&to=2000')
  })
})

describe('useSchedulePublication', () => {
  it('poste les identifiants et une échéance unique, invalide vivier et calendrier', async () => {
    const call = vi.fn(async () => response({ entries: [] }))
    vi.stubGlobal('fetch', call)
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useSchedulePublication(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate({ clipIds: ['c1', 'c2'], scheduledAt: 1_700_000_000_000 })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const [path, options] = call.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/planning/schedule')
    expect(JSON.parse(String(options.body))).toEqual({
      clipIds: ['c1', 'c2'],
      scheduledAt: 1_700_000_000_000,
    })
    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.planningPool })
    expect(invalid).toHaveBeenCalledWith({ queryKey: ['planning-schedule'] })
  })
})

describe('useUnschedulePublication', () => {
  it('poste les identifiants, invalide vivier et calendrier', async () => {
    const call = vi.fn(async () => response({ removed: 1 }))
    vi.stubGlobal('fetch', call)
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useUnschedulePublication(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate(['c1'])
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const [path, options] = call.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/planning/unschedule')
    expect(JSON.parse(String(options.body))).toEqual({ clipIds: ['c1'] })
    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.planningPool })
    expect(invalid).toHaveBeenCalledWith({ queryKey: ['planning-schedule'] })
  })
})
