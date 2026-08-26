'use client'

import { useState } from 'react'

import { hasSchedulablePlatform, PLATFORM_LABELS, PUBLICATION_STATUS_LABELS } from '@/core/publication'
import { dayKeyFor } from '@/core/planning'
import type { ScheduledEntry } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatDayLabel, formatDeadlineTime } from '@/components/planning/texts'
import { cn } from '@/lib/utils'

/**
 * Le bandeau de cinq semaines, en lecture (spec §5.3).
 *
 * **Il ne gouverne rien** : il lit `publications`, jamais le vivier. Un clip
 * réédité qui retombe en `kept` reste sur ce bandeau et partira quand même —
 * l'inverse serait la régression silencieuse que la conception nomme.
 */
export function FiveWeekBand({
  days,
  entries,
  onUnschedule,
}: {
  days: readonly string[]
  entries: readonly ScheduledEntry[]
  onUnschedule: (clipId: string) => void
}) {
  // Initialiseur paresseux : `Date.now()` pendant le rendu rendrait le
  // composant impur (même règle que `PlanningScreen`).
  const [today] = useState(() => dayKeyFor(Date.now()))
  const byDay = new Map<string, ScheduledEntry[]>()
  for (const entry of entries) {
    const key = dayKeyFor(entry.scheduledAt)
    const bucket = byDay.get(key)
    if (bucket) bucket.push(entry)
    else byDay.set(key, [entry])
  }

  const weeks: (readonly string[])[] = []
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7))

  return (
    <div className="flex flex-col gap-2">
      {weeks.map((week) => (
        <div key={week[0]} className="grid grid-cols-1 gap-2 sm:grid-cols-7">
          {week.map((day) => (
            <div
              key={day}
              className={cn(
                'flex min-h-24 flex-col gap-1.5 rounded-lg border bg-card p-2',
                day === today && 'border-stage/60',
              )}
            >
              <p
                className={cn(
                  'text-xs font-medium capitalize text-muted-foreground',
                  day === today && 'text-foreground',
                )}
              >
                {formatDayLabel(day)}
              </p>
              {(byDay.get(day) ?? []).map((entry) => (
                <DeadlineCard key={entry.clipId} entry={entry} onUnschedule={onUnschedule} />
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function DeadlineCard({
  entry,
  onUnschedule,
}: {
  entry: ScheduledEntry
  onUnschedule: (clipId: string) => void
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-background px-2 py-1.5 text-xs">
      <div className="flex items-center gap-1.5">
        <span className="font-mono tabular-nums text-muted-foreground">
          {formatDeadlineTime(entry.scheduledAt)}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{entry.title || entry.clipId}</span>
      </div>

      {/* **Signale, ne bloque rien** (spec §5.3) : aucun contrôle désactivé,
          rien qui empêche la programmation de partir. */}
      {entry.stale && (
        <Badge variant="destructive" className="w-fit">
          rendu périmé
        </Badge>
      )}

      <div className="flex flex-wrap gap-1">
        {Object.entries(entry.statuses).map(([platform, status]) => (
          <Badge key={platform} variant="outline" className="w-fit">
            {PLATFORM_LABELS[platform as keyof typeof PLATFORM_LABELS]} · {PUBLICATION_STATUS_LABELS[status]}
          </Badge>
        ))}
      </div>

      {hasSchedulablePlatform(entry.statuses) && (
        <Button
          variant="ghost"
          size="xs"
          className="self-start text-muted-foreground"
          onClick={() => onUnschedule(entry.clipId)}
        >
          Déprogrammer
        </Button>
      )}
    </div>
  )
}
