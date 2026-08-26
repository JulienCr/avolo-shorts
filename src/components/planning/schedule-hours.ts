/**
 * `publication.scheduleHours` : jusqu'à quatre `HH:MM`, du plus récent au
 * plus ancien (`src/lib/api.ts`, `PublicationSettings.scheduleHours`).
 *
 * Pas dans `@/core/planning` : ce module compose une chaîne de réglage
 * d'interface, pas une date — il n'a rien à faire sous la frontière de
 * pureté qui protège `src/core/`.
 */

export function parseScheduleHours(csv: string): string[] {
  return csv
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0)
}

/** Place `hour` en tête, sans doublon, borné à quatre entrées. */
export function pushScheduleHour(csv: string, hour: string): string {
  const hours = [hour, ...parseScheduleHours(csv).filter((h) => h !== hour)]
  return hours.slice(0, 4).join(',')
}
