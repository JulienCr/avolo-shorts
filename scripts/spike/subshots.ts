/**
 * Subdiviser un plan en **sous-plans**, chacun gardant un crop fixe — et mesurer
 * ce que ça change, **avec ses témoins**.
 *
 *     pnpm tsx scripts/spike/subshots.ts [<projectId…>]
 *         [--min-hold 2] [--switch-frames 3] [--frontal-margin 0.25]
 *         [--crop-overlap-max 0.5] [--ratio-lock none|shot] [--seed 1]
 *         [--json <fichier>]
 *
 * Sans `projectId`, les quatre émissions du disque (`DEFAULT_SHOW_IDS`).
 *
 * **Le résultat qui commande tout ce script est un témoin qui a démenti sa
 * mesure.** `docs/locuteur-et-orientation.md` le pose : couper un plan
 * *n'importe où* resserre 31,7 % du gisement, contre 41,3 % pour le meilleur
 * critère essayé — et le hasard fait mieux que lui sur deux émissions sur
 * quatre. La règle des 90 % s'applique à un intervalle plus court, où l'action a
 * moins le temps de bouger. Donc **tout gain annoncé sans témoin est faux**, et
 * ce script en porte deux : `randomWho`, qui garde les frontières du candidat et
 * tire au sort qui l'on suit, et `evenCuts`, qui garde le critère de choix et
 * coupe à cadence régulière.
 *
 * `randomWho` isole ce que vaut le **choix** : si le candidat ne le bat pas,
 * alors on gagne en subdivisant, pas en sachant qui est de face. `evenCuts`
 * isole ce que vaut le **placement** des frontières.
 *
 * **Ce script ne décide rien du cadrage.** `chooseRatio`, `cropRect`,
 * `personBounds`, `isForeground`, `orientationOf` et `computeFraming` sont les
 * seules autorités — la skill `cadrage` est explicite : jamais une
 * réimplémentation. Ce qui est propre à ce spike, c'est *quelles boîtes* on
 * passe à `computeFraming` et *sur quels intervalles*, jamais ce qu'il en fait.
 *
 * Cinq sorties :
 *
 * 1. **le gain** — la part du temps de montage dont le sous-plan sort en `9:16`,
 *    c'est-à-dire remplit le canevas vertical, plus la répartition des quatre
 *    ratios ;
 * 2. **le risque, en deux compteurs séparés et surtout pas un seul** — les têtes
 *    hors du rectangle de crop parmi les personnes **gardées**, qui sont la
 *    seule faute réelle, et celles des personnes **délibérément écartées**, qui
 *    sont l'effet voulu. Les confondre ferait crier au désastre pour exactement
 *    ce qu'on cherche à faire ;
 * 3. **le rythme** — coupes ajoutées par minute et distribution des durées de
 *    sous-plan ;
 * 4. **le confort** — les changements de **taille de canevas** par minute, ce
 *    que `--ratio-lock shot` doit faire baisser ;
 * 5. **les replis** — la part de temps où la décision est « garder tout le
 *    monde », ventilée par cause. Cette ventilation compte autant que le gain :
 *    sur certains plans le détecteur pose une boîte de personne **sur un visage
 *    imprimé** — une jaquette de DVD brandie devant la caméra — avec une
 *    frontalité de 0,96, plus haute que celle des deux vrais comédiens. Le plan
 *    passe alors à trois personnes et la règle ne se déclenche plus ; la ligne
 *    `moreThanTwo` dit combien de temps ça coûte.
 *
 * Puis un balayage `--min-hold` × `--ratio-lock`, huit lignes, pour voir ce que
 * chaque cran de confort coûte en gain.
 *
 * **La partition est vérifiée, pas supposée.** `analysis.json` a le même
 * contrôle (`shotsInPartition`, `src/server/steps/analysis.ts`) et son
 * commentaire dit pourquoi : un trou fait disparaître des boîtes en silence, un
 * recouvrement les compte deux fois.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { normalizeSegments } from '@/core/edl'
import type { Ratio, Segment } from '@/core/edl'
import {
  FRAMING_DEFAULTS,
  RATIOS,
  TORSOS,
  computeFraming,
  isForeground,
  orientationOf,
  personBounds,
  ratioCoverage,
  sizeInCanvas,
} from '@/core/framing'
import type { ShotFraming } from '@/core/framing'
import type { PersonBox, Shot } from '@/core/shots'
import { closeDb, getClips, getDb } from '@/server/db'
import { pathTemporary } from '@/server/ffmpeg'
import { analysisPath } from '@/server/paths'
import { lireAnalysis, type Analysis } from '@/server/steps/analysis'
import { chargerEnv, quit } from '../dev-common'

/** Les quatre émissions du disque, faute de `projectId` sur la ligne de commande. */
const DEFAULT_SHOW_IDS = [
  '2025-06-15-cqlp',
  '2026-03-08-caro-mdlm',
  '2026-05-31-nabla',
  '2026-22-02-entre-nous',
] as const

/**
 * Les quatre ratios du plus étroit au plus large, déduits de `RATIOS` — la même
 * construction que `scripts/measure-ratios.ts` et `scripts/spike/addressable.ts`,
 * dupliquée plutôt qu'importée : la table de `framing.ts` est privée, et un ordre
 * d'affichage n'est pas un calcul de cadrage.
 */
const MORE_NARROW_MORE_WIDE = (Object.keys(RATIOS) as Ratio[]).sort((a, b) => RATIOS[a] - RATIOS[b])

/**
 * Le canevas vertical de la sortie 9:16, celui dont on mesure la hauteur
 * occupée. Les chiffres qu'il produit sont ceux de la skill `cadrage` : un 9:16
 * remplit, un 4:5 occupe 70,3 %, un 1:1 56,3 %, un 16:9 31,6 %.
 */
const CANVAS = { w: 1080, h: 1920 } as const

/**
 * Les points de tête, ceux dont la présence dans le cadre n'est pas négociable :
 * nez, yeux, oreilles. **Repris de `costOf` dans `scripts/measure-ratios.ts`**,
 * méthode comprise — la consigne est de s'en servir, pas de la réinventer.
 */
const HEAD_POINTS = TORSOS.head

/** La tolérance du contrôle de partition, en secondes. La même que `analysis.ts`. */
const TOLERANCE_PARTITION = 0.001

// ---------------------------------------------------------------------------
// Les petites primitives d'affichage et de statistique.
// ---------------------------------------------------------------------------

/** La médiane, au sens strict : sur un compte pair, le milieu des deux centrales. */
function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const m = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

/** Le percentile `p` (0 à 1), par le rang le plus proche — comme `measure-ratios.ts`. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[i]
}

/**
 * Le minimum et le maximum, **par accumulation et jamais par `Math.min(...t)`** :
 * l'étalement passe chaque élément en argument, et le corpus porte des dizaines
 * de milliers de sous-plans — de quoi dépasser la pile d'appels sur une valeur
 * qui n'a rien de limite.
 */
function extremes(values: number[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  return values.length === 0 ? { min: Number.NaN, max: Number.NaN } : { min, max }
}

function number(n: number, decimals = 1): string {
  return Number.isFinite(n) ? n.toFixed(decimals) : '—'
}

function percent(part: number, total: number): string {
  return total > 0 ? `${((100 * part) / total).toFixed(1)} %` : '—'
}

/** `t` tombe-t-il dans l'intervalle ? **Fin exclue**, comme `computeFraming`. */
function inInterval(t: number, start: number, end: number): boolean {
  return t >= start && t < end
}

function bound(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), Math.max(min, max))
}

/** L'intervalle entre deux images mesurées, en secondes, **lu dans l'analyse**. */
function sampleStep(analysis: Analysis): number {
  return analysis.fps > 0 ? 1 / analysis.fps : Number.NaN
}

/** Le temps commun à un intervalle et à une liste de segments, en secondes. */
function overlapSeconds(interval: { start: number; end: number }, segments: Segment[]): number {
  return segments.reduce(
    (n, s) => n + Math.max(0, Math.min(interval.end, s.end) - Math.max(interval.start, s.start)),
    0,
  )
}

