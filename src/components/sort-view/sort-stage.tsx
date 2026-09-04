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
 * **A second presentation of `useSortLoop`, not a second loop.** The grid
 * (`ReviewFeed`) mounts one card per visible clip; this mounts one video for
 * whichever clip is `current`. Both drive the same frozen queue, the same
 * decide/move/undo, because `useSortLoop` is layout-agnostic by design.
 *
 * **`attemptFocus` never races the clip it targets.** The grid needs the
 * *new* current card's DOM node to exist before it can focus it — issue #323
 * — because each card is its own node. Here there is exactly one node for
 * the whole screen, independent of which clip is current: focusing it is
 * never conditional on a clip having mounted, so the race issue #323
 * describes cannot occur on this surface.
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

  // **A marker only when the queue actually mixes passes.** A queue made of
  // a single pass would mark every clip, and a marker every item carries is
  // not a marker — it is a background.
  const passes = new Set(visible.map((c) => c.pass))
  const earliestPass = Math.min(...passes)
  const showsPassMarker = passes.size > 1 && currentClip !== null && currentClip.pass > earliestPass

  // **Seek and play on every clip change, never inside the `timeupdate`
  // handler below.** `clipBounds` is the extent this candidate covers;
  // `playbackAction` (the same pure helper `ClipPlayer` uses) is what skips
  // a removed passage instead of playing straight through it.
  useEffect(() => {
    const el = video.current
    const bounds = currentClip === null ? null : clipBounds(currentClip.segments)
    if (el === null || bounds === null) return
    el.currentTime = bounds.start
    // **Unmuted first, muted on `NotAllowedError`.** A click on the review
    // grid's card carries the gesture into this screen; a direct link to
    // `/sort` has none, and the browser refuses unmuted autoplay without
    // one. Falling back to muted keeps the video always playing — a silent
    // failure to play is the outcome this guards against, not the sound.
    el.play().catch(() => {
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

  if (done) {
    return (
      <LoopEnd projectId={projectId} clips={clips} durationKept={count(clips).durationKept} next={next} />
    )
  }

  return (
    <div
      ref={stage}
      tabIndex={-1}
      className="flex flex-1 flex-col items-center justify-center gap-4 outline-none"
    >
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
          <div className="relative aspect-video w-full max-w-3xl overflow-hidden rounded-xl bg-zinc-950">
            {proxyUrl !== null && (
              <video
                ref={video}
                src={proxyUrl}
                muted={muted}
                playsInline
                onTimeUpdate={onTimeUpdate}
                onSeeked={onTimeUpdate}
                className="size-full object-contain"
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

          <div className="flex items-center gap-3">
            <Button size="lg" variant="outline" onClick={() => decide('discarded')}>
              Écarter
            </Button>
            <Button size="lg" onClick={() => decide('kept')}>
              Garder
            </Button>
          </div>
        </>
      )}

      <HelpKeyboard open={help} onOpen={setHelp} />
    </div>
  )
}

const SHORTCUTS: readonly [string, string][] = [
  ['J / K', 'clip suivant, précédent'],
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
