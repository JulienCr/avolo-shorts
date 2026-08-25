/**
 * Le gisement du spike « qui parle » : combien de temps de montage pourrait
 * basculer d'un cadrage large à deux personnes vers un cadrage serré sur une
 * seule — celle qui s'adresse à la caméra.
 *
 *     pnpm tsx scripts/spike/addressable.ts <projectId…> [--min-shot 4]
 *       [--frontal-margin 0.25] [--unknown-veto shot] [--decisive-share 0.9]
 *       [--json <fichier>]
 *
 * Sans `projectId`, les quatre émissions du disque (`DEFAULT_SHOW_IDS`).
 *
 * **Ce script ne décide rien du cadrage.** Il mesure ce qu'un cadrage à une
 * personne *gagnerait* sur les plans que le cadrage automatique sort
 * aujourd'hui en 16:9 à deux personnes — sans jamais recalculer `chooseRatio`,
 * `isForeground` ou `personBounds` à sa façon : ce sont les seules autorités,
 * voir la skill `cadrage`.
 *
 * Sept sorties, dans l'ordre de la spécification :
 *
 * a. la grille temps × (nombre de personnes : 0, 1, 2, 3+) × (ratio) ;
 * b. le gisement du cas 1 — les plans à exactement deux personnes, en 16:9,
 *    d'au moins `--min-shot` secondes ;
 * c. le plafond du gain sur ce gisement : les deux rangs pris seuls
 *    donneraient-ils un 9:16, un seul, ou aucun ?
 * d. le gisement du cas 2 — l'orientation : la part de ce même gisement où une
 *    personne est nettement plus de face que l'autre, **au sens relatif**
 *    (l'écart entre les deux, jamais un seuil absolu — la spec §2 rappelle que
 *    les comédiens jouent de profil, face à face, donc un seuil absolu serait
 *    juste sur une interview et faux partout ailleurs) ;
 * e. le jeu d'évaluation auto-supervisé — le temps à exactement une personne
 *    sur l'émission **entière**, monté ou non ;
 * f. les dix plus longs plans de chaque gisement, pour nourrir un rendu A/B ;
 * g. `--json` : le même contenu, exploitable, par émission.
 *
 * **Une correction par rapport à la sonde jetable de Julien.** Elle calculait
 * le ratio d'un plan sur le plan entier ; celui-ci le calcule sur les boîtes
 * restreintes aux segments montés — c'est ce que `computeFraming` fait en
 * production, et mesurer sur autre chose décrirait un autre clip que celui
 * qui sort vraiment. Voir `analyzeShots` plus bas. La correction peut déplacer
 * des chiffres ; ce n'est pas une raison de les rapprocher des siens par un
 * autre biais.
 *
 * **Un second écart, découvert en écrivant ce script et pas anticipé par la
 * spécification** : la base contient deux clips de test, `clip_verif_1to1` et
 * `clip_verif_auto`, et ils **appartiennent bel et bien à `2025-06-15-cqlp`**
 * (`projectId` posé, statut `kept`, jamais écarté) — vérifié à la base, pas
 * supposé. `getClips(db, '2025-06-15-cqlp')` les rend donc, comme
 * `scripts/measure-ratios.ts` le documente déjà pour ses propres besoins et le
 * compte délibérément (« les vestiges de vérification, si »). Ce script suit
 * la même convention : il filtre `status !== 'discarded'`, jamais un nom de
 * clip, parce qu'une convention de nommage dans un script de mesure se périme
 * sans bruit. Les deux clips ajoutent 43,2 s et 30 s de segments à l'union
 * montée de `cqlp` — de quoi expliquer un écart de quelques dizaines de
 * secondes sur cette seule émission.
 *
 * **Une extension, ajoutée le 20 août 2026** pour répondre à une question
 * précise : sur le gisement du cas 2, la règle d'orientation a quatre
 * conditions (écart décisif sur au moins 90 % des images à deux personnes,
 * même rang gagnant partout, perdant jamais `unknown`, retirer le perdant
 * change le ratio), et une bonne partie du gisement du cas 1 les échoue sans
 * qu'on sache laquelle. Trois ajouts, tous après la section d :
 *
 * - une **ventilation des rejets** par catégorie, dans l'ordre où elles sont
 *   testées (`noGap`, `unknownVeto`, `winnerFlips`, `shareTooLow`,
 *   `ratioUnchanged`) — voir `classifyRejection` ;
 * - deux options pour desserrer une condition à la fois sans toucher au
 *   défaut, `--unknown-veto` et `--decisive-share` — voir `shotPasses` ;
 * - un **balayage** des huit combinaisons, affiché en dernier, chacune
 *   accompagnée du temps où la tête du rang perdant tomberait hors du
 *   rectangle de crop si on l'écartait de l'empan — voir `printSweep`. Le
 *   calcul de risque reprend la méthode de `costOf` dans
 *   `scripts/measure-ratios.ts` (tête = points COCO de `TORSOS.head`, hors
 *   cadre si aucun n'est dedans), mais passe par `headBounds`, qui n'existait
 *   pas encore quand `measure-ratios.ts` a été écrit.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { normalizeSegments } from '@/core/edl'
import type { Ratio, Segment } from '@/core/edl'
import {
  FRAMING_DEFAULTS,
  RATIOS,
  chooseRatio,
  computeFraming,
  cropRect,
  headBounds,
  isForeground,
  orientationOf,
  personBounds,
} from '@/core/framing'
import type { PersonBox, Shot } from '@/core/shots'
import { pathTemporary } from '@/server/ffmpeg'
import { closeDb, getClips, getDb } from '@/server/db'
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
 * Les quatre ratios du plus étroit au plus large, déduits de `RATIOS` — la
 * même construction que `scripts/measure-ratios.ts`, dupliquée plutôt
 * qu'importée : `MORE_NARROW_MORE_WIDE` est privée à `framing.ts`, et un ordre
 * d'affichage n'est pas un calcul de cadrage.
 */
const MORE_NARROW_MORE_WIDE = (Object.keys(RATIOS) as Ratio[]).sort((a, b) => RATIOS[a] - RATIOS[b])

/** La part d'images « décisives » qu'exige la condition 1 de la règle d'orientation, par défaut. */
const DEFAULT_DECISIVE_SHARE = 0.9

/** Comment la condition 3 (le perdant n'est jamais `unknown`) s'applique — voir `shotPasses`. */
type UnknownVetoMode = 'shot' | 'frame'

/** Le défaut de `--unknown-veto`, et le seul comportement d'avant cette extension. */
const DEFAULT_UNKNOWN_VETO_MODE: UnknownVetoMode = 'shot'

/**
 * La médiane, au sens strict : sur un compte pair, le milieu des deux
 * centrales. Dupliquée depuis `framing.ts`/`measure-ratios.ts`, comme eux :
 * chaque script de mesure garde la sienne plutôt que d'exporter une primitive
 * de calcul depuis un module de cadrage.
 */
function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const m = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

/** `t` tombe-t-il dans l'intervalle ? Fin exclue, comme `inInterval` de `framing.ts`. */
function inInterval(t: number, start: number, end: number): boolean {
  return t >= start && t < end
}