/** L'abscisse du centre de `personBounds` — le repère sur lequel le rang se départage. */
function centerOf(box: PersonBox): number {
  const bounds = personBounds(box)
  return (bounds.x0 + bounds.x1) / 2
}

// ---------------------------------------------------------------------------
// Le générateur pseudo-aléatoire, déterministe et écrit à la main.
// ---------------------------------------------------------------------------

/**
 * Mulberry32, en clair et sans dépendance. **Jamais `Math.random()`** : deux
 * exécutions du même balayage doivent être comparables, sans quoi l'écart entre
 * `candidate` et `randomWho` ne se distingue plus du bruit d'un tirage.
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * FNV-1a sur 32 bits. Sert à décaler la graine par émission, pour que le tirage
 * d'une émission ne dépende pas de l'ordre dans lequel les autres sont passées
 * sur la ligne de commande.
 */
function hashOfString(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i += 1) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// La décision d'une image.
// ---------------------------------------------------------------------------

/** Qui l'on garde : le rang 0 (gauche), le rang 1 (droite), ou tout le monde. */
type Keep = 0 | 1 | 'all'

/** Pourquoi une image retombe sur « garder tout le monde ». */
const FALLBACK_CAUSES = [
  'lessThanTwo',
  'moreThanTwo',
  'unknown',
  'narrowGap',
  'cropOverlap',
  'absorbed',
] as const
type FallbackCause = (typeof FALLBACK_CAUSES)[number]

/** Les libellés français des causes de repli, pour les en-têtes de tableau. */
const CAUSE_LABELS: Readonly<Record<FallbackCause, string>> = {
  lessThanTwo: '< 2 pers.',
  moreThanTwo: '> 2 pers.',
  unknown: 'unknown',
  narrowGap: 'ecart faible',
  cropOverlap: 'coupe refusee',
  absorbed: 'absorbe',
}

/** Une image du plan, avec ses boîtes et la décision qu'elle porte à elle seule. */
type FrameDecision = {
  /** L'instant, en secondes dans la source. */
  t: number
  /** Toutes les boîtes de cette image, sans filtre — ce que `today` passe au cadrage. */
  all: PersonBox[]
  /**
   * Les boîtes **retenues** (score et premier plan filtrés), triées par
   * l'abscisse du centre de `personBounds`, croissante.
   *
   * **Même parade que `collective_shift` dans `worker/detect.py`** : une
   * translation préserve l'ordre gauche-droite, donc trier par abscisse suffit à
   * apparier deux images successives. **Et ça casse si les deux personnes se
   * croisent** — rien ici ne suit une identité d'une image à l'autre, seul le
   * rang instantané compte, donc deux comédiens qui échangent leurs places
   * échangent aussi leurs rangs sans que rien ne le signale.
   */
  ranked: PersonBox[]
  /** La décision de cette image seule, avant hystérésis et avant `--min-hold`. */
  keep: Keep
  /** La cause du repli, `null` quand `keep` est un rang. */
  cause: FallbackCause | null
  /** L'image tombe-t-elle dans le montage ? Seules celles-là comptent dans les mesures. */
  inMontage: boolean
}

/**
 * La décision, image par image, sur les boîtes d'un plan.
 *
 * La règle est **relative, jamais absolue** : ce qui compte est l'écart de
 * frontalité entre les deux personnes de *cette image-là*, pas la position de
 * chacune contre un seuil fixe. La spec §2 rappelle que les comédiens jouent de
 * profil, face à face — un seuil absolu serait juste sur une interview et faux
 * partout ailleurs. Et `frontalThreshold` ne sert qu'à l'étiquette `facing`, qui
 * est un diagnostic.
 *
 * **`unknown` n'exclut jamais personne** : une frontalité inconnue fait retomber
 * l'image sur « garder tout le monde », elle ne fait pas perdre son occupant.
 */
function frameDecisionsOf(
  boxes: PersonBox[],
  shot: Shot,
  segments: Segment[],
  frontalMargin: number,
): FrameDecision[] {
  const byFrame = new Map<number, PersonBox[]>()
  for (const b of boxes) {
    if (!inInterval(b.t, shot.start, shot.end)) continue
    const key = Math.round(b.t * 1000)
    const already = byFrame.get(key)
    if (already) already.push(b)
    else byFrame.set(key, [b])
  }

  const out: FrameDecision[] = []
  for (const all of byFrame.values()) {
    const t = all[0].t
    const ranked = all
      .filter((b) => b.score >= FRAMING_DEFAULTS.minScore && !isForeground(b))
      .sort((x, y) => centerOf(x) - centerOf(y))

    let keep: Keep = 'all'
    let cause: FallbackCause | null = null
    if (ranked.length !== 2) {
      cause = ranked.length < 2 ? 'lessThanTwo' : 'moreThanTwo'
    } else {
      const left = orientationOf(ranked[0]).frontality
      const right = orientationOf(ranked[1]).frontality
      if (left === null || right === null) {
        cause = 'unknown'
      } else if (!(Math.abs(left - right) >= frontalMargin)) {
        // `!(écart >= marge)` et non `écart < marge` : un écart non fini doit
        // tomber du côté du repli, jamais passer.
        cause = 'narrowGap'
      } else {
        keep = left > right ? 0 : 1
      }
    }

    out.push({
      t,
      all,
      ranked,
      keep,
      cause,
      inMontage: segments.some((s) => inInterval(t, s.start, s.end)),
    })
  }

  return out.sort((a, b) => a.t - b.t)
}

/** Les boîtes qu'un sous-plan garde, pour une image donnée. */
function keptBoxesOf(frame: FrameDecision, keep: Keep): PersonBox[] {
  if (keep === 'all') return frame.all
  // Un sous-plan qui suit un rang le suit sur **toutes** ses images, y compris
  // celles qui, prises seules, auraient dit « garder tout le monde » : c'est
  // exactement ce à quoi sert l'hystérésis. Quand le rang n'existe pas dans
  // cette image-là — moins de personnes retenues qu'il n'en faut — on garde
  // tout le monde plutôt que rien : une image vidée ne dit pas que le cadre
  // peut être serré, elle ne dit rien, et `spans` la compterait comme telle.
  return keep < frame.ranked.length ? [frame.ranked[keep]] : frame.all
}

/** Les personnes retenues qu'un sous-plan **écarte** délibérément, pour une image. */
function droppedBoxesOf(frame: FrameDecision, keep: Keep): PersonBox[] {
  if (keep === 'all' || keep >= frame.ranked.length) return []
  return frame.ranked.filter((_, i) => i !== keep)
}

/** Les personnes retenues qu'un sous-plan **garde**, parmi les seules retenues. */
function keptRetainedOf(frame: FrameDecision, keep: Keep): PersonBox[] {
  if (keep === 'all' || keep >= frame.ranked.length) return frame.ranked
  return [frame.ranked[keep]]
}

// ---------------------------------------------------------------------------
// De la suite des décisions aux intervalles.
// ---------------------------------------------------------------------------

/** Un sous-plan : un intervalle du plan, et qui l'on y garde. */
type SubShot = {
  start: number
  end: number
  keep: Keep
  /**
   * Vrai quand cet intervalle est né d'une fusion imposée par
   * `--crop-overlap-max` : la coupe se lisait comme un faux raccord.
   */
  mergedByOverlap: boolean
}

/**
 * L'hystérésis : il faut `switchFrames` images consécutives d'accord pour
 * changer de décision.
 *
 * **On part de « garder tout le monde »**, jamais de la décision de la première
 * image. C'est le repli du dépôt, et le début d'un plan est précisément
 * l'endroit où l'on n'a encore rien confirmé — suivre quelqu'un dès la première
 * image serait décider sur une voix. Le petit intervalle de repli que ça crée en
 * tête de plan est ensuite absorbé par `--min-hold`, qui est là pour ça.
 */
