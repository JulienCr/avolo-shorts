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
 * **Le ratio est choisi par plan**, et c'est ce que la mesure impose : la part
 * du temps qui descend sous le 16:9 vaut 50 % sur `2025-06-15-cqlp`, 32 % sur
 * `2026-22-02-entre-nous` et 7 % sur `2026-03-08-caro-mdlm`. Un ratio unique
 * écrase cette part sous le plan le plus large.
 *
 * **Et le cadre n'a pas à contenir les gens en entier** : chaque boîte abandonne
 * ses extrémités avant d'entrer dans l'empan, voir `trimmedBounds`. C'est ce qui
 * a fait passer ces trois parts de 20 %, 5 % et moins de 1 % à ce qu'elles valent
 * ci-dessus, sur des fenêtres de 30 s qui couvrent l'émission entière.
 *
 * **Les deux sorties n'en font pas le même usage** (spec §11), et c'est un
 * arbitrage, pas une inconséquence :
 *
 * - le **natif**, pour le feed d'Instagram et de Facebook, garde **un seul
 *   ratio pour tout le clip** — le plus large que ses plans demandent. Une vidéo
 *   de feed dont les bandes latérales apparaîtraient et disparaîtraient serait
 *   exactement le défaut que le fond flouté existe pour éviter ;
 * - la **variante 9:16**, pour TikTok et Shorts, pose chaque plan sur son canevas
 *   vertical **à son propre ratio**, le fond flouté prenant le reste : 100 % de
 *   la hauteur pour un 9:16, 70,3 % pour un 4:5, 56,3 % pour un 1:1, 31,6 % pour
 *   un 16:9. Le saut de taille tombe sur une coupe, donc il ne se voit pas —
 *   c'est le même argument qui justifie déjà le crop qui saute aux frontières.
 *
 * Ça ne coûte rien parce que **la variante ne dérive pas du natif** : elle refait
 * tout le chemin depuis la source (`blurredVariantArgs`, correctif de #22). Un
 * plan serré n'est donc jamais rétréci deux fois.
 *
 * Ce module ne calcule que de la géométrie.
 */

import { normalizeSegments } from '@/core/edl'
import type { Ratio, Segment } from '@/core/edl'
import { POINT, POINT_COUNT, shotStartMs, shotsForSegments } from '@/core/shots'
import type { PersonBox, Shot } from '@/core/shots'

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
 * **C'est le défaut d'un clip qu'aucune analyse n'a mesuré**, et il vaut `9:16`.
 * La vraie décision est celle de `computeFraming`, qui a des boîtes de personnes
 * sous les yeux ; celle-ci répond quand il n'y en a pas du tout — un projet dont
 * l'analyse n'a pas tourné, un clip cadré à la main comme en itération 0.
 *
 * La différence avec `chooseRatio`, qui prend le 16:9 quand il ne mesure rien,
 * est voulue et tient à ce que les deux silences ne disent pas la même chose.
 * Ici l'analyse n'a rien dit parce qu'on ne la lui a pas demandée, et le cadrage
 * appartient encore à l'humain, qui a réglé `cropX` lui-même. Là-bas elle a
 * tourné et n'a trouvé personne : on ignore où sont les comédiens, et couper à
 * l'aveugle serait une faute silencieuse.
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
const SIZES: Readonly<Record<Ratio, { w: number; h: number }>> = {
  '9:16': { w: 1080, h: 1920 },
  '4:5': { w: 1080, h: 1350 },
  '1:1': { w: 1080, h: 1080 },
  '16:9': { w: 1920, h: 1080 },
}

export function outputSize(ratio: Ratio): { w: number; h: number } {
  // Une copie : la table est une constante du module, et l'appelant passe le
  // résultat à `renderArgs`, qui n'a aucune raison de pouvoir la modifier.
  return { ...SIZES[ratio] }
}

/**
 * La place qu'un cadre de ce ratio occupe **dans un canevas**, posé pleine
 * largeur et centré.
 *
 * Dans le canevas vertical de 1080x1920 : 1920 pour un 9:16 — il remplit —, 1350
 * pour un 4:5, 1080 pour un 1:1, 608 pour un 16:9. Dans le canevas natif, le
 * cadre a le ratio du canevas et le remplit toujours, ce qui rend la même
 * fonction utilisable des deux côtés.
 *
 * **La hauteur est paire**, comme toutes les dimensions que ffmpeg reçoit :
 * libx264 refuse une dimension impaire en yuv420p. 1080 / (16/9) vaut 607,5, et
 * c'est le seul des quatre qui ne tombe pas juste. **Et elle se calcule depuis le
 * ratio nominal, jamais depuis le rectangle de crop** : `cropRect` arrondit ses
 * composantes au pair, donc un 9:16 sort en 608x1080 et non en 607,5x1080, et la
 * hauteur déduite de ce rapport tomberait à 1918 — deux pixels de fond flouté en
 * haut et en bas d'un cadre qui devait remplir.
 */
export function sizeInCanvas(
  ratio: Ratio,
  canvas: { w: number; h: number },
): { w: number; h: number } {
  return { w: canvas.w, h: Math.min(canvas.h, pairNear(canvas.w / RATIOS[ratio])) }
}

/** Le pair immédiatement inférieur ou égal, jamais négatif. */
function pairLower(n: number): number {
  return Math.max(0, Math.floor(n / 2) * 2)
}

/** Le pair le plus proche. 607,5 → 608. */
function pairNear(n: number): number {
  return Math.max(0, Math.round(n / 2) * 2)
}

function bound(n: number, min: number, max: number): number {
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

  const target = RATIOS[ratio]
  const maxW = pairLower(srcW)
  const maxH = pairLower(srcH)

  let h = maxH
  let w = pairNear(h * target)
  if (w > maxW) {
    w = maxW
    h = Math.min(pairNear(w / target), maxH)
  }

  // `Number.isFinite` : `cropX` vient de la base et de l'interface. Un `NaN`
  // traverserait tout le calcul sans erreur et sortirait en `crop=608:1080:NaN:0`,
  // que ffmpeg refuse avec un message qui ne nomme pas la cause.
  const center = Number.isFinite(cropX) ? bound(cropX, 0, 1) : 0.5

  return {
    w,
    h,
    x: pairLower(bound(Math.round(center * srcW - w / 2), 0, srcW - w)),
    y: pairLower(bound(Math.round((srcH - h) / 2), 0, srcH - h)),
  }
}

// ---------------------------------------------------------------------------
// Le cadrage automatique (itération 1).
//
// Tout ce qui suit décide *quel* ratio et *quel* `cropX` passer aux fonctions
// ci-dessus. Rien n'y touche : `cropRect` et `outputSize` reçoivent aujourd'hui
// des réglages humains et recevront demain ceux-ci, sans changer d'une ligne.
// ---------------------------------------------------------------------------

/** Ce qui se règle dans la lecture des boîtes de personnes. */
export type FramingOptions = {
  /**
   * Le score minimal pour qu'une boîte compte. 0,5 est le seuil des mesures de
   * la spec §2. Une détection douteuse au bord du cadre suffirait sinon à
   * imposer un 16:9 à tout le clip.
   */
  minScore?: number
  /**
   * L'air laissé de chaque côté des personnes, en fraction de largeur.
   *
   * Un réglage de confort à l'origine, et **mesuré depuis** : la boîte du
   * détecteur épouse la silhouette, et un crop posé pile dessus met un coude sur
   * le bord de l'image. Voir `FRAMING_DEFAULTS` pour ce que sa valeur coûte.
   */
  margin?: number
  /**
   * À partir de quelle fraction de hauteur une boîte est réputée **tronquée par
   * le bord bas** de l'image. Voir `isForeground`.
   */
  bottomEdge?: number
  /**
   * En deçà de quelle **hauteur visible** une boîte tronquée par le bord bas est
   * du premier plan, donc écartée. Voir `isForeground`.
   *
   * `0` désactive le filtre entièrement — aucune boîte ne peut être plus courte
   * que zéro. C'est la façon de mesurer l'effet du filtre sans toucher au code.
   */
  foregroundMaxHeight?: number
  /**
   * La part de **sa propre largeur** qu'une boîte abandonne de chaque côté avant
   * d'entrer dans l'empan. Voir `trimmedBounds` et `FRAMING_DEFAULTS`.
   *
   * `0` reproduit exactement le comportement d'avant le 19 août 2026 : l'empan
   * exige alors que les boîtes tiennent en entier dans le cadre.
   */
  sideTrim?: number
  /**
   * Le plafond de ce rognage, en fraction de la **largeur de l'image** et non de
   * la boîte. Voir `trimmedBounds` : c'est lui qui empêche une boîte très large
   * d'abandonner une tête.
   */
  sideTrimMax?: number
  /**
   * Quels points de pose définissent le **tronc**, c'est-à-dire ce que le cadre
   * doit vraiment contenir d'une personne. Voir `TORSOS` et `torsoBounds`.
   *
   * `'off'` ignore les points et rend le comportement d'avant le 19 août 2026 :
   * la boîte corps entier, moins ses extrémités. C'est aussi ce qui se passe,
   * quel que soit ce réglage, sur une analyse qui ne porte pas de points.
   */
  torso?: TorsoName | 'off'
  /**
   * La confiance minimale d'un point pour qu'il compte dans le tronc.
   *
   * Un point que le réseau n'a pas vu — une épaule cachée, une hanche hors cadre
   * — sort avec une confiance basse **et une position quand même**, souvent au
   * milieu du corps. Le compter ne rate pas bruyamment : il resserre le tronc
   * d'un côté, ce qui déplace le crop sans rien signaler.
   */
  torsoMinScore?: number
  /**
   * Ce que le tronc s'ajoute de chaque côté, en fraction de **sa propre
   * largeur**.
   *
   * Les points d'épaule sont les **centres des articulations**, pas le bord de
   * la silhouette : un tronc pris à la lettre coupe la moitié de chaque épaule.
   * Voir `FRAMING_DEFAULTS` pour ce que la mesure a retenu.
   */
  torsoPad?: number
  /**
   * La part du tronc qu'on s'autorise à abandonner de chaque côté, **la tête
   * exceptée**. Voir `torsoBounds`.
   *
   * C'est `sideTrim` posé sur la bonne primitive : le rognage de la boîte
   * abandonne des extrémités dont il ignore le contenu — d'où son plafond,
   * installé le 19 août parce que sans lui un visage tombait dehors —, alors que
   * celui-ci sait ce qu'il abandonne et refuse de toucher à la tête.
   */
  torsoTrim?: number
  /**
   * La part de la **plus haute boîte retenue de la même image** en deçà de
   * laquelle une boîte n'est plus quelqu'un à cadrer. Voir `spans` et
   * `docs/superpowers/specs/2026-08-25-size-floor-design.md`.
   *
   * `0` désactive le filtre entièrement, comme `foregroundMaxHeight: 0`.
   */
  sizeFloor?: number
  /**
   * Poser un split-screen sur un plan à deux personnes plutôt qu'un crop
   * unique. Voir `computeShotSplit` et
   * `docs/superpowers/specs/2026-08-25-split-screen-design.md`.
   *
   * `false` rend le comportement d'avant le split à l'identique — le crop
   * unique par plan, comme aujourd'hui.
   */
  splitScreen?: boolean
  /** La durée en deçà de laquelle un plan n'entre pas dans le split, en secondes. */
  splitMinShot?: number
  /**
   * Le plancher de largeur d'une cellule, en fraction de la largeur source,
   * sous lequel un tronc étroit produirait un grossissement absurde.
   *
   * **Reproduit les maquettes validées le 25 août 2026** : `max(torse × 3,
   * hauteur de cellule × 1,125 × 0,6)` sur le canevas 1080×1920, soit 60 % de
   * la largeur d'une cellule prise à pleine hauteur de source. Demande un
   * balayage, comme `sizeFloor` avant le sien.
   */
  splitMinCellWidth?: number
  /**
   * La tolérance au débordement d'une cellule dans la **boîte** de l'autre
   * personne (pas son tronc), en fraction de la largeur source.
   *
   * **Repose sur trois points, pas sur un balayage** : les mesures du 25 août
   * placent les deux plans approuvés à 0,010 et 0,020, et le seul plan rejeté
   * à 0,123. `0,05` tient dans cet intervalle sans y avoir été balayé.
   */
  splitBleedTolerance?: number
  /**
   * La part des images appariées qui doivent tenir sous la tolérance.
   *
   * **Reprend la valeur de `chooseRatioFromSpans` pour sa raison** : la
   * cellule est fixe pour tout le plan, comme le crop du ratio, et exiger
   * que 100 % des images tiennent tiendrait le split à une norme plus
   * stricte que celle que le dépôt applique déjà au ratio lui-même.
   */
  splitBleedShare?: number
}

/**
 * Les définitions de tronc que la mesure a comparées, chacune par les rangs
 * COCO qu'elle retient.
 *
 * **Elles sont nommées et exportées parce que c'est la mesure qui a tranché**,
 * pas une intuition : le balayage de `scripts/measure-ratios.ts` les passe toutes
 * sur la même émission et met en regard ce que chacune gagne en ratio et ce
 * qu'elle coupe des gens. Un nom recopié dans le script mesurerait un autre
 * tronc que celui qui décide, le jour où l'un des deux bouge.
 *
 * Ce qui les sépare :
 *
 * - `'head'` — la tête seule, nez, yeux et oreilles. Le minimum absolu, et la
 *   borne basse du balayage : il dit ce qu'on gagnerait à ne garantir que les
 *   visages. Ce n'est pas un cadrage défendable en soi — un buste coupé aux
 *   oreilles est une faute que la mesure ne voit pas —, c'est l'extrémité de la
 *   courbe.
 * - `'bust'` — la tête et les épaules. Le plus serré défendable, et celui qui décrit le
 *   mieux « ce qu'on regarde » : sur le plan de référence du rognage latéral,
 *   un 1:1 garde les deux visages et les deux bustes et ne perd que l'épaule
 *   extérieure de chacun. C'est donc déjà le cadre que l'œil accepte.
 * - `'bust-hips'` — plus les hanches. Elles ne dépassent presque jamais les
 *   épaules chez quelqu'un d'assis de face, et elles rattrapent les dos tournés,
 *   où la tête n'a pas de point fiable.
 * - `'shoulders-hips'` — le tronc anatomique, sans la tête. Écarté d'avance sur
 *   le papier — perdre la tête est exactement la faute qu'on répare — mais
 *   mesuré quand même, parce que le papier s'est déjà trompé sur ce sujet.
 * - `'upper-body'` — plus les coudes. Un bras tendu compte alors, un bras levé
 *   aussi : c'est la définition qui se rapproche le plus de la boîte, et elle
 *   sert de borne haute au balayage.
 */
export const TORSOS = Object.freeze({
  head: [POINT.NOSE, POINT.LEFT_EYE, POINT.RIGHT_EYE, POINT.LEFT_EAR, POINT.RIGHT_EAR],
  bust: [
    POINT.NOSE,
    POINT.LEFT_EYE,
    POINT.RIGHT_EYE,
    POINT.LEFT_EAR,
    POINT.RIGHT_EAR,
    POINT.LEFT_SHOULDER,
    POINT.RIGHT_SHOULDER,
  ],
  'bust-hips': [
    POINT.NOSE,
    POINT.LEFT_EYE,
    POINT.RIGHT_EYE,
    POINT.LEFT_EAR,
    POINT.RIGHT_EAR,
    POINT.LEFT_SHOULDER,
    POINT.RIGHT_SHOULDER,
    POINT.LEFT_HIP,
    POINT.RIGHT_HIP,
  ],
  'shoulders-hips': [
    POINT.LEFT_SHOULDER,
    POINT.RIGHT_SHOULDER,
    POINT.LEFT_HIP,
    POINT.RIGHT_HIP,
  ],
  'upper-body': [
    POINT.NOSE,
    POINT.LEFT_EYE,
    POINT.RIGHT_EYE,
    POINT.LEFT_EAR,
    POINT.RIGHT_EAR,
    POINT.LEFT_SHOULDER,
    POINT.RIGHT_SHOULDER,
    POINT.LEFT_ELBOW,
    POINT.RIGHT_ELBOW,
    POINT.LEFT_HIP,
    POINT.RIGHT_HIP,
  ],
} as const satisfies Record<string, readonly number[]>)

export type TorsoName = keyof typeof TORSOS

/**
 * Les valeurs par défaut des quatre réglages, **exportées parce que les scripts
 * de mesure ont besoin de les nommer**. Un tirage « au voisinage du seuil » qui
 * recopierait `0.35` mesurerait un autre filtre que celui qui décide, et le jour
 * où le seuil bouge, il continuerait de viser l'ancien sans rien signaler.
 *
 * **`margin` valait 0,02 et n'avait jamais été mesuré.** Le balayage du 18 août
 * 2026 (`scripts/measure-ratios.ts`, `docs/ratios-par-clip.md`) le fait tomber à
 * 0,01, et la baisse ne coûte rien de mesurable : sur trois émissions, aucun clip
 * ni aucune fenêtre ne s'**élargit** entre 0,02 et 0,01, deux clips de
 * `2025-06-15-cqlp` passent du 16:9 au 1:1 et quinze fenêtres sur 197 se
 * resserrent. La marge compte **deux fois** dans l'empan — une fois de chaque
 * côté —, donc 0,02 en dépense 0,04, à comparer aux 0,5625 qu'un 1:1 couvre : un
 * quatorzième du cadre, dépensé sur un réglage que personne n'avait éprouvé.
 *
 * **Ce qu'elle protège tient encore à 0,01**, et ça s'est vérifié à l'image, pas
 * au chiffre : sur les deux clips qui basculent, le rectangle de crop laisse de
 * l'air des deux côtés des comédiens. 0,01 de la source fait 19 px sur une sortie
 * de 1080, c'est mince mais ce n'est pas nul — et `0` a été écarté pour ça, alors
 * qu'il donne exactement la même répartition par clip.
 *
 * Descendre plus bas n'achèterait donc rien, et monter coûte : à 0,03, huit
 * fenêtres de `cqlp` s'élargissent.
 */
export const FRAMING_DEFAULTS: Readonly<Required<FramingOptions>> = Object.freeze({
  minScore: 0.5,
  margin: 0.01,
  bottomEdge: 0.97,
  foregroundMaxHeight: 0.35,
  sideTrim: 0.3,
  sideTrimMax: 0.12,
  torso: 'bust',
  torsoMinScore: 0.5,
  torsoPad: 0.15,
  torsoTrim: 0.3,
  sizeFloor: 0.5,
  splitScreen: true,
  splitMinShot: 4,
  splitMinCellWidth: 0.38,
  splitBleedTolerance: 0.08,
  splitBleedShare: 0.9,
})

/**
 * La fraction de la largeur source qu'un crop pleine hauteur de ce ratio couvre.
 *
 * C'est la grandeur qui rend la table de la spec §2 lisible : dans une image
 * 16:9, un 9:16 couvre 31,6 % de la largeur, un 4:5 45 %, un 1:1 56,2 %. Elle
 * borne à 1 parce qu'un crop ne peut pas être plus large que sa source — sur un
 * portrait, les quatre ratios prennent toute la largeur et se départagent sur la
 * hauteur, dont `cropRect` s'occupe.
 */
export function ratioCoverage(ratio: Ratio, srcW: number, srcH: number): number {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
    throw new Error(
      `ratioCoverage : dimensions de source invalides (${String(srcW)}x${String(srcH)}).`,
    )
  }
  return Math.min(1, (RATIOS[ratio] * srcH) / srcW)
}

