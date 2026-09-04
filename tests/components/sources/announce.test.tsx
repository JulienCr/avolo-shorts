// @vitest-environment jsdom

/** `useAnalysisAnnouncement`: step changes, entering the queue, and the end. */

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useAnalysisAnnouncement } from '@/components/sources/announce'
import type { ProjectListItem } from '@/lib/api'

afterEach(cleanup)

function project(id: string, partial: Partial<ProjectListItem> = {}): ProjectListItem {
  return {
    id,
    title: id,
    durationSec: 5_940,
    createdAt: '2025-06-15T19:04:00.000Z',
    running: null,
    runningAll: [],
    error: null,
    warning: null,
    stopped: false,
    everRan: true,
    ...partial,
  }
}

describe('useAnalysisAnnouncement', () => {
  it('annonce l’entrée dans la file, avec la ressource attendue', () => {
    const before = [project('a')]
    const after = [
      project('a', {
        running: { step: 'transcript', progress: 0, waiting: { resource: 'gpu', waitedMs: 0 } },
      }),
    ]
    const { result, rerender } = renderHook(({ projects }) => useAnalysisAnnouncement(projects), {
      initialProps: { projects: before },
    })
    rerender({ projects: after })
    expect(result.current).toBe('a : en attente de la carte graphique.')
  })

  it('n’annonce pas de nouveau quand seul le temps d’attente augmente', () => {
    const queued = (waitedMs: number) => [
      project('a', {
        running: { step: 'transcript', progress: 0, waiting: { resource: 'gpu', waitedMs } },
      }),
    ]
    const { result, rerender } = renderHook(({ projects }) => useAnalysisAnnouncement(projects), {
      initialProps: { projects: queued(0) },
    })
    const first = result.current

    rerender({ projects: queued(240_000) })
    expect(result.current).toBe(first)
  })

  it('annonce le démarrage en sortant de la file, sans message dédié à la sortie', () => {
    const queued = [
      project('a', {
        running: { step: 'transcript', progress: 0, waiting: { resource: 'gpu', waitedMs: 0 } },
      }),
    ]
    const running = [project('a', { running: { step: 'transcript', progress: 0, waiting: null } })]
    const { result, rerender } = renderHook(({ projects }) => useAnalysisAnnouncement(projects), {
      initialProps: { projects: queued },
    })
    rerender({ projects: running })
    expect(result.current).toBe('a : Transcription.')
    expect(result.current).not.toMatch(/attente/i)
  })
})
