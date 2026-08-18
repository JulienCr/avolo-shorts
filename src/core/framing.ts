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
 * du temps qui descend sous le 16:9 vaut 25 % sur `2025-06-15-cqlp`, 8 % sur
 * `2026-22-02-entre-nous` et 1 % sur `2026-03-08-caro-mdlm`. Un ratio unique
 * écrase ces 8 à 25 % sous le plan le plus large.
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
export function tailleDansLeCanevas(
  ratio: Ratio,
  canevas: { w: number; h: number },
): { w: number; h: number } {
  return { w: canevas.w, h: Math.min(canevas.h, pairProche(canevas.w / RATIOS[ratio])) }
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
}

/**
 * Les valeurs par défaut des quatre réglages, **exportées parce que les scripts
 * de mesure ont besoin de les nommer**. Un tirage « au voisinage du seuil » qui
 * recopierait `0.35` mesurerait un autre filtre que celui qui décide, et le jour
 * où le seuil bouge, il continuerait de viser l'ancien sans rien signaler.
 *
 * **`margin` valait 0,02 et n'avait jamais été mesuré.** Le balayage du 18 août
 * 2026 (`scripts/mesure-ratios.ts`, `docs/ratios-par-clip.md`) le fait tomber à
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
function réglage(valeur: number | undefined, défaut: number): number {
  return typeof valeur === 'number' && Number.isFinite(valeur) ? valeur : défaut
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
  const bord = réglage(options.bottomEdge, FRAMING_DEFAULTS.bottomEdge)
  const hauteurMax = Math.max(
    0,
    réglage(options.foregroundMaxHeight, FRAMING_DEFAULTS.foregroundMaxHeight),
  )
  // Une seule garde suffit : `y1 - y0` n'est fini que si les deux bornes le sont.
  const hauteur = box.y1 - box.y0
  if (!Number.isFinite(hauteur)) return false
  return box.y1 >= bord && hauteur < hauteurMax
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
  const seuil = réglage(options.minScore, FRAMING_DEFAULTS.minScore)
  const marge = Math.max(0, réglage(options.margin, FRAMING_DEFAULTS.margin))

  const parImage = new Map<number, Empan>()
  for (const b of boxes) {
    // Les boîtes viennent d'un JSON produit par un autre processus. Une borne
    // non finie ou inversée traverserait tout le calcul en `NaN` et ne se
    // verrait qu'au rendu, sous la forme d'un crop absurde.
    if (!Number.isFinite(b.t) || !Number.isFinite(b.x0) || !Number.isFinite(b.x1)) continue
    if (b.x1 <= b.x0) continue
    // `!(score >= seuil)` et non `score < seuil` : un score `NaN` doit sortir.
    if (!(b.score >= seuil)) continue
    // Le public au premier plan, écarté avant de compter l'empan : c'est lui qui
    // faisait sortir tous les clips de `2025-06-15-cqlp` en 16:9.
    if (isForeground(b, options)) continue

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

const LE_PLUS_ÉTROIT = DU_PLUS_ÉTROIT_AU_PLUS_LARGE[0]
const LE_PLUS_LARGE = DU_PLUS_ÉTROIT_AU_PLUS_LARGE[DU_PLUS_ÉTROIT_AU_PLUS_LARGE.length - 1]

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
 * **Les boîtes arrivent pour UN plan, et c'est le changement du 18 août 2026.**
 * Le choix se faisait par clip, sur tous les plans à la fois ; il se fait
 * désormais par plan, et le format du fichier ne dépend plus de lui — toutes les
 * sorties sont en 9:16, le cadre retenu s'y pose et le fond flouté remplit ce
 * qui reste. Un ratio par clip écrasait sous le plan le plus large la part du
 * temps qui descend sous le 16:9 : 25 % sur `2025-06-15-cqlp`, 8 % sur
 * `2026-22-02-entre-nous`, 1 % sur `2026-03-08-caro-mdlm`. Le saut de taille
 * tombe sur une coupe, donc il ne se voit pas.
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
  return choisirRatio(empans(boxes, options), srcW, srcH)
}

/** Le même choix, sur des empans déjà calculés — ce que `computeFraming` a en main. */
function choisirRatio(mesures: Empan[], srcW: number, srcH: number): Ratio {
  if (mesures.length === 0) return LE_PLUS_LARGE

  for (const r of DU_PLUS_ÉTROIT_AU_PLUS_LARGE) {
    const { cadrées } = cropDuPlan(mesures, ratioCoverage(r, srcW, srcH))
    // `× 10 ≥ × 9` plutôt que `≥ 0,9 ×` : `0.9 * 40` vaut 36,000000000000004, et
    // 36 images sur 40 rateraient de justesse le seuil qu'elles atteignent pile.
    if (cadrées * 10 >= mesures.length * 9) return r
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
 * Il n'y a **pas de zone interdite** ici, et la spec §10 ne le réclame plus :
 * constaté à l'image, le panneau de chat n'existe que sur `2025-06-15-cqlp` et
 * le bloc « SOMMAIRE » reste une préférence, pas une interdiction.
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

/** Le cadrage d'un plan du clip : un ratio, et une position. */
export type ShotFraming = {
  /** Le plan, avec ses bornes dans la source. */
  shot: Shot
  /** Sa clé de dérogation, `shotStartMs(shot)`. */
  key: number
  /**
   * Le cadre pris dans la source pour ce plan : le plus serré qui tienne.
   *
   * **Ce n'est pas le format du fichier**, qui vaut toujours 9:16 : c'est ce
   * qu'on découpe, et qui sera posé sur le canevas avec un fond flouté autour —
   * pleine hauteur pour un 9:16, 31,6 % pour un 16:9.
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
  cropXNatif: number
  /**
   * D'où vient le cadrage : `'auto'` calculé sur les boîtes, `'manual'` posé par
   * une dérogation humaine, `'default'` centré faute d'avoir mesuré quoi que ce
   * soit sur ce plan. Le troisième cas mérite d'être visible dans l'interface :
   * c'est un plan que personne n'a cadré, ni la machine ni l'humain.
   */
  source: 'auto' | 'default' | 'manual'
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
   * choisit mal, et elle porte sur le **cadre**, pas sur le format du fichier,
   * qui reste 9:16 dans les deux cas.
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
const TOLÉRANCE_DÉROGATION_MS = 250

/**
 * Le cadrage complet d'un clip : **par plan**, un ratio et un crop, puis les
 * dérogations humaines par-dessus.
 *
 * Chaque plan reçoit le cadre le plus serré qu'une position fixe y tienne pour
 * 90 % de ses images — voir `chooseRatio`. Le format du fichier ne s'en déduit
 * pas : il vaut 9:16 pour tous.
 *
 * **Quand le ratio est épinglé, le choix est sauté — mais pas le calcul des
 * crops.** Ils se calculent alors pour *ce* ratio-là : sans ça, des crops cadrés
 * pour un 1:1 se retrouveraient posés dans un cadre 4:5, décalés de la
 * différence de largeur.
 *
 * La sortie est une **donnée**, pas un `argv`. `découperParPlan` la traduit en
 * morceaux à décoder, et `renderArgs` en filtergraph.
 */
export function computeFraming(req: FramingRequest): ClipFraming {
  const segments = normalizeSegments(req.segments)
  // Recopiés un par un, et non par étalement de `req` : `FramingRequest` porte
  // aussi des segments, des plans et un mode, et les laisser passer ferait de
  // `empans` un consommateur de tout, dont plus rien ne dirait ce qu'il lit.
  const options: FramingOptions = {
    minScore: req.minScore,
    margin: req.margin,
    bottomEdge: req.bottomEdge,
    foregroundMaxHeight: req.foregroundMaxHeight,
  }

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

  // **Un ratio par plan.** Épinglé, il vaut pour tous ; sinon, chacun prend le
  // plus serré qui tienne chez lui.
  const ratiosDesPlans = mesuresParPlan.map((mesures) =>
    req.ratio === 'auto' ? choisirRatio(mesures, req.srcW, req.srcH) : req.ratio,
  )

  // Le ratio du natif : le plus large des plans. Sans plan, le plus large tout
  // court — la même réponse que `chooseRatio` quand il ne mesure rien.
  // **Sans aucun plan, le plus large**, et pas le plus étroit qu'un accumulateur
  // partant du bas rendrait : on ne sait rien de l'endroit où sont les gens, et
  // c'est déjà la réponse de `chooseRatio` au même silence. Une sortie
  // visiblement large se rattrape d'un clic ; un 9:16 aveugle couperait les
  // comédiens sans que rien ne le signale.
  const ratioNatif =
    req.ratio !== 'auto'
      ? req.ratio
      : ratiosDesPlans.length === 0
        ? LE_PLUS_LARGE
        : ratiosDesPlans.reduce<Ratio>((a, b) => (RATIOS[b] > RATIOS[a] ? b : a), LE_PLUS_ÉTROIT)
  const largeurNative = ratioCoverage(ratioNatif, req.srcW, req.srcH)

  const shots: ShotFraming[] = plans.map((plan, i) => {
    const mesures = mesuresParPlan[i]
    const ratio = ratiosDesPlans[i]
    // Le crop se calcule **pour ce ratio-là et jamais pour un autre** — sans
    // quoi un cadre mesuré en 1:1 se retrouverait posé dans un 4:5, décalé de la
    // différence de largeur. Deux ratios, donc deux positions : celle du plan
    // pour la variante 9:16, celle du natif pour le fichier du feed.
    const { cropX: calculé } = cropDuPlan(mesures, ratioCoverage(ratio, req.srcW, req.srcH))
    const { cropX: natif } = cropDuPlan(mesures, largeurNative)
    return {
      shot: plan,
      key: shotStartMs(plan),
      ratio,
      // Un plan sans mesure est **centré**, et n'emprunte pas le crop de son
      // voisin : une frontière de plan est précisément l'endroit où l'axe
      // change, donc le seul endroit où la continuité n'est pas une hypothèse
      // défendable. 0,5 est aussi ce que `cropRect` prend quand `cropX` ne veut
      // rien dire, et deux défauts qui divergent finissent par se contredire.
      cropX: calculé ?? 0.5,
      cropXNatif: natif ?? 0.5,
      source: calculé === null ? 'default' : 'auto',
    }
  })

  return { ratio: ratioNatif, shots, rejectedOverrides: appliquerDérogations(shots, req) }
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
    // **Les deux positions, et la même.** Une dérogation est une intention
    // humaine sur *où regarder*, pas sur une fenêtre : la poser d'un seul côté
    // ferait diverger le natif et la variante sur un plan que quelqu'un a cadré
    // exprès, et l'écart ne se verrait qu'en comparant deux fichiers.
    s.cropX = dérogation.valeur
    s.cropXNatif = dérogation.valeur
    s.source = 'manual'
  }

  return [...new Set(rejetées)].sort((a, b) => a - b)
}
