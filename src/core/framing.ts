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

import { normalizeSegments } from '@/core/edl'
import type { Ratio, Segment } from '@/core/edl'
import { shotStartMs, shotsForSegments } from '@/core/shots'
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
   * Un réglage de confort, pas une mesure : la boîte du détecteur épouse la
   * silhouette, et un crop posé pile dessus met un coude sur le bord de l'image.
   */
  margin?: number
}

const SCORE_MINIMAL = 0.5
const MARGE = 0.02

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
function réglage(valeur: number | undefined, défaut: number): number {
  return typeof valeur === 'number' && Number.isFinite(valeur) ? valeur : défaut
}

/**
 * La médiane, au sens strict : sur un nombre **pair** de valeurs, le milieu des
 * deux centrales et non la plus basse des deux.
 *
 * La différence ne se voit que sur un plan partagé en deux moitiés égales — et
 * c'est exactement le cas où prendre la plus basse fait pencher à gauche un
 * départage qui n'a aucune raison de pencher. (relevé par Copilot)
 */
function médiane(triées: number[]): number {
  const m = triées.length >> 1
  return triées.length % 2 === 1 ? triées[m] : (triées[m - 1] + triées[m]) / 2
}

/** L'empan des personnes d'une image, marge comprise, en fractions de largeur. */
type Empan = { t: number; g: number; d: number }

/**
 * `t` tombe-t-il dans l'intervalle ? **Fin exclue** : une image posée pile sur
 * la borne appartient à ce qui suit. Sans cette convention, l'image d'une
 * frontière de plan compterait dans les deux plans, et celle d'une borne de
 * segment dans un segment qui ne la montre pas.
 */
