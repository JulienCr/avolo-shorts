// @vitest-environment jsdom

/**
 * Le bandeau de cinq semaines : le détail d'un échec de publication doit
 * rester lisible sans survol, et une réussite partielle ne doit jamais se
 * réduire au seul mot « échec » (issue backlog « détail des échecs »).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FiveWeekBand } from '@/components/planning/five-week-band'
import type { PublicationDetail, ScheduledEntry } from '@/lib/api'
import { installPointerEventPolyfill } from '../../fixtures/pointer-event'

installPointerEventPolyfill()

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, statusText: '', json: async () => body } as Response
}

function detail(status: PublicationDetail['status'], fields: Partial<PublicationDetail> = {}): PublicationDetail {
  return { status, error: null, updatedAt: 1000, remoteUrl: null, ...fields }
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return Wrapper
}

describe('FiveWeekBand', () => {
  it('deux réussites et deux échecs restent visibles, chaque raison se lit sans survol', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ publications: [] })),
    )
    const user = userEvent.setup()

    const entry: ScheduledEntry = {
      clipId: 'c1',
      projectId: '2026-06-15-cqlp',
      title: 'La chute',
      scheduledAt: Date.UTC(2026, 8, 7, 19, 0),
      statuses: {
        instagram: detail('published'),
        facebook: detail('submitted'),
        tiktok: detail('failed', { error: 'Le débit TikTok est atteint.', updatedAt: 4242 }),
        youtube: detail('failed', { error: 'Meta refuse le fichier : durée trop longue.', updatedAt: 4343 }),
      },
      stale: false,
    }

    render(<FiveWeekBand days={['2026-09-07']} entries={[entry]} onUnschedule={() => {}} />, {
      wrapper: wrapper(),
    })

    // L'agrégat ne se réduit pas au seul mot « échec » : deux plateformes ont réussi.
    expect(screen.getByText('échec partiel')).toBeTruthy()

    // Ni `pointerover` ni la souris : le déclencheur reçoit le focus, puis
    // l'activation clavier — la même voie qu'un utilisateur au clavier seul.
    const trigger = screen.getByRole('button', { name: /en échec/ })
    trigger.focus()
    await user.keyboard('{Enter}')

    expect(await screen.findByText('Le débit TikTok est atteint.')).toBeTruthy()
    expect(screen.getByText('Meta refuse le fichier : durée trop longue.')).toBeTruthy()
  })

  it('la relance appelle /publish sur la seule plateforme en échec et affiche l\'erreur au rejet', async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/clips/c1/publish') return response({ error: 'rendu périmé' }, false, 400)
      return response({ publications: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    const entry: ScheduledEntry = {
      clipId: 'c1',
      projectId: '2026-06-15-cqlp',
      title: 'La chute',
      scheduledAt: Date.UTC(2026, 8, 7, 19, 0),
      statuses: {
        instagram: detail('published'),
        facebook: detail('submitted'),
        tiktok: detail('failed', { error: 'Le débit TikTok est atteint.', updatedAt: 4242 }),
        youtube: detail('published'),
      },
      stale: false,
    }

    render(<FiveWeekBand days={['2026-09-07']} entries={[entry]} onUnschedule={() => {}} />, {
      wrapper: wrapper(),
    })

    const trigger = screen.getByRole('button', { name: /en échec/ })
    trigger.focus()
    await user.keyboard('{Enter}')

    const retryButton = await screen.findByRole('button', { name: 'Relancer' })
    await user.click(retryButton)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/clips/c1/publish',
      expect.objectContaining({
        body: JSON.stringify({ platforms: ['tiktok'] }),
      }),
    )
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('rendu périmé'))
  })
})