/**
 * Un réglage, ou son défaut. `??` ne suffit pas : il ne remplace que `undefined`,
 * et laisse passer un `NaN`, qui se propage au lieu d'être corrigé.
 *
 * `margin` à `NaN` rendait toutes les bornes d'empan `NaN`, donc un `cropX` à
 * `NaN` **étiqueté `source: 'auto'`** : `cropRect` retombant sur le centre par sa
 * propre garde, rien ne se voyait à l'image, et la panne n'existait que dans ce
 * que l'interface affiche — « calculé » pour un plan qu'aucun calcul n'avait
 * cadré. C'est exactement pour ça qu'elle aurait survécu. (relevé par Aristarque)
 */
function setting(value: number | undefined, defaultValue: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue
}

/**
 * Le même repli que `setting`, pour une valeur qui **divise** : zéro y est aussi
 * invalide qu'un `NaN`. Sans ce garde, `0` traverse `setting`, la division rend
 * `NaN`, et `frontality` sort non nulle sous un `facing` décidé.
 */
function positiveSetting(value: number | undefined, defaultValue: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : defaultValue
}

/** `setting`, pour un drapeau : tout ce qui n'est pas un booléen retombe. */
function flag(value: boolean | undefined, defaultValue: boolean): boolean {
  return typeof value === 'boolean' ? value : defaultValue
}

/**
 * Une boîte du **premier plan** : quelqu'un entre la caméra et le plateau, dont
 * le bord bas de l'image coupe le corps, et dont il ne reste qu'une tranche.
 *
 * **Sur `2025-06-15-cqlp`, ce sont 33,8 % des boîtes**, et elles ruinaient le
 * cadrage automatique : des têtes de spectateurs au premier rang, collées au bas
 * de l'image, à gauche et à droite du cadre. Leur empan va d'un bord à l'autre
 * pendant que les comédiens tiennent dans le tiers central, donc tous les clips
 * sortaient en 16:9 — c'est-à-dire au ratio le plus large, c'est-à-dire à rien.
 *
 * **Le critère est double, et aucune de ses deux moitiés ne suffit.** Les trois
 * points ci-dessous ont tous été trouvés en regardant les images, aucun en lisant
 * un histogramme :
 *
 * - *Le bord bas seul jette les comédiens.* 76 % des boîtes de comédiens
 *   touchent le bas de l'image : ils jouent debout et leurs pieds y sont. Couper
 *   à `y1 ≥ 0,97` ne laisse survivre que 16 % des boîtes.
 * - *La hauteur seule jette les plans lointains.* À 419 s, deux comédiens assis
 *   dans le noir donnent des boîtes de 0,27 de haut qui flottent au milieu du
 *   cadre, loin du bord bas. Une hauteur minimale sans condition de bord les
 *   écarte, et ce plan-là n'a plus personne.
 * - *Le rapport largeur/hauteur ne tranche pas.* Une tête de spectateur vue de
 *   profil descend à 0,33, exactement comme un corps debout. La séparation par
 *   ce seul rapport laisse 11 % des boîtes dans la zone d'incertitude, contre
 *   0,8 % pour la hauteur.
 *
 * **Les deux seuils tombent dans un creux, ils ne sont pas choisis.** Sur les
 * boîtes collées au bas, la hauteur est franchement bimodale : le mode du public
 * tient entre 0,08 et 0,25, celui des comédiens repart à partir de 0,40, et
 * entre les deux il ne reste que **29 boîtes sur 26 436**. 0,35 est le fond
 * de ce creux. Déplacer le seuil de ±0,03 ne change donc presque rien — c'est ce
 * qui en fait un réglage tenable et non un nombre magique.
 *
 * **Ce filtre est un réglage et vit ici, pas dans le détecteur.** La sortie de
 * `worker/detect.py` est une donnée : un filtre posé dedans est irréversible
 * sans relancer le GPU, alors que relire un `analysis.json` est instantané. Et
 * le phénomène n'est **pas général** — `2026-03-08-caro-mdlm` n'a que 832 boîtes
 * de premier plan sur 45 362, soit 1,8 % contre 33,8 % —, donc ce qui se règle
 * doit rester réglable (spec §5). Le détail est dans `docs/premier-plan.md`.
 *
 * Une boîte dont la hauteur ne se mesure pas est **gardée** : un filtre qui ne
 * peut pas juger ne rejette pas.
 */
export function isForeground(box: PersonBox, options: FramingOptions = {}): boolean {
  const edge = setting(options.bottomEdge, FRAMING_DEFAULTS.bottomEdge)
  const hauteurMax = Math.max(
    0,
    setting(options.foregroundMaxHeight, FRAMING_DEFAULTS.foregroundMaxHeight),
  )
  // Une seule garde suffit : `y1 - y0` n'est fini que si les deux bornes le sont.
  const hauteur = box.y1 - box.y0
  if (!Number.isFinite(hauteur)) return false
  return box.y1 >= edge && hauteur < hauteurMax
}

