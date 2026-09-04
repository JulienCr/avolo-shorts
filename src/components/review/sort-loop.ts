'use client'

import { useState } from 'react'

import type { ClipStatus } from '@/core/edl'
import { count } from '@/core/phase'
import type { CandidateClip } from '@/lib/api'
import { toggleStatus, type Decision } from '@/lib/clip-status'
import { belongs, idsForView, type View } from '@/components/review/template'

/**
 * The sort loop's machinery, shared by every surface that sorts candidates.
 *
 * Frozen membership, one decision back, and how much is left to sort — see
 * `ReviewFeed`'s own docstring for what the loop is and why it behaves this
 * way.
 */

/**
 * The displayed list, frozen until the next view change.
 *
 * A decided card keeps its place until the view changes; only membership is
 * frozen, not the clip data, so a card's own status can still update in place
 * and new candidates from an in-progress detection pass still appear.
 */
export function useViewFrozen(clips: readonly CandidateClip[], view: View): CandidateClip[] {
  // A null byte, not a space: clip ids inherit the source filename, spaces
  // included, and two different lists could otherwise join to the same
  // string.
  const identities = clips.map((c) => c.id).join('\u0000')
  const [frozen, setFrozen] = useState(() => ({ view, identities, ids: idsForView(clips, view) }))

  // A state adjustment during render, not an effect: React replays before
  // paint, so the grid never flashes its previous state on a view change.
  if (frozen.view !== view || frozen.identities !== identities) {
    setFrozen({
      view,
      identities,
      // A view change recomputes; a clips update extends instead: refreezing
      // from scratch would hide decided cards the moment a forced detection
      // pass adds candidates without discarding decisions.
      ids:
        frozen.view !== view
          ? idsForView(clips, view)
          : clips
              .filter((c) => frozen.ids.includes(c.id) || belongs(c.status, view))
              .map((c) => c.id),
    })
  }

  const byId = new Map(clips.map((c) => [c.id, c]))
  return frozen.ids.flatMap((id) => {
    const clip = byId.get(id)
    return clip === undefined ? [] : [clip]
  })
}

/** An undoable decision: the clip, and its status before the decision. */
type UndoEntry = { clipId: string; before: ClipStatus }

/**
 * Moves DOM focus onto `clipId`'s element and scrolls it into view, or does
 * nothing if that element isn't currently rendered.
 *
 * @returns Whether the element was found. `false` is a normal answer — e.g.
 * the caller is between renders, or the card belongs to a different view —
 * not a failure to report.
 */
export type AttemptFocus = (clipId: string | null) => boolean

/**
 * What a sort surface needs to run the loop: the frozen list, the keyboard's
 * current card, one decision back, and how much is left to sort.
 *
 * Layout-agnostic by design — a grid of cards and a single full-screen clip
 * both drive it the same way. Moving the keyboard's DOM focus is the one part
 * left to the caller, via `attemptFocus`.
 */
export type SortLoop = {
  /** The displayed list, frozen until the next view change. */
  visible: CandidateClip[]
  /** The card the keyboard acts on, or `null` when nothing is visible. */
  current: string | null
  /** Selects a card without deciding or moving DOM focus (a plain click). */
  select: (clipId: string | null) => void
  /** Selects a card and attempts to move DOM focus onto it. */
  focusCard: (clipId: string | null) => boolean
  /** Moves `current` by `delta` cards within `visible`, clamped at both ends. */
  move: (delta: number) => void
  /** Decides on `current`, and advances by one card. No-op with nothing selected. */
  decide: (decision: Decision) => void
  /** Decides on `clipId` in place, without touching `current`. */
  decideOn: (clipId: string, decision: Decision) => void
  /** Reverts the last decision and restores focus to its card. No-op off-view or empty stack. */
  undo: () => void
  /** How many candidates are still to sort. */
  remaining: number
  /** True once nothing remains to sort in the 'atrier' view. */
  done: boolean
}

export function useSortLoop(
  clips: readonly CandidateClip[],
  view: View,
  onStatus: (clipId: string, status: Exclude<ClipStatus, 'exported'>) => void,
  attemptFocus: AttemptFocus,
): SortLoop {
  const visible = useViewFrozen(clips, view)
  const [selection, setSelection] = useState<string | null>(null)
  const [stack, setStack] = useState<UndoEntry[]>([])

  // Derived rather than stored: a selection held in state would survive its
  // card's disappearance — on a view change, or after a forced detection —
  // and the keyboard would act on an id nothing displays any more.
  const current = visible.some((c) => c.id === selection) ? selection : (visible[0]?.id ?? null)

  function select(clipId: string | null) {
    setSelection(clipId)
  }

  function focusCard(clipId: string | null): boolean {
    setSelection(clipId)
    return attemptFocus(clipId)
  }

  function move(delta: number) {
    if (visible.length === 0) return
    const since = visible.findIndex((c) => c.id === current)
    // No wraparound at either end: wrapping would cycle indefinitely over
    // already-seen cards with no sign that a lap has been made.
    const toward = Math.max(0, Math.min(visible.length - 1, (since < 0 ? 0 : since) + delta))
    focusCard(visible[toward]?.id ?? null)
  }

  function apply(clip: CandidateClip, decision: Decision) {
    setStack((p) => [...p, { clipId: clip.id, before: clip.status }])
    onStatus(clip.id, toggleStatus(clip.status, decision))
  }

  function decide(decision: Decision) {
    const clip = visible.find((c) => c.id === current)
    if (clip === undefined) return
    apply(clip, decision)
    move(1)
  }

  function decideOn(clipId: string, decision: Decision) {
    const clip = visible.find((c) => c.id === clipId)
    if (clip === undefined) return
    apply(clip, decision)
  }

  function undo() {
    const last = stack.at(-1)
    if (last === undefined) return
    // Nothing undoes out of view: reverting a decision on a card the active
    // view doesn't show would move state with nothing moving on screen, and
    // `focusCard` below is what brings the card back for exactly that reason.
    if (!visible.some((c) => c.id === last.clipId)) return
    setStack((p) => p.slice(0, -1))
    // `exported` never gets written back: the server rejects it on `PATCH`,
    // and the render this decision undoes has been discarded regardless.
    onStatus(last.clipId, last.before === 'exported' ? 'kept' : last.before)
    focusCard(last.clipId)
  }

  const counts = count(clips)

  return {
    visible,
    current,
    select,
    focusCard,
    move,
    decide,
    decideOn,
    undo,
    remaining: counts.aSort,
    done: clips.length > 0 && counts.aSort === 0 && view === 'atrier',
  }
}