function smoothDecisions(frames: FrameDecision[], switchFrames: number): Keep[] {
  const out: Keep[] = []
  let current: Keep = 'all'
  let pending: Keep | null = null
  let pendingCount = 0
  let pendingStart = 0

  for (const [i, frame] of frames.entries()) {
    if (frame.keep === current) {
      pending = null
      pendingCount = 0
      out.push(current)
      continue
    }
    if (pending !== null && frame.keep === pending) pendingCount += 1
    else {
      pending = frame.keep
      pendingCount = 1
      pendingStart = i
    }
    if (pendingCount >= switchFrames && pending !== null) {
      current = pending
      // Rétroactivement : la bascule appartient à la première des `n` images qui
      // l'ont confirmée, pas à la dernière. Sinon la frontière arriverait
      // systématiquement `n` images trop tard, soit 1,5 s au défaut.
      for (let j = pendingStart; j <= i; j += 1) out[j] = current
      pending = null
      pendingCount = 0
      continue
    }
    out.push(current)
  }

  return out
}

/**
 * Les intervalles d'une suite de décisions lissées, **bornés par le plan**.
 *
 * La frontière est posée sur l'instant de la première image de la nouvelle
 * décision : une boîte à `t` appartient à l'intervalle qui commence à `t`, fin
 * exclue, comme partout ailleurs dans ce dépôt.
 */
function intervalsFrom(frames: FrameDecision[], keeps: Keep[], shot: Shot): SubShot[] {
  if (frames.length === 0) {
    return [{ start: shot.start, end: shot.end, keep: 'all', mergedByOverlap: false }]
  }
  const edges: { start: number; keep: Keep }[] = [{ start: shot.start, keep: keeps[0] }]
  for (let i = 1; i < frames.length; i += 1) {
    if (keeps[i] === keeps[i - 1]) continue
    // Une frontière hors du plan ou en arrière de la précédente n'existe pas :
    // la partition prime sur la décision.
    if (!(frames[i].t > edges[edges.length - 1].start && frames[i].t < shot.end)) continue
    edges.push({ start: frames[i].t, keep: keeps[i] })
  }
  return edges.map((e, i) => ({
    start: e.start,
    end: i + 1 < edges.length ? edges[i + 1].start : shot.end,
    keep: e.keep,
    mergedByOverlap: false,
  }))
}

/**
 * `--min-hold` : aucun intervalle plus court que `minHold` secondes.
 *
 * **Un intervalle trop court est absorbé par son voisin le plus long**, dont il
 * prend la décision. À longueurs égales, le voisin de gauche gagne : arbitraire,
 * mais déterministe, et le dire vaut mieux que de le maquiller.
 *
 * Un plan plus court que `minHold` garde un seul intervalle : la boucle s'arrête
 * dès qu'il ne reste plus rien à fusionner.
 */
function enforceMinHold(intervals: SubShot[], minHold: number): SubShot[] {
  const out = [...intervals]
  while (out.length > 1) {
    let worst = -1
    let worstDuration = Number.POSITIVE_INFINITY
    for (const [i, s] of out.entries()) {
      const duration = s.end - s.start
      if (duration >= minHold || duration >= worstDuration) continue
      worst = i
      worstDuration = duration
    }
    if (worst < 0) break

    const left = worst > 0 ? out[worst - 1] : null
    const right = worst + 1 < out.length ? out[worst + 1] : null
    const takeRight =
      left === null ||
      (right !== null && right.end - right.start > left.end - left.start)
    if (takeRight && right !== null) {
      out.splice(worst, 2, {
        start: out[worst].start,
        end: right.end,
        keep: right.keep,
        mergedByOverlap: right.mergedByOverlap,
      })
    } else if (left !== null) {
      out.splice(worst - 1, 2, {
        start: left.start,
        end: out[worst].end,
        keep: left.keep,
        mergedByOverlap: left.mergedByOverlap,
      })
    } else break
  }
  return out
}

/**
 * La décision majoritaire des images d'un intervalle, sur les décisions
 * **brutes** — celles d'avant l'hystérésis, qui est propre au découpage du
 * candidat et n'aurait pas de sens sur des frontières régulières.
 *
 * **À égalité, on garde tout le monde**, et ce n'est pas le défaut prudent que
 * `CLAUDE.md` met en garde : deux rangs à égalité sur un intervalle, ce sont
 * deux hypothèses concurrentes à une voix chacune, et la réponse honnête est de
 * refuser de trancher — pas de poser un gagnant au hasard.
 */
function majorityKeep(frames: FrameDecision[], start: number, end: number): Keep {
  let rank0 = 0
  let rank1 = 0
  let all = 0
  for (const f of frames) {
    if (!inInterval(f.t, start, end)) continue
    if (f.keep === 0) rank0 += 1
    else if (f.keep === 1) rank1 += 1
    else all += 1
  }
  if (rank0 > rank1 && rank0 > all) return 0
  if (rank1 > rank0 && rank1 > all) return 1
  return 'all'
}

/** `count` intervalles réguliers couvrant le plan, avec leur décision majoritaire. */
function evenIntervals(shot: Shot, count: number, frames: FrameDecision[]): SubShot[] {
  const duration = shot.end - shot.start
  const edges = [shot.start]
  for (let i = 1; i < count; i += 1) {
    const edge = shot.start + (duration * i) / count
    // Strictement croissantes : sur un plan très court, deux frontières
    // régulières peuvent tomber sur le même flottant, et un intervalle vide
    // disparaîtrait du cadrage sans disparaître de la partition.
    if (edge > edges[edges.length - 1] && edge < shot.end) edges.push(edge)
  }
  edges.push(shot.end)
  return edges.slice(0, -1).map((start, i) => ({
    start,
    end: edges[i + 1],
    keep: majorityKeep(frames, start, edges[i + 1]),
    mergedByOverlap: false,
  }))
}

// ---------------------------------------------------------------------------
// Le cadrage d'un plan subdivisé, et le garde-fou du faux raccord.
// ---------------------------------------------------------------------------

/** Un sous-plan cadré. `ratio` et `cropX` valent `null` hors du montage. */
type FramedSubShot = SubShot & {
  /**
   * Le ratio du sous-plan, ou `null` quand il ne touche aucun segment monté —
   * `computeFraming` ne le rend alors pas, et `inClipSeconds` vaut exactement 0
   * dans ce cas : `shotsForSegments` retient un plan sur un recouvrement
   * strictement positif, la même condition.
   */
  ratio: Ratio | null
  cropX: number | null
  inClipSeconds: number
}

/** Ce qu'on a préparé d'un plan avant de le subdiviser. */
type ShotWork = {
  shot: Shot
  /** Les images du plan, décidées, dans l'ordre du temps. */
  frames: FrameDecision[]
  /** Les segments montés qui touchent ce plan — le reste ne changerait rien. */
  segments: Segment[]
  /** L'intersection du plan avec le montage, en secondes. */
  inClipSeconds: number
}

type RatioLock = 'none' | 'shot'

/**
 * Le cadrage des sous-plans d'un plan, **par `computeFraming` et par lui seul**.
 *
 * Les boîtes passées sont celles que chaque sous-plan garde ; le reste est le
 * travail du cœur — le seuil de score, le filtre du premier plan, le tronc, la
 * marge, le choix du ratio et la position.
 *
 * `--ratio-lock shot` se pose ici, et pas plus tard : le ratio épinglé change la
 * largeur de la fenêtre, donc la position, donc ce que le garde-fou du faux
 * raccord voit.
 */
function framingOfSubShots(
  work: ShotWork,
  subShots: SubShot[],
  analysis: Analysis,
  ratioLock: RatioLock,
): FramedSubShot[] {
  const people: PersonBox[] = []
  for (const frame of work.frames) {
    const sub = subShots.find((s) => inInterval(frame.t, s.start, s.end))
    if (sub === undefined) continue
    for (const b of keptBoxesOf(frame, sub.keep)) people.push(b)
  }

  const base = {
    segments: work.segments,
    shots: subShots.map((s) => ({ start: s.start, end: s.end })),
    people,
    srcW: analysis.source.w,
    srcH: analysis.source.h,
    cropMode: 'auto' as const,
  }

  let framing = computeFraming({ ...base, ratio: 'auto' })
  if (ratioLock === 'shot' && framing.shots.length > 1) {
    const widest = framing.shots.reduce<Ratio>(
      (a, s) => (RATIOS[s.ratio] > RATIOS[a] ? s.ratio : a),
      framing.shots[0].ratio,
    )
    framing = computeFraming({ ...base, ratio: widest })
  }

  const byStart = new Map<number, ShotFraming>()
  for (const s of framing.shots) byStart.set(s.shot.start, s)

  return subShots.map((s) => {
    const framed = byStart.get(s.start)
    return {
      ...s,
      ratio: framed?.ratio ?? null,
      cropX: framed?.cropX ?? null,
      inClipSeconds: overlapSeconds(s, work.segments),
    }
  })
}

