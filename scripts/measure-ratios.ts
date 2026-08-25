/**
 * Le ratio que le cadrage automatique choisit, clip par clip, sur plusieurs
 * émissions — et ce que ses deux réglages d'empan lui coûtent.
 *
 *     pnpm tsx scripts/mesure-ratios.ts 2025-06-15-cqlp 2026-03-08-caro-mdlm
 *
 * **La question à laquelle ce script répond.** Sur `2025-06-15-cqlp`, les dix
 * clips réels sortent tous en 16:9, avant comme après le filtre du public au
 * premier plan. Deux explications coexistaient : ou bien cette émission est le
 * pire cas connu — elle porte un panneau de chat Twitch sur 20 % de la largeur et
 * elle est la seule des vingt dans ce cas —, ou bien **le ratio par clip est
 * large partout**, auquel cas l'itération 1 construirait un crop par plan qui ne
 * se déclenche jamais. Départager demande la répartition des ratios sur une
 * émission sans chat incrusté, et personne ne l'avait mesurée.
 *
 * `scripts/mesure-premier-plan.ts` répond à une autre question — *ce que le
 * filtre écarte* — et compare pour ça trois réglages du filtre sur une seule
 * émission. Celui-ci laisse le filtre à son défaut et compare des **émissions**,
 * puis des **marges**. Les deux se recoupent sur une ligne, la répartition des
 * ratios, et c'est voulu : elle est le point de contrôle commun.
 *
 * Neuf sorties :
 *
 * 1. **Le ratio par clip**, avec l'empan résiduel qui l'explique. Les clips sont
 *    ceux du projet, ceux que le repérage a retenus.
 * 2. **La répartition comparée**, clips et fenêtres régulières. Dix clips ne font
 *    pas une distribution ; les fenêtres disent ce qu'un clip quelconque
 *    deviendrait.
 * 3. **Le balayage de la marge.** `FramingOptions.margin` valait 2 % sans avoir
 *    jamais été mesuré : un réglage de confort, posé parce qu'un crop pile sur la
 *    boîte du détecteur met un coude au bord. Elle coûte deux fois sa valeur en
 *    empan — une fois de chaque côté — et arbitre plusieurs clips autour du seuil
 *    du 1:1. C'est ce balayage qui l'a fait tomber à 1 %.
 * 4. **Le balayage du rognage latéral**, avec en regard **ce qui est coupé des
 *    gens**. Les deux moitiés ne se lisent pas séparément : un rognage assez fort
 *    fait basculer n'importe quel plan en 1:1, il suffit de couper les comédiens.
 *    C'est ce balayage qui a posé la part à 0,30 et son plafond à 0,12.
 * 5. **Les plans que la position borne**, et non la largeur : ceux dont toutes
 *    les images tiendraient plus serré, mais qu'aucune position fixe ne sert.
 *    C'est la signature d'une frontière de plan manquée, et ça ne se corrige pas
 *    dans le choix du ratio.
 * 6. **Le tronc contre la boîte corps entier**, sur une analyse qui porte des
 *    points de pose. C'est le balayage de l'issue #69 : ce que chaque définition
 *    de tronc gagne en ratio, ce qu'elle coupe des gens, et ce qu'il reste au
 *    rognage latéral une fois le tronc en place.
 * 7. **Où regarder** : les images d'une fenêtre qui font le plus monter le
 *    ratio, pour rejouer un balayage sur l'image plutôt que sur un chiffre.
 * 8. **Le plancher de taille** (PR #177) : ce qu'il change au ratio, et à
 *    l'effectif retenu par image — ce second chiffre n'avait jamais été mesuré.
 * 9. **Le split-screen**, deux personnes deux cellules : le rendement par
 *    plan, ses causes de refus, et le contrôle que le fichier natif ne bouge
 *    pas, split activé ou non.
 *
 * **Le chiffre qui décide est le temps de montage par ratio, pas le compte de
 * clips.** Depuis que le ratio se choisit par plan, un clip « en 16:9 » est
 * seulement un clip dont le *fichier natif* prend le plus large de ses plans ; ce
 * que la variante 9:16 montre, plan par plan, se mesure en secondes. Les deux
 * lignes sont imprimées côte à côte partout où elles existent.
 *
 * Deux drapeaux changent ce qui est lu et avec quoi :
 *
 * - `--analyse <projet>=<fichier>` lit une autre analyse que celle de
 *   `projects/<projet>/analysis.json`. C'est ce qui permet de comparer deux
 *   détecteurs sans écraser le fichier que le serveur sert. **Une occurrence par
 *   projet** : deux analyses de la même émission se comparent en deux
 *   exécutions, et un doublon est refusé plutôt qu'écrasé.
 * - `--tronc <nom|off>` fixe la définition de tronc des sections 1 à 5 et 7. La
 *   section 6 balaie le tronc, et les deux balayages de ses réglages le forcent
 *   à son défaut : hérités d'un `--tronc off`, ils n'auraient rien à régler.
 *
 * Et `--instants N` imprime, par clip, les N images qui **font monter le ratio** :
 * les plus larges après filtrage, une par plan au plus, parce que le crop est
 * fixe à l'intérieur d'un plan et que deux images du même plan ont le même
 * cadrage à expliquer. La ligne à passer à `vignettes-premier-plan.ts` est
 * imprimée avec — un chiffre ne dit pas si les comédiens sont *vraiment* aux deux
 * bords, et sur ce sujet le dépôt s'est déjà trompé une fois en ne regardant que
 * des histogrammes.
 *
 * Rien n'échoue ici : le script imprime des chiffres, et c'est en les lisant
 * qu'on décide.
 */

import fs from 'node:fs'

import {
  FRAMING_DEFAULTS,
  RATIOS,
  TORSOS,
  computeFraming,
  computeShotSplit,
  hasValidGeometry,
  isForeground,
  personBounds,
  ratioCoverage,
  requiredWidths,
  retainedCountByFrame,
  torsoBounds,
  trimmedBounds,
} from '@/core/framing'
import type { ClipFraming, SplitRejection, TorsoName } from '@/core/framing'
import type { FramingOptions } from '@/core/framing'
import { normalizeSegments } from '@/core/edl'
import type { Ratio, Segment } from '@/core/edl'
import type { PersonBox } from '@/core/shots'
import { closeDb, getClips, getDb } from '@/server/db'
import { analysisPath } from '@/server/paths'
import { lireAnalysis, type Analysis } from '@/server/steps/analysis'
import { chargerEnv, quit } from './dev-common'

/** Les quatre ratios du plus étroit au plus large, déduits de `RATIOS`. */
const MORE_NARROW_MORE_WIDE = (Object.keys(RATIOS) as Ratio[]).sort(
  (a, b) => RATIOS[a] - RATIOS[b],
)

/**
 * Les marges balayées : les quatre valeurs de la campagne, **plus le défaut en
 * vigueur**.
 *
 * Le défaut y est par `FRAMING_DEFAULTS.margin` et non recopié — sans quoi le
 * jour où il bouge, le balayage continuerait de viser l'ancienne valeur sans
 * rien signaler. Et les quatre valeurs restent écrites en clair *à côté* de lui,
 * parce que la campagne les compare : les fondre dans le défaut a fait
 * disparaître 0,02 de la sortie à la seconde où il a cessé d'être le défaut,
 * c'est-à-dire à la seconde où la comparaison devenait intéressante.
 */
const MARGINS = [...new Set([0, 0.01, 0.02, 0.03, FRAMING_DEFAULTS.margin])].sort((a, b) => a - b)

/**
 * Les rognages balayés, **plus le défaut en vigueur** — même règle que `MARGINS`,
 * et pour la même raison : recopier la valeur du jour la fait disparaître de la
 * sortie le jour où elle bouge.
 *
 * La plage va de zéro — le comportement d'avant le 19 août 2026, qui exige que
 * les boîtes tiennent en entier — jusqu'au delà de ce qui a été retenu, parce
 * que c'est la pente au-delà du défaut qui dit s'il est posé sur une falaise.
 */
const SIDE_TRIMS = [
  ...new Set([0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.325, 0.35, 0.4, FRAMING_DEFAULTS.sideTrim]),
].sort((a, b) => a - b)

/**
 * Les planchers de taille balayés, **plus le défaut en vigueur** — même règle
 * que `SIDE_TRIMS`. `0,41` est la part exacte de la jaquette de DVD mesurée sur
 * `nabla` à 984,0 s : elle sert de repère, pas de candidat, et n'est retenue que
 * si elle coïncide déjà avec l'une des valeurs rondes.
 */
const SIZE_FLOORS = [
  ...new Set([0, 0.3, 0.4, 0.5, 0.6, 0.7, FRAMING_DEFAULTS.sizeFloor]),
].sort((a, b) => a - b)

/**
 * L'intervalle entre deux images mesurées, en secondes, **lu dans l'analyse**.
 *
 * Il sert à convertir un compte d'images en durée, et c'est la seule forme sous
 * laquelle une perte se juge : « huit boîtes sur deux mille » ne dit pas si le
 * spectateur voit quelqu'un sortir du cadre pendant quatre secondes ou pendant
 * un battement de paupières.
 *
 * **Pas la constante 0,5 qu'il valait**, même si les trois émissions mesurées
 * sont toutes à 2 im/s : `detect.py` accepte `--fps`, chaque `analysis.json`
 * porte le sien, et une analyse produite à 1 ou 4 im/s aurait fait afficher des
 * durées fausses sans que rien ne les contredise — le compte d'images, lui,
 * serait resté juste. (relevé par Copilot)
 */
function sampleStep(analysis: Analysis): number {
  return analysis.fps > 0 ? 1 / analysis.fps : Number.NaN
}

/**
 * Les définitions de tronc balayées, **plus le repli sans tronc**.
 *
 * `'off'` n'est pas une valeur de plus dans la liste : c'est la ligne de base,
 * celle qui reproduit le cadrage d'avant les points de pose. Sans elle, le
 * tableau dirait ce que chaque tronc vaut par rapport aux autres et jamais ce
 * qu'il vaut par rapport à ce qui tourne aujourd'hui.
 */
const TORSO_NAMES: readonly (TorsoName | 'off')[] = ['off', ...(Object.keys(TORSOS) as TorsoName[])]

/**
 * Les élargissements de tronc balayés, **plus le défaut en vigueur** — même
 * règle que `MARGINS` et `SIDE_TRIMS`.
 */
const TORSO_PADS = [...new Set([0, 0.1, 0.15, 0.2, 0.3, FRAMING_DEFAULTS.torsoPad])].sort(
  (a, b) => a - b,
)