function dansIntervalle(t: number, début: number, fin: number): boolean {
  return t >= début && t < fin
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
function empans(boxes: PersonBox[], options: FramingOptions = {}): Empan[] {
  const seuil = réglage(options.minScore, SCORE_MINIMAL)
  const marge = Math.max(0, réglage(options.margin, MARGE))

  const parImage = new Map<number, Empan>()
  for (const b of boxes) {
    // Les boîtes viennent d'un JSON produit par un autre processus. Une borne
    // non finie ou inversée traverserait tout le calcul en `NaN` et ne se
    // verrait qu'au rendu, sous la forme d'un crop absurde.
    if (!Number.isFinite(b.t) || !Number.isFinite(b.x0) || !Number.isFinite(b.x1)) continue
    if (b.x1 <= b.x0) continue
    // `!(score >= seuil)` et non `score < seuil` : un score `NaN` doit sortir.
    if (!(b.score >= seuil)) continue

    const clé = Math.round(b.t * 1000)
    const déjà = parImage.get(clé)
    if (déjà) {
      déjà.g = Math.min(déjà.g, b.x0)
      déjà.d = Math.max(déjà.d, b.x1)
    } else {
      parImage.set(clé, { t: b.t, g: b.x0, d: b.x1 })
    }
  }

  return [...parImage.values()].map((e) => ({
    t: e.t,
    g: Math.max(0, e.g - marge),
    d: Math.min(1, e.d + marge),
  }))
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
  return empans(boxes, options).map((e) => e.d - e.g)
}

/** Les quatre ratios du plus étroit au plus large, déduits de `RATIOS`. */
const DU_PLUS_ÉTROIT_AU_PLUS_LARGE: Ratio[] = (Object.keys(RATIOS) as Ratio[]).sort(
  (a, b) => RATIOS[a] - RATIOS[b],
)

const LE_PLUS_LARGE = DU_PLUS_ÉTROIT_AU_PLUS_LARGE[DU_PLUS_ÉTROIT_AU_PLUS_LARGE.length - 1]

/**
 * Le plus petit ratio dont **un crop fixe par plan cadre 90 % des images**.
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
 * Les boîtes arrivent **groupées par plan**, parce que c'est la granularité du
 * crop. Le même déplacement réparti sur deux plans ne coûte rien — une coupe
 * existe entre les deux, et le crop a le droit d'y sauter.
 */
export function chooseRatio(
  peoplePerShot: PersonBox[][],
  srcW: number,
  srcH: number,
  options: FramingOptions = {},
): Ratio {
  return choisirRatio(
    peoplePerShot.map((boxes) => empans(boxes, options)),
    srcW,
    srcH,
  )
}

/** Le même choix, sur des empans déjà calculés — ce que `computeFraming` a en main. */
function choisirRatio(mesuresParPlan: Empan[][], srcW: number, srcH: number): Ratio {
  const total = mesuresParPlan.reduce((n, m) => n + m.length, 0)
  if (total === 0) return LE_PLUS_LARGE

  for (const r of DU_PLUS_ÉTROIT_AU_PLUS_LARGE) {
    const largeur = ratioCoverage(r, srcW, srcH)
    const cadrées = mesuresParPlan.reduce((n, m) => n + cropDuPlan(m, largeur).cadrées, 0)
    // `× 10 ≥ × 9` plutôt que `≥ 0,9 ×` : `0.9 * 40` vaut 36,000000000000004, et
    // 36 images sur 40 rateraient de justesse le seuil qu'elles atteignent pile.
    if (cadrées * 10 >= total * 9) return r
  }

  // Inatteignable en pratique : le ratio le plus large couvre toute la largeur
  // de la source, donc une position unique y cadre toutes les images. Le filet
  // reste, parce qu'une fonction qui rend `undefined` sur un cas qu'on croyait
  // impossible est pire que celle qui rend le pire ratio.
  return LE_PLUS_LARGE
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
 * Il n'y a **pas de zone interdite** ici, malgré ce que la spec §10 réclame
 * encore —
 * constaté à l'image, le panneau de chat n'existe que sur `2025-06-15-cqlp` et
 * le bloc « SOMMAIRE » reste une préférence, pas une interdiction. Ce passage
 * de la spec est en cours de correction ailleurs.
 *
 * `cropX` vaut `null` quand le plan n'a **aucune** image mesurée : l'appelant
 * décide, et il n'y a rien à moyenner. `cadrées` compte les images que la
 * position rendue cadre entièrement — c'est ce dont `chooseRatio` a besoin pour
 * juger un ratio sur ce qu'il permet vraiment, et non sur une largeur.
 */
function cropDuPlan(mesures: Empan[], largeur: number): { cropX: number | null; cadrées: number } {
  if (mesures.length === 0) return { cropX: null, cadrées: 0 }

  const demi = largeur / 2
  // Le crop reste dans l'image : `cropRect` borne déjà, mais rendre une valeur
  // qu'il faudra borner plus loin, c'est rendre une donnée fausse.
  const légal = (c: number): number => borner(c, demi, 1 - demi)

  const cible = médiane(mesures.map((e) => (e.g + e.d) / 2).sort((a, b) => a - b))

  // L'intervalle des centres qui cadrent entièrement cette image. Triés par
  // `lo` : à recouvrement et à distance égaux, c'est le premier essayé qui
  // l'emporte, et « le premier » doit vouloir dire le plus à gauche plutôt que
  // le premier dans l'ordre des images, qui ne veut rien dire.
  const intervalles = mesures
    .filter((e) => e.d - e.g <= largeur + 1e-9)
    .map((e) => ({ lo: e.d - demi, hi: e.g + demi }))
    .sort((a, b) => a.lo - b.lo)
  if (intervalles.length === 0) return { cropX: légal(cible), cadrées: 0 }

  // Le recouvrement maximal est atteint sur au moins un `lo` : au-dessous, une
  // image de plus sortirait du cadre. On les essaie donc tous, et pour chacun on
  // regarde jusqu'où les mêmes images restent cadrées — ce plateau.
  let meilleur = { images: -1, centre: cible }
  for (const { lo } of intervalles) {
    let images = 0
    let hi = Number.POSITIVE_INFINITY
    for (const i of intervalles) {
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
    const centre = borner(cible, lo, hi)
    // Le `1e-9` fait tenir la règle annoncée. Sans lui, deux positions
    // symétriques ne sont jamais à égalité *exacte* — `0.92 - 0.225` et
    // `0.08 + 0.225` ne tombent pas à la même distance de 0,5 à 4e-17 près — et
    // c'est ce bruit-là qui tranchait, pas le tri. Un départage qui dépend du
    // dernier bit d'un flottant n'est pas déterministe, il est seulement stable
    // tant que personne ne touche à l'arithmétique.
    const mieux =
      images > meilleur.images ||
      (images === meilleur.images &&
        Math.abs(centre - cible) < Math.abs(meilleur.centre - cible) - 1e-9)
    if (mieux) meilleur = { images, centre }
  }

  const cropX = légal(meilleur.centre)
  // Recompté sur la position finalement rendue. Le bornage dans l'image ne peut
  // pas sortir du plateau — ça se démontre — mais compter ce qu'on rend vraiment
  // survit à une démonstration qui se périme.
  return { cropX, cadrées: intervalles.filter((i) => i.lo <= cropX && cropX <= i.hi).length }
}

/** Le cadrage d'un plan du clip. */
export type ShotFraming = {
  /** Le plan, avec ses bornes dans la source. */
  shot: Shot
  /** Sa clé de dérogation, `shotStartMs(shot)`. */
  key: number
  /** Le centre horizontal du crop, 0 à 1, tel que `cropRect` l'attend. */
  cropX: number
  /**
   * D'où vient `cropX` : `'auto'` calculé sur les boîtes, `'manual'` posé par
   * une dérogation humaine, `'default'` centré faute d'avoir mesuré quoi que ce
   * soit sur ce plan. Le troisième cas mérite d'être visible dans l'interface :
   * c'est un plan que personne n'a cadré, ni la machine ni l'humain.
   */
  source: 'auto' | 'default' | 'manual'
}

/** Le cadrage d'un clip : un ratio, un crop par plan, et ce qui n'a pas collé. */
export type ClipFraming = {
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
  /** `'auto'` recalcule ; un ratio concret est épinglé et ne bouge plus. */
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
const TOLÉRANCE_DÉROGATION_MS = 250

/**
 * Le cadrage complet d'un clip : le ratio, puis un crop par plan, puis les
 * dérogations humaines par-dessus.
 *
 * Le ratio se choisit sur ce qu'un crop fixe par plan cadre réellement, pas sur
 * les largeurs par image — voir `chooseRatio`.
 *
 * **Quand le ratio est épinglé, le choix du ratio est sauté — mais pas le calcul
 * des crops.** Ils se calculent alors pour *ce* ratio : sans ça, des crops
 * cadrés pour un 1:1 se retrouveraient posés dans un canevas 4:5, décalés de la
 * différence de largeur.
 *
 * La sortie est une **donnée**, pas un `argv`. Le rendu applique aujourd'hui un
 * seul rectangle à tous les segments ; le faire varier par plan est une autre
 * tâche, et elle lira ceci.
 */
export function computeFraming(req: FramingRequest): ClipFraming {
  const segments = normalizeSegments(req.segments)
  const options: FramingOptions = { minScore: req.minScore, margin: req.margin }

  // Seules les images des segments retenus comptent (spec §10) : le clip ne
  // montre rien d'autre, et une image coupée au montage n'a pas voix au
  // chapitre. C'est aussi ce qui fait que les crops se recalculent quand le
  // montage change — et pourquoi les dérogations ne peuvent pas s'indexer sur
  // autre chose que la source.
  const montées = req.people.filter((b) =>
    segments.some((s) => dansIntervalle(b.t, s.start, s.end)),
  )

  // Groupées par plan dès maintenant : c'est la granularité du crop, donc celle
  // à laquelle le ratio doit être jugé. Une image qui ne tombe dans aucun plan
  // ne compte pas — sans plan, elle n'a pas de crop, et on ne peut donc pas dire
  // si elle serait cadrée.
  const plans = shotsForSegments(req.shots, segments)
  const mesuresParPlan = plans.map((plan) =>
    empans(
      montées.filter((b) => dansIntervalle(b.t, plan.start, plan.end)),
      options,
    ),
  )

  const ratio = req.ratio === 'auto' ? choisirRatio(mesuresParPlan, req.srcW, req.srcH) : req.ratio
  const largeur = ratioCoverage(ratio, req.srcW, req.srcH)

  const shots: ShotFraming[] = plans.map((plan, i) => {
    const { cropX: calculé } = cropDuPlan(mesuresParPlan[i], largeur)
    return {
      shot: plan,
      key: shotStartMs(plan),
      // Un plan sans mesure est **centré**, et n'emprunte pas le crop de son
      // voisin : une frontière de plan est précisément l'endroit où l'axe
      // change, donc le seul endroit où la continuité n'est pas une hypothèse
      // défendable. 0,5 est aussi ce que `cropRect` prend quand `cropX` ne veut
      // rien dire, et deux défauts qui divergent finissent par se contredire.
      cropX: calculé ?? 0.5,
      source: calculé === null ? 'default' : 'auto',
    }
  })

  return { ratio, shots, rejectedOverrides: appliquerDérogations(shots, req) }
}

/**
 * Pose les dérogations humaines par-dessus les crops calculés et rend les clés
 * rejetées. **En mode `'auto'`, la table est ignorée** — entièrement, y compris
 * pour le rapport : ce qu'elle contient est en sommeil, pas en erreur.
 */
function appliquerDérogations(shots: ShotFraming[], req: FramingRequest): number[] {
  if (req.cropMode !== 'manual' || !req.crops) return []

  const rejetées: number[] = []
  // Une dérogation retenue par plan : `{ clé d'origine, distance, valeur }`.
  const retenues = new Map<number, { clé: number; distance: number; valeur: number }>()

  const entrées = Object.entries(req.crops)
    .map(([clé, valeur]) => ({ clé: Number(clé), valeur }))
    // L'ordre de parcours d'un objet JSON ne se promet pas pour toutes les
    // formes de clés. Trier rend le résultat identique d'une lecture à l'autre.
    .sort((a, b) => a.clé - b.clé)

  for (const { clé, valeur } of entrées) {
    // Une clé illisible ne peut pas être signalée dans une liste de nombres, et
    // n'a jamais pu désigner un plan : elle disparaît.
    if (!Number.isFinite(clé)) continue
    if (!Number.isFinite(valeur)) {
      rejetées.push(clé)
      continue
    }

    let cible: ShotFraming | null = null
    let distance = Number.POSITIVE_INFINITY
    for (const s of shots) {
      const d = Math.abs(s.key - clé)
      if (d <= TOLÉRANCE_DÉROGATION_MS && d < distance) {
        cible = s
        distance = d
      }
    }
    if (cible === null) {
      rejetées.push(clé)
      continue
    }

    // Deux dérogations sur le même plan : la plus proche gagne, l'autre est
    // rejetée. Aucune ne s'applique en silence à la place de l'autre.
    const tenante = retenues.get(cible.key)
    if (tenante && tenante.distance <= distance) {
      rejetées.push(clé)
      continue
    }
    if (tenante) rejetées.push(tenante.clé)
    // Une valeur hors de [0, 1] est **bornée, pas rejetée** : elle vient d'un
    // curseur, c'est une intention maladroite et non une donnée corrompue.
    retenues.set(cible.key, { clé, distance, valeur: borner(valeur, 0, 1) })
  }

  for (const s of shots) {
    const dérogation = retenues.get(s.key)
    if (!dérogation) continue
    s.cropX = dérogation.valeur
    s.source = 'manual'
  }

  return [...new Set(rejetées)].sort((a, b) => a - b)
}
