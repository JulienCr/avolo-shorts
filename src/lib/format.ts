import type { DurationRange } from '@/core/phase'

/**
 * Les nombres tels qu'on les lit à l'écran.
 *
 * La durée d'un clip est **une information, jamais une contrainte** : elle
 * s'affiche, elle bouge pendant qu'on monte, et rien ne la plafonne. Elle est
 * donc rendue en chiffres tabulaires partout où elle bouge, sinon la mise en
 * page tressaute à chaque coupe.
 */

/**
 * Une durée, en `m:ss` — et en `h:mm:ss` dès qu'il y a une heure.
 *
 * Les durées sont arrondies à la seconde : au-delà, la précision est du bruit
 * pour l'œil. Une valeur absente ou aberrante rend `0:00` plutôt que `NaN:aN` —
 * l'interface affiche une durée nulle, elle ne se casse pas.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'

  const total = Math.round(seconds)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)

  const ss = String(s).padStart(2, '0')
  if (h === 0) return `${m}:${ss}`
  return `${h}:${String(m).padStart(2, '0')}:${ss}`
}

/**
 * Une étendue courte : ce qu'une sélection de mots s'apprête à retirer.
 *
 * `formatDuration` ne convient pas ici — elle arrondit à la seconde, et trois
 * mots retirés s'y affichent « 0:00 », ce qui ressemble à une panne. Sous la
 * minute on donne donc le dixième de seconde, et au-delà on repasse en `m:ss`,
 * où le dixième ne renseigne plus personne.
 */
export function formatSpan(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s'
  if (seconds < 60) return `${seconds.toFixed(1).replace('.', ',')} s`
  return formatDuration(seconds)
}

/**
 * Une position dans la source, en `h:mm:ss`.
 *
 * Toujours les trois champs, contrairement à `formatDuration` : ces valeurs se
 * comparent entre elles d'une carte à l'autre, et une colonne de positions dont
 * la largeur change ne se lit pas.
 */
export function formatTimecode(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * Une durée annoncée, telle qu'on l'écrit à quelqu'un qui attend.
 *
 * **Deux bornes arrondies, jamais une seconde près.** C'est la demande du §4.2
 * du retour d'usage, mot pour mot : « environ 2–3 min » plutôt que « 2 min 17 s
 * restantes ». La raison est dans `DurationRange` — chaque étape n'a été
 * chronométrée qu'une fois, sur une machine à 40-80 % de variance.
 *
 * `null` rend la **chaîne vide**, et pas un texte d'excuse : c'est la règle déjà
 * tenue depuis toujours par ce panneau : on n'affiche rien plutôt qu'une estimation
 * qui n'est adossée à rien. L'appelant teste la chaîne et n'affiche pas la ligne.
 *
 * Sous la minute on ne chiffre pas non plus. L'extraction audio coûte six
 * secondes sur une émission d'1 h 40 : « environ 0–1 min » serait ridicule, et
 * « 4–8 s » promettrait une précision qu'une mesure unique ne porte pas.
 */
export function formatDurationRange(range: DurationRange | null): string {
  if (range === null) return ''
  const low = Number.isFinite(range.lowSec) ? Math.max(0, range.lowSec) : 0
  const high = Number.isFinite(range.highSec) ? Math.max(low, range.highSec) : 0
  if (high <= 0) return ''
  if (high < 60) return 'moins d’une minute'

  // **Les deux bornes s'arrondissent au plus proche, pas l'une vers le bas et
  // l'autre vers le haut.** Un arrondi divergent élargit la fourchette d'une
  // minute à chaque bout, systématiquement : une estimation de 119 à 121
  // secondes — deux secondes d'écart — ressortait en « environ 1–3 min », qui
  // annonce une incertitude trois fois plus grande que celle qu'on a calculée.
  // Or c'est justement ce nombre-là qui doit rester honnête.
  //
  // Le plancher à une minute évite « environ 0–2 min », qui promet une fin
  // immédiate.
  const lowMin = Math.max(1, Math.round(low / 60))
  const highMin = Math.max(lowMin, Math.round(high / 60))
  if (lowMin === highMin) return `environ ${lowMin} min`
  return `environ ${lowMin}–${highMin} min`
}
