// @vitest-environment jsdom

/**
 * The full-screen sort view's discriminating behaviour: `P`/`X` decide and
 * advance, `J`/`K` move without deciding, and the remaining count only moves
 * on a decision. None of it shows up in a pure unit test — it is a fact of
 * which clip is on screen after a keystroke.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClipStatus } from '@/core/edl'
import { next } from '@/lib/navigation'
import type { CandidateClip } from '@/lib/api'
import { SortStage } from '@/components/sort-view/sort-stage'

beforeEach(() => {
  // jsdom's `<video>` throws on `play()`/`pause()` — same stub as
  // `clip-screen.test.tsx`.
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function candidate(n: number, status: ClipStatus = 'candidate', pass = 1): CandidateClip {
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
    status,
    pass,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
    preview: `Ce qui se dit dans l'extrait ${n}.`,
    thumbnailUrl: null,
  }
}

const issue = next({ analysis: 'sortable', work: 'toSort' }, { id: 'p1' })

/**
 * Holds status the way the real page does with `usePatchClip`'s optimistic
 * write: without it, a decision would never come back to the screen.
 */
function Harness({ start }: { start: CandidateClip[] }) {
  const [clips, setClips] = useState(start)
  return (
    <SortStage
      projectId="p1"
      clips={clips}
      proxyUrl="blob:fake-proxy"
      next={issue}
      onStatus={(clipId, status) =>
        setClips((cs) => cs.map((c) => (c.id === clipId ? { ...c, status } : c)))
      }
    />
  )
}

function title(): string | null {
  return screen.getByTestId('stage-title').textContent
}

function remaining(): string | null {
  return screen.getByTestId('remaining').textContent
}

describe('SortStage', () => {
  it('P keeps the current clip and advances; X discards and advances', async () => {
    const user = userEvent.setup()
    render(<Harness start={[candidate(1), candidate(2), candidate(3)]} />)

    expect(remaining()).toBe('3')
    expect(title()).toMatch(/Extrait 1/)

    await user.keyboard('p')
    expect(title()).toMatch(/Extrait 2/)
    expect(remaining()).toBe('2')

    await user.keyboard('x')
    expect(title()).toMatch(/Extrait 3/)
    expect(remaining()).toBe('1')
  })

  it('K moves back without deciding; the remaining count only drops on a decision', async () => {
    const user = userEvent.setup()
    render(<Harness start={[candidate(1), candidate(2), candidate(3)]} />)

    await user.keyboard('p')
    expect(title()).toMatch(/Extrait 2/)
    expect(remaining()).toBe('2')

    // Back to the decided clip, with no further change to its status or the count.
    await user.keyboard('k')
    expect(title()).toMatch(/Extrait 1/)
    expect(remaining()).toBe('2')

    // Forward again lands on the still-undecided clip 2, unaffected by the trip back.
    await user.keyboard('j')
    expect(title()).toMatch(/Extrait 2/)
    expect(remaining()).toBe('2')
  })

  it('the buttons write the same decision as the keyboard', async () => {
    const user = userEvent.setup()
    render(<Harness start={[candidate(1), candidate(2)]} />)

    await user.click(screen.getByRole('button', { name: /garder/i }))
    expect(title()).toMatch(/Extrait 2/)
    expect(remaining()).toBe('1')
  })

  it('shows the loop end once nothing remains, and none before', () => {
    render(<Harness start={[candidate(1, 'kept'), candidate(2, 'discarded')]} />)
    expect(screen.getByText('Tout est trié.')).toBeTruthy()
  })

  it('marks a clip from a later pass only when the queue holds more than one pass', async () => {
    const user = userEvent.setup()
    const single = render(
      <SortStage
        projectId="p1"
        clips={[candidate(1, 'candidate', 1), candidate(2, 'candidate', 1)]}
        proxyUrl="blob:fake-proxy"
        next={issue}
        onStatus={() => {}}
      />,
    )
    // A single-pass queue never carries the marker, on either clip.
    expect(screen.queryByTestId('pass-marker')).toBeNull()
    await user.keyboard('j')
    expect(screen.queryByTestId('pass-marker')).toBeNull()
    single.unmount()

    render(
      <SortStage
        projectId="p1"
        clips={[candidate(1, 'candidate', 1), candidate(2, 'candidate', 2)]}
        proxyUrl="blob:fake-proxy"
        next={issue}
        onStatus={() => {}}
      />,
    )
    // Clip 1 is pass 1, the queue's earliest: no marker on it.
    expect(screen.queryByTestId('pass-marker')).toBeNull()
    // Clip 2 is pass 2, later than the queue's earliest: marked.
    await user.keyboard('j')
    expect(title()).toMatch(/Extrait 2/)
    expect(screen.queryByTestId('pass-marker')).not.toBeNull()
  })
})
