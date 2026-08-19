/**
 * Les plans et les boîtes de personnes — ce que l'analyse vidéo rend au cadrage.
 *
 * Ce module ne détecte rien : la détection tourne dans le worker, sur le proxy,
 * et dépose son résultat en JSON. Ici vivent la **forme** de ce résultat et ce
 * qui ne dépend que de lui — désigner un plan de façon stable, savoir lesquels
 * un clip traverse, et poser une coupe sur une frontière.
 *
 * Le serveur valide le JSON de l'analyse avec son propre schéma zod, et ces
 * types-ci le redisent. La redondance est délibérée et temporaire : les deux
 * s'écrivent en parallèle, et les coudre ensemble maintenant coûterait un
 * conflit pour une économie de dix lignes.
 */

import { normalizeSegments } from '@/core/edl'
import type { Segment } from '@/core/edl'

/**
 * Une boîte de personne, en **fractions** de la largeur et de la hauteur, jamais
 * en pixels : la détection tourne sur le proxy 960x540 et le rendu croppe
 * l'original 1920x1080. Des pixels obligeraient chaque appelant à savoir de
 * quelle image ils viennent.
 */
export type PersonBox = {
  /** Instant dans la source, en secondes. */
  t: number
  /** Bord gauche, fraction de la largeur, 0 à 1. */
  x0: number
  /** Bord droit. */
  x1: number
  /** Bord haut, fraction de la hauteur. */
  y0: number
  /** Bord bas. */
  y1: number
  /** Confiance du détecteur, 0 à 1. */
  score: number
  /**
   * Les dix-sept points COCO de cette personne, `x, y, confiance` mis bout à
   * bout — nez, yeux, oreilles, épaules, coudes, poignets, hanches, genoux,
   * chevilles, dans cet ordre. Absents quand la détection a tourné sur un
   * modèle de détection et non de pose.
   *
   * **Ils ne remplacent pas la boîte, ils s'ajoutent à elle.** Le filtre du
   * public au premier plan lit la géométrie de la boîte — bord bas et hauteur —
   * et un squelette ne dit pas si le bas de l'image a tronqué quelqu'un.
   *
   * Les coordonnées **ne sont pas bornées à [0, 1]** : un point hors cadre est
   * une information, là où une boîte hors cadre ne désigne plus rien.
   */
  k?: number[]
}

/**
 * Les points COCO qui nous intéressent, par leur rang dans `PersonBox.k`.
 *
 * L'ordre est celui du jeu COCO, sur lequel tous les modèles `-pose` de la
 * famille YOLO sont entraînés : 0 nez, 1-2 yeux, 3-4 oreilles, 5-6 épaules,
 * 7-8 coudes, 9-10 poignets, 11-12 hanches, 13-14 genoux, 15-16 chevilles.
 *
 * Nommés parce qu'un `k[10]` dans une expression de cadrage ne se relit pas, et
 * qu'une erreur d'un rang y désigne un poignet là où on voulait une hanche —
 * sans rien casser, juste en élargissant.
 */
export const POINT = Object.freeze({
  NOSE: 0,
  LEFT_EYE: 1,
  RIGHT_EYE: 2,
  LEFT_EAR: 3,
  RIGHT_EAR: 4,
  LEFT_SHOULDER: 5,
  RIGHT_SHOULDER: 6,
  LEFT_ELBOW: 7,
  RIGHT_ELBOW: 8,
  LEFT_WRIST: 9,
  RIGHT_WRIST: 10,
  LEFT_HIP: 11,
  RIGHT_HIP: 12,
  LEFT_KNEE: 13,
  RIGHT_KNEE: 14,
  LEFT_ANKLE: 15,
  RIGHT_ANKLE: 16,
})

/** Le nombre de points d'un squelette COCO. `k` fait trois fois cette longueur. */
export const POINT_COUNT = 17

/** Un plan : un intervalle continu de la source, sans changement d'axe. */
export type Shot = { start: number; end: number }

/**
 * La clé qui désigne un plan, et le point qui se paie en bug silencieux si on le
 * rate.
 *
 * Les crops se recalculent depuis l'EDL et ne sont pas stockés. **Une dérogation
 * humaine indexée sur le rang du plan dans le clip se décale dès qu'on modifie
 * le montage** : retirer un segment en amont décale tous les rangs, les
 * dérogations atterrissent sur les mauvais plans, et rien ne le signale — ni
 * erreur, ni avertissement, juste un cadrage devenu faux.
 *
 * La clé désigne donc le plan **dans la source**. C'est déjà la doctrine du
 * dépôt : les identifiants de clip sont dérivés des bornes
 * (`<projet>_<startMs>-<endMs>`) et jamais d'un compteur, pour la même raison —
 * voir `mergeCandidates`.
 *
 * La milliseconde plutôt que la seconde flottante : une clé sert d'index dans un
 * objet JSON, et deux écritures de `10.400000000000001` ne se retrouvent pas.
 */
