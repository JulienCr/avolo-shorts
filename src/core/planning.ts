/**
 * L'arithmétique du bandeau de planning, **pure** (spec §5.3).
 *
 * Sous la frontière de pureté outillée (`eslint.config.mjs`) : aucun import
 * hors `zod`, aucun global au-delà d'`es2023` — `Date` et `Intl` en font
 * partie, `fetch` et `process` non. Chaque fonction prend son instant de
 * référence en paramètre ; rien ici ne lit l'horloge, ce qui rend les tests
 * déterministes.
 *
 * **Pourquoi convertir explicitement plutôt que `new Date(string).getTime()`.**
 * Un `<input type="date">` rend `YYYY-MM-DD`, un champ libre rend `HH:MM`, et
 * les composer dans le fuseau du navigateur produirait une échéance fausse
 * dès que le serveur tourne sous un autre `TZ` — la même classe de bug que
 * `src/components/sources/texts.ts:61-90` corrige pour l'affichage. Ici c'est
 * la saisie qui doit être fixée à Europe/Paris, pas seulement la lecture.
 */

const PARIS_TZ = 'Europe/Paris'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toDateKey(utcCalendarDate: Date): string {
  return `${utcCalendarDate.getUTCFullYear()}-${pad(utcCalendarDate.getUTCMonth() + 1)}-${pad(utcCalendarDate.getUTCDate())}`
}

/** `key` + `days` jours civils, sans notion de fuseau — une addition de calendrier. */
export function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() + days)
  return toDateKey(date)
}

/** Le lundi de la semaine civile qui porte `key`. */
export function mondayOfWeekKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const weekday = date.getUTCDay() // 0 = dimanche
  const backToMonday = weekday === 0 ? -6 : 1 - weekday
  date.setUTCDate(date.getUTCDate() + backToMonday)
  return toDateKey(date)
}

/**
 * L'écart entre UTC et `timeZone` à l'instant `utcMs`, en millisecondes.
 *
 * La méthode standard : demander à `Intl` les champs civils de cet instant
 * dans le fuseau visé, les relire comme s'ils étaient UTC, et soustraire.
 * Elle est exacte partout sauf dans l'heure ambiguë ou absente du changement
 * d'heure lui-même, hors du périmètre de ce planning.
 */
function timeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs))

  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  const asIfUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  )
  return asIfUtc - utcMs
}

/**
 * `YYYY-MM-DD` + `HH:MM`, lus comme une heure locale d'Europe/Paris, rendus
 * en ms depuis l'époque. Couvre l'été (CEST, UTC+2) et l'hiver (CET, UTC+1).
 */
export function composeScheduledAt(dateKey: string, time: string): number {
  const [y, m, d] = dateKey.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const naiveUtc = Date.UTC(y, m - 1, d, hh, mm)
  return naiveUtc - timeZoneOffsetMs(naiveUtc, PARIS_TZ)
}

/** La clé civile Europe/Paris de l'instant `ms` — dans quel jour du bandeau il tombe. */
export function dayKeyFor(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PARIS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms))
  const field = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${field('year')}-${field('month')}-${field('day')}`
}

export type FiveWeekWindow = {
  /** Borne basse, incluse (ms). */
  from: number
  /** Borne haute, exclue (ms). */
  to: number
  /** Les trente-cinq jours du bandeau, lundi en premier. */
  days: readonly string[]
}

/**
 * Le bandeau de cinq semaines qui contient `referenceMs` (spec §5.3) : pas
 * une grille de mois, aucune rupture de fin septembre à début octobre.
 */
export function fiveWeekWindow(referenceMs: number): FiveWeekWindow {
  const monday = mondayOfWeekKey(dayKeyFor(referenceMs))
  const days = Array.from({ length: 35 }, (_, i) => addDaysToKey(monday, i))
  return {
    from: composeScheduledAt(days[0]!, '00:00'),
    to: composeScheduledAt(addDaysToKey(days[34]!, 1), '00:00'),
    days,
  }
}
