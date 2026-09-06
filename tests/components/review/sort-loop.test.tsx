// @vitest-environment jsdom

/**
 * `useSortLoop`'s undo, checked against data rather than the DOM.
 *
 * The extraction replaced a `querySelectorAll` scoped to the grid with a
 * `visible.some(...)` check: same question — is this card still shown by the
 * active view — asked from the frozen list instead of the rendered tree.
 * `feed.test.tsx`'s "ne défait rien hors de vue" proves this end to end
 * through real DOM; this pins the extracted unit's own contract in isolation.
 */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ClipStatus } from '@/core/edl'
import type { CandidateClip } from '@/lib/api'
import { useSortLoop } from '@/components/review/sort-loop'
import type { View } from '@/components/review/template'
import { resetDecideStatusForTests } from '@/lib/clip-status'

afterEach(cleanup)
// `decided` is module state (issue #330): without this, a clip id reused
// across `it()` blocks in this file would read a previous test's decision.
afterEach(resetDecideStatusForTests)

function clip(id: string, status: ClipStatus): CandidateClip {
  return {
    id,
    projectId: 'p1',
    segments: [{ start: 0, end: 30 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    footer: true,
    title: id,
    description: '',
    status,
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
    preview: '',
    thumbnailUrl: null,
  }
}

describe('useSortLoop, undo across a view change', () => {
  it('no-ops on a card the active view no longer shows, and applies once it reappears', () => {
    const statuses: Record<string, ClipStatus> = { c1: 'candidate', c2: 'candidate' }
    const onStatus = vi.fn((id: string, status: ClipStatus) => {
      statuses[id] = status
    })
    const attemptFocus = vi.fn(() => true)

    const { result, rerender } = renderHook(
      ({ view }: { view: View }) =>
        useSortLoop([clip('c1', statuses.c1), clip('c2', statuses.c2)], view, onStatus, attemptFocus, true),
      { initialProps: { view: 'atrier' as View } },
    )

    act(() => result.current.decide('kept'))
    expect(statuses.c1).toBe('kept')

    // 'écartés' doesn't show a kept card: the data check must see it as
    // absent, exactly as the removed DOM query would have.
    rerender({ view: 'ecartes' })
    attemptFocus.mockClear()
    act(() => result.current.undo())
    expect(statuses.c1).toBe('kept')
    expect(attemptFocus).not.toHaveBeenCalled()

    // Back in 'gardés', the same card is visible again, and the same undo
    // now applies.
    rerender({ view: 'gardes' })
    act(() => result.current.undo())
    expect(statuses.c1).toBe('candidate')
    expect(attemptFocus).toHaveBeenCalledWith('c1')
  })
})

/**
 * A second rapid press before render (issue #330): `apply`'s undo entry must
 * record what the decision actually toggled from, not the render snapshot
 * `clip.status` — otherwise `undo` reverts to the wrong status.
 */
describe('useSortLoop, undo across two rapid decisions on the same card', () => {
  it('undoes each decision in the order it was taken, not the render snapshot', () => {
    const statuses: Record<string, ClipStatus> = { c1: 'candidate' }
    const onStatus = vi.fn((id: string, status: ClipStatus) => {
      statuses[id] = status
    })
    const attemptFocus = vi.fn(() => true)

    const { result } = renderHook(
      ({ view }: { view: View }) => useSortLoop([clip('c1', statuses.c1)], view, onStatus, attemptFocus, true),
      { initialProps: { view: 'atrier' as View } },
    )

    // No rerender between the two: `clip.status` in the closure is still
    // 'candidate' for both, exactly the repeat #330 targets.
    act(() => {
      result.current.decideOn('c1', 'kept')
      result.current.decideOn('c1', 'kept')
    })
    expect(statuses.c1).toBe('candidate') // second press cancels the first

    act(() => result.current.undo())
    expect(statuses.c1).toBe('kept') // undoes the second decision

    act(() => result.current.undo())
    expect(statuses.c1).toBe('candidate') // undoes the first, back to the original
  })
})

describe('useSortLoop, done at zero candidates', () => {
  it('is done on an empty list once detection has finished', () => {
    const { result } = renderHook(() =>
      useSortLoop([], 'atrier', vi.fn(), vi.fn(() => true), true),
    )
    expect(result.current.done).toBe(true)
  })
})