/** Le rectangle de crop d'un sous-plan, en fractions de largeur : `[x, x + w]`. */
function cropWindowOf(
  sub: FramedSubShot,
  analysis: Analysis,
): { x: number; width: number } | null {
  if (sub.ratio === null || sub.cropX === null) return null
  const width = ratioCoverage(sub.ratio, analysis.source.w, analysis.source.h)
  // Le bord gauche, borné dans l'image comme `cropRect` le fait — même calcul
  // que `costOf` dans `scripts/measure-ratios.ts`.
  return { x: bound(sub.cropX - width / 2, 0, Math.max(0, 1 - width)), width }
}

/**
 * La part de largeur commune à deux crops consécutifs, rapportée **au plus large
 * des deux**.
 *
 * Au plus large, et le contraire a été essayé puis mesuré : rapporté au plus
 * **étroit**, un 9:16 entièrement contenu dans le 16:9 voisin note 1,00, donc
 * franchit n'importe quel seuil, et **toute** coupe touchant un plan large est
 * refusée — 45 % du montage de `2026-05-31-nabla` fusionnait ainsi. Or ce
 * cas-là n'est pas un faux raccord : c'est le cut-in, on passe de la scène
 * entière à une seule personne, et le canevas passe de 31,6 % à 100 % de sa
 * hauteur. Le vrai faux raccord est deux cadres de **même taille au même
 * endroit**, et c'est ce que le rapport au plus large note à 1,00.
 */
function overlapFraction(
  a: FramedSubShot,
  b: FramedSubShot,
  analysis: Analysis,
): number | null {
  const one = cropWindowOf(a, analysis)
  const two = cropWindowOf(b, analysis)
  if (one === null || two === null) return null
  const common = Math.max(
    0,
    Math.min(one.x + one.width, two.x + two.width) - Math.max(one.x, two.x),
  )
  const widest = Math.max(one.width, two.width)
  return widest > 0 ? common / widest : null
}

/** La pire coupe interne, celle dont les deux crops se recouvrent le plus. */
function worstInternalOverlap(
  framed: FramedSubShot[],
  analysis: Analysis,
): { index: number; fraction: number } | null {
  let worst: { index: number; fraction: number } | null = null
  for (let i = 0; i + 1 < framed.length; i += 1) {
    const fraction = overlapFraction(framed[i], framed[i + 1], analysis)
    if (fraction === null) continue
    if (worst === null || fraction > worst.fraction) worst = { index: i, fraction }
  }
  return worst
}

/** Fusionne les sous-plans `i` et `i + 1` — et le fusionné garde tout le monde. */
function mergeAt(subShots: SubShot[], i: number): SubShot[] {
  const out = [...subShots]
  out.splice(i, 2, {
    start: subShots[i].start,
    end: subShots[i + 1].end,
    keep: 'all',
    mergedByOverlap: true,
  })
  return out
}

/**
 * Le cadrage du candidat, garde-fou du faux raccord compris.
 *
 * `--crop-overlap-max` : quand les crops de deux sous-plans consécutifs se
 * recouvrent de plus que cette part de leur largeur, **on ne coupe pas**. Une
 * coupe qui ne change pas d'axe ne se lit pas comme un changement d'axe, elle se
 * lit comme un faux raccord. Les deux intervalles fusionnent et gardent tout le
 * monde.
 *
 * La boucle refait le cadrage après chaque fusion, parce que fusionner change le
 * ratio et la position des deux côtés — donc ce que la coupe suivante vaut. Elle
 * termine : chaque passe retire au moins un sous-plan.
 */
function resolveWithGuard(
  work: ShotWork,
  subShots: SubShot[],
  analysis: Analysis,
  ratioLock: RatioLock,
  cropOverlapMax: number,
): FramedSubShot[] {
  let current = subShots
  for (let pass = 0; pass <= subShots.length; pass += 1) {
    const framed = framingOfSubShots(work, current, analysis, ratioLock)
    const worst = worstInternalOverlap(framed, analysis)
    if (worst === null || !(worst.fraction > cropOverlapMax)) return framed
    current = mergeAt(current, worst.index)
  }
  return framingOfSubShots(work, current, analysis, ratioLock)
}

// ---------------------------------------------------------------------------
// Les quatre variantes.
// ---------------------------------------------------------------------------

const VARIANT_KEYS = ['today', 'candidate', 'randomWho', 'evenCuts'] as const
type VariantKey = (typeof VARIANT_KEYS)[number]

/** Ce que chaque variante isole, imprimé en tête de sortie pour qu'on le relise. */
const VARIANT_LEGEND: Readonly<Record<VariantKey, string>> = {
  today: 'aucune subdivision, tout le monde — le comportement actuel',
  candidate: 'frontieres de la politique, gagnant de frontalite',
  randomWho: 'memes frontieres, rang TIRE AU SORT — temoin du choix',
  evenCuts:
    'coupes regulieres en meme nombre (avant garde-fou), gagnant de frontalite — temoin du placement',
}

type Config = {
  minHold: number
  switchFrames: number
  frontalMargin: number
  cropOverlapMax: number
  ratioLock: RatioLock
}

/** Les sous-plans du candidat, **avant** le garde-fou du faux raccord. */
function candidateIntervals(work: ShotWork, config: Config): SubShot[] {
  const keeps = smoothDecisions(work.frames, config.switchFrames)
  return enforceMinHold(intervalsFrom(work.frames, keeps, work.shot), config.minHold)
}

/**
 * Les quatre variantes d'un plan.
 *
 * **Chaque témoin ne change qu'une chose, et les deux jouent avec les mêmes
 * règles.**
 *
 * `randomWho` reprend *exactement* les frontières finales du candidat et ne
 * change que le rang suivi. Il n'est délibérément **pas** re-gardé : le
 * garde-fou a déjà tranché sur ces frontières-là, et le repasser sur des crops
 * différents les déplacerait — le témoin isolerait alors deux choses à la fois.
 * Ce qu'il coûte est mesuré et non caché : la colonne « faux raccords » du
 * tableau du rythme compte les coupes que le garde-fou aurait refusées à
 * `randomWho`.
 *
 * `evenCuts` part du **nombre de sous-plans que la politique a produits avant le
 * garde-fou**, les répartit régulièrement, puis **repasse le même garde-fou**.
 * C'est la construction parallèle : un témoin qui garderait des coupes que le
 * candidat refuse serait crédité d'un gain que la politique ne s'autorise pas —
 * et c'est précisément le genre de comparaison truquée que ce script existe pour
 * éviter.
 */
function runShotVariants(
  work: ShotWork,
  analysis: Analysis,
  config: Config,
  random: () => number,
): Record<VariantKey, FramedSubShot[]> {
  const wholeShot: SubShot[] = [
    { start: work.shot.start, end: work.shot.end, keep: 'all', mergedByOverlap: false },
  ]
  const beforeGuard = candidateIntervals(work, config)
  const candidate = resolveWithGuard(
    work,
    beforeGuard,
    analysis,
    config.ratioLock,
    config.cropOverlapMax,
  )

  // Un tirage par sous-plan qui suit un rang, dans l'ordre du temps. Les
  // sous-plans qui gardent tout le monde n'ont pas deux rangs entre lesquels
  // tirer : ils restent tels quels, sans quoi le témoin changerait aussi la
  // *couverture* de la règle et n'isolerait plus le seul choix.
  const randomWho: SubShot[] = candidate.map((s) =>
    s.keep === 'all' ? { ...s } : { ...s, keep: random() < 0.5 ? 0 : 1 },
  )

  return {
    today: framingOfSubShots(work, wholeShot, analysis, config.ratioLock),
    candidate,
    randomWho: framingOfSubShots(work, randomWho, analysis, config.ratioLock),
    evenCuts: resolveWithGuard(
      work,
      evenIntervals(work.shot, beforeGuard.length, work.frames),
      analysis,
      config.ratioLock,
      config.cropOverlapMax,
    ),
  }
}

