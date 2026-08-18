/**
 * Le cadrage : d'un ratio et d'une position horizontale vers un rectangle de
 * crop, et vers une taille de sortie.
 *
 * **Le crop est pleine hauteur** (spec §2). Dans une image 16:9, la hauteur est
 * toujours prise en entier et seule la position horizontale reste à décider —
 * d'où `cropX`, un seul nombre, et non un rectangle à quatre composantes. Et le
 * crop est **fixe à l'intérieur d'un plan** : rien ici ne dépend du temps, la
 * caméra ne suit personne.
 *
 * Ce module ne calcule que de la géométrie. Le choix du ratio et de `cropX`
 * appartient à l'humain en itération 0, et au cadrage automatique en
 * itération 1 — qui viendra alimenter ces mêmes fonctions, sans les changer.
 */

import type { Ratio } from '@/core/edl'

/**
 * La largeur pour une hauteur de 1. C'est la seule grandeur dont la géométrie
 * ait besoin : les noms `9:16` et compagnie sont des étiquettes de produit.
 */
export const RATIOS: Readonly<Record<Ratio, number>> = {
  '9:16': 9 / 16,
  '4:5': 4 / 5,
  '1:1': 1,
  '16:9': 16 / 9,
}

/**
 * `Clip.ratio` vaut `Ratio | 'auto'`, mais tout ce qui rend a besoin d'un
 * `Ratio` : `'auto'` n'est pas une géométrie, c'est une intention.
 *
 * **En itération 0, `'auto'` vaut `9:16`** : le cadrage automatique n'existe
 * pas encore (spec §4). Cette fonction est le seul endroit où cette valeur par
 * défaut est écrite — l'itération 1 la remplacera par une vraie décision, et
 * elle n'aura qu'un fichier à toucher.
 *
 * Sans elle, le rendu recevrait `'auto'` et échouerait sur une clé de `RATIOS`
 * qui n'existe pas.
 */
export function resolveRatio(r: Ratio | 'auto'): Ratio {
  return r === 'auto' ? '9:16' : r
}

/**
 * Les dimensions de la vidéo produite. 1080 pixels sur le petit côté : c'est ce
 * que les plateformes verticales servent, et monter plus haut ne fait grossir le
 * fichier que pour être redescendu chez elles.
 */
const TAILLES: Readonly<Record<Ratio, { w: number; h: number }>> = {
  '9:16': { w: 1080, h: 1920 },
  '4:5': { w: 1080, h: 1350 },
  '1:1': { w: 1080, h: 1080 },
  '16:9': { w: 1920, h: 1080 },
}

export function outputSize(ratio: Ratio): { w: number; h: number } {
  // Une copie : la table est une constante du module, et l'appelant passe le
  // résultat à `renderArgs`, qui n'a aucune raison de pouvoir la modifier.
  return { ...TAILLES[ratio] }
}

/** Le pair immédiatement inférieur ou égal, jamais négatif. */
function pairInférieur(n: number): number {
  return Math.max(0, Math.floor(n / 2) * 2)
}

/** Le pair le plus proche. 607,5 → 608. */
function pairProche(n: number): number {
  return Math.max(0, Math.round(n / 2) * 2)
}

function borner(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), Math.max(min, max))
}

/**
 * Le rectangle à découper dans l'image source pour obtenir `ratio`.
 *
 * `cropX` est le **centre** du rectangle, entre 0 et 1 : `0.5` centre, `0`
 * colle à gauche, `1` à droite. Une valeur hors de [0, 1] est bornée plutôt que
 * propagée — elle arrive d'un curseur d'interface ou d'une base, et un
 * rectangle hors cadre ferait échouer ffmpeg au lieu de rogner.
 *
 * **Deux invariants, et les deux sont payés par une mesure ou par un échec :**
 *
 * - *Le rectangle reste dans l'image*, quel que soit `cropX`.
 * - *Toutes les composantes sont paires.* libx264 refuse une dimension impaire
 *   en yuv420p, et une origine impaire décale le plan de chrominance, qui est
 *   sous-échantillonné d'un facteur deux.
 *
 * La hauteur est prise en entier — c'est la règle. Sur une source trop étroite
 * pour que la pleine hauteur tienne (un 4:3, un portrait), c'est la largeur qui
 * borne et le rectangle est centré verticalement : le ratio demandé est
 * conservé dans tous les cas.
 */
export function cropRect(
  ratio: Ratio,
  cropX: number,
  srcW: number,
  srcH: number,
): { w: number; h: number; x: number; y: number } {
  // Les dimensions de la source viennent de `ffprobe` ou de la base. Sans
  // cette garde, un `NaN` se propage à toutes les composantes du rectangle et
  // n'est attrapé que bien plus loin, par `renderArgs`, sous la forme
  // « crop.w doit être un nombre fini » — un message qui désigne le symptôme
  // et cache la cause.
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH)) {
    throw new Error(
      `cropRect : dimensions de source invalides (${String(srcW)}x${String(srcH)}).`,
    )
  }

  const cible = RATIOS[ratio]
  const maxW = pairInférieur(srcW)
  const maxH = pairInférieur(srcH)

  let h = maxH
  let w = pairProche(h * cible)
  if (w > maxW) {
    w = maxW
    h = Math.min(pairProche(w / cible), maxH)
  }

  // `Number.isFinite` : `cropX` vient de la base et de l'interface. Un `NaN`
  // traverserait tout le calcul sans erreur et sortirait en `crop=608:1080:NaN:0`,
  // que ffmpeg refuse avec un message qui ne nomme pas la cause.
  const centre = Number.isFinite(cropX) ? borner(cropX, 0, 1) : 0.5

  return {
    w,
    h,
    x: pairInférieur(borner(Math.round(centre * srcW - w / 2), 0, srcW - w)),
    y: pairInférieur(borner(Math.round((srcH - h) / 2), 0, srcH - h)),
  }
}