/**
 * Les bords horizontaux d'une boîte **une fois ses extrémités abandonnées**.
 *
 * **Le cadrage n'a pas à contenir les gens en entier, et c'est le constat du
 * 19 août 2026.** Sur `2025-06-15-cqlp` à 2120 s, deux comédiens occupent
 * `[0,106 ; 0,490]` et `[0,523 ; 0,778]` : leur union fait 0,672 quand un 1:1 en
 * couvre 0,5625, donc **aucune** des 61 images du plan ne tient, à aucun
 * percentile. Vérifié à l'image, le 1:1 centré garde pourtant les deux visages et
 * les deux bustes — il ne perd que l'épaule extérieure de chacun. Le critère
 * d'avant refusait ce cadre-là parce qu'il exigeait l'union des boîtes
 * **entières**, bras traînant compris.
 *
 * Le rognage est donc une **permission**, pas une coupe : il ne décide que du
 * ratio. Le crop, lui, occupe toute la fenêtre du ratio retenu et rend
 * l'essentiel de ce qui a été abandonné — sur ce plan, la fenêtre 1:1 fait 0,5625
 * pour un empan rogné de 0,501.
 *
 * **Deux bornes, et chacune rattrape ce que l'autre laisse passer** :
 *
 * - *La part* (`sideTrim`) borne la perte **relative**. Elle protège les sujets
 *   lointains : à plafond seul, une boîte de 0,10 de large en abandonnerait la
 *   totalité. Elle rogne aussi là où il y a de quoi rogner — une boîte est large
 *   précisément quand un membre est tendu —, alors qu'une valeur absolue
 *   uniforme rabote autant les empans déjà étroits et les pousse vers des ratios
 *   trop serrés : mesuré, elle bascule des fenêtres en 9:16 là où la part les
 *   amène en 1:1.
 * - *Le plafond* (`sideTrimMax`) borne la perte **absolue**, et il a été payé par
 *   une image. Sans lui, sur `2026-03-08-caro-mdlm` à 7250 s, un comédien assis
 *   jambes tendues donne une boîte de 0,536 de large dont la tête occupe
 *   l'extrémité droite ; en abandonner 30 % de chaque côté, c'est 0,161 de
 *   l'image, et **son visage tombe dehors pendant les 28 secondes du plan**. Le
 *   plafond ramène cette perte à un liseré et le plan reste en 16:9. C'est le cas
 *   documenté par l'issue #69, vu ici par l'autre bout.
 *
 * **Ce que les valeurs valent, et pourquoi elles ne sont pas sur une falaise.**
 * Le plan de référence bascule en 1:1 à partir d'une part de 0,30 et d'un plafond
 * de 0,09 ; le visage de `caro-mdlm` tombe à partir d'un plafond de 0,15. Le
 * plafond retenu, 0,12, est au milieu de cet intervalle — le plus loin possible
 * des deux bords. Au-delà de 0,40 de part, le coût explose : sur les fenêtres de
 * `cqlp`, le temps où quelqu'un perd plus d'un tiers de sa largeur passe de 152 s
 * à 463 s.
 *
 * Le détail, les tableaux et les images sont dans `docs/ratios-par-clip.md`.
 */
export function trimmedBounds(
  box: PersonBox,
  options: FramingOptions = {},
): { x0: number; x1: number } {
  const share = bound(setting(options.sideTrim, FRAMING_DEFAULTS.sideTrim), 0, 0.5)
  const cap = Math.max(0, setting(options.sideTrimMax, FRAMING_DEFAULTS.sideTrimMax))
  const width = box.x1 - box.x0
  // La demi-largeur borne le tout : au-delà, la boîte se retournerait, et une
  // borne gauche passée à droite de la borne droite est un empan négatif que
  // rien en aval ne saurait lire.
  const trimmed = Math.min(width * share, cap, width / 2)
  return { x0: box.x0 + trimmed, x1: box.x1 - trimmed }
}

/**
 * Le tronc, ou `null` quand cette personne n'en a pas de lisible.
 *
 * **C'est la primitive que l'issue #69 réclamait, et elle a demandé de changer
 * de modèle.** Une `PersonBox` est un rectangle : sa largeur est la même à
 * toutes les hauteurs, donc rien à l'intérieur ne distingue une tête d'une
 * cheville. Le rognage latéral du 19 août contourne ce mur en abandonnant une
 * part fixe de chaque côté, sans savoir ce qu'il abandonne — d'où son plafond,
 * posé pour qu'il ne puisse pas jeter un visage. Les variantes `-pose` de la
 * même famille rendent dix-sept points par personne : le tronc s'en déduit, et
 * on sait où est la tête.
 *
 * **Le tronc remplace la boîte pour le seul choix du cadre, pas ailleurs.** Le
 * filtre du public au premier plan continue de lire la boîte — bord bas et
 * hauteur —, et il le doit : un squelette ne dit pas si le bas de l'image a
 * tronqué quelqu'un, et la géométrie de ce filtre est mesurée sur 26 436 boîtes.
 *
 * **Deux points au minimum, sinon on rend `null`.** Un seul point donne un
 * intervalle de largeur nulle : ce n'est pas un tronc serré, c'est une personne
 * réduite à un pixel, et le crop qui en découlerait serait posé sur un nez. À
 * `null`, l'appelant retombe sur la boîte, c'est-à-dire sur le comportement
 * mesuré du 19 août — dégrader vers ce qui marchait vaut mieux que dégrader vers
 * un point.
 *
 * **Et compter deux points ne suffit pas à garantir cette largeur**, ce qui a
 * été relevé en review : deux points peuvent partager la même abscisse — le
 * fichier arrondit à quatre décimales, et un profil pose l'œil sur l'oreille —,
 * et un `torsoTrim` de 0,5 rabat sur son milieu un tronc que la tête ne rattrape
 * pas. C'est donc la **largeur finale** qui décide, pas le compte des points :
 * le repli sur la boîte doit valoir dans les trois cas, sans quoi la promesse du
 * paragraphe précédent est fausse là où elle sert.
 *
 * `torsoPad` élargit le résultat parce que **les points d'épaule sont les
 * centres des articulations** : pris à la lettre, le tronc passe au milieu de
 * chaque épaule. L'élargissement est proportionnel à la largeur du tronc, donc
 * il suit la distance du sujet, comme `sideTrim` le fait pour la boîte.
 */
export function torsoBounds(
  box: PersonBox,
  options: FramingOptions = {},
): { x0: number; x1: number } | null {
  const name = options.torso ?? FRAMING_DEFAULTS.torso
  if (name === 'off') return null
  const indices: readonly number[] | undefined = TORSOS[name as TorsoName]
  if (indices === undefined) return null

  const k = box.k
  // La longueur est revérifiée ici et pas seulement au schéma : `PersonBox` est
  // un type de `core`, et rien n'oblige un appelant — un test, un script — à
  // passer par la validation d'I/O.
  if (k === undefined || k.length !== POINT_COUNT * 3) return null

  const threshold = setting(options.torsoMinScore, FRAMING_DEFAULTS.torsoMinScore)
  const extentOf = (
    which: readonly number[],
  ): { x0: number; x1: number; seen: number } => {
    let x0 = Number.POSITIVE_INFINITY
    let x1 = Number.NEGATIVE_INFINITY
    let seen = 0
    for (const index of which) {
      const x = k[index * 3]
      const confidence = k[index * 3 + 2]
      // `!(c >= seuil)` et non `c < seuil`, comme partout ailleurs ici : un `NaN`
      // doit tomber du côté écarté.
      if (!Number.isFinite(x) || !(confidence >= threshold)) continue
      seen += 1
      if (x < x0) x0 = x
      if (x > x1) x1 = x
    }
    return { x0, x1, seen }
  }

  const torso = extentOf(indices)
  if (torso.seen < 2) return null

  // **Le rognage du tronc, et la tête qui lui sert de plancher.** C'est toute la
  // différence avec `sideTrim` : celui-là abandonne des extrémités sans savoir
  // ce qu'elles contiennent, et son plafond n'est qu'un pari sur la position de
  // la tête. Ici la tête est connue, donc elle est simplement remise dedans, et
  // ce qui est abandonné ne peut être qu'une épaule.
  const share = bound(setting(options.torsoTrim, FRAMING_DEFAULTS.torsoTrim), 0, 0.5)
  const trimmed = (torso.x1 - torso.x0) * share
  let x0 = torso.x0 + trimmed
  let x1 = torso.x1 - trimmed
  const head = extentOf(TORSOS.head)
  if (head.seen > 0) {
    x0 = Math.min(x0, head.x0)
    x1 = Math.max(x1, head.x1)
  }

  // La largeur finale, et non le compte des points : voir la note du bloc de
  // documentation. Un tronc réduit à un point retombe sur la boîte.
  if (!(x1 > x0)) return null

  const pad = Math.max(0, setting(options.torsoPad, FRAMING_DEFAULTS.torsoPad)) * (x1 - x0)
  return { x0: x0 - pad, x1: x1 + pad }
}

/**
 * L'étendue des points de tête d'une personne, ou `null` si le squelette n'en
 * porte pas — analyse sans points, ou dos tourné.
 *
 * Les cinq points COCO de `TORSOS.head` (nez, yeux, oreilles), et non le seul
 * nez : un profil ne montre qu'un œil et qu'une oreille. Partagée entre
 * `scripts/framing-thumbnails.ts` et `scripts/framing-preview.ts` — les deux
 * répondent à la même question (le visage est-il dans le crop ?) et ne
 * doivent pas porter chacun sa propre lecture des points.
 *
 * **Longueur et coordonnées revérifiées ici**, comme dans `torsoBounds` : un
 * appelant `core` — un test, un script — n'est pas obligé de passer par la
 * validation d'I/O, et un `k` tronqué ou une coordonnée non finie ne doivent
 * pas produire de bornes partielles ou `NaN` que les deux outils transmettent
 * directement à leurs primitives de dessin.
 */
export function headBounds(
  box: PersonBox,
  options: FramingOptions = {},
): { x0: number; y0: number; x1: number; y1: number } | null {
  const k = box.k
  if (k === undefined || k.length !== POINT_COUNT * 3) return null
  const threshold = setting(options.torsoMinScore, FRAMING_DEFAULTS.torsoMinScore)
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  let seen = 0
  for (const rank of TORSOS.head) {
    const x = k[rank * 3]
    const y = k[rank * 3 + 1]
    const confidence = k[rank * 3 + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(confidence >= threshold)) continue
    seen += 1
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    y0 = Math.min(y0, y)
    y1 = Math.max(y1, y)
  }
  return seen === 0 ? null : { x0, y0, x1, y1 }
}

/**
 * À quel point une personne est de face — `1` pleinement de face, `0` pur
 * profil — et `'unknown'` quand on ne sait pas.
 */
export type Facing = 'frontal' | 'profile' | 'unknown'

/** Les trois signaux dont `orientationOf` moyenne les contributions disponibles. */
export type OrientationTerms = {
  /**
   * Asymétrie des confiances d'oreille, 0 (symétrique) à 1 (une seule vue).
   * `null` si les deux confiances sont nulles.
   */
  earAsymmetry: number | null
  /** 1 si les deux yeux sont confiants, 0 si un seul. `null` si aucun. */
  eyeTerm: number | null
  /** Écart des épaules en x, rapporté à une échelle verticale. `null` si incalculable. */
  shoulderRatio: number | null
}

/**
 * Le résultat d'`orientationOf`.
 *
 * **`frontality` vaut `null` si et seulement si `facing` vaut `'unknown'`** —
 * jamais `0`. Un appelant qui trierait par `frontality` classerait sinon un
 * `0` comme « le plus de profil », alors qu'on n'en sait rien : une personne
 * de dos n'est pas de profil, elle est de dos. C'est la distinction que
 * `CLAUDE.md` pose sous « Distinguer l'absence d'information de son
 * ambiguïté » — l'absence de signal n'est pas la valeur la plus prudente,
 * c'est une troisième chose.
 */
export type Orientation = {
  facing: Facing
  /** `null` si et seulement si `facing` vaut `'unknown'`. */
  frontality: number | null
  /** Le côté vers lequel la personne est tournée : -1 vers la gauche de l'image, +1 vers la droite, 0 indéterminé. */
  side: -1 | 0 | 1
  terms: OrientationTerms
}

