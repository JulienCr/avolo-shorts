/**
 * Le rectangle de cadrage, tel que l'écran de clip le dessine.
 *
 * **La géométrie fait autorité dans `@/core/framing`**, qui travaille en pixels
 * et que le rendu appelle. Ce module ne fait que la traduire en fractions de la
 * largeur affichée, parce qu'un aperçu ne connaît pas la taille de son
 * conteneur au moment du calcul — il la laisse au CSS. Rien n'est redéfini ici :
 * `RATIOS` et `resolveRatio` viennent de là-bas, et un test vérifie que le
 * rectangle dessiné est bien celui que ffmpeg découpera.
 *
 * Le crop est **pleine hauteur** (spec §2) : dans une image 16:9, la hauteur est
 * toujours prise en entier et seule la position horizontale reste à décider.
 * C'est pourquoi il n'y a qu'un `cropX` et aucun `cropY`.
 */

import type { Ratio } from '@/core/edl'
import { RATIOS } from '@/core/framing'

/** Dans l'ordre du plus serré au plus large — celui du sélecteur à l'écran. */
export const ORDRE_RATIOS: Ratio[] = ['9:16', '4:5', '1:1', '16:9']

/** Le rapport d'aspect de la source : 1920x1080 sur toutes les émissions mesurées. */
export const ASPECT_SOURCE = 16 / 9

/**
 * La largeur du rectangle, en fraction de la largeur de l'image source.
 *
 * Un 9:16 pleine hauteur couvre 31,6 % d'une image 16:9 — c'est la mesure qui
 * justifie tout le projet (spec §2). Un ratio plus large que la source est
 * ramené à 1 : on ne peut pas cadrer plus large que ce qu'on a filmé, et
 * `cropRect` fait la même chose en pixels.
 */
export function cropWidthFraction(ratio: Ratio, aspectSource = ASPECT_SOURCE): number {
  return Math.min(1, RATIOS[ratio] / aspectSource)
}

/**
 * Ramène le centre du crop dans l'image.
 *
 * Le rectangle ne doit **jamais** sortir du cadre, quel que soit `cropX` — le
 * même invariant que `cropRect`. Un `cropX` de 0 ne veut donc pas dire « collé
 * au bord gauche du monde » mais « collé au bord gauche de l'image », et le
 * centre vaut alors la demi-largeur du rectangle.
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
