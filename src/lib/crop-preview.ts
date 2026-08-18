/**
 * Le rectangle de cadrage, tel que l'écran de clip le dessine.
 *
 * **À rapatrier sur `@/core/framing` quand la tâche 5 l'aura livré.** Elle
 * portera `RATIOS`, `resolveRatio` et `cropRect`, qui font autorité et
 * travaillent en pixels ; ce module-ci travaille en fractions de la largeur
 * affichée, parce qu'un aperçu ne connaît pas la taille du conteneur au moment
 * du calcul. Les deux doivent dire la même chose — d'où les tests qui reprennent
 * les valeurs de la tâche 5.
 *
 * Le crop est **pleine hauteur** (spec §2) : dans une image 16:9, la hauteur est
 * toujours prise en entier et seule la position horizontale reste à décider.
 * C'est pourquoi il n'y a qu'un `cropX` et aucun `cropY`.
 */

import type { Ratio } from '@/core/edl'

/** Dans l'ordre du plus serré au plus large — celui du sélecteur à l'écran. */
export const RATIOS: Ratio[] = ['9:16', '4:5', '1:1', '16:9']

const VALEURS: Record<Ratio, number> = {
  '9:16': 9 / 16,
  '4:5': 4 / 5,
  '1:1': 1,
  '16:9': 16 / 9,
}

/** Le rapport d'aspect de la source : 1920x1080 sur toutes les émissions mesurées. */
export const ASPECT_SOURCE = 16 / 9

/**
 * `'auto'` vaut 9:16 en itération 0 : le cadrage automatique n'existe pas
 * encore. La même règle que `resolveRatio` de la tâche 5, et il faudra qu'elles
 * restent d'accord.
 */
export function previewRatio(ratio: Ratio | 'auto'): Ratio {
  return ratio === 'auto' ? '9:16' : ratio
}

/**
 * La largeur du rectangle, en fraction de la largeur de l'image source.
 *
 * Un 9:16 pleine hauteur couvre 31,6 % d'une image 16:9 — c'est la mesure qui
 * justifie tout le projet (spec §2). Un ratio plus large que la source est
 * ramené à 1 : on ne peut pas cadrer plus large que ce qu'on a filmé.
 */
export function cropWidthFraction(ratio: Ratio, aspectSource = ASPECT_SOURCE): number {
  return Math.min(1, VALEURS[ratio] / aspectSource)
}

/**
 * Ramène le centre du crop dans l'image.
 *
 * Le rectangle ne doit **jamais** sortir du cadre, quel que soit `cropX` — c'est
 * le même invariant que le test `cropRect` de la tâche 5. Un `cropX` de 0 ne
 * veut donc pas dire « collé au bord gauche du monde » mais « collé au bord
 * gauche de l'image », et le centre vaut alors la demi-largeur du rectangle.
 */
export function clampCropX(cropX: number, widthFraction: number): number {
  const demi = widthFraction / 2
  const valeur = Number.isFinite(cropX) ? cropX : 0.5
  return Math.min(1 - demi, Math.max(demi, valeur))
}

/** Le bord gauche du rectangle, en fraction de la largeur — ce que dessine le CSS. */
export function cropLeftFraction(cropX: number, widthFraction: number): number {
  return clampCropX(cropX, widthFraction) - widthFraction / 2
}
