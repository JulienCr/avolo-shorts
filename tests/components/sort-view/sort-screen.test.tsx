// @vitest-environment jsdom

/**
 * `SortScreen`'s proxy gate: the fact that it works today is not what a unit
 * test is for — it is that it keeps working the next time this file changes.
 * Mounted for real, same technique as `project-screen.test.tsx`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CandidateClip, ProjectStatus } from '@/lib/api'
import { SortScreen } from '@/components/sort-view/sort-screen'

beforeEach(() => {
  // jsdom's `<video>` throws on `play()`/`pause()` — same stub as `sort-stage.test.tsx`.
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {})
})

function state(fields: Partial<ProjectStatus> = {}): ProjectStatus {
  return {
    project: { id: 'p1', title: 'La scène du 15 juin', durationSec: 5940, createdAt: '2026-08-18' },
    steps: {
      audio: true,
      transcript: true,
      correction: false,
      candidates: true,
      proxy: false,
      analysis: true,
      renders: false,
    },
    running: null,
    runningAll: [],
    error: null,
    warning: null,
    selectionReport: null,
    stopped: false,
    sizeBytes: 4_300_000_000,
    everRan: true,
    ...fields,
  }
}

function candidate(n: number): CandidateClip {
  return {
    id: `c${n}`,
    projectId: 'p1',
    segments: [{ start: n * 100, end: n * 100 + 30 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    footer: true,
    title: `Extrait ${n}`,
    description: '',
    status: 'candidate',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
    preview: 'Ce qui se dit.',
    thumbnailUrl: null,
  }
}

function serve(project: ProjectStatus, candidates: CandidateClip[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      const [body, ok] = path.endsWith('/candidates') ? [candidates, true] : [project, true]
      return { ok, status: 200, statusText: '', json: async () => body } as Response
    }),
  )
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const envelope = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(<SortScreen scope={{ kind: 'project', projectId: 'p1' }} />, { wrapper: envelope })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SortScreen', () => {
  it('shows no queue and no video while the proxy is not ready', async () => {
    serve(state({ steps: { ...state().steps, proxy: false } }), [candidate(1)])
    mount()

    await waitFor(() => expect(screen.getByText(/en cours d.encodage/i)).toBeTruthy())
    expect(screen.queryByTestId('stage-title')).toBeNull()
    expect(document.querySelector('video')).toBeNull()
  })

  it('populates the queue once the proxy is ready', async () => {
    serve(state({ steps: { ...state().steps, proxy: true } }), [candidate(1)])
    mount()

    await waitFor(() => expect(screen.getByTestId('stage-title')).toBeTruthy())
    expect(screen.queryByText(/en cours d.encodage/i)).toBeNull()
  })
})
