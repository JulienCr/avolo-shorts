'use client'

import { VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { ClipStatus } from '@/core/edl'
import { count } from '@/core/phase'
import { clipBounds, playbackAction } from '@/lib/editing'
import type { CandidateClip } from '@/lib/api'
import type { Next } from '@/lib/navigation'
import { LoopEnd } from '@/components/review/loop-end'
import { useSortLoop, type AttemptFocus } from '@/components/review/sort-loop'
import { useShortcutsReview } from '@/components/review/shortcuts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * The dedicated sort view's screen: one clip's video, two buttons, a count.
 *
 * A second presentation of `useSortLoop`, not a second loop — the grid
 * (`ReviewFeed`) mounts one card per visible clip, this mounts one video for
 * `current`. `attemptFocus` targets a single stage container independent of
 * which clip is current, so issue #323's per-card mounting race never applies.
 */
export function SortStage({
  projectId,
  clips,
  proxyUrl,
  next,
  onStatus,
}: {
  projectId: string
  clips: readonly CandidateClip[]
  /** The project's single proxy file, or `null` — gated one level up. */
  proxyUrl: string | null
  next: Next
  onStatus: (clipId: string, status: Exclude<ClipStatus, 'exported'>) => void
}) {
  const stage = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [muted, setMuted] = useState(false)
  const [help, setHelp] = useState(false)

  const attemptFocus: AttemptFocus = (clipId) => {
    if (clipId === null) return false
    stage.current?.focus()
    return true
  }

  const { visible, current, move, decide, undo, remaining, done } = useSortLoop(
    clips,
    'atrier',
    onStatus,
    attemptFocus,
  )

  const currentClip = visible.find((c) => c.id === current) ?? null

  // A marker every item carries is not a marker — only when passes mix.
  const passes = new Set(visible.map((c) => c.pass))
  const earliestPass = Math.min(...passes)
  const showsPassMarker = passes.size > 1 && currentClip !== null && currentClip.pass > earliestPass

  // Seeks and plays on every clip change; `clipBounds`/`playbackAction` are
  // the same pure helpers `ClipPlayer` uses to skip a removed passage.
  useEffect(() => {
    const el = video.current
    const bounds = currentClip === null ? null : clipBounds(currentClip.segments)
    if (el === null || bounds === null) return
    el.currentTime = bounds.start
    // Unmuted first; a direct link to `/sort` carries no user gesture, and
    // the browser then rejects unmuted autoplay — fall back to muted rather
    // than leaving the video silently paused. `el.muted` is set synchronously
    // because `setMuted` only schedules the next render: retrying `play()`
    // immediately would still see an unmuted element and be rejected again.
    el.play().catch((error: unknown) => {
      if (!(error instanceof DOMException) || error.name !== 'NotAllowedError') return
      el.muted = true
      setMuted(true)
      void el.play()
    })
  }, [currentClip])

  function onTimeUpdate() {
    const el = video.current
    if (el === null || currentClip === null) return
    const action = playbackAction(currentClip.segments, el.currentTime)
    if (action.kind === 'seek') el.currentTime = action.to
    else if (action.kind === 'end') el.pause()
  }

  useShortcutsReview({
    previous: () => move(-1),
    next: () => move(1),
    keep: () => decide('kept'),
    discard: () => decide('discarded'),
    // No per-clip editing screen from here — `Entrée` has nothing to open.
    open: () => {},
    undo,
    help: () => setHelp(true),
  })

  return (
    // Mounted whether `done` or not: `undo()` can call `attemptFocus`
    // synchronously on the frame where the last clip is un-decided, before
    // React has re-rendered past `LoopEnd` — an unmounted container here
    // would drop that focus silently, the same race as issue #323.
    <div
      ref={stage}
      tabIndex={-1}
      className="flex h-full min-h-0 flex-1 flex-col items-center gap-3 outline-none"
    >
      {done ? (
        <LoopEnd projectId={projectId} clips={clips} durationKept={count(clips).durationKept} next={next} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            <span data-testid="remaining" className="font-mono tabular-nums">
              {remaining}
            </span>{' '}
            à trier
          </p>

          {currentClip === null ? (
            <p className="text-sm text-muted-foreground">Rien à trier pour le moment.</p>
          ) : (
            <>
              {/* `absolute inset-0`, not a flex/percentage size: a `<video>`'s
                  aspect ratio otherwise fights the flex layout sizing its
                  container, ballooning the whole page. Out of flow, it can't. */}
              <div className="relative w-full min-h-0 flex-1 overflow-hidden rounded-xl bg-zinc-950">
                {proxyUrl !== null && (
                  <video
                    ref={video}
                    src={proxyUrl}
                    muted={muted}
                    controls
                    playsInline
                    onTimeUpdate={onTimeUpdate}
                    onSeeked={onTimeUpdate}
                    className="absolute inset-0 size-full object-contain"
                  />
                )}
                {muted && (
                  <Badge
                    variant="outline"
                    className="absolute top-2 right-2 gap-1 bg-black/55 text-white backdrop-blur-sm"
                  >
                    <VolumeX className="size-3" aria-hidden />
                    <button type="button" onClick={() => setMuted(false)} className="underline">
                      son coupé
                    </button>
                  </Badge>
                )}
                {showsPassMarker && (
                  <Badge data-testid="pass-marker" variant="outline" className="absolute top-2 left-2 bg-black/55 text-white backdrop-blur-sm">
                    nouvelle passe
                  </Badge>
                )}
              </div>

              <p data-testid="stage-title" className="text-base font-medium">
                {currentClip.title || currentClip.id}
              </p>

              <div className="flex items-center gap-3 pb-2">
                <Button size="lg" onClick={() => decide('kept')}>
                  Garder
                </Button>
                <Button size="lg" variant="outline" onClick={() => decide('discarded')}>
                  Écarter
                </Button>
              </div>
            </>
          )}
        </>
      )}

      <HelpKeyboard open={help} onOpen={setHelp} />
    </div>
  )
}

const SHORTCUTS: readonly [string, string][] = [
  ['J / K / ←/→/↑/↓', 'clip suivant, précédent'],
  ['P', 'garder, et avancer d’un clip'],
  ['X', 'écarter, et avancer d’un clip'],
  ['U', 'défaire la dernière décision, et revenir sur son clip'],
  ['?', 'cette liste'],
]

function HelpKeyboard({ open, onOpen }: { open: boolean; onOpen: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Les raccourcis du tri</DialogTitle>
          <DialogDescription>Un clip à l’écran, quatre touches.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map(([key, effect]) => (
            <div key={key} className="contents">
              <dt className="font-mono text-xs text-muted-foreground">{key}</dt>
              <dd>{effect}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