/**
 * Les rognages de tronc balayés, **plus le défaut en vigueur**.
 *
 * La plage monte jusqu'à la demi-largeur, où il ne reste du tronc que son
 * milieu — et, la tête servant de plancher, exactement la tête. C'est la borne
 * de l'exercice : au-delà, il n'y a plus rien à abandonner.
 */
const TORSO_TRIMS = [
  ...new Set([0, 0.1, 0.2, 0.3, 0.4, 0.5, FRAMING_DEFAULTS.torsoTrim]),
].sort((a, b) => a - b)

/**
 * Les réglages communs à toutes les sections, **posés une fois** depuis la ligne
 * de commande.
 *
 * Un objet mutable de module plutôt qu'un argument passé de fonction en
 * fonction : chaque section a déjà sa propre notion de « ce qui varie », et
 * ajouter un paramètre partout ferait que le jour où quelqu'un en oublie un, une
 * section mesurerait un autre cadrage que ses voisines sous le même en-tête.
 */
const BASE: FramingOptions = {}

/** Les réglages de base, éventuellement surchargés par ce que la section fait varier. */
function opts(extra: FramingOptions = {}): FramingOptions {
  return { ...BASE, ...extra }
}

/** Une découpe à cadrer : un nom et des segments. */
type Cut = { name: string; segments: Segment[] }

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const m = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

/**
 * Le percentile `p` (0 à 1), par le rang le plus proche.
 *
 * `p90` est la grandeur qui parle ici, puisque le ratio se choisit sur « 90 % des
 * images tiennent ». **Mais elle ne décide pas** : elle porte sur des largeurs
 * par image, donc elle suppose un crop libre par image, alors que le crop est
 * fixe pour tout le plan. C'est une **borne optimiste** — le ratio réel est ce
 * qu'elle indique ou plus large, jamais plus serré. La spec §10 le dit d'un
 * autre côté : un sujet étroit à gauche puis à droite tient partout image par
 * image et nulle part avec une position fixe.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[i]
}

function number(n: number, decimals = 3): string {
  return Number.isFinite(n) ? n.toFixed(decimals) : '—'
}

/** Le cadrage complet d'une découpe : le ratio natif, et un cadre par plan. */
function framingOf(cut: Cut, analysis: Analysis, options: FramingOptions): ClipFraming {
  return computeFraming({
    ...options,
    segments: cut.segments,
    shots: analysis.shots,
    people: analysis.boxes,
    srcW: analysis.source.w,
    srcH: analysis.source.h,
    ratio: 'auto',
    cropMode: 'auto',
  })
}

/** Le ratio du fichier natif d'une découpe : le plus large de ses plans. */
function ratio(cut: Cut, analysis: Analysis, options: FramingOptions): Ratio {
  return framingOf(cut, analysis, options).ratio
}

/**
 * Les points de tête d'une personne, ceux dont la présence dans le cadre n'est
 * pas négociable : nez, yeux, oreilles.
 *
 * Les cinq et pas seulement le nez — un profil ne montre qu'un œil et qu'une
 * oreille, et un dos n'en montre aucun. La confiance décide, pas le rang.
 */
const HEAD_POINTS = TORSOS.head

/** Ce qu'un cadrage coûte à une découpe, sur les trois grandeurs qui le jugent. */
type Cost = {
  /** Ce qui est coupé de chaque **boîte corps entier**, une valeur par boîte. */
  box: number[]
  /** Ce qui est coupé de chaque **tronc**, quand la personne en a un de lisible. */
  torso: number[]
  /**
   * La **pire** perte de boîte de chaque image, une valeur par image mesurée.
   *
   * **C'est la seule des deux qui se convertit en secondes**, et l'autre ne le
   * peut pas : `box` porte une valeur par (personne, image), donc en compter les
   * éléments et les multiplier par le pas d'échantillonnage rend des
   * *personnes-secondes*. Deux comédiens amputés sur la même image de 0,5 s
   * donnaient « 1,0 s », c'est-à-dire deux fois la durée pendant laquelle le
   * spectateur voit quelque chose. Sur une émission à deux comédiens, l'écart
   * va jusqu'au facteur deux. (relevé par Copilot)
   */
  worstPerFrame: number[]
  /** Le nombre de (personne, image) dont **aucun point de tête** n'est dans le cadre. */
  headsOutside: number
  /** Le nombre d'**images** où au moins une tête est dehors — celui qui fait des secondes. */
  framesWithHeadOutside: number
  /** Celles dont un point de tête est dans le cadre mais à moins de 1 % du bord. */
  headsAtEdge: number
  /** Le nombre de personnes-images examinées, pour rapporter les deux précédents. */
  people: number
}

/**
 * Ce que le cadrage retenu **coûte aux gens**, plan par plan.
 *
 * **C'est la mesure de sûreté, et elle ne se déduit d'aucune autre.** La
 * répartition des ratios dit ce qu'on gagne ; celle-ci dit ce qu'on paie. Un
 * réglage qui fait basculer tous les clips en 1:1 en coupant un comédien sur
 * deux n'est pas un progrès.
 *
 * Le cadre mesuré est **celui du plan**, pas celui du natif : c'est le plus
 * serré des deux (le natif prend le plus large des plans), donc le seul qui
 * puisse couper quelqu'un que l'autre garderait.
 *
 * Les images que le seuil de 90 % sacrifie sont **comptées comme les autres**, et
 * c'est tout l'intérêt : rien d'autre ne les regarde. Le choix du ratio les
 * ignore par construction, donc c'est exactement là que se cachent les pertes
 * qu'aucun tableau de ratios ne montre.
 *
 * **`headsOutside` est l'instrument qui manquait au 19 août.** La campagne du
 * rognage latéral a posé son plafond sur un visage tombé hors cadre, et elle ne
 * l'a vu qu'en regardant une image : « le compteur de pertes ne le signalait
 * pas, il n'avait perdu que 27 % de sa boîte ». Avec des points de pose, la
 * question se pose directement — le nez, les yeux ou les oreilles sont-ils dans
 * le rectangle — et se compte sur l'émission entière au lieu de se chercher à
 * l'œil. Une personne dont aucun point de tête n'est fiable ne compte pas :
 * l'absence de tête détectée n'est pas une tête hors cadre.
 */
function costOf(cut: Cut, analysis: Analysis, options: FramingOptions): Cost {
  const framing = framingOf(cut, analysis, options)
  const segments = normalizeSegments(cut.segments)
  const threshold = FRAMING_DEFAULTS.minScore
  // **L'étalon ne bouge pas avec le réglage qu'on juge.** Le tronc et les points
  // de tête sont ici une *mesure*, pas une décision : lus avec les options sous
  // test, la ligne « tronc off » n'aurait aucun tronc à mesurer et la colonne
  // qui compare les deux primitives serait vide sur la seule ligne qui sert de
  // référence. Chaque ligne du balayage se juge donc au même mètre.
  const gauge: FramingOptions = {
    torso: FRAMING_DEFAULTS.torso,
    torsoMinScore: FRAMING_DEFAULTS.torsoMinScore,
    torsoPad: FRAMING_DEFAULTS.torsoPad,
  }
  // **Le filtre du premier plan, lui, suit le réglage testé et le doit.** Il
  // décide *quelles* boîtes entrent dans le cadrage ; les mesurer sur une autre
  // population que celle qui a choisi le ratio ne dirait plus ce que ce ratio
  // coûte. C'est l'inverse du tronc juste au-dessus, qui est un mètre et pas une
  // décision.
  //
  // La conséquence, et elle vaut d'être écrite avant que quelqu'un la découvre
  // dans un tableau : le jour où un balayage fera varier `bottomEdge` ou
  // `foregroundMaxHeight`, la colonne « têtes dehors » bougera pour deux raisons
  // à la fois — le cadre change, et la population aussi. Aucun balayage ne les
  // fait varier aujourd'hui. (relevé par Aristarque)
  const pointThreshold = FRAMING_DEFAULTS.torsoMinScore
  const cost: Cost = {
    box: [],
    torso: [],
    worstPerFrame: [],
    headsOutside: 0,
    framesWithHeadOutside: 0,
    headsAtEdge: 0,
    people: 0,
  }
  // Par instant, pour les deux grandeurs qui se comptent en secondes. La clé est
  // la milliseconde, comme partout ailleurs où ce dépôt regroupe des boîtes par
  // image.
  const worstAt = new Map<number, number>()
  const headOutAt = new Set<number>()
  for (const shot of framing.shots) {
    const width = ratioCoverage(shot.ratio, analysis.source.w, analysis.source.h)
    // Le bord gauche du rectangle, borné dans l'image comme `cropRect` le fait.
    const x = Math.min(Math.max(shot.cropX - width / 2, 0), Math.max(0, 1 - width))
    for (const b of analysis.boxes) {
      if (!withinInterval(b.t, shot.shot.start, shot.shot.end)) continue
      if (!segments.some((s) => withinInterval(b.t, s.start, s.end))) continue
      if (!(b.score >= threshold) || isForeground(b, options)) continue
      const boxWidth = b.x1 - b.x0
      if (!(boxWidth > 0)) continue
      cost.people += 1
      // **La boîte entière, pas la boîte rognée.** Le rognage est ce qu'on
      // s'autorise à perdre ; ce qu'on perd vraiment se mesure sur la personne.
      const inside = Math.max(0, Math.min(b.x1, x + width) - Math.max(b.x0, x))
      const loss = 1 - inside / boxWidth
      cost.box.push(loss)
      const frameKey = Math.round(b.t * 1000)
      worstAt.set(frameKey, Math.max(worstAt.get(frameKey) ?? 0, loss))

      const torso = torsoBounds(b, gauge)
      if (torso !== null && torso.x1 > torso.x0) {
        const insideTorso = Math.max(0, Math.min(torso.x1, x + width) - Math.max(torso.x0, x))
        cost.torso.push(1 - insideTorso / (torso.x1 - torso.x0))
      }

      const k = b.k
      if (k === undefined) continue
      let seen = false
      let inFrame = false
      let atEdge = false
      for (const rank of HEAD_POINTS) {
        const px = k[rank * 3]
        if (!Number.isFinite(px) || !(k[rank * 3 + 2] >= pointThreshold)) continue
        seen = true
        if (px >= x && px <= x + width) {
          inFrame = true
          if (px - x < 0.01 || x + width - px < 0.01) atEdge = true
        }
      }
      if (!seen) continue
      if (!inFrame) {
        cost.headsOutside += 1
        headOutAt.add(Math.round(b.t * 1000))
      } else if (atEdge) cost.headsAtEdge += 1
    }
  }
  cost.worstPerFrame = [...worstAt.values()]
  cost.framesWithHeadOutside = headOutAt.size
  return cost
}

