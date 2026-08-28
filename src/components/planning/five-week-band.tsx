'use client'

import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ExternalLink } from 'lucide-react'

import { formatErrorDetail } from '@/core/publication-errors'
import { hasSchedulablePlatform, PLATFORM_LABELS, PLATFORMS, PUBLICATION_STATUS_LABELS } from '@/core/publication'
import { aggregatePublicationStatus, dayKeyFor, PLANNING_AGGREGATE_LABELS } from '@/core/planning'
import { keys } from '@/lib/queries'
import { publishClip, type PublicationDetail, type ScheduledEntry } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { formatDayLabel, formatDeadlineTime } from '@/components/planning/texts'
import { cn } from '@/lib/utils'

const FORMAT_ATTEMPT = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Europe/Paris',
})

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

/** Le ton du badge d'état agrégé — `failed` reste seul à porter le rouge plein. */
const AGGREGATE_BADGE_VARIANT = {
  planned: 'outline',
  failed: 'destructive',
  partial_failure: 'outline',
  published: 'secondary',
  submitted: 'secondary',
  in_progress: 'outline',
  partial: 'outline',
} as const

const STATUS_BADGE_VARIANT = {
  planned: 'secondary',
  in_progress: 'outline',
  submitted: 'secondary',
  published: 'secondary',
  failed: 'destructive',
} as const

/** Le statut seul, pour les fonctions pures de `@/core` qui n'ont pas besoin du reste. */
function statusesOnly(
  statuses: ScheduledEntry['statuses'],
): Record<(typeof PLATFORMS)[number], PublicationDetail['status'] | undefined> {
  const result = {} as Record<(typeof PLATFORMS)[number], PublicationDetail['status'] | undefined>
  for (const platform of PLATFORMS) result[platform] = statuses[platform]?.status
  return result
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

      {/* **Signale, ne bloque rien** (spec §5.3) : aucun contrôle désactivé,
          rien qui empêche la programmation de partir. L'ambre du produit,
          pas le rouge d'échec — un rendu périmé n'est pas une publication
          ratée, et partagerait sinon sa couleur avec ce qui, lui, bloque. */}
      {entry.stale && (
        <Badge variant="outline" className="w-fit border-stage/60 bg-stage/15 text-stage-foreground">
          rendu périmé
        </Badge>
      )}

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

function PlatformDetailRow({
  clipId,
  platform,
  detail,
}: {
  clipId: string
  platform: (typeof PLATFORMS)[number]
  detail: PublicationDetail
}) {
  const client = useQueryClient()
  const retry = useMutation({
    mutationFn: () => publishClip(clipId, [platform]),
    onSuccess() {
      void client.invalidateQueries({ queryKey: ['planning-schedule'] })
      // Même clé que `usePublisher` (`src/lib/queries.ts:942`) : sans elle,
      // `usePublications` sert le `failed` périmé pendant son `staleTime`.
      void client.invalidateQueries({ queryKey: keys.publications(clipId) })
    },
  })

  return (
    <div className="flex flex-col gap-0.5 rounded border px-1.5 py-1">
      <div className="flex items-center gap-1.5">
        <Badge variant={STATUS_BADGE_VARIANT[detail.status]} className="shrink-0">
          {PUBLICATION_STATUS_LABELS[detail.status]}
        </Badge>
        <span className="font-medium">{PLATFORM_LABELS[platform]}</span>
        {/* **`http`/`https` seulement**, même garde que `PlatformRecords`
            (`src/components/publication/publish-dialog.tsx`) : `remoteUrl`
            ne doit jamais devenir un `href` non vérifié. */}
        {detail.remoteUrl !== null && /^https?:\/\//.test(detail.remoteUrl) && (
          <a
            href={detail.remoteUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline"
          >
            <ExternalLink className="size-3" aria-hidden />
            <span className="sr-only">voir en ligne sur {PLATFORM_LABELS[platform]}</span>
          </a>
        )}
        <span className="ml-auto font-mono tabular-nums text-muted-foreground">
          {FORMAT_ATTEMPT.format(new Date(detail.updatedAt))}
        </span>
      </div>

      {/* **Le message brut, lisible sans survol** (`ui/tooltip.tsx`) : la
          raison d'un échec ne doit dépendre ni d'un `hover`, ni du clavier
          pour être découverte une fois le détail déplié. */}
      {detail.status === 'failed' && detail.error !== null && (
        <pre className="whitespace-pre-wrap break-words font-mono text-[0.7rem] text-destructive">
          {formatErrorDetail(detail.error)}
        </pre>
      )}

      {detail.status === 'failed' && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="w-fit"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
          aria-label={`Relancer ${PLATFORM_LABELS[platform]}`}
        >
          Relancer
        </Button>
      )}

      {/* Sans ça, un rendu périmé ou un connecteur indisponible réactive le
          bouton sans un mot : la relance semble n'avoir rien fait. */}
      {retry.isError && (
        <p role="alert" className="text-[0.7rem] text-destructive">
          {retry.error instanceof Error ? retry.error.message : 'La relance a échoué.'}
        </p>
      )}
    </div>
  )
}
