// @vitest-environment jsdom

/**
 * `PendingExport` : le bouton qui rattrape les clips gardés sans vidéo à jour.
 *
 * Trois critères, et le premier est celui qui compte : les exports partent
 * **un à la fois**. ffmpeg tient le GPU, et deux rendus concurrents se le
 * disputeraient sans que rien ne le signale — c'est le genre de défaut qu'un
 * test de comptage d'appels laisserait passer.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PendingExport } from '@/components/planning/pool-pending'
import type { PlanningPendingClip } from '@/lib/api'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function pending(clipId: string, reason: PlanningPendingClip['reason'] = 'stale'): PlanningPendingClip {
  return {
    clipId,
    projectId: '2026-06-15-cqlp',
    title: `Titre ${clipId}`,
    reason,
  }
}

/**
 * Un serveur d'export dont chaque réponse s'ouvre à la main, pour observer
 * ce qui est en vol à un instant donné.
 */
function exportServer(fails: ReadonlySet<string> = new Set()) {
  const open: ((value: unknown) => void)[] = []
  const started: string[] = []
  let flight = 0
  let maxFlight = 0

  const fetchMock = vi.fn(async (url: string) => {
    const clipId = decodeURIComponent(/\/api\/clips\/(.+)\/export$/.exec(url)![1])
    started.push(clipId)
    flight += 1
    maxFlight = Math.max(maxFlight, flight)
    await new Promise((resolve) => open.push(resolve))
    flight -= 1
    if (fails.has(clipId)) {
      return {
        ok: false,
        status: 500,
        statusText: '',
        json: async () => ({ error: 'ffmpeg a renoncé' }),
      } as Response
    }
    return {
      ok: true,
      status: 200,
      statusText: '',
      json: async () => ({ skipped: false }),
    } as Response
  })
  vi.stubGlobal('fetch', fetchMock)

  /** Laisse partir la réponse en attente, et rend la main au rendu. */
  async function release() {
    await waitFor(() => expect(open.length).toBeGreaterThan(0))
    open.shift()!(undefined)
  }

  return { started, release, maxFlight: () => maxFlight }
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return Wrapper
}

describe('PendingExport', () => {
  it('nomme le compte et le détail des deux raisons', () => {
    render(<PendingExport pending={[pending('a', 'missing'), pending('b'), pending('c')]} />, {
      wrapper: wrapper(),
    })

    expect(screen.getByRole('button', { name: /Exporter les 3 clips manquants/ })).toBeTruthy()
    expect(screen.getByText(/1 sans rendu, 2 rendus périmés/)).toBeTruthy()
  })

  it('exporte un clip à la fois, dans l’ordre, et suit l’avancement', async () => {
    const user = userEvent.setup()
    const server = exportServer()
    render(<PendingExport pending={[pending('a'), pending('b'), pending('c')]} />, { wrapper: wrapper() })

    await user.click(screen.getByRole('button', { name: /Exporter les 3 clips manquants/ }))

    await waitFor(() => expect(server.started).toEqual(['a']))
    expect(screen.getByRole('button', { name: /Export 1\/3/ })).toBeTruthy()

    await server.release()
    await waitFor(() => expect(server.started).toEqual(['a', 'b']))
    expect(screen.getByRole('button', { name: /Export 2\/3/ })).toBeTruthy()

    await server.release()
    await waitFor(() => expect(server.started).toEqual(['a', 'b', 'c']))
    await server.release()

    await waitFor(() => expect(screen.getByRole('button', { name: /Exporter les 3 clips/ })).toBeTruthy())
    expect(server.maxFlight()).toBe(1)
  })

  it('un échec au milieu n’arrête pas les suivants, et se dit', async () => {
    const user = userEvent.setup()
    const server = exportServer(new Set(['b']))
    render(<PendingExport pending={[pending('a'), pending('b'), pending('c')]} />, { wrapper: wrapper() })

    await user.click(screen.getByRole('button', { name: /Exporter les 3 clips manquants/ }))
    for (let i = 0; i < 3; i += 1) await server.release()

    await waitFor(() => expect(screen.getByText(/Titre b/)).toBeTruthy())
    expect(server.started).toEqual(['a', 'b', 'c'])
    expect(screen.getByText(/1 clip n’a pas pu être exporté/)).toBeTruthy()
  })

  it('la boucle suit l’instantané du clic, que le rechargement du vivier ne raccourcit pas', async () => {
    const user = userEvent.setup()
    const server = exportServer()
    const list = [pending('a'), pending('b')]
    const { rerender } = render(<PendingExport pending={list} />, {
      wrapper: wrapper(),
    })

    await user.click(screen.getByRole('button', { name: /Exporter les 2 clips manquants/ }))
    await waitFor(() => expect(server.started).toEqual(['a']))

    // Le vivier s'est rechargé : `a` en est sorti, la propriété rétrécit.
    rerender(<PendingExport pending={[pending('b')]} />)
    await server.release()

    await waitFor(() => expect(server.started).toEqual(['a', 'b']))
    expect(screen.getByRole('button', { name: /Export 2\/2/ })).toBeTruthy()
  })
})
