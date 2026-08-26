/**
 * Les textes de l'écran de planning.
 *
 * **Premier écran à afficher une date absolue, et donc premier précédent.**
 * `src/components/sources/texts.ts:61-90` explique pourquoi le fuseau se fixe
 * ici plutôt que de suivre celui du navigateur ou du serveur — le même
 * raisonnement s'applique, sans second exemple à suivre.
 *
 * `@/lib/format` porte ce qui traverse plusieurs écrans (`formatDuration`) ;
 * ce fichier porte le vocabulaire propre à celui-ci.
 */

const PARIS_TZ = 'Europe/Paris'

/** Construit une fois : le bandeau appelle ce formateur pour chacun des trente-cinq jours. */
const FORMAT_DAY = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: PARIS_TZ,
})

const FORMAT_TIME = new Intl.DateTimeFormat('fr-FR', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: PARIS_TZ,
})

/** `YYYY-MM-DD` (une clé du bandeau) affiché en « lun. 5 août ». */
export function formatDayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return FORMAT_DAY.format(new Date(Date.UTC(y, m - 1, d, 12)))
}

/** Une échéance (ms) affichée en heure de Paris. */
export function formatDeadlineTime(ms: number): string {
  return FORMAT_TIME.format(new Date(ms))
}

/**
 * L'émission dont vient un clip, lue depuis l'identifiant de son projet.
 *
 * **Pas d'appel réseau supplémentaire** : le vivier est transversal aux
 * émissions et ne charge que `PlanningPoolClip`, sans le titre du projet. Un
 * identifiant de projet commence par sa date de tournage
 * (`docs/superpowers/specs/2026-08-26-publication-scheduling-design.md §5.3`),
 * ce qui suffit à situer le clip sans requête de plus — le nom qui suit sert
 * de repère quand deux émissions tombent le même jour.
 */
export function formatShowOrigin(projectId: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(.+)$/.exec(projectId)
  if (match === null) return projectId
  const [, y, m, d, rest] = match
  const label = FORMAT_DAY.format(new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 12)))
  return `${label} · ${rest}`
}
