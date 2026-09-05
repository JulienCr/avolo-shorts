'use client'

import { ApiError } from '@/lib/api'
import { useProject, useRequestMoreClips } from '@/lib/queries'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

const REASON_IN_CURRENT = 'Une exécution est déjà en cours ; la demande sera possible à sa fin.'

/**
 * The bridge to the second sweep pass — the only way to reach it.
 *
 * **Three states, read from `ProjectStatus` alone**: `moreClips.exhausted`
 * says the replay is spent, `running` says an execution is already in flight
 * (this tab's or another one's), and the absence of both renders the buttons.
 * No state is inferred from anything else — not the clip list, not the loop.
 */
export function MoreClips({ projectId }: { projectId: string }) {
  const project = useProject(projectId)
  const moreClips = useRequestMoreClips()

  const status = project.data
  if (status === undefined) return null

  if (status.moreClips?.exhausted === true) {
    return (
      <p className="mt-4 max-w-prose text-sm text-muted-foreground">
        Tout le replay a été exploré ; un nouveau repérage n’ajoutera rien de plus.
      </p>
    )
  }

  const inCurrent = status.running !== null
  const blocked = inCurrent || moreClips.isPending

  const ask = (count: 5 | 10) => {
    if (blocked) return
    moreClips.mutate({ projectId, count })
  }

  return (
    <div className="mt-4 flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          aria-disabled={blocked}
          aria-label="Demander 5 clips supplémentaires"
          onClick={() => ask(5)}
        >
          +5
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-disabled={blocked}
          aria-label="Demander 10 clips supplémentaires"
          onClick={() => ask(10)}
        >
          +10
        </Button>
      </div>
      <Reason blocked={blocked} inCurrent={inCurrent} />
      <MoreClipsFailure error={moreClips.error} inCurrent={inCurrent} />
    </div>
  )
}

/** Same idiom as `retry.tsx`'s `Reason`: only a running execution names itself. */
function Reason({ blocked, inCurrent }: { blocked: boolean; inCurrent: boolean }) {
  if (!blocked) return null
  return (
    <p data-testid="reason-more-clips" className="max-w-xs text-xs text-muted-foreground">
      {inCurrent ? REASON_IN_CURRENT : 'Demande en cours d’envoi.'}
    </p>
  )
}

/**
 * A failed +N request. A 409 is a lost race, not a breakdown (same reasoning
 * as `RetryFailure` in `retry.tsx`); the two 400s and the 404 render the
 * server's message as-is — it is already the right sentence.
 *
 * @param inCurrent Whether the project still shows a running execution — a
 * 409 recorded before it ended would otherwise claim one is still in flight.
 */
function MoreClipsFailure({ error, inCurrent }: { error: Error | null; inCurrent: boolean }) {
  if (error === null) return null
  const conflict = error instanceof ApiError && error.status === 409
  if (conflict && !inCurrent) return null
  return (
    <Alert variant="destructive" className="max-w-sm">
      <AlertDescription>
        {conflict
          ? 'Une exécution tourne déjà sur ce projet ; l’écran la suivra dès qu’elle se signalera.'
          : error.message}
      </AlertDescription>
    </Alert>
  )
}