/**
 * Les réglages d'`orientationOf`, **à part de `FramingOptions`** : cette
 * fonction n'est appelée par personne pour l'instant, surtout pas
 * `computeFraming`, et un champ de plus dans `FramingOptions` obligerait à
 * toucher son bloc de recopie sans aucun besoin.
 *
 * `shoulderRatioFull` et `sideDeadband` sont des valeurs de départ à mesurer,
 * pas des constantes gagnées par une campagne — un balayage viendra, comme
 * celui qui a fixé `sideTrim` ou `torsoTrim`. `pointMinScore` fait exception :
 * il reprend le défaut de `torsoMinScore`, déjà mesuré par la campagne du
 * 19 août 2026.
 *
 * **`frontalThreshold` valait 0,35 et deux mesures indépendantes l'ont
 * condamné** (20 août 2026, `docs/locuteur-et-orientation.md`). Sur une planche
 * de trente vignettes tirées entre 0,25 et 0,80 et triées par frontalité, la
 * fonction dit `'frontal'` sur des profils francs jusqu'à 0,54 ; la frontière
 * lue à l'image tombe vers 0,60. Et sur les 17 927 images du jeu
 * auto-supervisé, 0,35 range **97,7 %** des boîtes en `'frontal'` : une
 * étiquette qui ne distingue plus rien.
 *
 * **Aucun seuil unique ne sépare proprement**, et c'est le vrai résultat : des
 * profils francs subsistent jusqu'à 0,71 quand des visages exploitables
 * descendent à 0,54. 0,60 rend l'étiquette honnête, il ne la rend pas juste.
 * D'où la conséquence de conception, qui est ailleurs : **la décision de
 * cadrage se prend sur un écart entre deux personnes du même plan**, jamais sur
 * ce seuil. Dans un plan, les deux personnes partagent le détecteur,
 * l'éclairage et l'angle, donc leurs biais se compensent dans la différence là
 * où ils s'ajoutent dans la valeur. `facing` est un diagnostic, pas une
 * décision.
 */
export type OrientationOptions = {
  /** Confiance minimale d'un point pour compter, inclusive. Défaut : celui de `FRAMING_DEFAULTS.torsoMinScore`. */
  pointMinScore?: number
  /** Rapport d'épaules au-delà duquel le terme sature à 1. */
  shoulderRatioFull?: number
  /** Seuil de `frontality` qui sépare `'frontal'` de `'profile'`, inclusif du côté frontal. */
  frontalThreshold?: number
  /** Asymétrie d'oreille en deçà de laquelle `side` vaut 0. */
  sideDeadband?: number
}

export const ORIENTATION_DEFAULTS: Readonly<Required<OrientationOptions>> = Object.freeze({
  pointMinScore: FRAMING_DEFAULTS.torsoMinScore,
  shoulderRatioFull: 1,
  frontalThreshold: 0.6,
  sideDeadband: 0.5,
})

/**
 * L'écart horizontal des épaules, rapporté à une échelle verticale
 * insensible au lacet — un torse de profil projette ses deux épaules
 * quasiment au même `x`, quel que soit le sens dans lequel il regarde.
 *
 * **L'échelle n'est pas la largeur de tête** : elle se calcule sur les points
 * confiants du moment (nez à défaut hanches), donc elle bouge avec la
 * grandeur qu'on mesure plutôt que de dépendre d'une mesure indépendante
 * qu'il faudrait recaler séparément.
 */
function shoulderRatioOf(k: readonly number[], threshold: number): number | null {
  const shoulderLeftX = k[POINT.LEFT_SHOULDER * 3]
  const shoulderLeftY = k[POINT.LEFT_SHOULDER * 3 + 1]
  const shoulderLeftScore = k[POINT.LEFT_SHOULDER * 3 + 2]
  const shoulderRightX = k[POINT.RIGHT_SHOULDER * 3]
  const shoulderRightY = k[POINT.RIGHT_SHOULDER * 3 + 1]
  const shoulderRightScore = k[POINT.RIGHT_SHOULDER * 3 + 2]

  // `!(c >= seuil)` et non `c < seuil`, comme partout ailleurs ici : un `NaN`
  // doit tomber du côté écarté.
  // Les `y` autant que les `x` : ils portent l'échelle, et un `Infinity` y donne
  // `scale = Infinity` donc un rapport de 0 — un profil franc tiré du néant, que
  // le garde `!(scale > 0)` plus bas laisse passer.
  if (
    !Number.isFinite(shoulderLeftX) ||
    !Number.isFinite(shoulderRightX) ||
    !Number.isFinite(shoulderLeftY) ||
    !Number.isFinite(shoulderRightY) ||
    !(shoulderLeftScore >= threshold) ||
    !(shoulderRightScore >= threshold)
  ) {
    return null
  }

  const span = Math.abs(shoulderLeftX - shoulderRightX)
  const shoulderMidY = (shoulderLeftY + shoulderRightY) / 2

  const noseY = k[POINT.NOSE * 3 + 1]
  const noseScore = k[POINT.NOSE * 3 + 2]
  let scale: number
  if (Number.isFinite(noseY) && noseScore >= threshold) {
    scale = Math.abs(noseY - shoulderMidY)
  } else {
    const hipLeftScore = k[POINT.LEFT_HIP * 3 + 2]
    const hipRightScore = k[POINT.RIGHT_HIP * 3 + 2]
    if (hipLeftScore >= threshold && hipRightScore >= threshold) {
      const hipLeftY = k[POINT.LEFT_HIP * 3 + 1]
      const hipRightY = k[POINT.RIGHT_HIP * 3 + 1]
      scale = Math.abs(shoulderMidY - (hipLeftY + hipRightY) / 2)
    } else {
      return null
    }
  }

  // **Fini autant que positif**, et c'est le garde qui manquait : `!(scale > 0)`
  // écarte bien un `NaN`, mais `Infinity > 0` est vrai, donc une échelle infinie
  // passait et rendait `span / scale === 0` — un profil franc tiré du néant. Le
  // trou valait pour le nez et les hanches, pas seulement pour les épaules
  // gardées plus haut. (relevé par Copilot, trois fois de suite)
  if (!Number.isFinite(scale) || !(scale > 0)) return null
  return span / scale
}

/**
 * À quel point une personne est de face, à partir de son squelette COCO.
 *
 * **Un spike : cette fonction n'est appelée par personne**, et surtout pas
 * `computeFraming` — elle mesure avant de brancher, et le comportement du
 * cadrage en service ne change pas d'un iota tant qu'elle reste en dehors du
 * chemin qui y mène.
 *
 * Trois signaux, chacun pouvant manquer indépendamment des deux autres :
 *
 * - `earAsymmetry` compare les confiances brutes des deux oreilles, sans
 *   seuil — ici la confiance *est* le signal, pas un filtre. Une vue de
 *   profil ne montre le détecteur qu'une oreille, l'autre étant masquée par
 *   la tête.
 * - `eyeTerm` compte les yeux confiants. **Un seul œil confiant est une
 *   information — le visage est tourné — et vaut `0`, pas `null`.** `null`
 *   ne dit que l'absence totale de signal, quand aucun œil n'est confiant :
 *   c'est la même distinction que celle de `frontality` plus bas, à
 *   l'échelle d'un seul terme.
 * - `shoulderRatio` mesure l'écart horizontal des épaules, voir
 *   `shoulderRatioOf`.
 *
 * **`frontality` exige deux contributions disponibles, jamais une seule** :
 * une oreille seule ne doit pas pouvoir trancher à elle seule entre face et
 * profil, ce qui rendrait le résultat aussi fragile qu'un signal isolé.
 * En dessous de deux, `facing` vaut `'unknown'` et `frontality` `null`.
 *
 * `side` ne regarde que l'asymétrie d'oreille : sous `sideDeadband`, aucune
 * oreille ne domine assez pour dire un côté, et `side` vaut 0.
 */
export function orientationOf(box: PersonBox, options: OrientationOptions = {}): Orientation {
  const unknown: Orientation = {
    facing: 'unknown',
    frontality: null,
    side: 0,
    terms: { earAsymmetry: null, eyeTerm: null, shoulderRatio: null },
  }

  const k = box.k
  if (k === undefined || k.length !== POINT_COUNT * 3) return unknown

  const pointMinScore = setting(options.pointMinScore, ORIENTATION_DEFAULTS.pointMinScore)
  const shoulderRatioFull = positiveSetting(
    options.shoulderRatioFull,
    ORIENTATION_DEFAULTS.shoulderRatioFull,
  )
  const frontalThreshold = setting(options.frontalThreshold, ORIENTATION_DEFAULTS.frontalThreshold)
  const sideDeadband = setting(options.sideDeadband, ORIENTATION_DEFAULTS.sideDeadband)

  // 1. earAsymmetry, sur les confiances brutes.
  const earLeftScore = k[POINT.LEFT_EAR * 3 + 2]
  const earRightScore = k[POINT.RIGHT_EAR * 3 + 2]
  const earAsymmetry =
    Number.isFinite(earLeftScore) && Number.isFinite(earRightScore) && earLeftScore + earRightScore > 0
      ? Math.abs(earLeftScore - earRightScore) / (earLeftScore + earRightScore)
      : null

  // 2. eyeTerm, au compte des yeux confiants.
  const leftEyeSeen = k[POINT.LEFT_EYE * 3 + 2] >= pointMinScore
  const rightEyeSeen = k[POINT.RIGHT_EYE * 3 + 2] >= pointMinScore
  const eyesSeen = (leftEyeSeen ? 1 : 0) + (rightEyeSeen ? 1 : 0)
  const eyeTerm = eyesSeen === 0 ? null : eyesSeen === 2 ? 1 : 0

  // 3. shoulderRatio.
  const shoulderRatio = shoulderRatioOf(k, pointMinScore)

  // 4. frontality et facing : deux contributions disponibles au minimum.
  const contributions: number[] = []
  if (earAsymmetry !== null) contributions.push(1 - earAsymmetry)
  if (eyeTerm !== null) contributions.push(eyeTerm)
  if (shoulderRatio !== null) {
    contributions.push(bound(shoulderRatio / shoulderRatioFull, 0, 1))
  }

  let frontality: number | null = null
  let facing: Facing = 'unknown'
  if (contributions.length >= 2) {
    frontality = contributions.reduce((sum, c) => sum + c, 0) / contributions.length
    facing = frontality >= frontalThreshold ? 'frontal' : 'profile'
  }

  // 5. side. **Une egalite parfaite reste `0`.** Sous `sideDeadband: 0`, deux
  // confiances d'oreille egales et positives donnent `earAsymmetry === 0`, qui
  // franchit le seuil ; le ternaire tranchait alors au hasard. C'est la regle du
  // depot : un defaut prudent est juste face a une information absente, faux face
  // a une information ambigue. (releve par Copilot)
  let side: -1 | 0 | 1 = 0
  if (earAsymmetry !== null && earAsymmetry >= sideDeadband && earLeftScore !== earRightScore) {
    side = earLeftScore > earRightScore ? -1 : 1
  }

  return { facing, frontality, side, terms: { earAsymmetry, eyeTerm, shoulderRatio } }
}

/**
 * Ce que le cadre doit contenir d'une personne : son tronc si les points le
 * disent, sa boîte moins ses extrémités sinon.
 *
 * **Le rognage latéral ne s'applique pas au tronc**, et ce n'est pas un oubli :
 * les deux répondent à la même question. `sideTrim` abandonne une part de la
 * boîte parce qu'on ne sait pas ce qu'elle contient ; le tronc *sait*. Les
 * cumuler rognerait deux fois, et la seconde fois sur ce qu'on avait
 * précisément décidé de garder.
 *
 * Le rognage reste donc le **repli**, et il garde tout son sens là où il n'y a
 * pas de points : une analyse de version 1, un modèle de détection, une personne
 * de dos dont le réseau ne voit ni tête ni épaules.
 */
export function personBounds(
  box: PersonBox,
  options: FramingOptions = {},
): { x0: number; x1: number } {
  return torsoBounds(box, options) ?? trimmedBounds(box, options)
}

/**
 * La médiane, au sens strict : sur un nombre **pair** de valeurs, le milieu des
 * deux centrales et non la plus basse des deux.
 *
 * La différence ne se voit que sur un plan partagé en deux moitiés égales — et
 * c'est exactement le cas où prendre la plus basse fait pencher à gauche un
 * départage qui n'a aucune raison de pencher. (relevé par Copilot)
 */
