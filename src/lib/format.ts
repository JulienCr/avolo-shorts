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