// ---------------------------------------------------------------------------
// Ce qu'on compte.
// ---------------------------------------------------------------------------

type Tally = {
  /** Le temps de montage couvert, en secondes. Identique pour les quatre variantes. */
  seconds: number
  ratioSeconds: Map<Ratio, number>
  /** Les sous-plans qui touchent le montage. */
  subShots: number
  /** Les plans qui touchent le montage — la ligne de base des coupes. */
  parentShots: number
  /** La durée montée de chaque sous-plan, pour la distribution. */
  durations: number[]
  /** Les fois où la hauteur occupée du canevas change d'un sous-plan au suivant. */
  canvasChanges: number
  /** Les coupes internes dont les deux crops se recouvrent trop — les faux raccords. */
  falseCuts: number
  /** Personnes-images dont aucun point de tête n'est dans le cadre, **parmi les gardées**. */
  headsOutKept: number
  /** Images où au moins une tête gardée est dehors — celles qui font des secondes. */
  framesOutKept: number
  /** Les mêmes, **parmi les personnes délibérément écartées**. */
  headsOutDropped: number
  framesOutDropped: number
  /** Le temps monté des sous-plans qui gardent tout le monde. */
  fallbackSeconds: number
  /** Les images de repli, par cause. */
  causeFrames: Map<FallbackCause, number>
}

function emptyTally(): Tally {
  return {
    seconds: 0,
    ratioSeconds: new Map(MORE_NARROW_MORE_WIDE.map((r) => [r, 0])),
    subShots: 0,
    parentShots: 0,
    durations: [],
    canvasChanges: 0,
    falseCuts: 0,
    headsOutKept: 0,
    framesOutKept: 0,
    headsOutDropped: 0,
    framesOutDropped: 0,
    fallbackSeconds: 0,
    causeFrames: new Map(FALLBACK_CAUSES.map((c) => [c, 0])),
  }
}

function addTally(into: Tally, from: Tally): void {
  into.seconds += from.seconds
  for (const r of MORE_NARROW_MORE_WIDE) {
    into.ratioSeconds.set(r, (into.ratioSeconds.get(r) ?? 0) + (from.ratioSeconds.get(r) ?? 0))
  }
  into.subShots += from.subShots
  into.parentShots += from.parentShots
  into.durations.push(...from.durations)
  into.canvasChanges += from.canvasChanges
  into.falseCuts += from.falseCuts
  into.headsOutKept += from.headsOutKept
  into.framesOutKept += from.framesOutKept
  into.headsOutDropped += from.headsOutDropped
  into.framesOutDropped += from.framesOutDropped
  into.fallbackSeconds += from.fallbackSeconds
  for (const c of FALLBACK_CAUSES) {
    into.causeFrames.set(c, (into.causeFrames.get(c) ?? 0) + (from.causeFrames.get(c) ?? 0))
  }
}

/**
 * Une tête est-elle **hors** du rectangle ? Reprend point par point la méthode de
 * `costOf` dans `scripts/measure-ratios.ts` : nez, yeux, oreilles, confiance
 * comparée au seuil des points de tronc, hors cadre si aucun point lisible n'est
 * dedans.
 *
 * `null` quand aucun point de tête n'est lisible : **l'absence de tête détectée
 * n'est pas une tête hors cadre.**
 */
function headOutside(box: PersonBox, x: number, width: number): boolean | null {
  const k = box.k
  if (k === undefined) return null
  const threshold = FRAMING_DEFAULTS.torsoMinScore
  let seen = false
  for (const rank of HEAD_POINTS) {
    const px = k[rank * 3]
    if (!Number.isFinite(px) || !(k[rank * 3 + 2] >= threshold)) continue
    seen = true
    if (px >= x && px <= x + width) return false
  }
  return seen ? true : null
}

/** Ce qu'une variante donne sur une émission, plan par plan. */
function tallyOf(
  works: ShotWork[],
  framedByShot: FramedSubShot[][],
  analysis: Analysis,
  cropOverlapMax: number,
): Tally {
  const tally = emptyTally()
  /** La hauteur occupée du canevas, sous-plan par sous-plan, dans l'ordre du temps. */
  const canvasHeights: number[] = []

  for (const [i, work] of works.entries()) {
    const framed = framedByShot[i]
    if (work.inClipSeconds > 0) tally.parentShots += 1

    for (const [j, sub] of framed.entries()) {
      if (sub.inClipSeconds <= 0) continue
      tally.seconds += sub.inClipSeconds
      tally.subShots += 1
      tally.durations.push(sub.inClipSeconds)
      if (sub.ratio !== null) {
        tally.ratioSeconds.set(
          sub.ratio,
          (tally.ratioSeconds.get(sub.ratio) ?? 0) + sub.inClipSeconds,
        )
        canvasHeights.push(sizeInCanvas(sub.ratio, CANVAS).h)
      }
      if (sub.keep === 'all') tally.fallbackSeconds += sub.inClipSeconds

      // Le faux raccord : la coupe qui ouvre ce sous-plan, quand il en a une
      // à l'intérieur du plan.
      if (j > 0) {
        const fraction = overlapFraction(framed[j - 1], sub, analysis)
        if (fraction !== null && fraction > cropOverlapMax) tally.falseCuts += 1
      }

      const window = cropWindowOf(sub, analysis)
      const framesOutKept = new Set<number>()
      const framesOutDropped = new Set<number>()
      for (const frame of work.frames) {
        if (!frame.inMontage || !inInterval(frame.t, sub.start, sub.end)) continue

        // La ventilation des replis, image par image, dans les seuls sous-plans
        // qui gardent tout le monde. Une image dont la décision propre était un
        // rang y est comptée `absorbed` : ce n'est pas la règle qui a échoué,
        // c'est l'hystérésis ou `--min-hold` qui l'a lissée.
        if (sub.keep === 'all') {
          const cause: FallbackCause = sub.mergedByOverlap
            ? 'cropOverlap'
            : (frame.cause ?? 'absorbed')
          tally.causeFrames.set(cause, (tally.causeFrames.get(cause) ?? 0) + 1)
        }

        if (window === null) continue
        const key = Math.round(frame.t * 1000)
        for (const b of keptRetainedOf(frame, sub.keep)) {
          if (headOutside(b, window.x, window.width) === true) {
            tally.headsOutKept += 1
            framesOutKept.add(key)
          }
        }
        for (const b of droppedBoxesOf(frame, sub.keep)) {
          if (headOutside(b, window.x, window.width) === true) {
            tally.headsOutDropped += 1
            framesOutDropped.add(key)
          }
        }
      }
      tally.framesOutKept += framesOutKept.size
      tally.framesOutDropped += framesOutDropped.size
    }
  }

  for (let i = 1; i < canvasHeights.length; i += 1) {
    if (canvasHeights[i] !== canvasHeights[i - 1]) tally.canvasChanges += 1
  }

  return tally
}

// ---------------------------------------------------------------------------
// Le contrôle de partition.
// ---------------------------------------------------------------------------

type PartitionReport = { shots: number; subShots: number; faults: string[]; worstGap: number }

/**
 * Les sous-plans couvrent-ils leur plan **sans trou ni recouvrement** ?
 *
 * Vérifié, pas supposé : `analysis.json` porte le même contrôle et son
 * commentaire dit pourquoi — un trou fait disparaître des boîtes en silence,
 * un recouvrement les compte deux fois et élargit le cadre.
 */