function median(sorted: number[]): number {
  const m = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

/** L'empan des personnes d'une image, marge comprise, en fractions de largeur. */
type Span = { t: number; g: number; d: number }

/**
 * `t` tombe-t-il dans l'intervalle ? **Fin exclue** : une image posée pile sur
 * la borne appartient à ce qui suit. Sans cette convention, l'image d'une
 * frontière de plan compterait dans les deux plans, et celle d'une borne de
 * segment dans un segment qui ne la montre pas.
 */
function inInterval(t: number, start: number, fin: number): boolean {
  return t >= start && t < fin
}

/**
 * Un empan par **image**, pas par personne : ce que le cadrage doit contenir,
 * c'est tout le monde à la fois.
 *
 * Les images se reconnaissent à leur instant, arrondi à la milliseconde. Le
 * worker échantillonne à 2 images par seconde (spec §6), donc mille fois plus
 * gros que le bruit d'un flottant, et deux boîtes de la même image se retrouvent
 * quelle que soit la manière dont leur `t` a été calculé.
 *
 * Une image dont aucune boîte n'est retenue **ne rend rien**, plutôt qu'une
 * largeur nulle : elle ne dit pas que le cadre peut être serré, elle ne dit
 * rien. La compter pour zéro tirerait la décision vers un ratio trop étroit
 * pour les images où il y a quelqu'un — et sur les émissions mesurées, ces
 * images-là font de 5 à 30 % du total.
 */
/**
 * Une géométrie exploitable : bornes finies, largeur et hauteur strictement
 * positives. `spans()` l'applique boîte par boîte avant tout le reste ; les
 * diagnostics (`measure-ratios.ts`, `framing-thumbnails.ts`,
 * `framing-preview.ts`) doivent la reprendre pour rester fidèles au cadrage
 * réel plutôt que de retenir une boîte que `spans()` a déjà écartée.
 */
export function hasValidGeometry(box: Pick<PersonBox, 'x0' | 'x1' | 'y0' | 'y1'>): boolean {
  return (
    Number.isFinite(box.x0) &&
    Number.isFinite(box.x1) &&
    Number.isFinite(box.y0) &&
    Number.isFinite(box.y1) &&
    box.x1 > box.x0 &&
    box.y1 > box.y0
  )
}

/** Une boîte retenue, groupée par image : la même porte que `spans` ouvre à tous ses appelants. */
type RetainedBox = { box: PersonBox; x0: number; x1: number; height: number }

/**
 * Groupe les boîtes retenues par image — score, géométrie, premier plan —
 * avant le plancher de taille, qui compare une boîte à la plus haute de sa
 * propre image. Partagée par `spans` et `computeShotSplit` : les deux doivent
 * lire « retenu » de la même façon (trap #4 de la skill `cadrage`).
 */
function retainedByFrame(
  boxes: PersonBox[],
  options: FramingOptions,
): Map<number, { t: number; boxes: RetainedBox[] }> {
  const threshold = setting(options.minScore, FRAMING_DEFAULTS.minScore)
  const byImage = new Map<number, { t: number; boxes: RetainedBox[] }>()
  for (const b of boxes) {
    // Les boîtes viennent d'un JSON produit par un autre processus. Une borne
    // non finie ou inversée traverserait tout le calcul en `NaN` et ne se
    // verrait qu'au rendu, sous la forme d'un crop absurde.
    if (!Number.isFinite(b.t) || !hasValidGeometry(b)) continue
    // `!(score >= seuil)` et non `score < seuil` : un score `NaN` doit sortir.
    if (!(b.score >= threshold)) continue
    // Le public au premier plan, écarté avant de compter l'empan : c'est lui qui
    // faisait sortir tous les clips de `2025-06-15-cqlp` en 16:9.
    if (isForeground(b, options)) continue

    const { x0, x1 } = personBounds(b, options)
    const height = b.y1 - b.y0
    const key = Math.round(b.t * 1000)
    const already = byImage.get(key)
    if (already) already.boxes.push({ box: b, x0, x1, height })
    else byImage.set(key, { t: b.t, boxes: [{ box: b, x0, x1, height }] })
  }
  return byImage
}

/** Le plancher de taille clampé à `[0, 1]` : voir `spans` pour pourquoi 1 est la borne haute. */
function clampedSizeFloor(options: FramingOptions): number {
  return Math.min(1, Math.max(0, setting(options.sizeFloor, FRAMING_DEFAULTS.sizeFloor)))
}

/**
 * Les survivantes d'une image après le plancher de taille : une boîte
 * nettement plus courte que la plus haute de sa propre image n'est pas
 * quelqu'un à cadrer, souvent un visage imprimé (spec du 25 août 2026,
 * « Le plancher de taille »).
 */
function afterSizeFloor(frameBoxes: RetainedBox[], floor: number): RetainedBox[] {
  const tallest = Math.max(...frameBoxes.map((f) => f.height))
  // `!(hauteur >= plancher * plus_haute)`, même forme que pour le score :
  // `NaN` sort, et `floor` à 0 ne rejette jamais rien.
  return frameBoxes.filter((f) => f.height >= floor * tallest)
}

function spans(boxes: PersonBox[], options: FramingOptions = {}): Span[] {
  const margin = Math.max(0, setting(options.margin, FRAMING_DEFAULTS.margin))
  // Plafonné à 1 : au-delà, la plus haute boîte de l'image ne peut jamais
  // valoir floor fois elle-même, l'image se viderait entièrement et le clip
  // retomberait sur le ratio le plus large — l'inverse de l'intention d'un
  // plancher élevé. (relevé par Copilot et Aristarque)
  const floor = clampedSizeFloor(options)
  const byImage = retainedByFrame(boxes, options)

  const byFrame = new Map<number, Span>()
  for (const { t, boxes: frameBoxes } of byImage.values()) {
    const survivors = afterSizeFloor(frameBoxes, floor)
    if (survivors.length === 0) continue
    const g = Math.min(...survivors.map((f) => f.x0))
    const d = Math.max(...survivors.map((f) => f.x1))
    byFrame.set(Math.round(t * 1000), { t, g, d })
  }

  // **Les deux bornes sont ramenées dans [0, 1] des deux côtés**, et pas
  // seulement chacune du sien. Depuis que l'empan se lit sur des points de pose,
  // il peut sortir de l'image en entier : un point hors cadre est une
  // information que `detect.py` écrit exprès sans la borner. Un tronc
  // entièrement à gauche donnait alors `g = 0` et `d < 0`, donc une largeur
  // **négative** qui traversait le choix du ratio et la position sans rien
  // signaler. Borner des deux côtés rend au pire une largeur nulle, que le
  // percentile lit comme « cette image n'exige rien ». (relevé par Copilot)
  return [...byFrame.values()].map((e) => ({
    t: e.t,
    g: bound(e.g - margin, 0, 1),
    d: bound(e.d + margin, 0, 1),
  }))
}

/**
 * Le nombre de personnes retenues par image — même filtre que `spans`, sans
 * la fusion en empan. C'est ce que le déclencheur du split lit pour juger
 * l'effectif d'un plan (contrat, § « Le déclencheur »).
 */
export function retainedCountByFrame(boxes: PersonBox[], options: FramingOptions): number[] {
  const floor = clampedSizeFloor(options)
  const byImage = retainedByFrame(boxes, options)
  return [...byImage.values()].map(({ boxes: frameBoxes }) => afterSizeFloor(frameBoxes, floor).length)
}

/**
 * Les boîtes retenues d'une image, dans les seules images à **exactement**
 * `count` survivantes — ce que la géométrie du split apparie.
 */
function retainedBoxesByFrame(
  boxes: PersonBox[],
  count: number,
  options: FramingOptions,
): PersonBox[][] {
  const floor = clampedSizeFloor(options)
  const byImage = retainedByFrame(boxes, options)
  return [...byImage.values()]
    .map(({ boxes: frameBoxes }) => afterSizeFloor(frameBoxes, floor).map((f) => f.box))
    .filter((l) => l.length === count)
}

/** Une cellule du split, en fractions de la source. */
export type Cell = { x0: number; y0: number; x1: number; y1: number }

/**
 * Égalité de deux cellules, `undefined` compris — la même règle que
 * `splitByShot` applique déjà à `ratio`/`cropX`/`cropXNative` pour fusionner
 * deux morceaux adjacents. Canonique ici parce que `Cell` l'est : `shot-split.ts`
 * et `render.ts` l'importent plutôt que de la réécrire.
 */
export function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1
}

/**
 * Le rectangle en pixels d'une cellule, le pendant de `cropRect` pour le
 * split : les composantes s'arrondissent au pair pour la même raison — libx264
 * refuse une dimension impaire en yuv420p.
 */
export function splitCellRect(
  cell: Cell,
  srcW: number,
  srcH: number,
): { w: number; h: number; x: number; y: number } {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH)) {
    throw new Error(
      `splitCellRect : dimensions de source invalides (${String(srcW)}x${String(srcH)}).`,
    )
  }
  const x0 = bound(cell.x0, 0, 1) * srcW
  const x1 = bound(cell.x1, 0, 1) * srcW
  const y0 = bound(cell.y0, 0, 1) * srcH
  const y1 = bound(cell.y1, 0, 1) * srcH
  const w = pairLower(Math.max(2, Math.min(srcW, x1 - x0)))
  const h = pairLower(Math.max(2, Math.min(srcH, y1 - y0)))
  return {
    w,
    h,
    x: pairLower(bound(Math.round(x0), 0, srcW - w)),
    y: pairLower(bound(Math.round(y0), 0, srcH - h)),
  }
}

/** Le centre de ce qu'un cadre exige d'une personne, pour la ranger à gauche ou à droite. */
function centerOf(box: PersonBox, options: FramingOptions): number {
  const { x0, x1 } = personBounds(box, options)
  return (x0 + x1) / 2
}

/**
 * La hauteur d'œil d'une personne, fraction de hauteur source. Trois
 * priorités, jamais `null` : les deux yeux confiants en moyenne, le nez à
 * défaut, le haut de la boîte en dernier recours (contrat, § « La géométrie »).
 */
function eyeLevelOf(box: PersonBox, threshold: number): number {
  const k = box.k
  if (k !== undefined && k.length === POINT_COUNT * 3) {
    const leftY = k[POINT.LEFT_EYE * 3 + 1]
    const leftScore = k[POINT.LEFT_EYE * 3 + 2]
    const rightY = k[POINT.RIGHT_EYE * 3 + 1]
    const rightScore = k[POINT.RIGHT_EYE * 3 + 2]
    if (
      Number.isFinite(leftY) &&
      Number.isFinite(rightY) &&
      leftScore >= threshold &&
      rightScore >= threshold
    ) {
      return (leftY + rightY) / 2
    }
    const noseY = k[POINT.NOSE * 3 + 1]
    const noseScore = k[POINT.NOSE * 3 + 2]
    if (Number.isFinite(noseY) && noseScore >= threshold) return noseY
  }
  return box.y0
}

/** Pourquoi un plan n'a pas vu son split calculé. */
export type SplitRejection =
  | 'tooShort'
  | 'notTwoPeople'
  | 'ratioNotWide'
  | 'noPairs'
  | 'tooNarrowForSource'
  | 'bleedsIntoOther'

/** Ce que `computeShotSplit` rend. */
export type ShotSplit = {
  /** `[haut, bas]`, ou `null` quand le plan ne split pas. */
  cells: [Cell, Cell] | null
  rejection: SplitRejection | null
  /**
   * Le pire débordement mesuré d'une cellule dans la **boîte** de l'autre
   * personne, sur les images appariées — `null` tant qu'aucune géométrie n'a
   * pu se calculer (refus antérieur à elle). **Diagnostic, pas la décision** :
   * le rejet compare chaque image à la tolérance et exige `splitBleedShare`
   * d'entre elles en dessous, pas le pire seul. Exposé pour le balayage de
   * `scripts/measure-ratios.ts`, qui doit pouvoir situer un plan par rapport
   * à la tolérance sans la recalculer lui-même.
   */
  bleed: number | null
  /**
   * L'instant, dans la source, de l'image qui porte `bleed` — `null` en même
   * temps que lui. C'est le plan **et** l'instant qu'il faut pouvoir rendre à
   * nouveau pour juger un candidat de balayage sur l'image, pas sur un chiffre.
   */
  worstBleedAt: number | null
}

