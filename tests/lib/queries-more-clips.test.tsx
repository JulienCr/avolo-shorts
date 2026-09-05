// @vitest-environment jsdom

/**
 * `useRequestMoreClips`, and its onSuccess/onSettled split.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { keys, useRequestMoreClips } from '@/lib/queries'

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

describe('useRequestMoreClips', () => {
  it('invalide les candidats et le projet sur un succès', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ projectId: 'p1', plan: ['candidates'] })))
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useRequestMoreClips(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate({ projectId: 'p1', count: 5 })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.candidats('p1') })
    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.projet('p1') })
  })

  it('invalide le projet mais pas les candidats sur un 409', async () => {
    // A 409 means an execution is already running: nothing was launched, so
    // the candidates haven't moved, but the screen must fetch the running
    // execution for `refetchInterval` to restart.
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'déjà en cours' }, 409)))
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useRequestMoreClips(), { wrapper: envelope })

    await act(async () => {
      result.current.mutate({ projectId: 'p1', count: 10 })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.projet('p1') })
    expect(invalid).not.toHaveBeenCalledWith({ queryKey: keys.candidats('p1') })
  })
})