/**
 * La grille réelle d'échantillonnage sur `[start, end)`, en secondes, arrondie
 * au même pas que `worker/detect.py` (3 décimales).
 *
 * Issue #174 : une image sans détection n'a aucune entrée dans `analysis.boxes`,
 * donc un regroupement qui n'énumère que les boîtes la rend invisible plutôt
 * que nulle. Énumérer `k / fps` couvre les trous.
 */
function gridTimestamps(start: number, end: number, fps: number): number[] {
  if (!(fps > 0) || !(end > start)) return []
  // Bornes en `k` élargies d'un cran : une frontière de plan qui tombe pile sur
  // un pas de grille peut voir `k / fps` s'arrondir de l'autre côté que le `t`
  // stocké dans `analysis.boxes`. La membership se décide donc sur le
  // timestamp arrondi, pas sur les bornes non arrondies.
  const firstK = Math.floor(start * fps) - 1
  const lastK = Math.ceil(end * fps) + 1
  const out: number[] = []
  for (let k = Math.max(0, firstK); k <= lastK; k += 1) {
    const t = Math.round((k / fps) * 1000) / 1000
    if (t >= start && t < end) out.push(t)
  }
  return out
}

function number(n: number, decimals = 1): string {
  return Number.isFinite(n) ? n.toFixed(decimals) : '—'
}

function percent(part: number, total: number): string {
  return total > 0 ? `${((100 * part) / total).toFixed(1)} %` : '—'
}

/** L'abscisse du centre de `personBounds` — le repère sur lequel le rang se départage. */
function centerOf(box: PersonBox): number {
  const bounds = personBounds(box)
  return (bounds.x0 + bounds.x1) / 2
}

// ---------------------------------------------------------------------------
// Le cadrage d'un plan, restreint au montage : une ligne par plan monté.
// ---------------------------------------------------------------------------

/** Une image à deux personnes retenues, ordonnée gauche/droite. */
type TwoPersonFrame = { left: PersonBox; right: PersonBox }

/**
 * Ce qu'on sait d'un plan une fois restreint à un ensemble de segments.
 *
 * `ratio`, `ratioIfRank0` et `ratioIfRank1` viennent tous de `chooseRatio` —
 * jamais recalculés à la main. `typicalPeople`, `peopleBucket` et le rang
 * gauche/droite sont, eux, propres à ce spike : ils ne décident d'aucun
 * cadrage, ils le *caractérisent*.
 */
type ShotRecord = {
  shot: Shot
  /** L'intersection du plan avec les segments passés à `analyzeShots`, en secondes. */
  inClipSeconds: number
  /** Le ratio du plan, boîtes restreintes aux segments — la correction du point 3. */
  ratio: Ratio
  /** La médiane, par image, du nombre de boîtes retenues (score et premier plan filtrés). */
  typicalPeople: number
  /** `typicalPeople` rangé dans une case à 4 valeurs, 3 voulant dire « 3 ou plus ». */
  peopleBucket: 0 | 1 | 2 | 3
  /** Le ratio qu'on obtiendrait en ne suivant que le rang 0 (gauche) sur les images à deux personnes. */
  ratioIfRank0: Ratio
  /** Le même, pour le rang 1 (droite). */
  ratioIfRank1: Ratio
  /** Le nombre d'images à exactement deux personnes retenues dans ce plan. */
  twoPersonFrameCount: number
  /** La fraction des images à deux personnes qui ont un écart de frontalité net et lisible (condition 1). */
  decisiveFraction: number
  /**
   * Condition 2, seule : vrai si, sur les images décisives, les deux rangs ont
   * chacun gagné au moins une fois — auquel cas aucun rang n'est « le »
   * gagnant. Sert à distinguer, dans la ventilation des rejets, un plan qui
   * bascule d'un plan qui n'a simplement pas assez d'images décisives.
   */
  hasFlip: boolean
  /**
   * Le rang qui gagne systématiquement sur les images décisives (condition 2
   * seule, **jamais** couplée à la part décisive de la condition 1 — c'est ce
   * découplage qui permet à `shotPasses` de tester les quatre conditions
   * indépendamment). `null` si aucun rang ne gagne partout, ou si aucune
   * image n'est décisive.
   */
  consistentWinner: 0 | 1 | null
  /**
   * Condition 3 : vrai si, sur **toutes** les images à deux personnes du plan
   * (décisives ou non), le rang perdant de `consistentWinner` n'est jamais
   * `'unknown'`. Calculé dès que `consistentWinner` est connu — indépendamment
   * de la condition 1, contrairement à l'ancienne version de ce champ qui ne
   * se calculait que si les conditions 1 et 2 tenaient déjà ensemble.
   * `false` par défaut quand `consistentWinner` vaut `null` : sans gagnant,
   * la question n'a pas de sens.
   */
  loserNeverUnknown: boolean
  /**
   * Le nombre d'images à deux personnes où le rang perdant de
   * `consistentWinner` est `'unknown'` — 0 si `loserNeverUnknown` est vrai.
   * Sert au chiffre médian de la ventilation des rejets : combien d'images
   * `unknown` ont suffi à faire jouer la condition 3.
   */
  unknownVetoFrameCount: number
  /** Le nombre d'images à deux personnes où au moins un des deux rangs est `'unknown'`. */
  unknownFrameCount: number
  /** La frontalité médiane du rang 0, sur les images où elle est connue. `null` si jamais connue. */
  medianFrontalityRank0: number | null
  /** La même, pour le rang 1. */
  medianFrontalityRank1: number | null
  /**
   * Le compteur de risque : combien d'images à deux personnes verraient la
   * tête du rang perdant de `consistentWinner` **entièrement** hors du
   * rectangle de crop si on écartait ce perdant de l'empan et qu'on cadrait
   * sur le seul gagnant, à `ratioIfRank0`/`ratioIfRank1`. 0 si
   * `consistentWinner` vaut `null`, si retirer le perdant ne change pas le
   * ratio (16:9 inchangé — un tel plan ne peut de toute façon jamais entrer
   * dans le gisement du cas 2, quel que soit le réglage), ou si l'appelant a
   * passé `computeRisk: false` à `analyzeShots`.
   *
   * Indépendant de `--decisive-share` et `--unknown-veto` : ceux-ci décident
   * *quels* plans passent, celui-ci mesure ce que passer coûterait au
   * perdant, une fois pour toutes par plan.
   */
  riskFrameCount: number
}

/**
 * Le cadrage de chaque plan de l'analyse, restreint à `segments`.
 *
 * **Le même appel sert deux usages.** Pour le montage (sections a à d, f, g),
 * `segments` est l'union des segments de clips. Pour le jeu d'évaluation
 * (section e), `segments` vaut `[{ start: 0, end: durée }]` — l'émission
 * entière comptée comme si elle était montée en un seul segment, ce qu'elle
 * est du point de vue de cette fonction : `inClipSeconds` retombe alors sur la
 * durée pleine du plan.
 *
 * Un plan qui ne touche aucun segment ne rend rien : c'est le point 2 de la
 * spécification, « un plan qui n'en touche aucun ne compte pas ».
 *
 * `computeRisk` gouverne le seul calcul qui appelle `computeFraming` — le
 * compteur de risque de `riskFrameCount`. Le jeu d'évaluation (section e) n'en
 * a aucun usage : lui passer `false` évite un appel par plan qualifié sur
 * l'émission entière, pour un résultat que personne ne lit.
 */