/**
 * Le split-screen d'un plan à deux personnes (spec du 25 août 2026) : deux
 * cellules empilées plutôt qu'un crop unique, posées là où c'est
 * géométriquement utile. Aucun signal de contenu n'y participe — voir le
 * contrat pour les pistes mesurées et écartées.
 *
 * @param boxes Les boîtes du plan, restreintes à lui et aux segments montés.
 * @param ratio Le ratio que ce plan prendrait sans split (condition 3).
 * @returns Les deux cellules `[haut, bas]`, ou la cause du refus.
 */
export function computeShotSplit(
  boxes: PersonBox[],
  shot: Shot,
  ratio: Ratio,
  srcW: number,
  srcH: number,
  options: FramingOptions,
): ShotSplit {
  const refuse = (
    rejection: SplitRejection,
    bleed: number | null = null,
    worstBleedAt: number | null = null,
  ): ShotSplit => ({
    cells: null,
    rejection,
    bleed,
    worstBleedAt,
  })

  const minShot = setting(options.splitMinShot, FRAMING_DEFAULTS.splitMinShot)
  // `!(durée >= plancher)` et non `<` : une borne non finie doit refuser.
  if (!(shot.end - shot.start >= minShot)) return refuse('tooShort')

  const counts = retainedCountByFrame(boxes, options)
  if (counts.length === 0) return refuse('notTwoPeople')
  if (Math.round(median([...counts].sort((a, b) => a - b))) !== 2) return refuse('notTwoPeople')

  if (!(RATIOS[ratio] > RATIOS['9:16'])) return refuse('ratioNotWide')

  // Le rang gauche/droite, par image, sans suivre d'identité : deux comédiens
  // qui se croisent échangent leurs rangs, et rien ici ne le corrige (ouvert
  // dans la spec, « Ce qui reste ouvert »).
  const pairs = retainedBoxesByFrame(boxes, 2, options).map((l) => {
    const [left, right] = [...l].sort((a, b) => centerOf(a, options) - centerOf(b, options))
    return { left, right }
  })
  if (pairs.length === 0) return refuse('noPairs')

  const pointThreshold = setting(options.torsoMinScore, FRAMING_DEFAULTS.torsoMinScore)
  const geometryOf = (which: 'left' | 'right') => {
    const slotBoxes = pairs.map((p) => p[which])
    const widths = slotBoxes
      .map((b) => {
        const { x0, x1 } = personBounds(b, options)
        return x1 - x0
      })
      .sort((a, b) => a - b)
    const centers = slotBoxes.map((b) => centerOf(b, options)).sort((a, b) => a - b)
    const eyes = slotBoxes.map((b) => eyeLevelOf(b, pointThreshold)).sort((a, b) => a - b)
    return { torsoWidth: median(widths), centerX: median(centers), eyeY: median(eyes) }
  }
  const left = geometryOf('left')
  const right = geometryOf('right')

  // Le rang haut/bas : celui qui regarde à droite (`side === 1`) sur la
  // majorité des images qui départagent. Égalité ou silence : la gauche va en
  // haut — c'est le cas `cqlp`, dont l'homme de droite sort à `side` nul.
  let leftWins = 0
  let rightWins = 0
  for (const { left: l, right: r } of pairs) {
    const sideLeft = orientationOf(l).side
    const sideRight = orientationOf(r).side
    if (sideLeft === 1 && sideRight !== 1) leftWins += 1
    else if (sideRight === 1 && sideLeft !== 1) rightWins += 1
  }
  const leftOnTop = leftWins >= rightWins

  const minWidthFrac = bound(
    setting(options.splitMinCellWidth, FRAMING_DEFAULTS.splitMinCellWidth),
    0,
    1,
  )
  const cellRatio = 1080 / 960

  const cellFor = (slot: { torsoWidth: number; centerX: number; eyeY: number }): Cell | null => {
    // Clampée à la source : un tronc large — quelqu'un proche caméra, bras
    // écartés — peut pousser `3 × torse` au-delà de 1, et une cellule ne peut
    // pas être plus large que sa source.
    const widthFrac = Math.min(1, Math.max(3 * slot.torsoWidth, minWidthFrac))
    const heightFrac = (widthFrac * srcW) / cellRatio / srcH
    // Une largeur clampée qui ne tient plus la hauteur voulue : pas de
    // géométrie exploitable pour ce plan, plutôt qu'une cellule déformée.
    if (!(heightFrac <= 1)) return null

    let x0 = slot.centerX - widthFrac / 2
    let x1 = x0 + widthFrac
    if (x0 < 0) {
      x1 -= x0
      x0 = 0
    }
    if (x1 > 1) {
      x0 -= x1 - 1
      x1 = 1
    }
    x0 = Math.max(0, x0)

    let y0 = slot.eyeY - heightFrac / 3
    let y1 = y0 + heightFrac
    if (y0 < 0) {
      y1 -= y0
      y0 = 0
    }
    if (y1 > 1) {
      y0 -= y1 - 1
      y1 = 1
    }
    y0 = Math.max(0, y0)

    return { x0, y0, x1, y1 }
  }

  const leftCell = cellFor(left)
  const rightCell = cellFor(right)
  if (leftCell === null || rightCell === null) return refuse('tooNarrowForSource')

  // Le recouvrement des cellules est autorisé ; ce qui compte est le
  // débordement dans la **boîte** de l'autre personne, pas son tronc — voir
  // le corps de la PR pour la mesure qui l'a tranché.
  const bleedPerFrame = pairs.map(
    ({ left: l, right: r }) =>
      Math.max(
        0,
        Math.min(leftCell.x1, r.x1) - Math.max(leftCell.x0, r.x0),
        Math.min(rightCell.x1, l.x1) - Math.max(rightCell.x0, l.x0),
      ),
  )
  const bleed = Math.max(0, ...bleedPerFrame)
  // L'image qui porte ce pire débordement — le premier rang si `bleed` vaut 0
  // partout, faute de mieux à désigner.
  const worstBleedAt = pairs[bleedPerFrame.indexOf(bleed)]?.left.t ?? null

  const tolerance = bound(
    setting(options.splitBleedTolerance, FRAMING_DEFAULTS.splitBleedTolerance),
    0,
    1,
  )
  // 90 % des images, pas 100 % : même tolérance relative que
  // `chooseRatioFromSpans` applique déjà au ratio — voir le corps de la PR
  // pour la mesure qui l'a tranché.
  const share = bound(setting(options.splitBleedShare, FRAMING_DEFAULTS.splitBleedShare), 0, 1)
  const within = bleedPerFrame.filter((b) => b <= tolerance).length
  // `- 1e-9` absorbe l'arrondi flottant à la frontière, comme partout ailleurs
  // dans ce module : `within / total >= share` peut rater de justesse un cas
  // pile égal.
  if (!(within >= share * bleedPerFrame.length - 1e-9)) {
    return refuse('bleedsIntoOther', bleed, worstBleedAt)
  }

  const topCell = leftOnTop ? leftCell : rightCell
  const bottomCell = leftOnTop ? rightCell : leftCell
  return { cells: [topCell, bottomCell], rejection: null, bleed, worstBleedAt }
}


/**
 * La largeur nécessaire pour contenir les personnes, une valeur par image, en
 * fraction de la largeur source.
 *
 * **Elle mesure, elle ne décide pas.** Le ratio ne s'en déduit pas, et c'est le
 * point que la première version de ce module ratait : une largeur par image
 * suppose un crop libre par image, alors que le crop est fixe pour tout le plan.
 * Voir `chooseRatio`, qui juge ce qu'une position fixe cadre vraiment.
 */
export function requiredWidths(boxes: PersonBox[], options: FramingOptions = {}): number[] {
  return spans(boxes, options).map((e) => e.d - e.g)
}

/** Les quatre ratios du plus étroit au plus large, déduits de `RATIOS`. */
const MORE_NARROW_MORE_WIDE: Ratio[] = (Object.keys(RATIOS) as Ratio[]).sort(
  (a, b) => RATIOS[a] - RATIOS[b],
)

const NARROWEST = MORE_NARROW_MORE_WIDE[0]

/**
 * La durée minimale d'un morceau à décoder, en secondes.
 *
 * **Elle vit ici et non dans `shot-split.ts` parce que le choix du ratio en
 * dépend**, et que la dépendance ne peut pas aller dans l'autre sens :
 * `computeFraming` doit savoir si un intervalle qu'aucun plan ne couvre est
 * assez long pour devenir une entrée, puisque c'est ce qui l'oblige à élargir le
 * ratio natif. Deux exemplaires du seuil se contrediraient au premier réglage.
 *
 * **Ce qu'elle vaut, et pourquoi.** Un morceau plus court qu'une image ouvre un
 * décodeur qui ne rend rien, ou une image de trop : la somme des durées
 * demandées cesse alors de décrire ce que le fichier contient, et **les
 * sous-titres, qui sont recalés sur cette somme, glissent** — sans qu'aucun test
 * de durée ne le voie, puisque la durée totale, elle, ne bouge pas.
 *
 * 40 ms est une image à 25 im/s, un peu plus d'une à 30, deux et demie à 60.
 * C'est un ordre de grandeur, pas une mesure : ce qui compte est qu'aucun
 * morceau ne puisse être plus court qu'une image, et que le seuil reste très en
 * deçà de la plus courte frontière utile — les plans de ces émissions se
 * comptent en secondes, médiane 5,3 s sur la plus découpée des trois.
 */
export const MIN_PIECE_SEC = 0.04
const WIDEST = MORE_NARROW_MORE_WIDE[MORE_NARROW_MORE_WIDE.length - 1]

/**
 * Le plus petit ratio dont **un crop fixe cadre 90 % des images de ce plan**.
 *
 * **Le seuil de 90 %, pas le maximum.** Une seule image où quelqu'un traverse le
 * cadre condamnerait le clip entier au 16:9. Le prix est assumé et il faut le
 * dire : sur les 10 % d'images restantes, un sujet peut sortir partiellement du
 * cadre.
 *
 * **Ce qu'on compte, et c'est là que la première version se trompait.** Elle
 * prenait le percentile 90 des largeurs *par image*. Or une largeur par image
 * suppose un crop libre par image, et le crop est fixe pour tout le plan : un
 * sujet étroit à gauche pendant la moitié d'un plan puis à droite pendant
 * l'autre tient dans un 9:16 image par image, alors qu'aucune position fixe de
 * 9:16 n'en cadre plus de la moitié. Le percentile des largeurs était une
 * approximation du critère, et elle se casse exactement là où la spec §10 dit
 * qu'il faut monter : « un plan de trois minutes où les comédiens traversent le
 * plateau impose un crop large, donc un ratio qui monte, parfois jusqu'au
 * 16:9 ». On évalue donc, pour chaque ratio candidat, ce qu'une position fixe
 * par plan cadre réellement. (relevé par Copilot et Codex)
 *
 * Le seuil reste celui de la spec, et le geste aussi : « 90 % des images
 * tiennent » est une phrase vérifiable en regardant la vidéo.
 *
 * Pourquoi les ratios médians existent, et c'est le chiffre qui porte le
 * produit : sur trois émissions, seuls 24 à 33 % du temps tiennent dans un 9:16,
 * mais **48 % tiennent jusqu'au 1:1, et ce chiffre est stable sur les trois**
 * (spec §2). C'est une propriété du dispositif de tournage, pas un hasard
 * d'échantillon. Tout sortir en 9:16 jette la moitié du matériel.
 *
 * **Sans aucune mesure, le ratio le plus large.** Le cas est réel : un clip
 * entier sans détection (carton de titre, plateau vide, détecteur en échec). On
 * ne sait alors rien de l'endroit où sont les comédiens, et le 16:9 est le seul
 * choix qui ne perde aucune information. Un 9:16 aveugle jetterait 68 % de la
 * largeur et pourrait couper les comédiens **sans que rien ne le signale** ; un
 * 16:9 sort une vidéo visiblement large, que Julien rattrape d'un clic en
 * épinglant un ratio. Entre une faute silencieuse et une faute voyante, on
 * prend la voyante.
 *
 * **Les boîtes arrivent pour UN plan, et c'est le changement du 19 août 2026.**
 * Le choix se faisait par clip, sur tous les plans à la fois ; il se fait
 * désormais chez chacun. Un ratio unique écrasait sous le plan le plus large la
 * part du temps qui descend sous le 16:9 : 25 % sur `2025-06-15-cqlp`, 8 % sur
 * `2026-22-02-entre-nous`, 1 % sur `2026-03-08-caro-mdlm`. Le saut de taille
 * tombe sur une coupe, donc il ne se voit pas.
 *
 * **Ce que ce choix décide dépend de la sortie**, et c'est écrit en tête du
 * module : le fichier natif prend le plus large de ces ratios et le garde d'un
 * bout à l'autre, la variante 9:16 pose chaque plan au sien.
 *
 * Le percentile, lui, reste, et s'applique **à l'intérieur** du plan : c'est là
 * que le crop est fixe, donc là que la question a un sens.
 */
