/**
 * Le compte de vignettes de la planche, partagé entre le client qui le
 * demande et le serveur qui le sert.
 *
 * **Pourquoi un compte variable.** Un compte fixe étirait la planche pour
 * couvrir une bande fluide (2,89 au lieu de 1,78, PR #292). Le client mesure
 * sa largeur rendue et demande le compte qui la couvrirait à 16:9 ; le
 * serveur borne cette demande — sans quoi elle dimensionnerait un tuilage
 * ffmpeg pour l'appelant.
 */

/** Le rapport d'une vignette, celui que le serveur génère. */
export const FILMSTRIP_ASPECT = 16 / 9

/**
 * Les bornes du compte accepté. **Un entier arrondi est déjà un petit
 * ensemble** — une largeur de bande continue s'y écrase sur une trentaine de
 * valeurs distinctes au plus, ce qui borne le nombre de planches mises en
 * cache par clip sans bucketiser une seconde fois.
 */
export const FILMSTRIP_COUNT_MIN = 6
export const FILMSTRIP_COUNT_MAX = 32

/** Utilisé faute de mesure — un rechargement avant le premier passage du
 * `ResizeObserver` côté client, ou une requête qui n'a pas dit `count`. */
export const FILMSTRIP_COUNT_DEFAULT = 12

function clampCount(count: number): number {
  return Math.min(FILMSTRIP_COUNT_MAX, Math.max(FILMSTRIP_COUNT_MIN, count))
}

/**
 * Le compte qui couvre une boîte de `widthPx` par `heightPx` à 16:9 par
 * vignette, sans l'étirer. Arrondi puis borné : le résidu d'arrondi reste sous
 * une demi-vignette, largement sous les 63 % d'écart mesurés avec un compte
 * fixe de douze.
 */
export function filmstripCountForBox(widthPx: number, heightPx: number): number {
  if (!(widthPx > 0) || !(heightPx > 0)) return FILMSTRIP_COUNT_DEFAULT
  return clampCount(Math.round(widthPx / (heightPx * FILMSTRIP_ASPECT)))
}

/**
 * Lit le compte demandé par la requête. **Toujours validé ici, jamais fait
 * confiance au client** : un entier hors bornes, ou qui n'en est pas un,
 * retombe sur `FILMSTRIP_COUNT_DEFAULT` plutôt que de lever — la planche reste
 * servie, seulement pas au meilleur rapport.
 */
export function parseFilmstripCount(raw: string | null): number {
  if (raw === null) return FILMSTRIP_COUNT_DEFAULT
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) return FILMSTRIP_COUNT_DEFAULT
  return clampCount(parsed)
}