function checkPartition(works: ShotWork[], framedByShot: FramedSubShot[][]): PartitionReport {
  const report: PartitionReport = { shots: 0, subShots: 0, faults: [], worstGap: 0 }
  for (const [i, work] of works.entries()) {
    const framed = framedByShot[i]
    report.shots += 1
    report.subShots += framed.length
    const note = (why: string): void => {
      if (report.faults.length < 10) {
        report.faults.push(`${work.shot.start.toFixed(3)} → ${work.shot.end.toFixed(3)} : ${why}`)
      }
    }
    if (framed.length === 0) {
      note('aucun sous-plan')
      continue
    }
    const head = Math.abs(framed[0].start - work.shot.start)
    const tail = Math.abs(framed[framed.length - 1].end - work.shot.end)
    report.worstGap = Math.max(report.worstGap, head, tail)
    if (head > TOLERANCE_PARTITION) note(`le premier sous-plan ne part pas du plan (${head})`)
    if (tail > TOLERANCE_PARTITION) note(`le dernier sous-plan ne finit pas au plan (${tail})`)
    for (let j = 1; j < framed.length; j += 1) {
      const gap = Math.abs(framed[j].start - framed[j - 1].end)
      report.worstGap = Math.max(report.worstGap, gap)
      if (gap > TOLERANCE_PARTITION) note(`trou ou recouvrement de ${gap} s à ${framed[j].start}`)
    }
    const sum = framed.reduce((n, s) => n + (s.end - s.start), 0)
    const drift = Math.abs(sum - (work.shot.end - work.shot.start))
    report.worstGap = Math.max(report.worstGap, drift)
    if (drift > TOLERANCE_PARTITION) note(`somme des durées décalée de ${drift} s`)
  }
  return report
}

// ---------------------------------------------------------------------------
// Chargement d'une émission.
// ---------------------------------------------------------------------------

type Show = {
  id: string
  analysis: Analysis
  /** L'union des segments des clips non écartés — « ce qui est publié ». */
  editedSegments: Segment[]
  editedSeconds: number
  /** Les plans qui touchent le montage, préparés une fois pour tous les réglages. */
  works: ShotWork[]
}

function loadShow(id: string, frontalMargin: number): Show | null {
  const file = analysisPath(id)
  if (!fs.existsSync(file)) {
    console.error(`${id} : pas d'analyse (${file}).`)
    return null
  }
  const analysis = lireAnalysis(file)
  const db = getDb()
  // Filtré par statut, jamais par nom : `scripts/measure-ratios.ts` et
  // `scripts/spike/addressable.ts` documentent déjà les deux `clip_verif_*` de
  // `2025-06-15-cqlp`, qui appartiennent bel et bien à cette émission. Une
  // convention de nommage dans un script de mesure se périme sans bruit.
  const clips = getClips(db, id).filter((c) => c.status !== 'discarded')
  const editedSegments = normalizeSegments(clips.flatMap((c) => c.segments))
  const editedSeconds = editedSegments.reduce((n, s) => n + (s.end - s.start), 0)

  const works: ShotWork[] = []
  for (const shot of analysis.shots) {
    const segments = editedSegments.filter(
      (s) => Math.min(shot.end, s.end) > Math.max(shot.start, s.start),
    )
    const inClipSeconds = overlapSeconds(shot, segments)
    if (inClipSeconds <= 0) continue
    works.push({
      shot,
      frames: frameDecisionsOf(analysis.boxes, shot, segments, frontalMargin),
      segments,
      inClipSeconds,
    })
  }

  return { id, analysis, editedSegments, editedSeconds, works }
}

/** Les quatre variantes d'une émission, plan par plan. */
function runShow(
  show: Show,
  config: Config,
  seed: number,
): Record<VariantKey, FramedSubShot[][]> {
  // Une graine décalée par le nom de l'émission : le tirage de `nabla` ne doit
  // pas dépendre de l'ordre dans lequel les autres passent sur la ligne de
  // commande, sinon deux exécutions « comparables » ne le sont plus.
  const random = createRandom((seed + hashOfString(show.id)) >>> 0)
  const out: Record<VariantKey, FramedSubShot[][]> = {
    today: [],
    candidate: [],
    randomWho: [],
    evenCuts: [],
  }
  for (const work of show.works) {
    const variants = runShotVariants(work, show.analysis, config, random)
    for (const key of VARIANT_KEYS) out[key].push(variants[key])
  }
  return out
}

// ---------------------------------------------------------------------------
// L'affichage.
// ---------------------------------------------------------------------------

/** La part du temps dont la sortie verticale **remplit le canevas**. */
function gainOf(tally: Tally): number {
  return tally.seconds > 0 ? (100 * (tally.ratioSeconds.get('9:16') ?? 0)) / tally.seconds : Number.NaN
}

/**
 * Le temps où `randomWho` a tiré **l'autre** rang que le candidat.
 *
 * **Le témoin ne vaut que s'il a été exercé.** Un tirage à pile ou face tombe
 * une fois sur deux sur le rang que le candidat aurait choisi, et sur ces
 * sous-plans-là les deux variantes rendent rigoureusement la même chose. Sans ce
 * chiffre, « `candidate` et `randomWho` donnent le même gain » se lit comme une
 * conclusion alors que ce pourrait être une tautologie — les deux ne se
 * distinguent que sur le temps compté ici.
 */
function disagreementSeconds(
  candidate: FramedSubShot[][],
  randomWho: FramedSubShot[][],
): number {
  let seconds = 0
  for (const [i, subs] of candidate.entries()) {
    for (const [j, sub] of subs.entries()) {
      const drawn = randomWho[i][j]
      if (drawn !== undefined && drawn.keep !== sub.keep) seconds += sub.inClipSeconds
    }
  }
  return seconds
}

function printPartition(reports: { id: string; report: PartitionReport }[]): void {
  console.log('\n=== La partition — les sous-plans couvrent-ils le plan, sans trou ni recouvrement ? ===')
  let ok = true
  for (const { id, report } of reports) {
    const verdict = report.faults.length === 0 ? 'exacte' : `${report.faults.length} DEFAUT(S)`
    console.log(
      `  ${id.padEnd(24)} ${String(report.shots).padStart(5)} plans montés,` +
        ` ${String(report.subShots).padStart(6)} sous-plans` +
        `  écart max ${report.worstGap.toExponential(1)} s  → ${verdict}`,
    )
    for (const f of report.faults) console.log(`      ${f}`)
    if (report.faults.length > 0) ok = false
  }
  console.log(`  ${ok ? 'Aucun trou, aucun recouvrement, sur toutes les variantes.' : 'PARTITION ROMPUE — les chiffres ci-dessous ne valent rien.'}`)
}

function printGain(label: string, tallies: Record<VariantKey, Tally>): void {
  console.log(`\n  ${label}`)
  console.log(
    `  variante     ${MORE_NARROW_MORE_WIDE.map((r) => r.padStart(15)).join(' ')}` +
      `   gain 9:16   montage`,
  )
  for (const key of VARIANT_KEYS) {
    const t = tallies[key]
    const cells = MORE_NARROW_MORE_WIDE.map((r) => {
      const secs = t.ratioSeconds.get(r) ?? 0
      return `${secs.toFixed(0)} s (${percent(secs, t.seconds)})`.padStart(15)
    }).join(' ')
    console.log(
      `  ${key.padEnd(11)}  ${cells}   ${number(gainOf(t)).padStart(6)} %` +
        `   ${t.seconds.toFixed(0).padStart(6)} s`,
    )
  }
}

function printRisk(label: string, tallies: Record<VariantKey, Tally>, step: number): void {
  console.log(`\n  ${label}`)
  console.log(
    '  variante     têtes dehors PARMI LES GARDÉES     têtes dehors parmi les ÉCARTÉES',
  )
  for (const key of VARIANT_KEYS) {
    const t = tallies[key]
    const kept = `${t.headsOutKept} pers-img (${number(t.framesOutKept * step)} s)`
    const dropped = `${t.headsOutDropped} pers-img (${number(t.framesOutDropped * step)} s)`
    console.log(`  ${key.padEnd(11)}  ${kept.padStart(30)}     ${dropped.padStart(30)}`)
  }
}

function printRhythm(label: string, tallies: Record<VariantKey, Tally>): void {
  console.log(`\n  ${label}`)
  console.log(
    '  variante     sous-plans  coupes ajoutées/min  canevas/min  faux raccords' +
      '   durées min / p10 / méd. / max',
  )
  for (const key of VARIANT_KEYS) {
    const t = tallies[key]
    const minutes = t.seconds / 60
    const added = t.subShots - t.parentShots
    const durations = t.durations
    const { min, max } = extremes(durations)
    console.log(
      `  ${key.padEnd(11)}  ${String(t.subShots).padStart(10)}` +
        `  ${number(minutes > 0 ? added / minutes : Number.NaN, 2).padStart(19)}` +
        `  ${number(minutes > 0 ? t.canvasChanges / minutes : Number.NaN, 2).padStart(11)}` +
        `  ${String(t.falseCuts).padStart(13)}` +
        `   ${number(min).padStart(5)} /` +
        ` ${number(percentile(durations, 0.1)).padStart(5)} /` +
        ` ${number(median(durations)).padStart(5)} /` +
        ` ${number(max).padStart(6)}`,
    )
  }
}