export function chooseRatio(
  boxes: PersonBox[],
  srcW: number,
  srcH: number,
  options: FramingOptions = {},
): Ratio {
  return chooseRatioFromSpans(spans(boxes, options), srcW, srcH)
}

/** Le même choix, sur des empans déjà calculés — ce que `computeFraming` a en main. */
function chooseRatioFromSpans(measurements: Span[], srcW: number, srcH: number): Ratio {
  if (measurements.length === 0) return WIDEST

  for (const r of MORE_NARROW_MORE_WIDE) {
    const { framed } = shotCrop(measurements, ratioCoverage(r, srcW, srcH))
    // `× 10 ≥ × 9` plutôt que `≥ 0,9 ×` : `0.9 * 40` vaut 36,000000000000004, et
    // 36 images sur 40 rateraient de justesse le seuil qu'elles atteignent pile.
    if (framed * 10 >= measurements.length * 9) return r
  }

  // Inatteignable en pratique : le ratio le plus large couvre toute la largeur
  // de la source, donc une position unique y cadre toutes les images. Le filet
  // reste, parce qu'une fonction qui rend `undefined` sur un cas qu'on croyait
  // impossible est pire que celle qui rend le pire ratio.
  return WIDEST
}

/**
 * Le crop d'un plan : **un seul nombre pour tout le plan**, et c'est structurel.
 *
 * Rien ici ne dépend du temps. Sur des plans continus de plusieurs minutes avec
 * des comédiens qui se déplacent, toute caméra qui suit finit par tanguer —
 * c'est le défaut reproché au projet que celui-ci remplace, et il n'est **pas**
 * dans un réglage d'amortissement qu'on pourrait mieux régler (spec §10). Donc
 * pas de lissage, pas d'interpolation, pas de suivi : le crop ne bouge qu'aux
 * frontières de plans, où une coupe existe déjà et où le saut est invisible.
 *
 * Le critère est le nombre d'images **entièrement cadrées**. Une image plus large
 * que la fenêtre n'en donne aucune position possible : elle fait partie de ce que
 * le seuil de 90 % a déjà accepté de sacrifier, et la compter reviendrait à
 * laisser un passant tirer le cadre derrière lui pour tout le plan.
 *
 * À nombre d'images égal, on prend la position la plus proche du centre médian
 * de l'action ; à égalité parfaite — un plan partagé en deux moitiés
 * symétriques — la position la plus à gauche. Ce dernier départage est
 * arbitraire, et le dire vaut mieux que de le maquiller : deux moitiés
 * symétriques n'ont pas de bonne réponse. Le cadrage automatique n'y arrive
 * d'ailleurs jamais, puisqu'un tel plan ne cadre que la moitié de ses images et
 * fait donc monter le ratio ; il faut un ratio épinglé à la main pour l'atteindre.
 *
 * Il n'y a **pas de zone interdite** ici, et la spec §10 ne le réclame plus :
 * constaté à l'image, le panneau de chat n'existe que sur `2025-06-15-cqlp` et
 * le bloc « SOMMAIRE » reste une préférence, pas une interdiction.
 *
 * `cropX` vaut `null` quand le plan n'a **aucune** image mesurée : l'appelant
 * décide, et il n'y a rien à moyenner. `cadrées` compte les images que la
 * position rendue cadre entièrement — c'est ce dont `chooseRatio` a besoin pour
 * juger un ratio sur ce qu'il permet vraiment, et non sur une largeur.
 */
function shotCrop(measurements: Span[], width: number): { cropX: number | null; framed: number } {
  if (measurements.length === 0) return { cropX: null, framed: 0 }

  const demi = width / 2
  // Le crop reste dans l'image : `cropRect` borne déjà, mais rendre une valeur
  // qu'il faudra borner plus loin, c'est rendre une donnée fausse.
  const legal = (c: number): number => bound(c, demi, 1 - demi)

  const target = median(measurements.map((e) => (e.g + e.d) / 2).sort((a, b) => a - b))

  // L'intervalle des centres qui cadrent entièrement cette image. Triés par
  // `lo` : à recouvrement et à distance égaux, c'est le premier essayé qui
  // l'emporte, et « le premier » doit vouloir dire le plus à gauche plutôt que
  // le premier dans l'ordre des images, qui ne veut rien dire.
  const intervals = measurements
    .filter((e) => e.d - e.g <= width + 1e-9)
    .map((e) => ({ lo: e.d - demi, hi: e.g + demi }))
    .sort((a, b) => a.lo - b.lo)
  if (intervals.length === 0) return { cropX: legal(target), framed: 0 }

  // Le recouvrement maximal est atteint sur au moins un `lo` : au-dessous, une
  // image de plus sortirait du cadre. On les essaie donc tous, et pour chacun on
  // regarde jusqu'où les mêmes images restent cadrées — ce plateau.
  let best = { images: -1, center: target }
  for (const { lo } of intervals) {
    let images = 0
    let hi = Number.POSITIVE_INFINITY
    for (const i of intervals) {
      if (i.lo <= lo && lo <= i.hi) {
        images++
        if (i.hi < hi) hi = i.hi
      }
    }
    // La cible **projetée** dans le plateau, et non le milieu du plateau. Tout
    // point du plateau cadre exactement les mêmes images, donc la marge que
    // donnerait le milieu ne protège de rien : rien ne bouge à l'intérieur d'un
    // plan, et les images sont toutes déjà connues. Se rapprocher du centre de
    // l'action, en revanche, se voit. (relevé par Copilot et Codex)
    const center = bound(target, lo, hi)
    // Le `1e-9` fait tenir la règle annoncée. Sans lui, deux positions
    // symétriques ne sont jamais à égalité *exacte* — `0.92 - 0.225` et
    // `0.08 + 0.225` ne tombent pas à la même distance de 0,5 à 4e-17 près — et
    // c'est ce bruit-là qui tranchait, pas le tri. Un départage qui dépend du
    // dernier bit d'un flottant n'est pas déterministe, il est seulement stable
    // tant que personne ne touche à l'arithmétique.
    const better =
      images > best.images ||
      (images === best.images &&
        Math.abs(center - target) < Math.abs(best.center - target) - 1e-9)
    if (better) best = { images, center }
  }

  const cropX = legal(best.center)
  // Recompté sur la position finalement rendue. Le bornage dans l'image ne peut
  // pas sortir du plateau — ça se démontre — mais compter ce qu'on rend vraiment
  // survit à une démonstration qui se périme.
  return { cropX, framed: intervals.filter((i) => i.lo <= cropX && cropX <= i.hi).length }
}

/** Le cadrage d'un plan du clip : un ratio, et une position. */
export type ShotFraming = {
  /** Le plan, avec ses bornes dans la source. */
  shot: Shot
  /** Sa clé de dérogation, `shotStartMs(plan)`. */
  key: number
  /**
   * Le cadre pris dans la source pour ce plan : le plus serré qui tienne.
   *
   * **Ce n'est pas le format du fichier natif**, qui vaut `ClipFraming.ratio` —
   * le plus large des plans — d'un bout à l'autre du clip. C'est le cadre que la
   * **variante 9:16** pose sur son canevas, avec un fond flouté autour : pleine
   * hauteur pour un 9:16, 70,3 % pour un 4:5, 56,3 % pour un 1:1, 31,6 % pour un
   * 16:9.
   */
  ratio: Ratio
  /**
   * Le centre horizontal du crop **pour `ratio`**, 0 à 1, tel que `cropRect`
   * l'attend. C'est la position que la variante 9:16 utilise.
   */
  cropX: number
  /**
   * Le centre horizontal du crop **pour le ratio natif du clip**
   * (`ClipFraming.ratio`), qui est le plus large que ses plans demandent.
   *
   * **Deux positions et non une, parce que la fenêtre n'a pas la même largeur.**
   * Une position optimisée pour un 9:16 posée dans une fenêtre 1:1 n'est pas
   * fausse — elle est bornée dans l'image — mais elle n'est plus celle qui cadre
   * le plus d'images, et rien ne le dirait. Les deux sorties se calculent donc
   * chacune la sienne, sur les mêmes empans.
   *
   * Quand le ratio est épinglé, ou quand le plan est déjà le plus large, les
   * deux valeurs coïncident.
   */
  cropXNative: number
  /**
   * D'où vient le cadrage : `'auto'` calculé sur les boîtes, `'manual'` posé par
   * une dérogation humaine, `'default'` centré faute d'avoir mesuré quoi que ce
   * soit sur ce plan. Le troisième cas mérite d'être visible dans l'interface :
   * c'est un plan que personne n'a cadré, ni la machine ni l'humain.
   */
  source: 'auto' | 'default' | 'manual'
  /**
   * Les deux cellules du split-screen, `[haut, bas]`, quand ce plan en pose
   * un. **Optionnel, et non une union discriminée** : `ratio`/`cropX` restent
   * valides et calculés normalement, et tout lecteur qui ignore `split` (le
   * natif, en particulier) continue de fonctionner sans savoir qu'il existe.
   */
  split?: [Cell, Cell]
}

/**
 * Le cadrage d'un clip : un ratio pour le fichier natif, un cadre par plan, et
 * ce qui n'a pas collé.
 */
export type ClipFraming = {
  /**
   * Le ratio du **fichier natif**, celui du feed : le plus large que les plans
   * demandent.
   *
   * Un seul pour tout le clip, et c'est un choix : une vidéo de feed dont les
   * bandes latérales apparaîtraient et disparaîtraient au fil des plans serait
   * exactement le défaut que le fond flouté existe pour éviter. La variante
   * 9:16, elle, utilise le ratio de chaque plan.
   *
   * Sans aucun plan, le plus large — comme `chooseRatio` quand il ne mesure rien.
   */
  ratio: Ratio
  shots: ShotFraming[]
  /**
   * Les clés de dérogation qui n'ont apparié aucun plan, triées.
   *
   * Elles sont **rendues à l'appelant, jamais reportées sur une voisine**. Le cas
   * se produira le jour où l'analyse sera relancée avec un détecteur modifié :
   * les frontières bougent de quelques images, et une dérogation posée sur
   * l'ancienne poserait un cadrage humain sur un autre plan — un cadrage faux
   * que rien ne signale.
   */
  rejectedOverrides: number[]
}

export type FramingRequest = FramingOptions & {
  /** Les segments montés du clip. Seules leurs images comptent. */
  segments: Segment[]
  /** Les frontières de plans de la source, telles que l'analyse les a rendues. */
  shots: Shot[]
  /** Les boîtes de personnes de la source. */
  people: PersonBox[]
  srcW: number
  srcH: number
  /**
   * La contrainte de ratio, **facultative**.
   *
   * `'auto'` laisse chaque plan choisir le cadre le plus serré qui tienne. Une
   * valeur concrète le force partout : c'est l'échappatoire quand l'automatique
   * choisit mal. Elle porte sur le **cadre pris dans la source**, et le fichier
   * natif sort alors à ce ratio-là — c'est le plus large des plans, et ils l'ont
   * tous.
   */
  ratio: Ratio | 'auto'
  /**
   * Le mode de cadrage. Un **mode explicite** : bouger un curseur ne le bascule
   * pas à lui seul, c'est un geste d'interface distinct, pour qu'on ne perde pas
   * l'automatique par accident.
   */
  cropMode: 'auto' | 'manual'
  /**
   * Les dérogations, **une par plan**, indexées par `shotStartMs`.
   *
   * Par plan, et non une valeur globale pour le clip : l'automatique donne un
   * crop par plan, donc une dérogation valable partout détruirait le cadrage des
   * plans qui étaient bons. Un plan sans entrée garde son crop calculé.
   */
  crops?: Record<number, number>
}