function analyzeShots(
  analysis: Analysis,
  segments: Segment[],
  frontalMargin: number,
  computeRisk = true,
): ShotRecord[] {
  const segs = normalizeSegments(segments)
  const { w: srcW, h: srcH } = analysis.source
  const out: ShotRecord[] = []

  for (const shot of analysis.shots) {
    const inClipSeconds = segs.reduce(
      (n, s) => n + Math.max(0, Math.min(shot.end, s.end) - Math.max(shot.start, s.start)),
      0,
    )
    if (inClipSeconds <= 0) continue

    // Restreintes au plan et aux segments montés — la correction du point 3.
    // Non filtrées par score ni par premier plan : c'est le travail de
    // `chooseRatio` lui-même, via sa propre `spans()` interne.
    const inShot = analysis.boxes.filter(
      (b) => inInterval(b.t, shot.start, shot.end) && segs.some((s) => inInterval(b.t, s.start, s.end)),
    )
    const ratio = chooseRatio(inShot, srcW, srcH)

    // Les boîtes retenues, **filtrées ici et à la main** : c'est le point 4
    // de la spécification, une population différente de celle que
    // `chooseRatio` filtre en interne pour son propre usage — bien qu'elles se
    // recoupent presque entièrement, `chooseRatio` n'expose pas la sienne.
    const retained = inShot.filter((b) => b.score >= FRAMING_DEFAULTS.minScore && !isForeground(b))
    const byFrame = new Map<number, PersonBox[]>()
    for (const b of retained) {
      const key = Math.round(b.t * 1000)
      const already = byFrame.get(key)
      if (already) already.push(b)
      else byFrame.set(key, [b])
    }
    // La grille réelle, restreinte au montage comme `inShot` — une image sans
    // détection vaut 0, elle ne disparaît pas (issue #174).
    const ticks = gridTimestamps(shot.start, shot.end, analysis.fps).filter((t) =>
      segs.some((s) => inInterval(t, s.start, s.end)),
    )
    const counts = ticks.map((t) => byFrame.get(Math.round(t * 1000))?.length ?? 0)
    // Un plan sans aucune image dans le montage vaut 0, pas « inconnu » :
    // c'est la réponse honnête à « combien de personnes, typiquement ? ».
    const typicalPeople = counts.length === 0 ? 0 : median(counts)
    // Le classement en case est un arrondi au plus proche, pas un seuil
    // inclusif comparé à une valeur notée (CLAUDE.md) : il n'y a ici aucune
    // décision binaire qu'un `0,4996` pourrait faire basculer à tort, juste
    // quatre catégories d'affichage dont on choisit la plus proche.
    const peopleBucket = Math.min(3, Math.max(0, Math.round(typicalPeople))) as 0 | 1 | 2 | 3

    // Le rang gauche/droite, sur les seules images à *exactement* deux
    // personnes retenues. **Même parade que `collective_shift` dans
    // `worker/detect.py`** : une translation préserve l'ordre gauche-droite,
    // donc trier par abscisse suffit à apparier ; et elle casse pareillement
    // si les deux personnes se croisent — rien ici ne suit une identité d'une
    // image à l'autre, seul le rang instantané compte.
    const twoPersonFrames: TwoPersonFrame[] = []
    for (const boxes of byFrame.values()) {
      if (boxes.length !== 2) continue
      const [a, b] = [...boxes].sort((x, y) => centerOf(x) - centerOf(y))
      twoPersonFrames.push({ left: a, right: b })
    }

    const ratioIfRank0 = chooseRatio(
      twoPersonFrames.map((f) => f.left),
      srcW,
      srcH,
    )
    const ratioIfRank1 = chooseRatio(
      twoPersonFrames.map((f) => f.right),
      srcW,
      srcH,
    )

    const orientations = twoPersonFrames.map((f) => ({
      left: orientationOf(f.left),
      right: orientationOf(f.right),
    }))

    let decisiveCount = 0
    let winner0 = 0
    let winner1 = 0
    let unknownFrameCount = 0
    for (const o of orientations) {
      if (o.left.facing === 'unknown' || o.right.facing === 'unknown') unknownFrameCount += 1
      // La règle est relative, jamais absolue (point d de la spécification) :
      // ce qui compte est l'écart entre les deux frontalités de cette
      // image-là, pas la position de chacune contre un seuil fixe.
      if (o.left.frontality === null || o.right.frontality === null) continue
      const gap = Math.abs(o.left.frontality - o.right.frontality)
      if (!(gap > frontalMargin)) continue
      decisiveCount += 1
      if (o.left.frontality > o.right.frontality) winner0 += 1
      else winner1 += 1
    }
    const decisiveFraction = orientations.length === 0 ? 0 : decisiveCount / orientations.length
    const hasFlip = winner0 > 0 && winner1 > 0
    let consistentWinner: 0 | 1 | null = null
    if (winner0 > 0 && winner1 === 0) consistentWinner = 0
    else if (winner1 > 0 && winner0 === 0) consistentWinner = 1

    // « unknown n'exclut jamais personne » (CLAUDE.md, absence d'information
    // contre ambiguïté) : condition 3, testée à part de la condition 1. Une
    // seule image où on ignore l'orientation du perdant suffit à retirer la
    // garantie — la certitude « il est nettement moins de face » ne tient pas
    // si, ailleurs dans le même plan, on ne sait tout simplement pas.
    let loserNeverUnknown = false
    let unknownVetoFrameCount = 0
    if (consistentWinner !== null) {
      const loserIsLeft = consistentWinner === 1
      for (const o of orientations) {
        if ((loserIsLeft ? o.left : o.right).facing === 'unknown') unknownVetoFrameCount += 1
      }
      loserNeverUnknown = unknownVetoFrameCount === 0
    }

    const knownLeft = orientations.map((o) => o.left.frontality).filter((f): f is number => f !== null)
    const knownRight = orientations.map((o) => o.right.frontality).filter((f): f is number => f !== null)

    // Le compteur de risque. Voir la doc du champ sur `ShotRecord` : il ne
    // dépend ni de `--decisive-share` ni de `--unknown-veto`, seulement de
    // l'identité du gagnant et de si retirer le perdant change le ratio —
    // sinon ce plan n'entrera jamais dans le gisement du cas 2, à aucun
    // réglage du balayage, et le calcul ne servirait à rien.
    let riskFrameCount = 0
    if (computeRisk && consistentWinner !== null) {
      const ratioIfWinner = consistentWinner === 0 ? ratioIfRank0 : ratioIfRank1
      if (ratioIfWinner !== '16:9') {
        const winnerBoxes = twoPersonFrames.map((f) => (consistentWinner === 0 ? f.left : f.right))
        // `computeFraming` est l'autorité pour le crop d'un plan — `shotCrop`,
        // qui le calcule vraiment, est privée à `framing.ts`. Le ratio est
        // épinglé à `ratioIfWinner` : c'est déjà celui que `chooseRatio` a
        // rendu sur ces mêmes boîtes juste au-dessus, et l'épingler évite de
        // le laisser recalculer une seconde fois ce qui pourrait diverger
        // d'un bit flottant.
        const framing = computeFraming({
          segments: segs,
          shots: [shot],
          people: winnerBoxes,
          srcW,
          srcH,
          ratio: ratioIfWinner,
          cropMode: 'auto',
        })
        const shotFraming = framing.shots[0]
        if (shotFraming !== undefined) {
          const rect = cropRect(ratioIfWinner, shotFraming.cropX, srcW, srcH)
          const cropLo = rect.x / srcW
          const cropHi = (rect.x + rect.w) / srcW
          for (const f of twoPersonFrames) {
            const loserBox = consistentWinner === 0 ? f.right : f.left
            // `headBounds` rend l'étendue des points de tête confiants, ou
            // `null` si aucun n'est lisible — une tête non détectée n'est pas
            // une tête hors cadre (même doctrine que `costOf` dans
            // `scripts/measure-ratios.ts`).
            const head = headBounds(loserBox)
            if (head === null) continue
            // Hors cadre si l'étendue entière tombe d'un côté ou de l'autre du
            // rectangle — l'équivalent, via la primitive exportée, du test
            // point par point de `costOf` : les points de tête sont groupés
            // sur une largeur bien plus étroite que n'importe quel rectangle
            // de crop de ce dépôt (31,6 % de la source au plus serré), donc
            // les deux méthodes ne peuvent diverger que si le rectangle entier
            // tenait entre les points extrêmes de la tête — inatteignable ici.
            if (head.x1 < cropLo || head.x0 > cropHi) riskFrameCount += 1
          }
        }
      }
    }

    out.push({
      shot,
      inClipSeconds,
      ratio,
      typicalPeople,
      peopleBucket,
      ratioIfRank0,
      ratioIfRank1,
      twoPersonFrameCount: twoPersonFrames.length,
      decisiveFraction,
      hasFlip,
      consistentWinner,
      loserNeverUnknown,
      unknownVetoFrameCount,
      unknownFrameCount,
      medianFrontalityRank0: knownLeft.length === 0 ? null : median(knownLeft),
      medianFrontalityRank1: knownRight.length === 0 ? null : median(knownRight),
      riskFrameCount,
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// La règle d'orientation : quatre conditions, testables indépendamment.
// ---------------------------------------------------------------------------

/** Le résultat de classement d'un plan du gisement 1 pour la section d. */
type OrientationVerdict = 'core' | 'netNoGain' | 'none'

/**
 * Les quatre conditions de la règle, dans l'ordre où `shotPasses` les teste —
 * qui n'est **pas** l'ordre de priorité de `classifyRejection` ci-dessous.
 *
 * 1. `decisiveFraction` atteint `decisiveShare` ;
 * 2. `consistentWinner` n'est pas `null` (pas de bascule de gagnant) ;
 * 3. `loserNeverUnknown`, sauf en mode `'frame'` où cette condition est
 *    retirée : une image `unknown` devient simplement non décisive au lieu de
 *    disqualifier tout le plan (`--unknown-veto frame`) ;
 * 4. retirer le perdant change le ratio (il ne reste pas 16:9).
 */
function orientationVerdict(
  p: ShotRecord,
  decisiveShare: number,
  unknownVetoMode: UnknownVetoMode,
): OrientationVerdict {
  if (p.consistentWinner === null) return 'none'
  if (!(p.decisiveFraction >= decisiveShare)) return 'none'
  if (unknownVetoMode === 'shot' && !p.loserNeverUnknown) return 'none'
  const ratioIfWinner = p.consistentWinner === 0 ? p.ratioIfRank0 : p.ratioIfRank1
  // Le plan est déjà en 16:9 (condition du gisement 1) : le ratio change si,
  // et seulement si, retirer la perdante ne rend plus le 16:9.
  return ratioIfWinner !== '16:9' ? 'core' : 'netNoGain'
}

/** Un plan entre-t-il dans le gisement du cas 2, à ce réglage ? */
function shotPasses(p: ShotRecord, decisiveShare: number, unknownVetoMode: UnknownVetoMode): boolean {
  return orientationVerdict(p, decisiveShare, unknownVetoMode) === 'core'
}

/**
 * Les cinq catégories de rejet, **dans l'ordre où elles sont testées** — un
 * plan peut échouer sur plusieurs conditions à la fois, et c'est l'ordre qui
 * décide de sa case. Cet ordre n'est pas celui des quatre conditions
 * (1, 2, 3, 4) : c'est celui que Julien a demandé, pensé pour isoler d'abord
 * les rejets « légitimes » (`noGap`, qui n'a jamais été un candidat), puis la
 * condition 3 spécifiquement (`unknownVeto`, parce que c'est elle qu'on
 * soupçonne), avant de retomber sur 2, 1 puis 4.
 */
const REJECTION_CATEGORIES = ['noGap', 'unknownVeto', 'winnerFlips', 'shareTooLow', 'ratioUnchanged'] as const
type RejectionCategory = (typeof REJECTION_CATEGORIES)[number]

/**
 * Pourquoi un plan du gisement du cas 1 n'est pas retenu au cas 2, à ce
 * réglage. N'appeler que sur un plan qui échoue déjà `shotPasses` au même
 * réglage — cette fonction ne revérifie pas l'inverse.
 */
function classifyRejection(
  p: ShotRecord,
  frontalMargin: number,
  decisiveShare: number,
  unknownVetoMode: UnknownVetoMode,
): RejectionCategory {
  // noGap : l'écart médian entre les deux rangs ne dépasse pas la marge — ce
  // plan n'a jamais été un candidat. `!(gap > marge)` et non `gap <= marge`,
  // comme partout ailleurs ici : un écart introuvable (une des deux médianes
  // jamais connue) doit tomber du côté « pas d'écart », pas être traité comme
  // un écart nul qui se compare quand même.
  const gap =
    p.medianFrontalityRank0 !== null && p.medianFrontalityRank1 !== null
      ? Math.abs(p.medianFrontalityRank0 - p.medianFrontalityRank1)
      : Number.NaN
  if (!(gap > frontalMargin)) return 'noGap'

  // unknownVeto : la condition 3 seule le rejette — desserrer uniquement
  // elle (mode `'frame'`) le ferait passer, les conditions 1, 2 et 4 tenant
  // déjà. En mode `'frame'`, la condition 3 ne bloque jamais rien : cette
  // catégorie ne peut alors jamais s'appliquer, ce qui est le comportement
  // voulu.
  const ratioIfWinner = p.consistentWinner === null ? null : p.consistentWinner === 0 ? p.ratioIfRank0 : p.ratioIfRank1
  const wouldPassWithoutUnknownVeto =
    p.consistentWinner !== null && p.decisiveFraction >= decisiveShare && ratioIfWinner !== '16:9'
  const blockedByUnknown = unknownVetoMode === 'shot' && !p.loserNeverUnknown
  if (wouldPassWithoutUnknownVeto && blockedByUnknown) return 'unknownVeto'

  // winnerFlips : condition 2, le gagnant bascule en cours de plan.
  if (p.hasFlip) return 'winnerFlips'

  // shareTooLow : condition 1, la part d'images décisives n'atteint pas le
  // seuil — qu'il y ait un gagnant consistant (mais rare) ou aucune image
  // décisive du tout (part nulle, qui échoue le seuil trivialement).
  if (!(p.decisiveFraction >= decisiveShare)) return 'shareTooLow'

  // ratioUnchanged : tout le reste tient, condition 4 seule échoue.
  return 'ratioUnchanged'
}

// ---------------------------------------------------------------------------
// Chargement d'une émission.
// ---------------------------------------------------------------------------

type Show = {
  id: string
  analysis: Analysis
  totalDuration: number
  /** L'union des segments des clips non écartés — le dénominateur, « ce qui est publié ». */
  editedSegments: Segment[]
  editedSeconds: number
  /** Le cadrage par plan, restreint au montage. */
  shots: ShotRecord[]
  /** Le même calcul, sur l'émission entière — sert uniquement à la section e. */
  wholeShowShots: ShotRecord[]
}

function loadShow(id: string, frontalMargin: number): Show | null {
  const file = analysisPath(id)
  if (!fs.existsSync(file)) {
    console.error(`${id} : pas d'analyse (${file}).`)
    return null
  }
  const analysis = lireAnalysis(file)
  const db = getDb()
  // Ce qui est publié, pas ce qui est tourné : les clips écartés ne sortiront
  // jamais. Filtré par statut, jamais par nom — voir le commentaire d'en-tête
  // sur `clip_verif_1to1` et `clip_verif_auto`, qui appartiennent bel et bien
  // à `2025-06-15-cqlp` et que ce filtre-ci laisse donc passer, comme le fait
  // déjà `scripts/measure-ratios.ts`.
  const clips = getClips(db, id).filter((c) => c.status !== 'discarded')
  const editedSegments = normalizeSegments(clips.flatMap((c) => c.segments))
  const editedSeconds = editedSegments.reduce((n, s) => n + (s.end - s.start), 0)
  const totalDuration = analysis.shots.at(-1)?.end ?? 0

  return {
    id,
    analysis,
    totalDuration,
    editedSegments,
    editedSeconds,
    shots: analyzeShots(analysis, editedSegments, frontalMargin),
    // Le compteur de risque ne sert qu'au gisement du cas 2, calculé sur le
    // montage : lui passer `false` ici évite un `computeFraming` par plan
    // qualifié sur l'émission entière, pour un résultat que la section e ne
    // lit jamais.
    wholeShowShots: analyzeShots(analysis, [{ start: 0, end: totalDuration }], frontalMargin, false),
  }
}

// ---------------------------------------------------------------------------
// a. La grille : temps de plan par nombre de personnes × ratio.
// ---------------------------------------------------------------------------

function printGrid(shows: Show[]): void {
  console.log('\n=== a. La grille — temps de plan par nombre de personnes × ratio ===')
  const totals = new Map<string, number>()
  let totalEditedSeconds = 0

  const printBlock = (label: string, shots: ShotRecord[], editedSeconds: number): void => {
    console.log(`\n  ${label} — montage ${editedSeconds.toFixed(0)} s`)
    console.log(`  personnes  ${MORE_NARROW_MORE_WIDE.map((r) => r.padStart(14)).join(' ')}`)
    for (const bucket of [0, 1, 2, 3] as const) {
      const cells = MORE_NARROW_MORE_WIDE.map((r) => {
        const secs = shots
          .filter((p) => p.peopleBucket === bucket && p.ratio === r)
          .reduce((n, p) => n + p.inClipSeconds, 0)
        return `${secs.toFixed(0)} s (${percent(secs, editedSeconds)})`.padStart(14)
      }).join(' ')
      console.log(`  ${(bucket === 3 ? '3+' : String(bucket)).padEnd(9)}${cells}`)
    }
  }

  for (const show of shows) {
    printBlock(show.id, show.shots, show.editedSeconds)
    for (const bucket of [0, 1, 2, 3] as const) {
      for (const r of MORE_NARROW_MORE_WIDE) {
        const secs = show.shots
          .filter((p) => p.peopleBucket === bucket && p.ratio === r)
          .reduce((n, p) => n + p.inClipSeconds, 0)
        const key = `${bucket}|${r}`
        totals.set(key, (totals.get(key) ?? 0) + secs)
      }
    }
    totalEditedSeconds += show.editedSeconds
  }

  console.log(`\n  TOTAL CORPUS — montage ${totalEditedSeconds.toFixed(0)} s`)
  console.log(`  personnes  ${MORE_NARROW_MORE_WIDE.map((r) => r.padStart(14)).join(' ')}`)
  for (const bucket of [0, 1, 2, 3] as const) {
    const cells = MORE_NARROW_MORE_WIDE.map((r) => {
      const secs = totals.get(`${bucket}|${r}`) ?? 0
      return `${secs.toFixed(0)} s (${percent(secs, totalEditedSeconds)})`.padStart(14)
    }).join(' ')
    console.log(`  ${(bucket === 3 ? '3+' : String(bucket)).padEnd(9)}${cells}`)
  }
}

// ---------------------------------------------------------------------------
// b. Le gisement du cas 1.
// ---------------------------------------------------------------------------

/** Les plans à exactement deux personnes, en 16:9, d'au moins `minShot` secondes. */
function case1Shots(show: Show, minShot: number): ShotRecord[] {
  return show.shots.filter((p) => p.peopleBucket === 2 && p.ratio === '16:9' && p.inClipSeconds >= minShot)
}

function printCase1Pool(shows: Show[], minShot: number): Map<string, ShotRecord[]> {
  console.log(`\n=== b. Le gisement du cas 1 — 2 personnes, 16:9, ≥ ${minShot} s ===`)
  const byShow = new Map<string, ShotRecord[]>()
  let totalSeconds = 0
  let totalEditedSeconds = 0
  let totalShots = 0
  for (const show of shows) {
    const shots = case1Shots(show, minShot)
    byShow.set(show.id, shots)
    const seconds = shots.reduce((n, p) => n + p.inClipSeconds, 0)
    totalSeconds += seconds
    totalEditedSeconds += show.editedSeconds
    totalShots += shots.length
    console.log(
      `  ${show.id.padEnd(24)} ${shots.length.toString().padStart(3)} plans` +
        `  ${seconds.toFixed(0).padStart(6)} s  (${percent(seconds, show.editedSeconds)} du montage)`,
    )
  }
  console.log(
    `  ${'TOTAL CORPUS'.padEnd(24)} ${totalShots.toString().padStart(3)} plans` +
      `  ${totalSeconds.toFixed(0).padStart(6)} s  (${percent(totalSeconds, totalEditedSeconds)} du montage)`,
  )
  return byShow
}

// ---------------------------------------------------------------------------
// c. Le plafond du gain, sur le gisement du cas 1.
// ---------------------------------------------------------------------------

/**
 * Les pourcentages se lisent **en part du temps de montage**, pas en part du
 * gisement — c'est la règle générale de la spécification (« toutes les
 * durées… en part du temps de montage ») et c'est aussi la convention des
 * chiffres de contrôle de Julien : son « 71 s (11,9 %) » sur `cqlp` est
 * 71/596, pas 71/193.
 */
function printCeiling(shows: Show[], case1ByShow: Map<string, ShotRecord[]>): void {
  console.log('\n=== c. Le plafond du gain — les rangs pris seuls donneraient-ils un 9:16 ? ===')
  const buckets = { both: 0, one: 0, none: 0 }
  const bucketOf = (p: ShotRecord): keyof typeof buckets => {
    const left = p.ratioIfRank0 === '9:16'
    const right = p.ratioIfRank1 === '9:16'
    return left && right ? 'both' : left || right ? 'one' : 'none'
  }

  let totalEditedSeconds = 0
  for (const show of shows) {
    const shots = case1ByShow.get(show.id) ?? []
    const total = shots.reduce((n, p) => n + p.inClipSeconds, 0)
    const perBucket = { both: 0, one: 0, none: 0 }
    for (const p of shots) perBucket[bucketOf(p)] += p.inClipSeconds
    console.log(`\n  ${show.id} — ${total.toFixed(0)} s dans le gisement (montage : ${show.editedSeconds.toFixed(0)} s)`)
    console.log(
      `    les deux rangs en 9:16 : ${perBucket.both.toFixed(0)} s (${percent(perBucket.both, show.editedSeconds)} du montage)`,
    )
    console.log(
      `    un seul rang en 9:16   : ${perBucket.one.toFixed(0)} s (${percent(perBucket.one, show.editedSeconds)} du montage)`,
    )
    console.log(
      `    aucun rang en 9:16     : ${perBucket.none.toFixed(0)} s (${percent(perBucket.none, show.editedSeconds)} du montage)`,
    )
    buckets.both += perBucket.both
    buckets.one += perBucket.one
    buckets.none += perBucket.none
    totalEditedSeconds += show.editedSeconds
  }

  const totalAll = buckets.both + buckets.one + buckets.none
  console.log(`\n  TOTAL CORPUS — ${totalAll.toFixed(0)} s dans le gisement (montage : ${totalEditedSeconds.toFixed(0)} s)`)
  console.log(`    les deux rangs en 9:16 : ${buckets.both.toFixed(0)} s (${percent(buckets.both, totalEditedSeconds)} du montage)`)
  console.log(`    un seul rang en 9:16   : ${buckets.one.toFixed(0)} s (${percent(buckets.one, totalEditedSeconds)} du montage)`)
  console.log(`    aucun rang en 9:16     : ${buckets.none.toFixed(0)} s (${percent(buckets.none, totalEditedSeconds)} du montage)`)
}

// ---------------------------------------------------------------------------
// d. Le gisement du cas 2 — l'orientation.
// ---------------------------------------------------------------------------

function sampleStep(analysis: Analysis): number {
  return analysis.fps > 0 ? 1 / analysis.fps : Number.NaN
}

/** Même convention que la section c : les pourcentages sont en part du temps de montage. */
function printOrientation(
  shows: Show[],
  case1ByShow: Map<string, ShotRecord[]>,
  decisiveShare: number,
  unknownVetoMode: UnknownVetoMode,
): Map<string, ShotRecord[]> {
  console.log('\n=== d. Le gisement du cas 2 — orientation (règle relative, jamais absolue) ===')
  const core = new Map<string, ShotRecord[]>()
  let totalCase1Seconds = 0
  let totalEditedSeconds = 0
  let totalCore = 0
  let totalNetNoGain = 0
  let totalUnknownSeconds = 0

  for (const show of shows) {
    const shots = case1ByShow.get(show.id) ?? []
    const case1Seconds = shots.reduce((n, p) => n + p.inClipSeconds, 0)
    const coreForShow: ShotRecord[] = []
    let coreSeconds = 0
    let netNoGainSeconds = 0
    let unknownFrames = 0
    let twoPersonFrames = 0
    for (const p of shots) {
      const verdict = orientationVerdict(p, decisiveShare, unknownVetoMode)
      if (verdict === 'core') {
        coreForShow.push(p)
        coreSeconds += p.inClipSeconds
      } else if (verdict === 'netNoGain') {
        netNoGainSeconds += p.inClipSeconds
      }
      unknownFrames += p.unknownFrameCount
      twoPersonFrames += p.twoPersonFrameCount
    }
    const step = sampleStep(show.analysis)
    const unknownSeconds = Number.isFinite(step) ? unknownFrames * step : Number.NaN

    console.log(`\n  ${show.id} — ${case1Seconds.toFixed(0)} s dans le gisement du cas 1 (montage : ${show.editedSeconds.toFixed(0)} s)`)
    console.log(
      `    gisement du cas 2 (gain réel) : ${coreSeconds.toFixed(0)} s (${percent(coreSeconds, show.editedSeconds)} du montage)`,
    )
    console.log(
      `    écart net, ratio inchangé     : ${netNoGainSeconds.toFixed(0)} s (${percent(netNoGainSeconds, show.editedSeconds)} du montage)`,
    )
    console.log(
      `    au moins une personne unknown : ${number(unknownSeconds, 1)} s (${percent(unknownSeconds, show.editedSeconds)} du montage)` +
        ` — ${unknownFrames} / ${twoPersonFrames} images à deux personnes`,
    )

    core.set(show.id, coreForShow)
    totalCase1Seconds += case1Seconds
    totalEditedSeconds += show.editedSeconds
    totalCore += coreSeconds
    totalNetNoGain += netNoGainSeconds
    if (Number.isFinite(unknownSeconds)) totalUnknownSeconds += unknownSeconds
  }

  console.log(`\n  TOTAL CORPUS — ${totalCase1Seconds.toFixed(0)} s dans le gisement du cas 1 (montage : ${totalEditedSeconds.toFixed(0)} s)`)
  console.log(
    `    gisement du cas 2 (gain réel) : ${totalCore.toFixed(0)} s (${percent(totalCore, totalEditedSeconds)} du montage)`,
  )
  console.log(
    `    écart net, ratio inchangé     : ${totalNetNoGain.toFixed(0)} s (${percent(totalNetNoGain, totalEditedSeconds)} du montage)`,
  )
  console.log(
    `    au moins une personne unknown : ${totalUnknownSeconds.toFixed(1)} s (${percent(totalUnknownSeconds, totalEditedSeconds)} du montage)`,
  )

  return core
}

// ---------------------------------------------------------------------------
// La ventilation des rejets — pourquoi le gisement du cas 1 ne passe pas au
// cas 2, et dans quelle proportion pour chaque raison.
// ---------------------------------------------------------------------------

function printRejectionBreakdown(
  shows: Show[],
  case1ByShow: Map<string, ShotRecord[]>,
  frontalMargin: number,
  decisiveShare: number,
  unknownVetoMode: UnknownVetoMode,
): void {
  console.log('\n=== Ventilation des rejets du gisement du cas 1 qui ne passent pas au cas 2 ===')
  console.log(`  Ordre de bucketing (la première catégorie qui s'applique) : ${REJECTION_CATEGORIES.join(' → ')}`)
  console.log(`  Réglage : --unknown-veto ${unknownVetoMode}, --decisive-share ${decisiveShare}, --frontal-margin ${frontalMargin}`)

  const totals = new Map<RejectionCategory, number>(REJECTION_CATEGORIES.map((c) => [c, 0]))
  let totalEditedSeconds = 0
  const unknownVetoCounts: number[] = []

  for (const show of shows) {
    const shots = case1ByShow.get(show.id) ?? []
    const rejected = shots.filter((p) => !shotPasses(p, decisiveShare, unknownVetoMode))
    const perShow = new Map<RejectionCategory, number>(REJECTION_CATEGORIES.map((c) => [c, 0]))
    for (const p of rejected) {
      const category = classifyRejection(p, frontalMargin, decisiveShare, unknownVetoMode)
      perShow.set(category, (perShow.get(category) ?? 0) + p.inClipSeconds)
      totals.set(category, (totals.get(category) ?? 0) + p.inClipSeconds)
      if (category === 'unknownVeto') unknownVetoCounts.push(p.unknownVetoFrameCount)
    }
    console.log(`\n  ${show.id} — ${rejected.length} plans rejetés`)
    for (const category of REJECTION_CATEGORIES) {
      const secs = perShow.get(category) ?? 0
      console.log(`    ${category.padEnd(14)} ${secs.toFixed(0).padStart(6)} s  (${percent(secs, show.editedSeconds)} du montage)`)
    }
    totalEditedSeconds += show.editedSeconds
  }

  console.log(`\n  TOTAL CORPUS`)
  for (const category of REJECTION_CATEGORIES) {
    const secs = totals.get(category) ?? 0
    console.log(`    ${category.padEnd(14)} ${secs.toFixed(0).padStart(6)} s  (${percent(secs, totalEditedSeconds)} du montage)`)
  }
  console.log(
    `\n  unknownVeto — médiane des images unknown qui ont suffi à disqualifier : ${number(median(unknownVetoCounts), 1)}` +
      ` (sur ${unknownVetoCounts.length} plan${unknownVetoCounts.length === 1 ? '' : 's'} dans cette catégorie)`,
  )
}

// ---------------------------------------------------------------------------
// e. Le jeu d'évaluation auto-supervisé.
// ---------------------------------------------------------------------------

function printSoloTime(shows: Show[]): void {
  console.log("\n=== e. Le jeu d'évaluation auto-supervisé — le temps à une personne, émission entière ===")
  let totalSolo = 0
  let totalDuration = 0
  for (const show of shows) {
    const solo = show.wholeShowShots
      .filter((p) => p.peopleBucket === 1)
      .reduce((n, p) => n + p.inClipSeconds, 0)
    console.log(
      `  ${show.id.padEnd(24)} ${solo.toFixed(0).padStart(7)} s / ${show.totalDuration.toFixed(0)} s` +
        `  (${percent(solo, show.totalDuration)})`,
    )
    totalSolo += solo
    totalDuration += show.totalDuration
  }
  console.log(
    `  ${'TOTAL CORPUS'.padEnd(24)} ${totalSolo.toFixed(0).padStart(7)} s / ${totalDuration.toFixed(0)} s` +
      `  (${percent(totalSolo, totalDuration)})`,
  )
}

// ---------------------------------------------------------------------------
// f. Les extraits candidats.
// ---------------------------------------------------------------------------

function printCandidates(
  label: string,
  entries: { show: string; record: ShotRecord }[],
): void {
  console.log(`\n  ${label}`)
  const top = [...entries].sort((a, b) => b.record.inClipSeconds - a.record.inClipSeconds).slice(0, 10)
  if (top.length === 0) {
    console.log('    (aucun plan)')
    return
  }
  for (const { show, record } of top) {
    console.log(
      `    ${show.padEnd(24)} ${record.shot.start.toFixed(1).padStart(8)} → ${record.shot.end
        .toFixed(1)
        .padStart(8)}  (${record.inClipSeconds.toFixed(1)} s dans le montage)`,
    )
  }
}

function printCandidateExtracts(
  case1ByShow: Map<string, ShotRecord[]>,
  case2ByShow: Map<string, ShotRecord[]>,
): void {
  console.log('\n=== f. Les extraits candidats — les dix plus longs plans de chaque gisement ===')
  const flatten = (m: Map<string, ShotRecord[]>): { show: string; record: ShotRecord }[] =>
    [...m.entries()].flatMap(([show, records]) => records.map((record) => ({ show, record })))
  printCandidates('Gisement du cas 1 (2 personnes, 16:9)', flatten(case1ByShow))
  printCandidates('Gisement du cas 2 (orientation, gain réel)', flatten(case2ByShow))
}

// ---------------------------------------------------------------------------
// Le balayage — huit réglages, le gisement du cas 2 et le risque qu'il paie.
// ---------------------------------------------------------------------------

const UNKNOWN_VETO_MODES_SWEEP: readonly UnknownVetoMode[] = ['shot', 'frame']
const DECISIVE_SHARES_SWEEP: readonly number[] = [0.9, 0.8, 0.7, 0.6]

/**
 * Les huit combinaisons de `--unknown-veto` × `--decisive-share`, affichées en
 * dernier. Pour chacune : le gisement du cas 2 par émission et sur le corpus,
 * **et** à côté, le compteur de risque — le temps où la tête du rang perdant
 * tomberait hors du rectangle de crop si on l'écartait vraiment de l'empan.
 *
 * Le gisement se lit dans `ShotRecord` sans recalcul (`shotPasses`) ; le
 * risque non plus (`riskFrameCount`, déjà calculé par `analyzeShots` une fois
 * par plan, indépendamment du réglage) — ce balayage ne fait que sommer les
 * deux sur les plans qui passent à chaque réglage.
 */
function printSweep(shows: Show[], case1ByShow: Map<string, ShotRecord[]>): void {
  console.log('\n=== Balayage — le gisement du cas 2 et le risque de tête hors cadre, par réglage ===')
  const codes = shows.map((_, i) => String.fromCharCode(65 + i))
  console.log(`  ${codes.map((c, i) => `${c} = ${shows[i].id}`).join('   ')}`)
  console.log(
    `  veto    part   ${codes.map((c) => c.padStart(9)).join(' ')}   ${'corpus'.padStart(10)}  ${'% montage'.padStart(10)}  ${'risque'.padStart(9)}`,
  )

  for (const unknownVetoMode of UNKNOWN_VETO_MODES_SWEEP) {
    for (const decisiveShare of DECISIVE_SHARES_SWEEP) {
      let totalSeconds = 0
      let totalEditedSeconds = 0
      let totalRiskSeconds = 0
      const perShowCells: string[] = []

      for (const show of shows) {
        const shots = case1ByShow.get(show.id) ?? []
        const passing = shots.filter((p) => shotPasses(p, decisiveShare, unknownVetoMode))
        const seconds = passing.reduce((n, p) => n + p.inClipSeconds, 0)
        const step = sampleStep(show.analysis)
        const riskSeconds = Number.isFinite(step)
          ? passing.reduce((n, p) => n + p.riskFrameCount * step, 0)
          : Number.NaN

        perShowCells.push(`${seconds.toFixed(0)} s`)
        totalSeconds += seconds
        totalEditedSeconds += show.editedSeconds
        if (Number.isFinite(riskSeconds)) totalRiskSeconds += riskSeconds
      }

      console.log(
        `  ${unknownVetoMode.padEnd(6)}  ${decisiveShare.toFixed(1)}   ` +
          perShowCells.map((c) => c.padStart(9)).join(' ') +
          `   ${totalSeconds.toFixed(0).padStart(7)} s  ${percent(totalSeconds, totalEditedSeconds).padStart(10)}  ${totalRiskSeconds.toFixed(1).padStart(6)} s`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// g. Le JSON.
// ---------------------------------------------------------------------------

type JsonShotEntry = {
  start: number
  end: number
  inClipSeconds: number
  ratio: Ratio
  typicalPeople: number
  ratioIfRank0: Ratio
  ratioIfRank1: Ratio
  medianFrontalityRank0: number | null
  medianFrontalityRank1: number | null
  winningRank: 0 | 1 | null
}

type JsonShow = { editedSeconds: number; shots: JsonShotEntry[] }

/**
 * `winningRank` reproduit exactement l'ancienne sémantique (conditions 1 et 2
 * combinées, réglées au défaut) : c'est un contrat que d'autres scripts
 * peuvent lire, et il reste stable quels que soient `--unknown-veto` et
 * `--decisive-share` passés sur la ligne de commande — sinon le JSON changerait
 * de sens selon les options d'un balayage qui ne devrait affecter que
 * l'affichage.
 */
function toJsonShotEntry(p: ShotRecord): JsonShotEntry {
  return {
    start: p.shot.start,
    end: p.shot.end,
    inClipSeconds: p.inClipSeconds,
    ratio: p.ratio,
    typicalPeople: p.typicalPeople,
    ratioIfRank0: p.ratioIfRank0,
    ratioIfRank1: p.ratioIfRank1,
    medianFrontalityRank0: p.medianFrontalityRank0,
    medianFrontalityRank1: p.medianFrontalityRank1,
    winningRank:
      p.decisiveFraction >= DEFAULT_DECISIVE_SHARE && p.consistentWinner !== null ? p.consistentWinner : null,
  }
}

/** Écriture atomique : fichier temporaire, puis renommage — jamais d'écriture directe sur la cible. */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = pathTemporary(file)
  await fsp.writeFile(temporary, JSON.stringify(data, null, 2))
  await fsp.rename(temporary, file)
}

// ---------------------------------------------------------------------------
// Ligne de commande.
// ---------------------------------------------------------------------------

/**
 * Une suite de chiffres (entiers ou décimaux), ou `undefined` — jamais
 * `Number(raw)` seul, qui vaut 0 pour la chaîne vide et lit `"0x10"` comme
 * seize. Même principe que `parseSetting` dans `src/server/db.ts` : une
 * valeur illisible est refusée, jamais remplacée par le défaut en silence.
 */
function parseNumber(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined
  return Number(trimmed)
}

/** `'shot'` ou `'frame'`, ou `undefined` si autre chose. */
function parseUnknownVetoMode(raw: string): UnknownVetoMode | undefined {
  return raw === 'shot' || raw === 'frame' ? raw : undefined
}

/** Un drapeau à valeur : présent ou non, et sa valeur brute si présent. */
function flagValue(args: string[], name: string): { present: boolean; raw: string | undefined } {
  const i = args.indexOf(name)
  return i < 0 ? { present: false, raw: undefined } : { present: true, raw: args[i + 1] }
}

async function main(): Promise<number> {
  await chargerEnv()

  const args = process.argv.slice(2)
  const followerIndices = new Set<number>()
  for (const [i, a] of args.entries()) {
    if (
      a === '--min-shot' ||
      a === '--frontal-margin' ||
      a === '--json' ||
      a === '--unknown-veto' ||
      a === '--decisive-share'
    ) {
      followerIndices.add(i + 1)
    }
  }
  const positionals = args.filter((a, i) => !a.startsWith('--') && !followerIndices.has(i))
  const ids = positionals.length > 0 ? positionals : [...DEFAULT_SHOW_IDS]

  const minShotFlag = flagValue(args, '--min-shot')
  const minShot = !minShotFlag.present ? 4 : minShotFlag.raw === undefined ? undefined : parseNumber(minShotFlag.raw)
  if (minShot === undefined) {
    console.error(`--min-shot attend un nombre ≥ 0, reçu « ${String(minShotFlag.raw)} ».`)
    return 1
  }

  const marginFlag = flagValue(args, '--frontal-margin')
  const frontalMargin =
    !marginFlag.present ? 0.25 : marginFlag.raw === undefined ? undefined : parseNumber(marginFlag.raw)
  if (frontalMargin === undefined) {
    console.error(`--frontal-margin attend un nombre ≥ 0, reçu « ${String(marginFlag.raw)} ».`)
    return 1
  }

  const unknownVetoFlag = flagValue(args, '--unknown-veto')
  const unknownVetoMode =
    !unknownVetoFlag.present
      ? DEFAULT_UNKNOWN_VETO_MODE
      : unknownVetoFlag.raw === undefined
        ? undefined
        : parseUnknownVetoMode(unknownVetoFlag.raw)
  if (unknownVetoMode === undefined) {
    console.error(`--unknown-veto attend « shot » ou « frame », reçu « ${String(unknownVetoFlag.raw)} ».`)
    return 1
  }

  const decisiveShareFlag = flagValue(args, '--decisive-share')
  const decisiveShareRaw =
    !decisiveShareFlag.present
      ? DEFAULT_DECISIVE_SHARE
      : decisiveShareFlag.raw === undefined
        ? undefined
        : parseNumber(decisiveShareFlag.raw)
  const decisiveShare =
    decisiveShareRaw !== undefined && decisiveShareRaw > 0 && decisiveShareRaw <= 1 ? decisiveShareRaw : undefined
  if (decisiveShare === undefined) {
    console.error(`--decisive-share attend un nombre dans ]0, 1], reçu « ${String(decisiveShareFlag.raw)} ».`)
    return 1
  }

  const jsonFlag = flagValue(args, '--json')
  if (jsonFlag.present && (jsonFlag.raw === undefined || jsonFlag.raw.startsWith('--'))) {
    console.error(`--json attend un chemin de fichier, reçu « ${String(jsonFlag.raw)} ».`)
    return 1
  }
  const jsonPath = jsonFlag.present ? jsonFlag.raw : undefined

  try {
    const shows = ids.map((id) => loadShow(id, frontalMargin)).filter((s): s is Show => s !== null)
    if (shows.length === 0) return 1

    console.log(
      `Réglages : --min-shot ${minShot} s, --frontal-margin ${frontalMargin}, --unknown-veto ${unknownVetoMode}, --decisive-share ${decisiveShare}` +
        ` (score ≥ ${FRAMING_DEFAULTS.minScore})`,
    )
    for (const show of shows) {
      console.log(
        `  ${show.id} : ${show.shots.length} plans montés, ${show.editedSeconds.toFixed(0)} s de montage` +
          ` sur ${show.totalDuration.toFixed(0)} s d'émission`,
      )
    }

    printGrid(shows)
    const case1ByShow = printCase1Pool(shows, minShot)
    printCeiling(shows, case1ByShow)
    const case2ByShow = printOrientation(shows, case1ByShow, decisiveShare, unknownVetoMode)
    printRejectionBreakdown(shows, case1ByShow, frontalMargin, decisiveShare, unknownVetoMode)
    printSoloTime(shows)
    printCandidateExtracts(case1ByShow, case2ByShow)

    if (jsonPath !== undefined) {
      const out: Record<string, JsonShow> = {}
      for (const show of shows) {
        out[show.id] = {
          editedSeconds: show.editedSeconds,
          shots: (case1ByShow.get(show.id) ?? []).map(toJsonShotEntry),
        }
      }
      await writeJsonAtomic(jsonPath, out)
      console.log(`\nJSON écrit : ${jsonPath}`)
    }

    printSweep(shows, case1ByShow)

    return 0
  } finally {
    closeDb()
  }
}

void main().then(quit, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quit(1)
})
