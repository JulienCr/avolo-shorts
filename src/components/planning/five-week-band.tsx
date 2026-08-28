'use client'

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'

import { hasSchedulablePlatform, PLATFORM_LABELS, PLATFORMS } from '@/core/publication'
import { aggregatePublicationStatus, dayKeyFor, PLANNING_AGGREGATE_LABELS, statusesOnly } from '@/core/planning'
import type { ScheduledEntry } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  AGGREGATE_BADGE_VARIANT,
  PlatformDetailRow,
  StaleRenderBadge,
} from '@/components/planning/publication-detail'
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
  const client = useQueryClient()
  // `usePlanningSchedule` ne sonde pas comme `usePublications` le fait — le
  // sondage vit donc ici, au lieu de toucher `src/lib/queries.ts` (gelé par
  // la PR #150 en cours). Même cadence (2 s) tant qu'une plateforme reste
  // `in_progress` après une relance.
  const hasInProgress = entries.some((entry) =>
    PLATFORMS.some((platform) => entry.statuses[platform]?.status === 'in_progress'),
  )
  useEffect(() => {
    if (!hasInProgress) return
    const id = setInterval(() => {
      void client.invalidateQueries({ queryKey: ['planning-schedule'] })
    }, 2_000)
    return () => clearInterval(id)
  }, [hasInProgress, client])
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
  const [detailOpen, setDetailOpen] = useState(false)
  const statusMap = statusesOnly(entry.statuses)
  // **Une carte par clip, pas une par plateforme** (point de contrôle du 26
  // août) : « on publiera sur toutes les plateformes en même temps », donc
  // un seul état résume les quatre lignes — `aggregatePublicationStatus`,
  // où seul un échec des quatre plateformes gagne seul.
  const aggregate = aggregatePublicationStatus(statusMap)
  const failedPlatforms = PLATFORMS.filter((platform) => entry.statuses[platform]?.status === 'failed')

  return (
    <div className="flex flex-col gap-1 rounded-md border bg-background px-2 py-1.5 text-xs">
      <div className="flex items-center gap-1.5">
        <span className="font-mono tabular-nums text-muted-foreground">
          {formatDeadlineTime(entry.scheduledAt)}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{entry.title || entry.clipId}</span>
      </div>

      {entry.stale && <StaleRenderBadge />}

      <Badge variant={AGGREGATE_BADGE_VARIANT[aggregate]} className="w-fit">
        {PLANNING_AGGREGATE_LABELS[aggregate]}
      </Badge>

      {failedPlatforms.length > 0 && (
        <Collapsible open={detailOpen} onOpenChange={setDetailOpen}>
          <CollapsibleTrigger
            render={
              <Button type="button" variant="ghost" size="xs" className="w-fit gap-1 px-1 text-destructive">
                <ChevronDown
                  aria-hidden
                  className={cn('size-3 transition-transform', detailOpen && 'rotate-180')}
                />
                {failedPlatforms.map((p) => PLATFORM_LABELS[p]).join(', ')} en échec
              </Button>
            }
          />
          <CollapsiblePanel className="flex flex-col gap-1.5 pt-1.5">
            {PLATFORMS.map((platform) => {
              const detail = entry.statuses[platform]
              if (detail === undefined) return null
              return <PlatformDetailRow key={platform} clipId={entry.clipId} platform={platform} detail={detail} />
            })}
          </CollapsiblePanel>
        </Collapsible>
      )}

      {hasSchedulablePlatform(statusMap) && (
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