/**
 * `t` tombe-t-il dans l'intervalle ? **Fin exclue**, comme `computeFraming` :
 * une image posée sur une frontière appartient au plan qui suit.
 */
function withinInterval(t: number, start: number, fin: number): boolean {
  return t >= start && t < fin
}

/**
 * Les empans des images d'une découpe, marge et filtre compris.
 *
 * Les boîtes sont restreintes aux segments montés — c'est ce que `computeFraming`
 * fait, et mesurer sur l'émission entière décrirait un autre clip que celui dont
 * on lit le ratio deux colonnes plus loin. **Fin exclue**, comme `computeFraming`.
 */
function spans(cut: Cut, analysis: Analysis, options: FramingOptions): number[] {
  const segments = normalizeSegments(cut.segments)
  const inside = analysis.boxes.filter((b) =>
    segments.some((s) => b.t >= s.start && b.t < s.end),
  )
  return requiredWidths(inside, options)
}

/**
 * Le **temps de montage** de chaque ratio, en secondes.
 *
 * **C'est le chiffre qui décrit ce que la variante 9:16 montre**, et il ne se
 * déduit pas du compte de clips. Un clip est étiqueté par le ratio de son
 * fichier natif, qui est le plus large de ses plans : un clip de trente secondes
 * dont vingt-huit tiennent en 1:1 et deux exigent le 16:9 compte pour un clip en
 * 16:9, alors que la variante verticale y montre vingt-huit secondes de 1:1. Un
 * tableau de clips masque donc exactement ce que le ratio par plan a gagné.
 *
 * Le temps compté est l'intersection du plan avec les segments montés, pas la
 * durée du plan dans la source : le clip ne montre pas le reste.
 */
function timePerRatio(
  cuts: Cut[],
  analysis: Analysis,
  options: FramingOptions,
): Map<Ratio, number> {
  const times = new Map<Ratio, number>(MORE_NARROW_MORE_WIDE.map((r) => [r, 0]))
  for (const cut of cuts) {
    const segments = normalizeSegments(cut.segments)
    for (const shot of framingOf(cut, analysis, options).shots) {
      const duration = segments.reduce(
        (n, s) =>
          n + Math.max(0, Math.min(shot.shot.end, s.end) - Math.max(shot.shot.start, s.start)),
        0,
      )
      times.set(shot.ratio, (times.get(shot.ratio) ?? 0) + duration)
    }
  }
  return times
}

/** La part du temps de montage qui sort au ratio le plus large, en pourcentage. */
function shareInSixteenNine(times: Map<Ratio, number>): number {
  const total = [...times.values()].reduce((a, b) => a + b, 0)
  const wide = times.get(MORE_NARROW_MORE_WIDE[MORE_NARROW_MORE_WIDE.length - 1]) ?? 0
  return total === 0 ? Number.NaN : (100 * wide) / total
}

function timeLine(times: Map<Ratio, number>): string {
  return (
    MORE_NARROW_MORE_WIDE.map((r) => `${(times.get(r) ?? 0).toFixed(0).padStart(6)}`).join(
      ' ',
    ) + `   16:9 = ${number(shareInSixteenNine(times), 0).padStart(3)} %`
  )
}

/** La répartition des ratios d'une liste de découpes, comptée par ratio. */
function distribution(ratios: Ratio[]): Map<Ratio, number> {
  const count = new Map<Ratio, number>(MORE_NARROW_MORE_WIDE.map((r) => [r, 0]))
  for (const r of ratios) count.set(r, (count.get(r) ?? 0) + 1)
  return count
}

function lineDistribution(count: Map<Ratio, number>): string {
  return MORE_NARROW_MORE_WIDE.map(
    (r) => `${r} ${String(count.get(r) ?? 0).padStart(3)}`,
  ).join(' | ')
}

/**
 * Des fenêtres régulières qui couvrent l'émission.
 *
 * Les clips retenus par le repérage ne sont pas un échantillon de l'émission :
 * ce sont ses moments drôles, et ils sont dix. Les fenêtres disent ce qu'un clip
 * quelconque deviendrait, et c'est ce qui rend deux émissions comparables malgré
 * des repérages différents.
 */
function windows(duration: number, length: number, not: number): Cut[] {
  const out: Cut[] = []
  for (let t = 0; t + length <= duration; t += not) {
    out.push({ name: `${t.toFixed(0)}s`, segments: [{ start: t, end: t + length }] })
  }
  return out
}

// ---------------------------------------------------------------------------

/** Ce qu'on charge d'un projet avant de mesurer quoi que ce soit. */
type Show = { id: string; analysis: Analysis; clips: Cut[]; windows: Cut[] }

function charger(id: string, overrides: Map<string, string>): Show | null {
  // **Un fichier nommé à la main court-circuite `analysisPath`**, et c'est ce
  // qui permet de comparer deux détecteurs sur la même émission sans écraser
  // celui que le serveur de développement sert en direct.
  const file = overrides.get(id) ?? analysisPath(id)
  if (!fs.existsSync(file)) {
    console.error(`${id} : pas d'analyse (${file}). Lancer : pnpm tsx scripts/dev-run.ts ${id} analysis`)
    return null
  }
  const analysis = lireAnalysis(file)
  const db = getDb()
  // **Les écartés ne comptent pas.** Un clip mis au rebut ne sera jamais rendu,
  // donc son ratio ne dit rien de ce que le produit sortira ; l'inclure gonflerait
  // la seule colonne qui décide de la suite de l'itération.
  //
  // **Les vestiges de vérification, si**, et c'est délibéré : la base de `cqlp`
  // porte deux `clip_verif_*` non écartés (`ROADMAP.md`, « Vestiges à nettoyer »),
  // donc ce script en compte dix là où l'émission en a huit de vrais. Les filtrer
  // par leur nom mettrait une convention de nommage dans un script de mesure, où
  // elle se périmerait sans bruit ; ils sont nommés dans la sortie ligne par
  // ligne, et c'est au lecteur — et à `docs/ratios-par-clip.md` — de les écarter.
  // (relevé par Copilot)
  const clips = getClips(db, id)
    .filter((c) => c.status !== 'discarded')
    .map((c) => ({ name: c.id, segments: c.segments }))
  const duration = analysis.shots.at(-1)?.end ?? 0
  return { id, analysis, clips, windows: windows(duration, 30, 30) }
}

// ---------------------------------------------------------------------------
// 1. Le ratio par clip
// ---------------------------------------------------------------------------

function byClip(show: Show): void {
  const { w, h } = show.analysis.source
  const duration = show.analysis.shots.at(-1)?.end ?? 0
  console.log(
    `\n=== ${show.id} — ${show.clips.length} clips, ${(duration / 60).toFixed(0)} min, ` +
      `${show.analysis.boxes.length} boîtes ===`,
  )
  console.log(
    `Seuils de couverture : ` +
      MORE_NARROW_MORE_WIDE.map((r) => `${r} ${number(ratioCoverage(r, w, h))}`).join('  '),
  )
  if (show.clips.length === 0) {
    console.log('  (aucun clip — le repérage n’a pas tourné sur ce projet)')
    return
  }

  console.log('\n  clip                                  ratio   empan méd.  empan p90  images  durée')
  for (const clip of show.clips) {
    const measurements = spans(clip, show.analysis, opts())
    const duration = normalizeSegments(clip.segments).reduce((n, s) => n + (s.end - s.start), 0)
    console.log(
      `  ${clip.name.padEnd(36)}  ${ratio(clip, show.analysis, opts()).padEnd(6)}` +
        `  ${number(median(measurements)).padStart(9)}` +
        `  ${number(percentile(measurements, 0.9)).padStart(9)}` +
        `  ${String(measurements.length).padStart(6)}` +
        `  ${duration.toFixed(0)} s`,
    )
  }
  const all = show.clips.flatMap((c) => spans(c, show.analysis, opts()))
  console.log(
    `\n  répartition : ${lineDistribution(distribution(show.clips.map((c) => ratio(c, show.analysis, opts()))))}`,
  )
  console.log(
    `  empan résiduel médian, toutes images des clips confondues : ${number(median(all))}` +
      ` (p90 ${number(percentile(all, 0.9))})`,
  )
}

// ---------------------------------------------------------------------------
// 2. La répartition comparée
// ---------------------------------------------------------------------------

function comparison(shows: Show[], what: 'clips' | 'windows'): void {
  console.log(`\n${what === 'clips' ? 'Clips du repérage' : 'Fenêtres de 30 s tous les 30 s'}`)
  const header = shows.map((e) => e.id.padStart(22)).join(' ')
  console.log(`  ${''.padEnd(8)} ${header}`)
  const counts = shows.map((e) =>
    distribution(e[what].map((d) => ratio(d, e.analysis, opts()))),
  )
  for (const r of MORE_NARROW_MORE_WIDE) {
    const cellules = counts
      .map((c, i) => {
        const n = c.get(r) ?? 0
        const total = shows[i][what].length
        const part = total === 0 ? '—' : `${((100 * n) / total).toFixed(0)} %`
        return `${n} (${part})`.padStart(22)
      })
      .join(' ')
    console.log(`  ${r.padEnd(8)} ${cellules}`)
  }
  console.log(
    `  ${'total'.padEnd(8)} ${shows.map((e) => String(e[what].length).padStart(22)).join(' ')}`,
  )

  // **Le temps, sous le compte, et jamais à sa place.** Le compte décrit le
  // fichier natif, qui garde un ratio d'un bout à l'autre ; le temps décrit la
  // variante 9:16, qui pose chaque plan au sien. Les deux sont vrais et ne
  // répondent pas à la même question — celui qui ne lirait que le premier
  // conclurait qu'un clip « en 16:9 » sort entièrement en 16:9.
  console.log(`\n  temps de montage par ratio, en secondes`)
  const times = shows.map((e) => timePerRatio(e[what], e.analysis, opts()))
  for (const [i, e] of shows.entries()) {
    console.log(`  ${e.id.padEnd(24)} ${timeLine(times[i])}`)
  }
}

// ---------------------------------------------------------------------------
// 3. Le balayage de la marge
// ---------------------------------------------------------------------------

/**
 * Ce que la marge change à la répartition, et ce qu'elle coûte en empan.
 *
 * L'empan y est le médian sur toutes les images mesurées de l'émission, tous
 * clips confondus : c'est la grandeur qui varie linéairement avec la marge — deux
 * fois sa valeur, une fois de chaque côté — et qui rend le tableau lisible à côté
 * des seuils de couverture.
 */