/**
 * La tolérance d'appariement d'une dérogation, en millisecondes.
 *
 * Assez large pour absorber les quelques images dont une frontière peut bouger
 * quand l'analyse est relancée — 250 ms font 15 images à 60 fps. Assez étroite
 * pour ne pas pouvoir sauter sur le plan d'à côté : les plans de cette émission
 * durent des secondes, pas des fractions de seconde.
 */
const TOLERANCE_EXCEPTION_MS = 250

/**
 * Le cadrage complet d'un clip : **par plan**, un ratio et un crop, puis les
 * dérogations humaines par-dessus.
 *
 * Chaque plan reçoit le cadre le plus serré qu'une position fixe y tienne pour
 * 90 % de ses images — voir `chooseRatio`. Le fichier **natif**, lui, prend le
 * plus large de ces ratios et le garde d'un bout à l'autre (`ClipFraming.ratio`) ;
 * la variante 9:16 pose chaque plan au sien.
 *
 * **Quand le ratio est épinglé, le choix est sauté — mais pas le calcul des
 * crops.** Ils se calculent alors pour *ce* ratio-là : sans ça, des crops cadrés
 * pour un 1:1 se retrouveraient posés dans un cadre 4:5, décalés de la
 * différence de largeur.
 *
 * La sortie est une **donnée**, pas un `argv`. `splitByShot` la traduit en
 * morceaux à décoder, et `renderArgs` en filtergraph.
 */
export function computeFraming(req: FramingRequest): ClipFraming {
  const segments = normalizeSegments(req.segments)
  // Recopiés un par un, et non par étalement de `req` : `FramingRequest` porte
  // aussi des segments, des plans et un mode, et les laisser passer ferait de
  // `empans` un consommateur de tout, dont plus rien ne dirait ce qu'il lit.
  //
  // **Le type oblige à les nommer tous**, et ce n'est pas de la ceinture : un
  // réglage oublié ici ne casse rien, il retombe sur son défaut — donc un
  // balayage qui le fait varier mesure la même chose à chaque ligne, avec des
  // colonnes voisines qui bougent, elles, parce qu'elles ne passent pas par
  // cette fonction. C'est arrivé le 19 août 2026 sur `torsoTrim`, et le tableau
  // était crédible. Le `-?` rend chaque clé obligatoire : en oublier une ne
  // compile plus.
  const options: { [K in keyof Required<FramingOptions>]: FramingOptions[K] } = {
    minScore: req.minScore,
    margin: req.margin,
    bottomEdge: req.bottomEdge,
    foregroundMaxHeight: req.foregroundMaxHeight,
    sideTrim: req.sideTrim,
    sideTrimMax: req.sideTrimMax,
    torso: req.torso,
    torsoMinScore: req.torsoMinScore,
    torsoPad: req.torsoPad,
    torsoTrim: req.torsoTrim,
    sizeFloor: req.sizeFloor,
    splitScreen: req.splitScreen,
    splitMinShot: req.splitMinShot,
    splitMinCellWidth: req.splitMinCellWidth,
    splitBleedTolerance: req.splitBleedTolerance,
    splitBleedShare: req.splitBleedShare,
  }

  // Seules les images des segments retenus comptent (spec §10) : le clip ne
  // montre rien d'autre, et une image coupée au montage n'a pas voix au
  // chapitre. C'est aussi ce qui fait que les crops se recalculent quand le
  // montage change — et pourquoi les dérogations ne peuvent pas s'indexer sur
  // autre chose que la source.
  const peopleInSegments = req.people.filter((b) =>
    segments.some((s) => inInterval(b.t, s.start, s.end)),
  )

  // Groupées par plan dès maintenant : c'est la granularité du crop, donc celle
  // à laquelle le ratio doit être jugé. Une image qui ne tombe dans aucun plan
  // ne compte pas — sans plan, elle n'a pas de crop, et on ne peut donc pas dire
  // si elle serait cadrée.
  const shots = shotsForSegments(req.shots, segments)
  const boxesByShot = shots.map((shot) =>
    peopleInSegments.filter((b) => inInterval(b.t, shot.start, shot.end)),
  )

  const measuredAll = boxesByShot.map((boxes) => spans(boxes, options))

  // **Un ratio par plan.** Épinglé, il vaut pour tous ; sinon, chacun prend le
  // plus serré qui tienne chez lui.
  const ratioOf = (measurements: Span[]): Ratio =>
    req.ratio === 'auto' ? chooseRatioFromSpans(measurements, req.srcW, req.srcH) : req.ratio
  const shotRatiosAll = measuredAll.map(ratioOf)

  // **Le split-screen** (spec du 25 août 2026) : un plan à deux personnes,
  // plus large que le 9:16, se pose en deux cellules empilées plutôt qu'un
  // crop unique. Ça ne touche que la variante 9:16 — `shotRatiosAll` et le
  // natif l'ignorent totalement, voir `computeShotSplit`.
  const splitByShotIndex = flag(req.splitScreen, FRAMING_DEFAULTS.splitScreen)
    ? shots.map((shot, i) =>
        computeShotSplit(boxesByShot[i], shot, shotRatiosAll[i], req.srcW, req.srcH, options),
      )
    : null

  // Le ratio du natif : le plus large des plans. Sans plan, le plus large tout
  // court — la même réponse que `chooseRatio` quand il ne mesure rien.
  // **Un intervalle qu'aucun plan ne couvre compte comme un 16:9**, et c'est le
  // cas qui manquait.
  //
  // `splitByShot` donne à un tel intervalle le cadre le plus large, centré : on
  // ne sait rien de ce qui s'y passe. Mais le natif force **toutes** ses entrées
  // au ratio du clip, et il ne produit pas de variante 9:16 quand ce ratio vaut
  // déjà 9:16 — un plan étroit voisin d'un intervalle découvert faisait donc
  // sortir le natif en 9:16, et la queue s'y retrouvait rognée à l'aveugle : 68 %
  // de la largeur jetés, précisément le repli que le découpage prenait soin
  // d'éviter. Le cas est atteignable, les plans partitionnant la durée du
  // *proxy* quand la source peut finir quelques images plus loin.
  // (relevé par Codex et Copilot)
  //
  // Le seuil est celui du découpage : sous une image, l'intervalle est absorbé
  // par son voisin et ne porte aucun cadre à lui.
  const totalDuration = segments.reduce((n, s) => n + (s.end - s.start), 0)
  const covered = shots.reduce(
    (n, p) =>
      n +
      segments.reduce(
        (m, s) => m + Math.max(0, Math.min(p.end, s.end) - Math.max(p.start, s.start)),
        0,
      ),
    0,
  )
  const discovered = totalDuration - covered >= MIN_PIECE_SEC

  // **Sans aucun plan, le plus large**, et pas le plus étroit qu'un accumulateur
  // partant du bas rendrait : on ne sait rien de l'endroit où sont les gens, et
  // c'est déjà la réponse de `chooseRatio` au même silence. Une sortie
  // visiblement large se rattrape d'un clic ; un 9:16 aveugle couperait les
  // comédiens sans que rien ne le signale.
  // **Sur `shotRatiosAll` et non `shotRatios`** : le cas 2 ne touche que la
  // variante 9:16, et `ratio` décide aussi, via `pathsRender`, quels fichiers
  // sont dus.
  const candidates: Ratio[] = discovered ? [...shotRatiosAll, WIDEST] : shotRatiosAll
  const nativeRatio =
    req.ratio !== 'auto'
      ? req.ratio
      : candidates.length === 0
        ? WIDEST
        : candidates.reduce<Ratio>((a, b) => (RATIOS[b] > RATIOS[a] ? b : a), NARROWEST)
  const nativeWidth = ratioCoverage(nativeRatio, req.srcW, req.srcH)

  const framedShots: ShotFraming[] = shots.map((shot, i) => {
    const measurements = measuredAll[i]
    const ratio = shotRatiosAll[i]
    // Le crop se calcule **pour ce ratio-là et jamais pour un autre** — sans
    // quoi un cadre mesuré en 1:1 se retrouverait posé dans un 4:5, décalé de la
    // différence de largeur. Deux ratios, donc deux positions : celle du plan
    // pour la variante 9:16, celle du natif pour le fichier du feed.
    const { cropX: computed } = shotCrop(measurements, ratioCoverage(ratio, req.srcW, req.srcH))
    // Le natif prend les mesures **entières**, celles que le cas 2 n'a pas
    // touchées : sa fenêtre n'a pas la même largeur, et il ne suit personne.
    const { cropX: native } = shotCrop(measuredAll[i], nativeWidth)
    return {
      shot: shot,
      key: shotStartMs(shot),
      ratio,
      // Un plan sans mesure est **centré**, et n'emprunte pas le crop de son
      // voisin : une frontière de plan est précisément l'endroit où l'axe
      // change, donc le seul endroit où la continuité n'est pas une hypothèse
      // défendable. 0,5 est aussi ce que `cropRect` prend quand `cropX` ne veut
      // rien dire, et deux défauts qui divergent finissent par se contredire.
      cropX: computed ?? 0.5,
      cropXNative: native ?? 0.5,
      source: computed === null ? 'default' : 'auto',
      split: splitByShotIndex?.[i].cells ?? undefined,
    }
  })

  return { ratio: nativeRatio, shots: framedShots, rejectedOverrides: applyExceptions(framedShots, req) }
}

/**
 * Pose les dérogations humaines par-dessus les crops calculés et rend les clés
 * rejetées. **En mode `'auto'`, la table est ignorée** — entièrement, y compris
 * pour le rapport : ce qu'elle contient est en sommeil, pas en erreur.
 */
function applyExceptions(shots: ShotFraming[], req: FramingRequest): number[] {
  if (req.cropMode !== 'manual' || !req.crops) return []

  const rejected: number[] = []
  // Une dérogation retenue par plan : `{ clé d'origine, distance, valeur }`.
  const kept = new Map<number, { key: number; distance: number; value: number }>()

  const entries = Object.entries(req.crops)
    .map(([key, value]) => ({ key: Number(key), value }))
    // L'ordre de parcours d'un objet JSON ne se promet pas pour toutes les
    // formes de clés. Trier rend le résultat identique d'une lecture à l'autre.
    .sort((a, b) => a.key - b.key)

  for (const { key, value } of entries) {
    // Une clé illisible ne peut pas être signalée dans une liste de nombres, et
    // n'a jamais pu désigner un plan : elle disparaît.
    if (!Number.isFinite(key)) continue
    if (!Number.isFinite(value)) {
      rejected.push(key)
      continue
    }

    let target: ShotFraming | null = null
    let distance = Number.POSITIVE_INFINITY
    for (const s of shots) {
      const d = Math.abs(s.key - key)
      if (d <= TOLERANCE_EXCEPTION_MS && d < distance) {
        target = s
        distance = d
      }
    }
    if (target === null) {
      rejected.push(key)
      continue
    }

    // Deux dérogations sur le même plan : la plus proche gagne, l'autre est
    // rejetée. Aucune ne s'applique en silence à la place de l'autre.
    const holding = kept.get(target.key)
    if (holding && holding.distance <= distance) {
      rejected.push(key)
      continue
    }
    if (holding) rejected.push(holding.key)
    // Une valeur hors de [0, 1] est **bornée, pas rejetée** : elle vient d'un
    // curseur, c'est une intention maladroite et non une donnée corrompue.
    kept.set(target.key, { key, distance, value: bound(value, 0, 1) })
  }

  for (const s of shots) {
    const exception = kept.get(s.key)
    if (!exception) continue
    // **Les deux positions, et la même.** Une dérogation est une intention
    // humaine sur *où regarder*, pas sur une fenêtre : la poser d'un seul côté
    // ferait diverger le natif et la variante sur un plan que quelqu'un a cadré
    // exprès, et l'écart ne se verrait qu'en comparant deux fichiers.
    s.cropX = exception.value
    s.cropXNative = exception.value
    s.source = 'manual'
  }

  return [...new Set(rejected)].sort((a, b) => a - b)
}