export function shotStartMs(shot: Shot): number {
  return Math.round(shot.start * 1000)
}

/**
 * Les plans que le clip traverse, dans l'ordre de la source.
 *
 * **Les bornes rendues sont celles de la source, jamais rognées sur le segment
 * qui les traverse.** Rogner changerait `shotStartMs`, donc décrocherait toutes
 * les dérogations posées sur ce plan au premier ajustement de montage — le bug
 * silencieux que la clé existe précisément pour éviter.
 *
 * Un plan qui ne fait que toucher une borne de segment n'a aucune image en
 * commun avec lui : il ne compte pas.
 */
export function shotsForSegments(shots: Shot[], segments: Segment[]): Shot[] {
  const segs = normalizeSegments(segments)
  return shots
    .filter((shot) => segs.some((s) => Math.min(shot.end, s.end) > Math.max(shot.start, s.start)))
    .map((shot) => ({ ...shot }))
    .sort((a, b) => a.start - b.start)
}

/**
 * La tolérance par défaut de `snapToShots`, en secondes.
 *
 * Un ordre de grandeur, pas une mesure : c'est à peu près la longueur de la
 * pause que la délimitation vise déjà (spec §8). Au-delà, déplacer la borne
 * commence à mordre sur un mot, et le bénéfice — cacher la coupe derrière un
 * changement d'axe — ne vaut plus le mot perdu.
 */
const TOLERANCE_BY_DEFAULT = 0.5

/**
 * Pose les bornes de coupe sur les frontières de plans quand elles en ont une
 * assez près. À défaut, **jump cut assumé** : la borne reste où la délimitation
 * l'a mise, plutôt que d'aller chercher une coupe lointaine.
 *
 * **Une borne ne franchit jamais sa voisine.** Sans cette règle, deux segments
 * séparés par un retrait et encadrant une frontière se rejoindraient sur elle,
 * `normalizeSegments` les fusionnerait, et **le passage retiré reviendrait** —
 * sans erreur ni trace. La garde est simple et se démontre : chaque borne, prise
 * dans l'ordre, ne peut se poser qu'entre la valeur déjà décidée pour la borne
 * précédente et la valeur d'origine de la suivante. La borne d'origine reste
 * toujours admissible, donc la suite reste strictement croissante et aucun
 * segment ne peut se vider.
 *
 * Une tolérance non finie vaut zéro. Elle viendra d'un réglage, et un `NaN` qui
 * déplacerait toutes les coupes n'importe où est exactement le genre de panne
 * qu'on ne voit qu'au rendu.
 */
export function snapToShots(
  segments: Segment[],
  shots: Shot[],
  tolerance: number = TOLERANCE_BY_DEFAULT,
): Segment[] {
  const segs = normalizeSegments(segments)
  const tol = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0
  if (segs.length === 0 || tol === 0) return segs

  // Les deux bouts de chaque plan sont des frontières : un plan commence là où
  // le précédent finit, mais rien ne garantit que la liste soit contiguë.
  const boundaries = [...new Set(shots.flatMap((p) => [p.start, p.end]))]
    .filter((f) => Number.isFinite(f))
    .sort((a, b) => a - b)
  if (boundaries.length === 0) return segs

  // Les bornes à plat, dans l'ordre : début0, fin0, début1, fin1… La liste est
  // strictement croissante — `normalizeSegments` l'a rendue telle.
  const bounds = segs.flatMap((s) => [s.start, s.end])
  const decided: number[] = []

  for (let i = 0; i < bounds.length; i++) {
    const bound = bounds[i]
    const previous = i === 0 ? Number.NEGATIVE_INFINITY : decided[i - 1]
    const next = i + 1 < bounds.length ? bounds[i + 1] : Number.POSITIVE_INFINITY

    let chosen = bound
    let gap = Number.POSITIVE_INFINITY
    for (const f of boundaries) {
      // La garde qui empêche une borne de franchir sa voisine.
      if (f <= previous || f >= next) continue
      const d = Math.abs(f - bound)
      // `<` et non `<=` : à distance égale, la première frontière gagne, et
      // elles sont triées. Arbitraire, mais déterministe.
      if (d <= tol && d < gap) {
        chosen = f
        gap = d
      }
    }
    decided.push(chosen)
  }

  const out: Segment[] = []
  for (let i = 0; i < decided.length; i += 2) {
    out.push({ start: decided[i], end: decided[i + 1] })
  }
  return normalizeSegments(out)
}