function printFallbacks(label: string, tallies: Record<VariantKey, Tally>, step: number): void {
  console.log(`\n  ${label}`)
  console.log(
    `  variante     repli      part   ` +
      FALLBACK_CAUSES.map((c) => CAUSE_LABELS[c].padStart(13)).join(' '),
  )
  for (const key of VARIANT_KEYS) {
    const t = tallies[key]
    const cells = FALLBACK_CAUSES.map((c) => {
      const secs = (t.causeFrames.get(c) ?? 0) * step
      return `${number(secs, 0)} s`.padStart(13)
    }).join(' ')
    console.log(
      `  ${key.padEnd(11)}  ${t.fallbackSeconds.toFixed(0).padStart(6)} s` +
        `  ${percent(t.fallbackSeconds, t.seconds).padStart(7)}   ${cells}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Le balayage.
// ---------------------------------------------------------------------------

const MIN_HOLDS_SWEEP: readonly number[] = [1, 2, 3, 4]
const RATIO_LOCKS_SWEEP: readonly RatioLock[] = ['none', 'shot']

/**
 * `--min-hold` × `--ratio-lock`, huit lignes sur le corpus, **variante
 * `candidate` seule**. Ce qu'on y lit : ce que chaque cran de confort coûte en
 * gain, et ce qu'il rend en têtes perdues.
 *
 * Les décisions par image ne dépendent que de `--frontal-margin` : elles sont
 * calculées une fois au chargement et réutilisées à chaque ligne, sans quoi le
 * balayage rappellerait `orientationOf` sur tout le corpus huit fois.
 */
function printSweep(shows: Show[], base: Config, seed: number): void {
  console.log('\n=== Balayage --min-hold × --ratio-lock — variante candidate, corpus ===')
  console.log(
    `  Les autres réglages restent à --switch-frames ${base.switchFrames},` +
      ` --frontal-margin ${base.frontalMargin}, --crop-overlap-max ${base.cropOverlapMax}.`,
  )
  console.log(
    '  min-hold  ratio-lock   gain 9:16   coupes ajoutées/min   canevas/min   têtes perdues (gardées)',
  )
  for (const minHold of MIN_HOLDS_SWEEP) {
    for (const ratioLock of RATIO_LOCKS_SWEEP) {
      const config: Config = { ...base, minHold, ratioLock }
      const total = emptyTally()
      let headSeconds = 0
      for (const show of shows) {
        const framed = runShow(show, config, seed).candidate
        const tally = tallyOf(show.works, framed, show.analysis, config.cropOverlapMax)
        addTally(total, tally)
        headSeconds += tally.framesOutKept * sampleStep(show.analysis)
      }
      const minutes = total.seconds / 60
      console.log(
        `  ${minHold.toFixed(0).padStart(8)}  ${ratioLock.padEnd(10)}` +
          `  ${number(gainOf(total)).padStart(8)} %` +
          `  ${number(minutes > 0 ? (total.subShots - total.parentShots) / minutes : Number.NaN, 2).padStart(20)}` +
          `  ${number(minutes > 0 ? total.canvasChanges / minutes : Number.NaN, 2).padStart(12)}` +
          `  ${`${total.headsOutKept} pers-img (${number(headSeconds)} s)`.padStart(24)}`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Le JSON — ce que le rendu A/B lira.
// ---------------------------------------------------------------------------

type JsonSubShot = {
  start: number
  end: number
  inClipSeconds: number
  ratio: Ratio | null
  cropX: number | null
  /** La décision retenue : `0`, `1` ou `"all"`. */
  keep: Keep
  /** Vrai quand l'intervalle est né d'une fusion imposée par `--crop-overlap-max`. */
  mergedByOverlap: boolean
}

type JsonShot = {
  start: number
  end: number
  inClipSeconds: number
  /** Le ratio d'aujourd'hui, celui du plan non subdivisé — la ligne de base de l'A/B. */
  ratioToday: Ratio | null
  cropXToday: number | null
  subShots: JsonSubShot[]
}

type JsonShow = { editedSeconds: number; shots: JsonShot[] }

/** Écriture atomique : fichier temporaire, puis renommage. */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = pathTemporary(file)
  await fsp.writeFile(temporary, JSON.stringify(data, null, 2))
  await fsp.rename(temporary, file)
}

// ---------------------------------------------------------------------------
// Ligne de commande.
// ---------------------------------------------------------------------------

/** Les drapeaux à valeur, pour retirer leur valeur des positionnels. */
const VALUE_FLAGS = [
  '--min-hold',
  '--switch-frames',
  '--frontal-margin',
  '--crop-overlap-max',
  '--ratio-lock',
  '--seed',
  '--json',
] as const

/**
 * Une suite de chiffres, entière ou décimale, ou `undefined` — jamais
 * `Number(raw)` seul, qui vaut 0 pour la chaîne vide et lit `"0x10"` comme
 * seize. Même principe que `parseSetting` dans `src/server/db.ts` : **une valeur
 * illisible est refusée, jamais remplacée par le défaut en silence.**
 */
function parseNumber(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined
  return Number(trimmed)
}

function parseRatioLock(raw: string): RatioLock | undefined {
  return raw === 'none' || raw === 'shot' ? raw : undefined
}

/** Un drapeau à valeur : présent ou non, et sa valeur brute si présent. */
function flagValue(args: string[], name: string): { present: boolean; raw: string | undefined } {
  const i = args.indexOf(name)
  return i < 0 ? { present: false, raw: undefined } : { present: true, raw: args[i + 1] }
}

/**
 * Un réglage numérique : son défaut si le drapeau est absent, sa valeur si elle
 * est lisible et acceptable, `undefined` sinon — et `undefined` fait échouer le
 * script au lieu de retomber sur le défaut.
 */
function numberSetting(
  args: string[],
  name: string,
  defaultValue: number,
  accept: (n: number) => boolean,
): number | undefined {
  const flag = flagValue(args, name)
  if (!flag.present) return defaultValue
  if (flag.raw === undefined) return undefined
  const parsed = parseNumber(flag.raw)
  return parsed !== undefined && accept(parsed) ? parsed : undefined
}

async function main(): Promise<number> {
  await chargerEnv()

  const args = process.argv.slice(2)
  const followerIndices = new Set<number>()
  for (const [i, a] of args.entries()) {
    if ((VALUE_FLAGS as readonly string[]).includes(a)) followerIndices.add(i + 1)
  }
  const positionals = args.filter((a, i) => !a.startsWith('--') && !followerIndices.has(i))
  const ids = positionals.length > 0 ? positionals : [...DEFAULT_SHOW_IDS]

  const minHold = numberSetting(args, '--min-hold', 2, (n) => n >= 0)
  if (minHold === undefined) {
    console.error(`--min-hold attend un nombre ≥ 0, reçu « ${String(flagValue(args, '--min-hold').raw)} ».`)
    return 1
  }
  const switchFrames = numberSetting(args, '--switch-frames', 3, (n) => n >= 1 && Number.isInteger(n))
  if (switchFrames === undefined) {
    console.error(
      `--switch-frames attend un entier ≥ 1, reçu « ${String(flagValue(args, '--switch-frames').raw)} ».`,
    )
    return 1
  }
  const frontalMargin = numberSetting(args, '--frontal-margin', 0.25, (n) => n >= 0 && n <= 1)
  if (frontalMargin === undefined) {
    console.error(
      `--frontal-margin attend un nombre dans [0, 1], reçu « ${String(flagValue(args, '--frontal-margin').raw)} ».`,
    )
    return 1
  }
  const cropOverlapMax = numberSetting(args, '--crop-overlap-max', 0.5, (n) => n >= 0 && n <= 1)
  if (cropOverlapMax === undefined) {
    console.error(
      `--crop-overlap-max attend un nombre dans [0, 1], reçu « ${String(flagValue(args, '--crop-overlap-max').raw)} ».`,
    )
    return 1
  }
  const seed = numberSetting(args, '--seed', 1, (n) => Number.isInteger(n) && n >= 0)
  if (seed === undefined) {
    console.error(`--seed attend un entier ≥ 0, reçu « ${String(flagValue(args, '--seed').raw)} ».`)
    return 1
  }

  const ratioLockFlag = flagValue(args, '--ratio-lock')
  const ratioLock = !ratioLockFlag.present
    ? 'none'
    : ratioLockFlag.raw === undefined
      ? undefined
      : parseRatioLock(ratioLockFlag.raw)
  if (ratioLock === undefined) {
    console.error(`--ratio-lock attend « none » ou « shot », reçu « ${String(ratioLockFlag.raw)} ».`)
    return 1
  }

  const jsonFlag = flagValue(args, '--json')
  if (jsonFlag.present && (jsonFlag.raw === undefined || jsonFlag.raw.startsWith('--'))) {
    console.error(`--json attend un chemin de fichier, reçu « ${String(jsonFlag.raw)} ».`)
    return 1
  }
  const jsonPath = jsonFlag.present ? jsonFlag.raw : undefined

  const config: Config = { minHold, switchFrames, frontalMargin, cropOverlapMax, ratioLock }

  try {
    const shows = ids.map((id) => loadShow(id, frontalMargin)).filter((s): s is Show => s !== null)
    if (shows.length === 0) return 1

    console.log(
      `Réglages : --min-hold ${minHold} s, --switch-frames ${switchFrames},` +
        ` --frontal-margin ${frontalMargin}, --crop-overlap-max ${cropOverlapMax},` +
        ` --ratio-lock ${ratioLock}, --seed ${seed} (score ≥ ${FRAMING_DEFAULTS.minScore})`,
    )
    for (const key of VARIANT_KEYS) console.log(`  ${key.padEnd(11)} ${VARIANT_LEGEND[key]}`)
    for (const show of shows) {
      console.log(
        `  ${show.id} : ${show.works.length} plans montés, ${show.editedSeconds.toFixed(0)} s de montage`,
      )
    }

    const results = shows.map((show) => ({ show, framed: runShow(show, config, seed) }))

    printPartition(
      results.flatMap(({ show, framed }) =>
        VARIANT_KEYS.map((key) => ({
          id: `${show.id} / ${key}`,
          report: checkPartition(show.works, framed[key]),
        })),
      ),
    )

    const tallies = results.map(({ show, framed }) => {
      const perVariant = {} as Record<VariantKey, Tally>
      for (const key of VARIANT_KEYS) {
        perVariant[key] = tallyOf(show.works, framed[key], show.analysis, cropOverlapMax)
      }
      return { show, perVariant }
    })

    const corpus = {} as Record<VariantKey, Tally>
    for (const key of VARIANT_KEYS) {
      corpus[key] = emptyTally()
      for (const { perVariant } of tallies) addTally(corpus[key], perVariant[key])
    }
    // Le pas d'échantillonnage du corpus : celui de la première émission, et un
    // avertissement si les autres en diffèrent — additionner des images de
    // cadences différentes rendrait des secondes fausses sans rien signaler.
    const steps = [...new Set(shows.map((s) => sampleStep(s.analysis)))]
    if (steps.length > 1) {
      console.log(`\n  ATTENTION : cadences d'analyse mélangées (${steps.join(', ')} s) — les secondes du corpus sont approximatives.`)
    }
    const corpusStep = steps[0]

    console.log('\n=== 1. Le gain — part du temps de montage dont le sous-plan remplit le canevas ===')
    let followedTotal = 0
    let disagreedTotal = 0
    for (const [i, { show, perVariant }] of tallies.entries()) {
      printGain(`${show.id} — montage ${show.editedSeconds.toFixed(0)} s`, perVariant)
      const followed = perVariant.candidate.seconds - perVariant.candidate.fallbackSeconds
      const disagreed = disagreementSeconds(results[i].framed.candidate, results[i].framed.randomWho)
      followedTotal += followed
      disagreedTotal += disagreed
      console.log(
        `    le candidat suit une seule personne sur ${followed.toFixed(0)} s ;` +
          ` randomWho y tire l'autre rang sur ${disagreed.toFixed(0)} s (${percent(disagreed, followed)})`,
      )
    }
    printGain('TOTAL CORPUS', corpus)
    console.log(
      `    le candidat suit une seule personne sur ${followedTotal.toFixed(0)} s ;` +
        ` randomWho y tire l'autre rang sur ${disagreedTotal.toFixed(0)} s (${percent(disagreedTotal, followedTotal)})`,
    )

    console.log('\n=== 2. Le risque — têtes hors du rectangle, en deux compteurs séparés ===')
    console.log('  Les gardées sont la seule faute réelle ; les écartées sont l’effet voulu.')
    for (const { show, perVariant } of tallies) {
      printRisk(show.id, perVariant, sampleStep(show.analysis))
    }
    printRisk('TOTAL CORPUS', corpus, corpusStep)

    console.log('\n=== 3. Le rythme et le confort ===')
    console.log(
      '  « canevas/min » compte les changements de hauteur occupée d’un sous-plan au suivant :' +
        ' c’est ce que --ratio-lock shot doit faire baisser.',
    )
    console.log(
      '  Les durées sont des durées **montées**, pas des durées de source : un sous-plan qu’une' +
        ' borne de segment traverse se lit plus court que --min-hold, et c’est bien ce que le' +
        ' spectateur voit.',
    )
    console.log(
      '  « faux raccords » compte les coupes que --crop-overlap-max aurait refusées. Nulle par' +
        ' construction chez `candidate` et `evenCuts`, qui passent le garde-fou ; chez `randomWho`,' +
        ' elle chiffre ce que coûte de garder les frontières du candidat en changeant de rang.',
    )
    for (const { show, perVariant } of tallies) printRhythm(show.id, perVariant)
    printRhythm('TOTAL CORPUS', corpus)

    console.log('\n=== 4. Les replis — « garder tout le monde », et pourquoi ===')
    console.log(
      '  La ventilation est en images, converties en secondes. « > 2 pers. » est la ligne qui' +
        ' porte la jaquette de DVD prise pour une personne.',
    )
    console.log(
      '  **La ligne `today` porte la ventilation brute** : elle garde tout le monde partout, donc' +
        ' elle ventile chaque image du montage par la cause qu’elle porte à elle seule, avant' +
        ' hystérésis et avant --min-hold. Les trois autres lignes ne ventilent que ce qui reste en' +
        ' repli après lissage, et leur colonne « absorbe » compte les images dont la règle avait' +
        ' pourtant tranché.',
    )
    for (const { show, perVariant } of tallies) {
      printFallbacks(show.id, perVariant, sampleStep(show.analysis))
    }
    printFallbacks('TOTAL CORPUS', corpus, corpusStep)

    if (jsonPath !== undefined) {
      const out: Record<string, JsonShow> = {}
      for (const { show, framed } of results) {
        out[show.id] = {
          editedSeconds: show.editedSeconds,
          shots: show.works.map((work, i) => ({
            start: work.shot.start,
            end: work.shot.end,
            inClipSeconds: work.inClipSeconds,
            ratioToday: framed.today[i][0]?.ratio ?? null,
            cropXToday: framed.today[i][0]?.cropX ?? null,
            subShots: framed.candidate[i].map((s) => ({
              start: s.start,
              end: s.end,
              inClipSeconds: s.inClipSeconds,
              ratio: s.ratio,
              cropX: s.cropX,
              keep: s.keep,
              mergedByOverlap: s.mergedByOverlap,
            })),
          })),
        }
      }
      await writeJsonAtomic(jsonPath, out)
      console.log(`\nJSON écrit : ${jsonPath} (variante candidate, plus le ratio d'aujourd'hui)`)
    }

    printSweep(shows, config, seed)

    return 0
  } finally {
    closeDb()
  }
}

void main().then(quit, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quit(1)
})
