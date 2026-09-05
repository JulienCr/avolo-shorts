// @vitest-environment jsdom

/**
 * The bridge to the second sweep pass.
 *
 * `moreClips` is `null` on a project that never ran the pass — that is what
 * must render the two buttons — and `exhausted: true` must remove them,
 * without ever needing to click one to prove it.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectStatus } from '@/lib/api'
import { MoreClips } from '@/components/review/more-clips'

function status(overrides: Partial<ProjectStatus> = {}): ProjectStatus {
  return {
    project: { id: 'p1', title: 'La scene', durationSec: 3600, createdAt: '2026-01-01' },
    steps: {} as ProjectStatus['steps'],
    running: null,
    runningAll: [],
    error: null,
    warning: null,
    selectionReport: null,
    moreClips: null,
    stopped: false,
    ...overrides,
  } as ProjectStatus
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body } as Response
}

function envelope({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MoreClips', () => {
  it('rend les deux boutons quand la passe n’a jamais tourné', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(status())))
    render(<MoreClips projectId="p1" />, { wrapper: envelope })

    await waitFor(() => expect(screen.getByRole('button', { name: '+5' })).toBeTruthy())
    expect(screen.getByRole('button', { name: '+10' })).toBeTruthy()
  })

  it('ne rend aucun bouton quand le replay est épuisé', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(status({ moreClips: { requested: 5, added: 0, exhausted: true } }))),
    )
    render(<MoreClips projectId="p1" />, { wrapper: envelope })

    await waitFor(() => expect(screen.getByText(/épuisé|exploré/i)).toBeTruthy())
    expect(screen.queryByRole('button', { name: '+5' })).toBeNull()
    expect(screen.queryByRole('button', { name: '+10' })).toBeNull()
  })

  it('bloque les boutons pendant qu’une exécution tourne, avec sa raison à côté', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(status({ running: { step: 'candidates', progress: 0, waiting: null } })),
      ),
    )
    render(<MoreClips projectId="p1" />, { wrapper: envelope })

    const button = await screen.findByRole('button', { name: '+5' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('reason-more-clips').textContent).toMatch(/en cours/i)

    await userEvent.setup().click(button)
  })

  it('demande +5 ou +10 selon le bouton cliqué', async () => {
    const call = vi.fn(async (url: string) => {
      if (url.includes('/candidates/more')) return response({ projectId: 'p1', plan: ['candidates'] })
      return response(status())
    })
    vi.stubGlobal('fetch', call)
    render(<MoreClips projectId="p1" />, { wrapper: envelope })

    await userEvent.setup().click(await screen.findByRole('button', { name: '+10' }))

    await waitFor(() => expect(call).toHaveBeenCalledWith(
      expect.stringContaining('/candidates/more'),
      expect.anything(),
    ))
    const found = call.mock.calls.find(([u]) => String(u).includes('/candidates/more')) as unknown as [
      string,
      RequestInit,
    ]
    expect(JSON.parse(String(found[1].body))).toEqual({ count: 10 })
  })

  it('dit qu’une exécution tourne déjà plutôt que « échec » sur un 409', async () => {
    const call = vi.fn(async (url: string) => {
      if (url.includes('/candidates/more')) return response({ error: 'déjà en cours' }, 409)
      return response(status())
    })
    vi.stubGlobal('fetch', call)
    render(<MoreClips projectId="p1" />, { wrapper: envelope })

    await userEvent.setup().click(await screen.findByRole('button', { name: '+5' }))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/exécution.*(tourne|cours)/i),
    )
  })

  it('affiche le message du serveur sur un 400', async () => {
    const message = 'Ce projet a encore des clips non triés.'
    const call = vi.fn(async (url: string) => {
      if (url.includes('/candidates/more')) return response({ error: message }, 400)
      return response(status())
    })
    vi.stubGlobal('fetch', call)
    render(<MoreClips projectId="p1" />, { wrapper: envelope })

    await userEvent.setup().click(await screen.findByRole('button', { name: '+5' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(message))
  })
})
