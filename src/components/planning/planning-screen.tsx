'use client'

import { useState } from 'react'
import Link from 'next/link'
import { CircleAlert, TriangleAlert } from 'lucide-react'

import { composeScheduledAt, fiveWeekWindow } from '@/core/planning'
import {
  usePlanningPool,
  usePlanningSchedule,
  useSaveSettings,
  useSchedulePublication,
  useSettings,
  useUnschedulePublication,
} from '@/lib/queries'
import { settingsLink } from '@/lib/navigation'
import { AppBar } from '@/components/navigation/app-bar'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { FiveWeekBand } from '@/components/planning/five-week-band'
import { PoolList } from '@/components/planning/pool-list'
import { pushScheduleHour } from '@/components/planning/schedule-hours'
import { ScheduleForm } from '@/components/planning/schedule-form'

/**
 * L'écran du planning (issue #195, spec §5.2-5.3).
 *
 * **Le sens de circulation est clip d'abord** : le vivier, puis la date, puis
 * le bandeau — une vue de contrôle, en lecture. Le calendrier lit
 * `publications`, jamais le vivier : un clip réédité qui retombe en `kept`
 * reste programmé, et partira quand même.
 */
export function PlanningScreen() {
  // **`Date.now()` en initialiseur paresseux, jamais pendant le rendu** : un
  // appel direct rendrait le composant impur — la même entrée n'y donnerait
  // pas la même sortie (`review/progress.tsx`, même règle).
  const [band] = useState(() => fiveWeekWindow(Date.now()))

  const pool = usePlanningPool()
  const schedule = usePlanningSchedule(band.from, band.to)
  const settings = useSettings()
  const saveSettings = useSaveSettings()
  const schedulePublication = useSchedulePublication()
  const unschedulePublication = useUnschedulePublication()

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  // **Réconciliée avec le vivier, jamais lue seule** — même règle que
  // `ReviewFeed` (`feed.tsx:173-181`) : un repérage forcé peut faire
  // disparaître un clip entre deux rendus, et la sélection ne doit pas
  // annoncer un compte qu'elle ne peut plus honorer.
  const poolClips = pool.data ?? []
  const selectedClips = poolClips.filter((c) => selected.has(c.clipId))

  function toggle(clipId: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(clipId)) next.delete(clipId)
      else next.add(clipId)
      return next
    })
  }

  function confirm(dateKey: string, time: string) {
    const scheduledAt = composeScheduledAt(dateKey, time)
    schedulePublication.mutate(
      { clipIds: selectedClips.map((c) => c.clipId), scheduledAt },
      { onSuccess: () => setSelected(new Set()) },
    )
    const hours = settings.data?.publication.scheduleHours ?? ''
    saveSettings.mutate({ publication: { scheduleHours: pushScheduleHour(hours, time) } })
  }

  const error =
    pool.error ?? schedule.error ?? schedulePublication.error ?? unschedulePublication.error ?? saveSettings.error
  const errorMessage = error instanceof Error ? error.message : 'Le serveur n’a pas répondu.'

  return (
    <div className="flex min-h-full flex-col">
      <AppBar lieu={{ kind: 'planning' }} />

      <main className="mx-auto flex w-full max-w-[110rem] flex-1 flex-col gap-6 px-6 py-6">
        <h1 className="text-lg font-semibold tracking-tight">Planning</h1>

        {error !== null && error !== undefined && (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertTitle>Une opération n’a pas abouti.</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        {/* Un état, pas une erreur : le drapeau est une décision assumée
            (`docs/publication-scheduler.md`), donc pas de variante destructive
            ni de bandeau qu'on referme — la tâche planifiée tourne quand même,
            elle n'écrit simplement rien tant que ce réglage est faux. */}
        {settings.data?.publication.autoPublish === false && (
          <Alert>
            <CircleAlert aria-hidden />
            <AlertTitle>Publication automatique désactivée.</AlertTitle>
            <AlertDescription>
              Les échéances programmées ci-dessous ne partiront pas tant que ce réglage reste
              coupé.{' '}
              <Link href={settingsLink('publication')}>Ouvrir les réglages de publication</Link>.
            </AlertDescription>
          </Alert>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Vivier</h2>
          <PoolList clips={poolClips} selected={selected} onToggle={toggle} />
        </section>

        {selectedClips.length > 0 && (
          <ScheduleForm
            count={selectedClips.length}
            scheduleHours={settings.data?.publication.scheduleHours ?? ''}
            minDate={band.days[0]!}
            maxDate={band.days[band.days.length - 1]!}
            pending={schedulePublication.isPending}
            onCancel={() => setSelected(new Set())}
            onConfirm={confirm}
          />
        )}

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Calendrier</h2>
          <FiveWeekBand
            days={band.days}
            entries={schedule.data ?? []}
            onUnschedule={(clipId) => unschedulePublication.mutate([clipId])}
          />
        </section>
      </main>
    </div>
  )
}