function sweep(show: Show, what: 'clips' | 'windows'): void {
  const cuts = show[what]
  if (cuts.length === 0) return
  console.log(`\n  ${show.id} — ${cuts.length} ${what}`)
  console.log(`  marge    ${MORE_NARROW_MORE_WIDE.map((r) => r.padStart(6)).join(' ')}   empan méd.  déplacés`)

  const reference = cuts.map((d) => ratio(d, show.analysis, opts()))
  for (const margin of MARGINS) {
    const options = opts({ margin: margin })
    const ratios = cuts.map((d) => ratio(d, show.analysis, options))
    const count = distribution(ratios)
    const measurements = cuts.flatMap((d) => spans(d, show.analysis, options))
    const moved = cuts
      .map((d, i) => ({ nom: d.name, avant: reference[i], après: ratios[i] }))
      .filter((e) => e.avant !== e.après)
    const tightened = moved.filter((e) => RATIOS[e.après] < RATIOS[e.avant]).length
    const defaultValue = margin === FRAMING_DEFAULTS.margin ? ' ←' : '  '
    console.log(
      `  ${margin.toFixed(2)}${defaultValue}   ` +
        MORE_NARROW_MORE_WIDE.map((r) => String(count.get(r) ?? 0).padStart(6)).join(' ') +
        `   ${number(median(measurements)).padStart(9)}` +
        `   ${tightened} resserré(s), ${moved.length - tightened} élargi(s)`,
    )
    // **Nommés sur les clips, comptés sur les fenêtres.** Un clip qui bascule est
    // une décision qu'on ira vérifier à l'image ; deux cents fenêtres nommées
    // noieraient le tableau qu'elles sont censées expliquer.
    if (what !== 'clips') continue
    for (const e of moved) {
      console.log(`           ${e.nom} : ${e.avant} → ${e.après}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Le balayage du rognage latéral
// ---------------------------------------------------------------------------

/**
 * Ce que le rognage change à la répartition, **et ce qu'il coupe des gens**.
 *
 * Les deux moitiés vont ensemble et une ligne sans l'autre ne décide rien.
 * L'histoire du dépôt sur ce point : un filtre qui montait la part du 1:1 à
 * 90,4 % a été écarté parce qu'il vidait 64 % des images de toute détection —
 * une part calculée sur ce qui reste ne dit rien. Ici le piège est symétrique :
 * un rognage assez fort fait basculer n'importe quel plan en 1:1, il suffit de
 * couper les comédiens.
 *
 * Les colonnes de droite se lisent donc en premier :
 *
 * - `p99` et `max` : la fraction de sa propre largeur qu'une personne perd, au
 *   centile 99 et au pire ;
 * - `> 1/3` et `> 1/2` : combien de secondes de clip montrent quelqu'un amputé
 *   d'un tiers, puis de la moitié. La seconde est le seuil au-delà duquel un
 *   visage peut tomber, et c'est la ligne rouge posée par Julien.
 */
function sweepSideTrim(show: Show, what: 'clips' | 'windows'): void {
  const cuts = show[what]
  if (cuts.length === 0) return
  console.log(`\n  ${show.id} — ${cuts.length} ${what}`)
  console.log(
    `  rognage  ${MORE_NARROW_MORE_WIDE.map((r) => r.padStart(6)).join(' ')}` +
      `  16:9 tps   coupé d'une boîte : p90    p99   > 1/3    > 1/2   coupé du tronc p99   têtes dehors`,
  )

  const reference = cuts.map((d) => ratio(d, show.analysis, opts({ sideTrim: 0 })))
  for (const trim of SIDE_TRIMS) {
    const options = opts({ sideTrim: trim })
    const ratios = cuts.map((d) => ratio(d, show.analysis, options))
    const count = distribution(ratios)
    const times = timePerRatio(cuts, show.analysis, options)
    const costs = cuts.map((d) => costOf(d, show.analysis, options))
    const losses = costs.flatMap((c) => c.box)
    // **Le pire par image pour les durées, la distribution par personne pour les
    // percentiles.** Les deux répondent à deux questions : « quelle part
    // quelqu'un perd-il », qui se lit sur les personnes, et « pendant combien de
    // temps le spectateur le voit-il », qui se lit sur les images. Confondre les
    // deux rendait des personnes-secondes sous une étiquette « s ».
    const worst = costs.flatMap((c) => c.worstPerFrame)
    const headsOut = costs.reduce((n, c) => n + c.headsOutside, 0)
    // Le compte est en personnes-images — c'est ce que « têtes dehors » nomme —
    // et la durée en images, parce qu'une seconde ne se compte pas deux fois
    // quand deux têtes sortent ensemble.
    const framesOut = costs.reduce((n, c) => n + c.framesWithHeadOutside, 0)
    const asSeconds = (n: number): string => `${(n * sampleStep(show.analysis)).toFixed(1)} s`
    const widened = ratios.filter((r, i) => RATIOS[r] > RATIOS[reference[i]]).length
    const defaultValue = trim === FRAMING_DEFAULTS.sideTrim ? ' ←' : '  '
    console.log(
      `  ${trim.toFixed(3)}${defaultValue}` +
        MORE_NARROW_MORE_WIDE.map((r) => String(count.get(r) ?? 0).padStart(6)).join(' ') +
        `  ${number(shareInSixteenNine(times), 0).padStart(6)} %` +
        `   ${number(percentile(losses, 0.9)).padStart(24)}` +
        ` ${number(percentile(losses, 0.99)).padStart(6)}` +
        ` ${asSeconds(worst.filter((v) => v > 1 / 3).length).padStart(8)}` +
        ` ${asSeconds(worst.filter((v) => v > 0.5).length).padStart(8)}` +
        ` ${number(percentile(costs.flatMap((c) => c.torso), 0.99)).padStart(19)}` +
        ` ${`${headsOut} (${asSeconds(framesOut)})`.padStart(14)}` +
        (widened > 0 ? `   ${widened} ÉLARGI(S)` : ''),
    )
  }
}

// ---------------------------------------------------------------------------
// 5. Les plans que la position borne, et non la largeur
// ---------------------------------------------------------------------------

/**
 * Les plans dont le ratio monte **alors que leurs images tiendraient toutes dans
 * un cadre plus serré** — c'est-à-dire ceux qu'aucune position fixe ne sert.
 *
 * **C'est la signature d'une frontière de plan manquée**, et il faut savoir la
 * distinguer d'un plan réellement large, parce que les deux se soignent à des
 * endroits opposés. Le cas qui a fait écrire cette section :
 * `2026-22-02-entre-nous`, plan 3 234 → 3 297 s, **89 images sur 89 tiennent dans
 * un 1:1** et le ratio retenu est pourtant le 16:9. L'action y alterne entre
 * `[0,12 ; 0,55]` et `[0,39 ; 0,91]` : deux axes de caméra dans un même « plan ».
 * Vérifié à l'image sur le plan voisin — la coupe existe bel et bien à 2 953,2 s,
 * son score de scène vaut 0,366, et le seuil du détecteur est à 0,40.
 *
 * Le compte se lit en **temps**, pas en plans : un plan borné de deux secondes ne
 * coûte pas ce que coûte un plan de quarante.
 *
 * La borne comparée est **optimiste** : elle suppose un crop libre par image, ce
 * que le crop fixe par plan n'est pas. Un plan qui la dépasse est donc borné par
 * la position **à coup sûr**, jamais par accident d'arrondi.
 */
function boundedByPosition(show: Show): void {
  const { w, h } = show.analysis.source
  let shots = 0
  let bounded = 0
  let asSeconds = 0
  let boundedSeconds = 0
  const lines: string[] = []

  for (const clip of show.clips) {
    const framing = framingOf(clip, show.analysis, opts())
    const segments = normalizeSegments(clip.segments)
    for (const shot of framing.shots) {
      const inside = show.analysis.boxes.filter(
        (b) =>
          withinInterval(b.t, shot.shot.start, shot.shot.end) &&
          segments.some((s) => withinInterval(b.t, s.start, s.end)),
      )
      const measurements = requiredWidths(inside, opts())
      if (measurements.length === 0) continue
      // Le plus petit ratio que 90 % des images atteindraient si chacune pouvait
      // se cadrer pour elle-même.
      let libre: Ratio = MORE_NARROW_MORE_WIDE[MORE_NARROW_MORE_WIDE.length - 1]
      for (const r of MORE_NARROW_MORE_WIDE) {
        const coverage = ratioCoverage(r, w, h)
        if (measurements.filter((m) => m <= coverage + 1e-9).length * 10 >= measurements.length * 9) {
          libre = r
          break
        }
      }
      const duration = segments.reduce(
        (n, s) =>
          n + Math.max(0, Math.min(shot.shot.end, s.end) - Math.max(shot.shot.start, s.start)),
        0,
      )
      shots++
      asSeconds += duration
      if (RATIOS[shot.ratio] <= RATIOS[libre]) continue
      bounded++
      boundedSeconds += duration
      lines.push(
        `    ${shot.shot.start.toFixed(1)} → ${shot.shot.end.toFixed(1)}` +
          `  ${duration.toFixed(1)} s  ${libre} possible, ${shot.ratio} retenu  ${clip.name}`,
      )
    }
  }

  if (shots === 0) return
  const part = asSeconds === 0 ? 0 : (100 * boundedSeconds) / asSeconds
  console.log(
    `\n  ${show.id} : ${bounded} plans sur ${shots}, ` +
      `${boundedSeconds.toFixed(0)} s sur ${asSeconds.toFixed(0)} s (${part.toFixed(0)} %)`,
  )
  for (const l of lines) console.log(l)
}

// ---------------------------------------------------------------------------
// 6. Le tronc contre la boîte corps entier
// ---------------------------------------------------------------------------

/**
 * Ce que chaque définition de tronc change, **et ce qu'elle coûte**.
 *
 * L'issue #69 nomme la cause : on détecte des corps, donc une boîte suit des
 * jambes tendues jusqu'à un bord que la tête n'atteint pas, et l'empan mesuré —
 * donc le ratio — est décidé par des jambes que personne ne regarde. Le rognage
 * latéral du 19 août borne ce que ça peut coûter sans savoir ce qu'il abandonne ;
 * les points de pose disent où est la tête.
 *
 * **Les colonnes de droite se lisent en premier**, comme au balayage du rognage,
 * et pour la même raison : n'importe quel resserrement fait basculer n'importe
 * quel plan en 1:1, il suffit de couper les gens. `têtes` est la colonne qui
 * décide — le nombre de personnes-images dont aucun point de tête n'est dans le
 * rectangle. C'est le compteur qui manquait à la campagne précédente, qui n'a vu
 * son visage tombé qu'en regardant une image.
 */
function sweepTorso(show: Show, what: 'clips' | 'windows'): void {
  const cuts = show[what]
  if (cuts.length === 0) return
  console.log(`\n  ${show.id} — ${cuts.length} ${what}`)
  console.log(
    `  tronc             ${MORE_NARROW_MORE_WIDE.map((r) => r.padStart(5)).join(' ')}` +
      `  16:9 tps  empan méd.   coupé boîte p99   coupé tronc p99   têtes dehors  au bord`,
  )

  for (const torso of TORSO_NAMES) {
    const options = opts({ torso })
    const count = distribution(cuts.map((d) => ratio(d, show.analysis, options)))
    const times = timePerRatio(cuts, show.analysis, options)
    const measurements = cuts.flatMap((d) => spans(d, show.analysis, options))
    const costs = cuts.map((d) => costOf(d, show.analysis, options))
    const box = costs.flatMap((c) => c.box)
    const torsos = costs.flatMap((c) => c.torso)
    const headsOut = costs.reduce((n, c) => n + c.headsOutside, 0)
    // Le compte est en personnes-images — c'est ce que « têtes dehors » nomme —
    // et la durée en images, parce qu'une seconde ne se compte pas deux fois
    // quand deux têtes sortent ensemble.
    const framesOut = costs.reduce((n, c) => n + c.framesWithHeadOutside, 0)
    const atEdge = costs.reduce((n, c) => n + c.headsAtEdge, 0)
    const defaultValue = torso === FRAMING_DEFAULTS.torso ? ' ←' : '  '
    console.log(
      `  ${torso.padEnd(16)}${defaultValue}` +
        MORE_NARROW_MORE_WIDE.map((r) => String(count.get(r) ?? 0).padStart(5)).join(' ') +
        `  ${number(shareInSixteenNine(times), 0).padStart(6)} %` +
        `  ${number(median(measurements)).padStart(9)}` +
        `  ${number(percentile(box, 0.99)).padStart(16)}` +
        `  ${number(percentile(torsos, 0.99)).padStart(16)}` +
        `  ${`${headsOut} (${(sampleStep(show.analysis) * framesOut).toFixed(1)} s)`.padStart(13)}` +
        `  ${String(atEdge).padStart(7)}`,
    )
  }
}

/**
 * L'empan que chaque primitive demande, **boîte contre tronc**, une valeur par
 * personne et une par image.
 *
 * C'est la mesure qui dit d'où vient le gain, avant tout choix de ratio : de
 * combien le tronc est plus étroit que la boîte, et sur quelle part des
 * personnes il existe. Une part faible ferait du tronc un raffinement qui ne
 * s'applique jamais — c'est exactement ce que le filtre du premier plan a failli
 * être ailleurs que sur `cqlp`.
 */
function torsoVersusBox(show: Show): void {
  const options = opts({ torso: FRAMING_DEFAULTS.torso })
  const threshold = FRAMING_DEFAULTS.minScore
  const kept = show.analysis.boxes.filter((b) => b.score >= threshold && !isForeground(b, options))
  const boxWidths: number[] = []
  const trimmedWidths: number[] = []
  const torsoWidths: number[] = []
  let withTorso = 0
  for (const b of kept) {
    boxWidths.push(b.x1 - b.x0)
    const cropped = trimmedBounds(b, options)
    trimmedWidths.push(cropped.x1 - cropped.x0)
    const torso = torsoBounds(b, options)
    if (torso === null) continue
    withTorso += 1
    torsoWidths.push(torso.x1 - torso.x0)
  }
  if (kept.length === 0) return
  console.log(
    `\n  ${show.id} — ${kept.length} boîtes gardées, ` +
      `${withTorso} avec un tronc lisible (${((100 * withTorso) / kept.length).toFixed(0)} %)` +
      `${show.analysis.keypoints === undefined ? ' — analyse sans points de pose' : ''}`,
  )
  console.log('                     médiane      p90      p99')
  for (const [name, values] of [
    ['boîte corps entier', boxWidths],
    ['boîte rognée', trimmedWidths],
    [`tronc « ${FRAMING_DEFAULTS.torso} »`, torsoWidths],
  ] as const) {
    console.log(
      `  ${name.padEnd(18)} ${number(median(values)).padStart(7)}` +
        ` ${number(percentile(values, 0.9)).padStart(8)}` +
        ` ${number(percentile(values, 0.99)).padStart(8)}`,
    )
  }
}

/**
 * Ce que le **rembourrage** du tronc change.
 *
 * Les points d'épaule sont les centres des articulations : à zéro, le tronc
 * passe au milieu de chaque épaule, et le crop coupe une demi-épaule à chacun
 * sans que la colonne « tête » s'en émeuve. Le balayage dit où s'arrête le
 * bénéfice et où commence la dépense.
 */
function sweepTorsoPadding(
  show: Show,
  what: 'clips' | 'windows',
  whatVaries: 'torsoPad' | 'torsoTrim',
): void {
  const cuts = show[what]
  if (cuts.length === 0) return
  console.log(`\n  ${show.id} — ${cuts.length} ${what}`)
  const values = whatVaries === 'torsoPad' ? TORSO_PADS : TORSO_TRIMS
  const defaultOf = whatVaries === 'torsoPad' ? FRAMING_DEFAULTS.torsoPad : FRAMING_DEFAULTS.torsoTrim
  console.log(
    `  ${whatVaries === 'torsoPad' ? 'rembourrage' : 'rognage    '}  ${MORE_NARROW_MORE_WIDE.map((r) => r.padStart(5)).join(' ')}` +
      `  16:9 tps  empan méd.   coupé boîte p99   coupé tronc p99   têtes dehors`,
  )
  for (const pad of values) {
    // **Le tronc est forcé à son défaut ici**, `--tronc` compris. Ces deux
    // tableaux balaient des réglages *du tronc* : hérité de `BASE`, un
    // `--tronc off` les rendrait tous inertes et imprimerait des lignes
    // rigoureusement identiques, ce qui se lit comme « le réglage ne change
    // rien » et non comme « il n'y avait pas de tronc à régler ». La sortie
    // annonce les sections 1 à 5 et 7 ; celles-ci n'en font pas partie.
    // (relevé par Copilot)
    const options = opts({
      torso: FRAMING_DEFAULTS.torso,
      ...(whatVaries === 'torsoPad' ? { torsoPad: pad } : { torsoTrim: pad }),
    })
    const count = distribution(cuts.map((d) => ratio(d, show.analysis, options)))
    const times = timePerRatio(cuts, show.analysis, options)
    const measurements = cuts.flatMap((d) => spans(d, show.analysis, options))
    const costs = cuts.map((d) => costOf(d, show.analysis, options))
    const box = costs.flatMap((c) => c.box)
    const torsos = costs.flatMap((c) => c.torso)
    const headsOut = costs.reduce((n, c) => n + c.headsOutside, 0)
    // Le compte est en personnes-images — c'est ce que « têtes dehors » nomme —
    // et la durée en images, parce qu'une seconde ne se compte pas deux fois
    // quand deux têtes sortent ensemble.
    const framesOut = costs.reduce((n, c) => n + c.framesWithHeadOutside, 0)
    const defaultValue = pad === defaultOf ? ' ←' : '  '
    console.log(
      `  ${pad.toFixed(2)}${defaultValue}         ` +
        MORE_NARROW_MORE_WIDE.map((r) => String(count.get(r) ?? 0).padStart(5)).join(' ') +
        `  ${number(shareInSixteenNine(times), 0).padStart(6)} %` +
        `  ${number(median(measurements)).padStart(9)}` +
        `  ${number(percentile(box, 0.99)).padStart(16)}` +
        `  ${number(percentile(torsos, 0.99)).padStart(16)}` +
        `  ${`${headsOut} (${(sampleStep(show.analysis) * framesOut).toFixed(1)} s)`.padStart(13)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 7. Où regarder
// ---------------------------------------------------------------------------

/**
 * Les instants qui font monter le ratio d'un clip : ceux que **le crop retenu ne
 * cadre pas**, une image par plan au plus.
 *
 * **Pas les plus larges, et la différence n'est pas cosmétique.** Une largeur par
 * image suppose un crop libre par image, alors que le crop est fixe pour tout le
 * plan : un sujet étroit posé à gauche puis à droite donne des images toutes
 * étroites qu'aucune position fixe ne cadre, et c'est *ce* cas qui fait monter le
 * ratio. Un classement par largeur y désigne des images sans intérêt et laisse
 * croire, quand elles tiennent, que tout le plan tient. C'est exactement le
 * raisonnement de `chooseRatio`, en plus court. (relevé par Codex et Copilot)
 *
 * Une image par plan au plus, parce que les images voisines partagent le même
 * crop et racontent donc la même chose ; même règle que `--large` de
 * `vignettes-premier-plan.ts`, pour la même raison.
 */
function momentsWhichWiden(cut: Cut, analysis: Analysis, n: number): number[] {
  const segments = normalizeSegments(cut.segments)
  const inside = analysis.boxes.filter((b) => segments.some((s) => b.t >= s.start && b.t < s.end))

  // Le cadrage réellement retenu pour ce clip : c'est lui qui dit ce qui déborde.
  //
  // **Par `framingFor`, donc par `opts()`**, et pas par un `computeFraming` à
  // soi : cette section était la seule à ignorer `--tronc` par omission, si bien
  // qu'un balayage lancé avec un autre tronc désignait des images calculées avec
  // celui par défaut. La section 6 l'ignore aussi, mais parce qu'elle le balaie —
  // ce n'est pas la même chose, et c'est pourquoi elle reste seule à le faire.
  // (relevé par Aristarque)
  const framing = framingOf(cut, analysis, opts())
  const width = ratioCoverage(framing.ratio, analysis.source.w, analysis.source.h)

  // Par image, en passant par `requiredWidths` plutôt qu'en refaisant le calcul :
  // le seuil de confiance, la marge et le filtre du premier plan y sont déjà, et
  // une seconde copie de ces trois réglages finirait par diverger de celle qui
  // décide vraiment. Les bornes, elles, se relisent sur les boîtes gardées —
  // **par `personBounds`**, comme l'empan.
  //
  // C'est ce qui a divergé : depuis que `requiredWidths` lit le tronc ou la
  // boîte rognée, relire `b.x0` / `b.x1` bruts mesurait un débordement que le
  // critère ne regarde plus. Une image dont les boîtes débordent mais dont les
  // troncs tiennent remontait en tête du classement, et la section 7 envoyait
  // regarder les mauvaises images — sans jamais se contredire, puisque c'est
  // elle qui dit où regarder. (relevé par Aristarque)
  const byImage = new Map<number, PersonBox[]>()
  for (const b of inside) {
    const key = Math.round(b.t * 1000)
    const already = byImage.get(key)
    if (already) already.push(b)
    else byImage.set(key, [b])
  }

  const margin = FRAMING_DEFAULTS.margin
  const sorted = [...byImage.entries()]
    .map(([key, boxes]) => {
      const t = key / 1000
      const span = requiredWidths(boxes, opts())[0]
      // Géométrie invalide écartée en premier, comme `spans()` : sinon une
      // boîte à `x` inversés mais à hauteur valide peut devenir la plus haute
      // et fausser `kept`. (relevé par Copilot)
      const scored = boxes.filter(
        (b) => hasValidGeometry(b) && b.score >= FRAMING_DEFAULTS.minScore && !isForeground(b, opts()),
      )
      // Même plancher que `spans()` : sans lui, une jaquette exclue du cadrage
      // réel resterait comptée ici et désignerait la mauvaise image. (relevé
      // par Codex)
      const floor = Math.min(1, opts().sizeFloor ?? FRAMING_DEFAULTS.sizeFloor)
      const tallest = Math.max(0, ...scored.map((b) => b.y1 - b.y0))
      const kept = scored.filter((b) => b.y1 - b.y0 >= floor * tallest)
      if (span === undefined || kept.length === 0) return undefined
      const required = kept.map((b) => personBounds(b, opts()))
      // Bornées des deux côtés, comme `measurements` de `framing.ts` et `extent` de
      // `vignettes-cadrage.ts`. C'est le troisième exemplaire du même défaut, et
      // le seul que les deux premiers correctifs avaient laissé : un tronc
      // entièrement hors cadre donnait `g = 0` avec `d < 0`, donc un
      // `output` inventé qui remontait l'image en tête du classement — dans la
      // section dont le seul travail est de dire où regarder. (relevé par Copilot)
      const in01 = (n: number): number => Math.min(Math.max(n, 0), 1)
      const g = in01(Math.min(...required.map((e) => e.x0)) - margin)
      const d = in01(Math.max(...required.map((e) => e.x1)) + margin)
      // Le crop de *son* plan : à défaut de plan, le centre, comme `computeFraming`.
      const shot = framing.shots.find((p) => t >= p.shot.start && t < p.shot.end)
      const center = shot?.cropX ?? 0.5
      const x = Math.min(Math.max(center - width / 2, 0), Math.max(0, 1 - width))
      const output = Math.max(0, x - g) + Math.max(0, d - (x + width))
      return { t, span, output }
    })
    .filter((e): e is { t: number; span: number; output: number } => e !== undefined)
    // Ce qui déborde le plus d'abord ; à débordement égal — zéro, le cas courant
    // quand le ratio est confortable —, la plus large, qui reste la plus
    // instructive.
    .sort((a, b) => b.output - a.output || b.span - a.span)

  const seen = new Set<number>()
  const out: number[] = []
  for (const e of sorted) {
    if (out.length >= n) break
    const shot = analysis.shots.find((p) => e.t >= p.start && e.t < p.end)
    const key = shot === undefined ? -Math.round(e.t * 1000) - 1 : Math.round(shot.start * 1000)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e.t)
  }
  return out.sort((a, b) => a - b)
}

function whereRegarder(show: Show, n: number): void {
  console.log(`\n  ${show.id}`)
  const all: number[] = []
  for (const clip of show.clips) {
    const moments = momentsWhichWiden(clip, show.analysis, n)
    if (moments.length === 0) continue
    all.push(...moments)
    console.log(`    ${clip.name} : ${moments.map((t) => t.toFixed(1)).join(' ')}`)
  }
  if (all.length === 0) return
  console.log(
    `\n    pnpm tsx scripts/vignettes-premier-plan.ts ${show.id} ` +
      `${all.map((t) => t.toFixed(1)).join(' ')} --out <dossier>`,
  )
}

// ---------------------------------------------------------------------------
// 8. Le plancher de taille
// ---------------------------------------------------------------------------

/** Ce qu'un plancher coupe, une fois par image survivante des autres filtres. */
type SizeFloorStats = {
  boxes: number
  dropped: number
  framesConsidered: number
  /**
   * Images qui perdent au moins une boîte — pas nécessairement resserrées :
   * une boîte coupée déjà comprise entre les extrêmes des autres ne change
   * pas l'empan. (relevé par Copilot)
   */
  framesFiltered: number
  /** Part de la plus haute de l'image, une valeur par boîte coupée — l'honnête moitié : une boîte coupée à 0,49 n'est pas la même nouvelle qu'une coupée à 0,05. */
  droppedShares: number[]
}

/**
 * Ce que `spans` ferait de chaque boîte de l'analyse **entière**, filtres du
 * score et du premier plan compris, sans se restreindre aux segments montés.
 *
 * **Le compte est corpus-wide par construction** : ce que le plancher coupe est
 * une propriété du détecteur, pas du montage. Rejoue la même logique que
 * `spans` dans `src/core/framing.ts` — deux copies qui divergeraient le jour où
 * l'une bouge sans l'autre, acceptée ici comme ailleurs dans ce script, qui
 * réimplémente déjà son propre `costOf` plutôt que d'appeler le cadrage produit.
 */
function sizeFloorEffect(analysis: Analysis, floor: number, options: FramingOptions): SizeFloorStats {
  const threshold = FRAMING_DEFAULTS.minScore
  const byFrame = new Map<number, number[]>()
  for (const b of analysis.boxes) {
    if (
      !Number.isFinite(b.t) ||
      !Number.isFinite(b.x0) ||
      !Number.isFinite(b.x1) ||
      !Number.isFinite(b.y0) ||
      !Number.isFinite(b.y1)
    )
      continue
    if (b.x1 <= b.x0 || b.y1 <= b.y0) continue
    if (!(b.score >= threshold)) continue
    if (isForeground(b, options)) continue
    const key = Math.round(b.t * 1000)
    const list = byFrame.get(key)
    if (list) list.push(b.y1 - b.y0)
    else byFrame.set(key, [b.y1 - b.y0])
  }

  let boxes = 0
  let dropped = 0
  let framesFiltered = 0
  const droppedShares: number[] = []
  for (const heights of byFrame.values()) {
    boxes += heights.length
    const tallest = Math.max(...heights)
    let survivors = 0
    // La plus haute boîte de l'image se compare toujours à elle-même : elle
    // survit à tout plancher <= 1, donc `survivors` ne descend jamais à zéro
    // pour les candidats balayés ici (tous <= 0,7). Une image ne peut donc
    // qu'être resserrée, jamais vidée — structurel, pas mesuré. (relevé par
    // Codex : le garde-fou qu'un tel test suggérait n'aurait jamais pu être
    // pris en défaut)
    for (const height of heights) {
      if (!(height >= floor * tallest)) {
        dropped += 1
        droppedShares.push(height / tallest)
        continue
      }
      survivors += 1
    }
    if (survivors < heights.length) framesFiltered += 1
  }
  return {
    boxes,
    dropped,
    framesConsidered: byFrame.size,
    framesFiltered,
    droppedShares,
  }
}

/**
 * Ce que chaque plancher coupe et achète, **par émission et corpus entier**.
 *
 * Aucune image n'est jamais entièrement vidée pour les candidats balayés ici
 * (tous <= 0,7) : c'est structurel, pas une propriété du corpus — voir le
 * commentaire de `sizeFloorEffect`. Le piège documenté dans la skill `cadrage`
 * (un plancher qui vide des images entières produirait de bons ratios calculés
 * sur ce qu'il en reste) resterait réel pour un candidat >= 1, mais aucun de
 * ceux balayés n'y expose.
 */
function sweepSizeFloor(shows: Show[]): void {
  console.log('  plancher   boîtes coupées   images filtrées   part coupée p90')
  const perShow = new Map<string, SizeFloorStats[]>()
  for (const floor of SIZE_FLOORS) {
    const options = opts({ sizeFloor: floor })
    const perFloor = shows.map((show) => sizeFloorEffect(show.analysis, floor, options))
    for (const [i, show] of shows.entries()) {
      const list = perShow.get(show.id) ?? []
      list.push(perFloor[i])
      perShow.set(show.id, list)
    }
    printSizeFloorRow(floor, mergeSizeFloorStats(perFloor), '  ')
  }

  for (const show of shows) {
    console.log(`\n  ${show.id}`)
    for (const [i, floor] of SIZE_FLOORS.entries()) {
      const stats = perShow.get(show.id)?.[i]
      if (stats === undefined) continue
      printSizeFloorRow(floor, stats, '    ')
    }
  }
}

/** Les stats de plusieurs émissions réduites à une seule ligne — le corpus. */
function mergeSizeFloorStats(stats: SizeFloorStats[]): SizeFloorStats {
  return stats.reduce((a, b) => ({
    boxes: a.boxes + b.boxes,
    dropped: a.dropped + b.dropped,
    framesConsidered: a.framesConsidered + b.framesConsidered,
    framesFiltered: a.framesFiltered + b.framesFiltered,
    droppedShares: [...a.droppedShares, ...b.droppedShares],
  }))
}

/**
 * Une ligne du tableau du plancher. **« part coupée p90 »** est l'honnête
 * moitié : elle dit, parmi les boîtes coupées, à combien pour cent de la plus
 * haute de leur image elles s'arrêtaient — proche du plancher, la coupe est
 * disputable ; proche de zéro, elle ne l'est pas. Un compte de boîtes seul ne
 * distingue pas les deux.
 */
function printSizeFloorRow(floor: number, stats: SizeFloorStats, indent: string): void {
  const defaultValue = floor === FRAMING_DEFAULTS.sizeFloor ? ' ←' : '  '
  const dropShare = stats.boxes === 0 ? 0 : (100 * stats.dropped) / stats.boxes
  console.log(
    `${indent}${floor.toFixed(2)}${defaultValue}` +
      `   ${stats.dropped} / ${stats.boxes} (${dropShare.toFixed(1)} %)`.padStart(26) +
      `   ${stats.framesFiltered}`.padStart(21) +
      `   ${number(percentile(stats.droppedShares, 0.9))}`.padStart(19),
  )
}

/**
 * Ce que le plancher change au **ratio et au temps de montage**, dans le style
 * des autres balayages — `sweepSideTrim` en particulier, dont il reprend la
 * colonne « déplacés », ici nommée « resserrés » : un plancher ne peut
 * qu'écarter des boîtes, jamais en ajouter, donc il ne peut que resserrer un
 * ratio, jamais l'élargir.
 */
function sweepSizeFloorRatio(show: Show, what: 'clips' | 'windows'): void {
  const cuts = show[what]
  if (cuts.length === 0) return
  console.log(`\n  ${show.id} — ${cuts.length} ${what}`)
  console.log(
    `  plancher ${MORE_NARROW_MORE_WIDE.map((r) => r.padStart(6)).join(' ')}` + `  16:9 tps`,
  )

  const reference = cuts.map((d) => ratio(d, show.analysis, opts({ sizeFloor: 0 })))
  for (const floor of SIZE_FLOORS) {
    const options = opts({ sizeFloor: floor })
    const ratios = cuts.map((d) => ratio(d, show.analysis, options))
    const count = distribution(ratios)
    const times = timePerRatio(cuts, show.analysis, options)
    const narrowed = ratios.filter((r, i) => RATIOS[r] < RATIOS[reference[i]]).length
    const defaultValue = floor === FRAMING_DEFAULTS.sizeFloor ? ' ←' : '  '
    console.log(
      `  ${floor.toFixed(2)}${defaultValue}` +
        MORE_NARROW_MORE_WIDE.map((r) => String(count.get(r) ?? 0).padStart(6)).join(' ') +
        `  ${number(shareInSixteenNine(times), 0).padStart(6)} %` +
        (narrowed > 0 ? `   ${narrowed} RESSERRÉ(S)` : ''),
    )
  }
}

// ---------------------------------------------------------------------------
// 9. Le split-screen : deux personnes, deux cellules
// ---------------------------------------------------------------------------

/** Les sorts d'un plan devant le déclencheur du split, dans l'ordre où on les lit. */
const SPLIT_OUTCOMES = [
  'split',
  'tooShort',
  'notTwoPeople',
  'ratioNotWide',
  'noPairs',
  'tooNarrowForSource',
  'bleedsIntoOther',
] as const

type SplitOutcome = (typeof SPLIT_OUTCOMES)[number]

/**
 * Ce que le split-screen change sur une émission, en **temps de montage**.
 *
 * La table de la spec (83,9 % sur `nabla`, 0 % sur `fmr`…) mesurait le montage
 * en split ; celle-ci ajoute la répartition des refus, pour que chaque colonne
 * de rejet montre au moins un cas qui la fait tomber dedans (contrat, critère
 * d'acceptation 8) plutôt que de rester une case qui ne peut jamais s'allumer.
 */
/**
 * Le contrôle mécanique de l'acceptance criterion 2 : le natif ne doit bouger
 * sur aucun clip, split activé ou non — ni son ratio, ni la position d'aucun
 * de ses plans.
 */
/**
 * Les tolérances balayées : la fourchette entre les deux plans approuvés le
 * 25 août (0,010 et 0,020 de débordement) et le seul rejeté (0,123), plus le
 * défaut (0,08 — le point à 90 % de `cqlp` 2096 s, validé par le repérage
 * humain du 25 août).
 */
const SPLIT_BLEED_TOLERANCES = [0.01, 0.02, 0.05, 0.08, 0.1, 0.123, 0.15]

/**
 * Ce que chaque tolérance change au rendement du split, et **le pire cas
 * qu'elle laisse passer** — celui qu'il faut regarder à l'image, pas le
 * confortable. Une tolérance qui n'a jamais rien à montrer ne prouve rien.
 */
/** Un passage du balayage, sous une valeur de `splitBleedShare` donnée. */
function bleedPass(
  show: Show,
  tolerance: number,
  share: number,
): { counts: Map<SplitOutcome, number>; worst: { clip: string; t: number; bleed: number } | null } {
  const withSettings = { ...opts(), splitBleedTolerance: tolerance, splitBleedShare: share }
  const counts = new Map<SplitOutcome, number>(SPLIT_OUTCOMES.map((o) => [o, 0]))
  let worst: { clip: string; t: number; bleed: number } | null = null

  for (const cut of show.clips) {
    const withoutSplit = framingOf(cut, show.analysis, { ...withSettings, splitScreen: false })
    const segments = normalizeSegments(cut.segments)
    const inSegments = show.analysis.boxes.filter((b) =>
      segments.some((g) => withinInterval(b.t, g.start, g.end)),
    )
    for (const framed of withoutSplit.shots) {
      const shot = framed.shot
      const boxes = inSegments.filter((b) => withinInterval(b.t, shot.start, shot.end))
      const { cells, rejection, bleed, worstBleedAt } = computeShotSplit(
        boxes,
        shot,
        framed.ratio,
        show.analysis.source.w,
        show.analysis.source.h,
        withSettings,
      )
      const outcome: SplitOutcome =
        cells !== null ? 'split' : ((rejection as SplitRejection | null) ?? 'tooShort')
      counts.set(outcome, (counts.get(outcome) ?? 0) + 1)
      // Le pire cas **accepté**, celui qu'un lecteur verrait vraiment sous ce
      // réglage — pas le pire cas tout court. `worstBleedAt` désigne l'image
      // précise, pas seulement le plan.
      if (cells !== null && bleed !== null && worstBleedAt !== null) {
        if (worst === null || bleed > worst.bleed) {
          worst = { clip: cut.name, t: worstBleedAt, bleed }
        }
      }
    }
  }
  return { counts, worst }
}

/**
 * Le balayage de la tolérance, **sous les deux lectures** : chaque image du
 * plan doit tenir (part à 1 — l'ancien critère de recouvrement, en plus
 * strict), et 90 % d'entre elles suffisent (le défaut retenu). La deuxième
 * colonne est ce que la part achète ; sans la première à côté, 0,9 se lirait
 * comme hérité plutôt qu'argumenté.
 */
function sweepBleedTolerance(show: Show): void {
  console.log(`\n  ${show.id}`)
  for (const tolerance of SPLIT_BLEED_TOLERANCES) {
    for (const [label, share] of [
      ['chaque image (part 1,0)', 1] as const,
      [`90 % des images (part ${FRAMING_DEFAULTS.splitBleedShare})`, FRAMING_DEFAULTS.splitBleedShare] as const,
    ]) {
      const { counts, worst } = bleedPass(show, tolerance, share)
      const line = SPLIT_OUTCOMES.map((o) => `${o} ${counts.get(o) ?? 0}`).join('  ')
      const worstText =
        worst === null
          ? 'aucun split accepté'
          : `pire bleed accepté ${worst.bleed.toFixed(3)} — ${worst.clip} @ ${worst.t.toFixed(1)} s`
      console.log(`    ${tolerance.toFixed(3)}  ${label.padEnd(26)}  ${line}  —  ${worstText}`)
    }
  }
}

function splitNativeControl(show: Show): void {
  const options = opts()
  let moved = 0
  const touched: string[] = []
  for (const cut of show.clips) {
    const off = framingOf(cut, show.analysis, { ...options, splitScreen: false })
    const on = framingOf(cut, show.analysis, { ...options, splitScreen: true })
    const same =
      off.ratio === on.ratio &&
      off.shots.length === on.shots.length &&
      off.shots.every((p, i) => p.cropXNative === on.shots[i].cropXNative)
    if (!same) {
      moved += 1
      touched.push(`${cut.name} : ${off.ratio} → ${on.ratio}`)
    }
  }
  console.log(
    `  ${show.id} — natif : ${moved === 0 ? 'intact sur les ' + String(show.clips.length) + ' clips' : String(moved) + ' CLIPS DÉPLACÉS'}`,
  )
  if (touched.length > 0) console.log(`    ${touched.join(', ')}`)
}

function splitYield(show: Show): void {
  const options = opts()
  const seconds = new Map<SplitOutcome, number>(SPLIT_OUTCOMES.map((o) => [o, 0]))
  const shotsSeen = new Map<SplitOutcome, number>(SPLIT_OUTCOMES.map((o) => [o, 0]))
  let montage = 0

  for (const cut of show.clips) {
    // Le ratio qui vaudrait **sans** split : c'est la condition 3 du
    // déclencheur, et `computeShotSplit` la reçoit déjà tranchée plutôt que de
    // la recalculer — une seule fonction décide de `shotRatiosAll`.
    const withoutSplit = framingOf(cut, show.analysis, { ...options, splitScreen: false })

    const segments = normalizeSegments(cut.segments)
    const inSegments = show.analysis.boxes.filter((b) =>
      segments.some((g) => withinInterval(b.t, g.start, g.end)),
    )
    for (const framed of withoutSplit.shots) {
      const shot = framed.shot
      const inClip = segments.reduce(
        (n, g) => n + Math.max(0, Math.min(shot.end, g.end) - Math.max(shot.start, g.start)),
        0,
      )
      montage += inClip
      const boxes = inSegments.filter((b) => withinInterval(b.t, shot.start, shot.end))
      const { cells, rejection } = computeShotSplit(
        boxes,
        shot,
        framed.ratio,
        show.analysis.source.w,
        show.analysis.source.h,
        options,
      )
      const outcome: SplitOutcome = cells !== null ? 'split' : ((rejection as SplitRejection | null) ?? 'tooShort')
      seconds.set(outcome, (seconds.get(outcome) ?? 0) + inClip)
      shotsSeen.set(outcome, (shotsSeen.get(outcome) ?? 0) + 1)
    }
  }

  const share = (n: number): string => (montage === 0 ? '—' : `${((100 * n) / montage).toFixed(1)} %`)
  const split = seconds.get('split') ?? 0
  console.log(`\n  ${show.id} — ${montage.toFixed(0)} s de montage couvertes par un plan`)
  console.log(`    ${'sort'.padEnd(19)} ${'plans'.padStart(6)} ${'secondes'.padStart(10)} ${'du montage'.padStart(11)}`)
  for (const outcome of SPLIT_OUTCOMES) {
    const n = seconds.get(outcome) ?? 0
    if (n === 0 && (shotsSeen.get(outcome) ?? 0) === 0) continue
    console.log(
      `    ${outcome.padEnd(19)} ${String(shotsSeen.get(outcome) ?? 0).padStart(6)} ` +
        `${n.toFixed(1).padStart(10)} ${share(n).padStart(11)}`,
    )
  }
  console.log(`    → split sur ${split.toFixed(1)} s, soit ${share(split)} du montage`)
}

/** Le nombre de personnes retenues, réduit aux trois classes que le split lit. */
function headcountBucket(n: number): '0' | '1' | '2' | '3+' {
  return n <= 0 ? '0' : n === 1 ? '1' : n === 2 ? '2' : '3+'
}

/**
 * Ce que le plancher de taille de la PR #177 change à **l'effectif par
 * image**, et non à un ratio — ce que sa propre section 8 n'a jamais mesuré,
 * alors que c'est exactement ce que lit le déclencheur du split (contrat,
 * critère d'acceptation 7). Une image de trois personnes qui retombe à deux
 * quand le plancher s'active est le cas visé : la jaquette de DVD de la
 * conception, comptée en trop tant que rien ne l'excluait.
 */
function sizeFloorHeadcountShift(show: Show): void {
  const withFloor = opts()
  const withoutFloor = opts({ sizeFloor: 0 })
  let framesConsidered = 0
  let framesShifted = 0
  const shifts = new Map<string, number>()

  for (const cut of show.clips) {
    const segments = normalizeSegments(cut.segments)
    const boxes = show.analysis.boxes.filter((b) => segments.some((g) => withinInterval(b.t, g.start, g.end)))
    const before = retainedCountByFrame(boxes, withoutFloor)
    const after = retainedCountByFrame(boxes, withFloor)
    // Les deux comptes viennent du même regroupement par image et donc du même
    // ordre d'itération : `retainedCountByFrame` ne fait que varier le
    // plancher, jamais le regroupement lui-même.
    framesConsidered += before.length
    for (const [i, b] of before.entries()) {
      const bucketBefore = headcountBucket(b)
      const bucketAfter = headcountBucket(after[i])
      if (bucketBefore === bucketAfter) continue
      framesShifted += 1
      const key = `${bucketBefore} → ${bucketAfter}`
      shifts.set(key, (shifts.get(key) ?? 0) + 1)
    }
  }

  const share = framesConsidered === 0 ? '—' : `${((100 * framesShifted) / framesConsidered).toFixed(2)} %`
  console.log(`\n  ${show.id} — ${framesConsidered} image(s) considérée(s), ${framesShifted} changent de classe (${share})`)
  for (const [key, n] of [...shifts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${key.padEnd(10)} ${n}`)
  }
}

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const iMoments = arguments_.indexOf('--instants')
  // Les valeurs qui suivent un drapeau ne sont pas des identifiants de projet :
  // les retirer avant de lire les positionnels, sinon `--instants 3` demande un
  // projet nommé « 3 » et va lire une analyse qui n'existe pas.
  const suiveuses = new Set<number>()
  for (const [i, a] of arguments_.entries()) {
    if (a === '--instants' || a === '--tronc' || a === '--analyse') suiveuses.add(i + 1)
  }
  const ids = arguments_.filter((a, i) => !a.startsWith('--') && !suiveuses.has(i))
  if (ids.length === 0) {
    console.error(
      'Usage : pnpm tsx scripts/mesure-ratios.ts <projectId…> [--instants N] ' +
        '[--tronc <nom|off>] [--analyse <projet>=<fichier>]…',
    )
    return 1
  }

  // **Un fichier d'analyse nommé à la main, par projet.** Répétable d'un projet
  // à l'autre, mais **une seule fois par projet** : deux analyses de la même
  // émission se comparent en deux exécutions, pas en deux drapeaux.
  const overrides = new Map<string, string>()
  for (const [i, a] of arguments_.entries()) {
    if (a !== '--analyse') continue
    const raw = arguments_[i + 1]
    const separator = raw === undefined ? -1 : raw.indexOf('=')
    if (raw === undefined || separator <= 0) {
      console.error(`--analyse attend <projet>=<fichier>, reçu « ${String(raw)} ».`)
      return 1
    }
    const project = raw.slice(0, separator)
    // **Un doublon est refusé, pas écrasé.** Le commentaire ci-dessus promettait
    // de comparer deux détecteurs sur la même émission ; la `Map` étant indexée
    // par projet, le second `--analyse` du même projet remplaçait simplement le
    // premier, et les deux identifiants passés en positionnel chargeaient le
    // même fichier. Le tableau sortait donc deux lignes identiques sous deux
    // noms, ce dont on aurait conclu que les deux détecteurs se valent. Deux
    // fichiers se comparent en deux exécutions, ou en donnant à chacun son
    // identifiant de projet. (relevé par Copilot)
    if (overrides.has(project)) {
      console.error(
        `--analyse est donné deux fois pour « ${project} » : ce script lit une analyse par projet, ` +
          'donc la seconde écraserait la première sans rien dire. Comparer deux détecteurs sur la ' +
          'même émission demande deux exécutions.',
      )
      return 1
    }
    overrides.set(project, raw.slice(separator + 1))
  }

  // Un tronc inconnu est **refusé**, pas remplacé par le défaut : une faute de
  // frappe qui mesurerait silencieusement le tronc par défaut est exactement la
  // sortie dont on tirerait une conclusion fausse — même règle que `--marge` et
  // `--trim` de `vignettes-cadrage.ts`.
  const iTronc = arguments_.indexOf('--tronc')
  if (iTronc >= 0) {
    const raw = arguments_[iTronc + 1]
    if (raw === undefined || !TORSO_NAMES.some((t) => t === raw)) {
      console.error(`--tronc attend l'un de ${TORSO_NAMES.join(', ')}, reçu « ${String(raw)} ».`)
      return 1
    }
    BASE.torso = raw as TorsoName | 'off'
  }
  // Un compte illisible est **refusé**, pas remplacé par le défaut : `--instants 0`
  // qui imprimerait trois instants est le genre de silence qui fait chercher le
  // défaut ailleurs.
  const rawMoments = iMoments >= 0 ? arguments_[iMoments + 1] : undefined
  const nMoments =
    iMoments < 0
      ? null
      : rawMoments === undefined || rawMoments.startsWith('--')
        ? 3
        : Number(rawMoments)
  if (nMoments !== null && (!Number.isInteger(nMoments) || nMoments <= 0)) {
    console.error(`--instants attend un entier ≥ 1, reçu « ${String(rawMoments)} ».`)
    return 1
  }

  try {
    const shows = ids
      .map((id) => charger(id, overrides))
      .filter((e): e is Show => e !== null)
    if (shows.length === 0) return 1

    console.log(
      `Réglages par défaut : y1 ≥ ${FRAMING_DEFAULTS.bottomEdge}, ` +
        `hauteur < ${FRAMING_DEFAULTS.foregroundMaxHeight}, score ≥ ${FRAMING_DEFAULTS.minScore}, ` +
        `marge ${FRAMING_DEFAULTS.margin}, rognage ${FRAMING_DEFAULTS.sideTrim} ` +
        `plafonné à ${FRAMING_DEFAULTS.sideTrimMax}, tronc « ${FRAMING_DEFAULTS.torso} » ` +
        `points ≥ ${FRAMING_DEFAULTS.torsoMinScore} rembourré de ${FRAMING_DEFAULTS.torsoPad}`,
    )
    if (BASE.torso !== undefined) {
      console.log(`Sections 1 à 5 et 7 forcées sur le tronc « ${BASE.torso} » ; la 6 le balaie.`)
    }
    for (const e of shows) {
      const source = overrides.get(e.id)
      console.log(
        `  ${e.id} : ${source ?? analysisPath(e.id)}` +
          ` — version ${e.analysis.version}, ${e.analysis.model ?? 'modèle inconnu'}` +
          `, ${e.analysis.keypoints ?? 'sans points de pose'}`,
      )
    }

    console.log('\n=== 1. Le ratio par clip ===')
    for (const e of shows) byClip(e)

    console.log('\n=== 2. La répartition comparée ===')
    comparison(shows, 'clips')
    comparison(shows, 'windows')

    console.log('\n=== 3. Le balayage de la marge ===')
    console.log('  (« déplacés » se compte par rapport à la marge par défaut)')
    for (const e of shows) sweep(e, 'clips')
    for (const e of shows) sweep(e, 'windows')

    console.log('\n=== 4. Le balayage du rognage latéral ===')
    console.log('  (« coupé » se mesure sur le cadre du plan, boîtes entières, images sacrifiées comprises)')
    console.log('  (les p90/p99 portent sur les personnes ; les colonnes en secondes comptent les images, la pire perte de chacune)')
    for (const e of shows) sweepSideTrim(e, 'clips')
    for (const e of shows) sweepSideTrim(e, 'windows')

    console.log('\n=== 5. Les plans que la position borne, et non la largeur ===')
    console.log('  (leurs images tiendraient plus serré ; aucune position fixe ne les sert)')
    for (const e of shows) boundedByPosition(e)

    console.log('\n=== 6. Le tronc contre la boîte corps entier ===')
    console.log("  (l'empan que chaque primitive demande, avant tout choix de ratio)")
    for (const e of shows) torsoVersusBox(e)
    console.log('\n  Ce que chaque définition de tronc change')
    console.log('  (« têtes dehors » : personnes-images dont aucun point de tête n’est dans le crop ; la durée entre parenthèses compte les images, pas les personnes)')
    for (const e of shows) sweepTorso(e, 'clips')
    for (const e of shows) sweepTorso(e, 'windows')
    console.log('\n  Le rembourrage du tronc')
    for (const e of shows) sweepTorsoPadding(e, 'clips', 'torsoPad')
    for (const e of shows) sweepTorsoPadding(e, 'windows', 'torsoPad')
    console.log('\n  Le rognage du tronc, tête exceptée')
    for (const e of shows) sweepTorsoPadding(e, 'clips', 'torsoTrim')
    for (const e of shows) sweepTorsoPadding(e, 'windows', 'torsoTrim')

    if (nMoments !== null) {
      console.log('\n=== 7. Où regarder — les images qui font monter le ratio ===')
      for (const e of shows) whereRegarder(e, nMoments)
    }

    console.log('\n=== 8. Le plancher de taille ===')
    console.log('  (une boîte plus courte que ce plancher fois la plus haute de sa propre image en sort)')
    sweepSizeFloor(shows)
    for (const e of shows) sweepSizeFloorRatio(e, 'clips')
    for (const e of shows) sweepSizeFloorRatio(e, 'windows')
    console.log('\n  Ce que le plancher change à l\'effectif par image, pas seulement au ratio')
    for (const e of shows) sizeFloorHeadcountShift(e)

    console.log('\n=== 9. Le split-screen : deux personnes, deux cellules ===')
    console.log("  (« split » : le déclencheur s'applique ; les autres colonnes sont les causes de refus)")
    for (const e of shows) splitYield(e)
    console.log('\n  Contrôle mécanique : le natif ne bouge pas, split activé ou non')
    for (const e of shows) splitNativeControl(e)

    console.log('\n  Le balayage de la tolérance au débordement (splitBleedTolerance)')
    console.log('  (« pire bleed accepté » : le plan le plus proche de la tolérance parmi ceux acceptés — celui à regarder à l\'image)')
    for (const e of shows) sweepBleedTolerance(e)

    return 0
  } finally {
    closeDb()
  }
}

void main().then(quit, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quit(1)
})
