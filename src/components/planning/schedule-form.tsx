'use client'

import { useId, useState } from 'react'

import { dayKeyFor } from '@/core/planning'
import { parseScheduleHours } from '@/components/planning/schedule-hours'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/**
 * L'entrée de date/heure, apparue avec la sélection (spec §5.3).
 *
 * **Un `<input type="date">`, jamais un composant de calendrier** — il n'y en
 * a pas dans le dépôt, et il n'en faut pas. Les heures mémorisées sont des
 * raccourcis, pas des bornes : le champ libre reste toujours actionnable.
 */
export function ScheduleForm({
  count,
  scheduleHours,
  minDate,
  maxDate,
  pending,
  onCancel,
  onConfirm,
}: {
  count: number
  /** `publication.scheduleHours`, brut — jusqu'à quatre `HH:MM`, du plus récent au plus ancien. */
  scheduleHours: string
  /** Premier et dernier jour du bandeau affiché (`YYYY-MM-DD`) — le calendrier
   * ne montre que ces cinq semaines, une date hors bornes y serait invisible. */
  minDate: string
  maxDate: string
  pending: boolean
  onCancel: () => void
  onConfirm: (dateKey: string, time: string) => void
}) {
  const dateId = useId()
  const timeId = useId()
  const hours = parseScheduleHours(scheduleHours)
  const [date, setDate] = useState(() => dayKeyFor(Date.now()))
  const [time, setTime] = useState(() => hours[0] ?? '19:00')
  // Tant que l'utilisateur n'a rien choisi, suit le raccourci le plus récent
  // — au montage, les réglages n'ont pas toujours fini de charger, et
  // `scheduleHours` arrive après le premier rendu. Ajustement pendant le
  // rendu (pas d'effet) : le motif React pour « resynchroniser un état
  // dérivé d'une prop qui change ».
  const [touched, setTouched] = useState(false)
  const [lastHour, setLastHour] = useState(hours[0])
  if (!touched && hours[0] !== lastHour) {
    setLastHour(hours[0])
    if (hours[0] !== undefined) setTime(hours[0])
  }

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/40 px-3 py-2">
      <p className="w-full text-sm sm:w-auto">
        {count === 1 ? '1 clip sélectionné' : `${count} clips sélectionnés`}
      </p>

      <div className="flex flex-col gap-1">
        <Label htmlFor={dateId} className="text-xs text-muted-foreground">
          Date
        </Label>
        <Input
          id={dateId}
          type="date"
          value={date}
          min={minDate}
          max={maxDate}
          onChange={(e) => setDate(e.target.value)}
          className="w-36"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={timeId} className="text-xs text-muted-foreground">
          Heure
        </Label>
        <Input
          id={timeId}
          type="time"
          value={time}
          onChange={(e) => {
            setTouched(true)
            setTime(e.target.value)
          }}
          className="w-24"
        />
      </div>

      {hours.length > 0 && (
        <div className="flex items-center gap-1">
          {hours.map((h) => (
            <Button
              key={h}
              type="button"
              variant={h === time ? 'default' : 'outline'}
              size="sm"
              className={cn('font-mono tabular-nums')}
              onClick={() => {
                setTouched(true)
                setTime(h)
              }}
            >
              {h}
            </Button>
          ))}
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Annuler la sélection
        </Button>
        <Button
          size="sm"
          disabled={pending || date === '' || time === '' || date < minDate || date > maxDate}
          onClick={() => onConfirm(date, time)}
        >
          Programmer {count === 1 ? '1 clip' : `${count} clips`}
        </Button>
      </div>
    </div>
  )
}
