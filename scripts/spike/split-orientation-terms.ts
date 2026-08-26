/**
 * La première mesure de l'issue #190 : `shoulderRatio` seul, un terme
 * d'`orientationOf`, sépare-t-il un profil franc (gardé) d'un trois-quarts
 * dos (écarté) ? `docs/locuteur-et-orientation.md:179-185` semble déjà le
 * réfuter — mais cette section répond à la question inverse (détecter un
 * profil pour l'exclure), pas à celle-ci (le garder). Isole aussi la
 * branche `unknown`, jamais mesurée séparément de `frontality < 0,2`.
 *
 *     PROJECTS_DIR=projects pnpm tsx scripts/spike/split-orientation-terms.ts
 *
 * `null` n'est jamais plié à 0. Mesure seule : `src/core/framing.ts` n'est pas modifié.
 */

import { orientationOf, hasValidGeometry, isForeground, FRAMING_DEFAULTS, type Facing } from '@/core/framing'
import type { PersonBox } from '@/core/shots'
import { resolveCase } from '../framing/case-registry'
import { findCase, projectOf } from '../framing/cases'
import { sweepCorpus, type PersonFrame, type ShotSample } from '../framing/corpus'

const NAMED_CASE_IDS = [
  'nabla-1798867',
  'nabla-1607967',
  'nabla-2056800',
  'nabla-2077400',
  'nabla-6418667',
] as const

/**
 * Les boîtes retenues d'une image — score, géométrie, premier plan, plancher
 * de taille. Même filtre que `retainedInFrame` de `scripts/framing/metrics.ts`,
 * non exportée là-bas et un autre agent tient ce fichier en ce moment ;
 * reconstruite ici sur les seules primitives publiques de `@/core/framing`.
 */
function retainedInFrame(boxes: readonly PersonBox[]): PersonBox[] {
  const threshold = FRAMING_DEFAULTS.minScore
  const survivors = boxes.filter(
    (b) => hasValidGeometry(b) && b.score >= threshold && !isForeground(b, FRAMING_DEFAULTS),
  )
  if (survivors.length === 0) return []
  const floor = Math.min(1, Math.max(0, FRAMING_DEFAULTS.sizeFloor))
  const tallest = Math.max(...survivors.map((b) => b.y1 - b.y0))
  return survivors.filter((b) => b.y1 - b.y0 >= floor * tallest)
}

/** Le centre horizontal d'une boîte, pour un rang gauche/droite stable — même clé que `computeShotSplit`. */
function centerX(box: PersonBox): number {
  return (box.x0 + box.x1) / 2
}

/**
 * Les images d'un plan à exactement deux personnes retenues — l'appariement que
 * `computeShotSplit` exige. Trié gauche/droite par centre, jamais par l'ordre
 * brut de détection : celui-ci n'est pas un rang stable d'une image à l'autre
 * (relevé par @copilot-pull-request-reviewer sur PR #198).
 */
function pairedFrames(frames: readonly PersonFrame[]): [PersonBox, PersonBox][] {
  const pairs: [PersonBox, PersonBox][] = []
  for (const f of frames) {
    const retained = retainedInFrame(f.boxes)
    if (retained.length === 2) {
      const [left, right] = [...retained].sort((a, b) => centerX(a) - centerX(b))
      pairs.push([left, right])
    }
  }
  return pairs
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const m = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

/** Le minimum de `shoulderRatio` des deux personnes d'une image, ou `null` dès que l'un des deux termes manque. */
function minShoulderRatio(pair: readonly [PersonBox, PersonBox]): number | null {
  const ra = orientationOf(pair[0]).terms.shoulderRatio
  const rb = orientationOf(pair[1]).terms.shoulderRatio
  if (ra === null || rb === null) return null
  return Math.min(ra, rb)
}

/**
 * Le `facing` de la personne la moins de face d'une image appariée.
 *
 * Ne rend jamais `null` : `orientationOf` garantit que `frontality === null`
 * si et seulement si `facing === 'unknown'` (`framing.ts:1149-1157`), donc dès
 * qu'un des deux camps est `unknown`, il est de fait le perdant — aucune
 * comparaison numérique n'est nécessaire pour le savoir.
 *
 * Limite connue (@chatgpt-codex-connector, PR #198) : rien ici n'établit de
 * gagnant par plan sur les images décisives avant de vérifier `unknown` côté
 * perdant, contrairement à `addressable.ts`. Vérifié sur les 5 plans mesurés
 * par la mesure 2 : le côté connu y est frontal (médiane 0,73 à 0,89 sur
 * chacun), donc c'est bien lui le gagnant dans ce jeu — mais rien ne le
 * garantit sur une autre population.
 */
function loserFacing(pair: readonly [PersonBox, PersonBox]): Facing {
  const oa = orientationOf(pair[0])
  const ob = orientationOf(pair[1])
  if (oa.frontality === null) return 'unknown'
  if (ob.frontality === null) return 'unknown'
  return oa.frontality <= ob.frontality ? oa.facing : ob.facing
}

function decile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx]
}

// --- 1. Les cinq cas nommés -------------------------------------------------

function reportNamedCases(): void {
  console.log('=== 1. Les cinq cas nommés — shoulderRatio seul ===\n')
  for (const id of NAMED_CASE_IDS) {
    const c = findCase(id)
    if (c === undefined) {
      console.log(`${id} : introuvable dans le registre.`)
      continue
    }
    let resolved
    try {
      resolved = resolveCase(c)
    } catch (e) {
      console.log(`${id} : ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    if (resolved.drift.length > 0) {
      console.log(`${id} : a dérivé depuis son étiquetage — ${JSON.stringify(resolved.drift)}`)
    }
    const projectId = projectOf(c)
    const { samples } = sweepCorpus({ projects: [projectId], population: 'shots' })
    const instant = c.anchor.instants[0]
    const sample = samples.find(
      (s: ShotSample) => s.shot.shot.start <= instant && instant < s.shot.shot.end,
    )
    if (sample === undefined) {
      console.log(`${id} : aucun plan de ${projectId} ne couvre t=${instant}.`)
      continue
    }

    const pairs = pairedFrames(sample.frames)
    const perPersonA: number[] = []
    const perPersonB: number[] = []
    let nullCountA = 0
    let nullCountB = 0
    for (const [a, b] of pairs) {
      const ra = orientationOf(a).terms.shoulderRatio
      const rb = orientationOf(b).terms.shoulderRatio
      if (ra === null) nullCountA += 1
      else perPersonA.push(ra)
      if (rb === null) nullCountB += 1
      else perPersonB.push(rb)
    }
    const minPerFrame = pairs.map(minShoulderRatio).filter((v): v is number => v !== null)
    const nullFrames = pairs.length - minPerFrame.length
    const aggregate = median(minPerFrame)

    console.log(`${id} (${c.label?.call ?? 'sans étiquette'}, ${sample.frames.length} images du plan) :`)
    console.log(
      `  rang gauche — n=${perPersonA.length}, null=${nullCountA}, ` +
        `min=${perPersonA.length ? Math.min(...perPersonA).toFixed(3) : 'n/a'}, ` +
        `max=${perPersonA.length ? Math.max(...perPersonA).toFixed(3) : 'n/a'}, ` +
        `médiane=${median(perPersonA)?.toFixed(3) ?? 'n/a'}`,
    )
    console.log(
      `  rang droit — n=${perPersonB.length}, null=${nullCountB}, ` +
        `min=${perPersonB.length ? Math.min(...perPersonB).toFixed(3) : 'n/a'}, ` +
        `max=${perPersonB.length ? Math.max(...perPersonB).toFixed(3) : 'n/a'}, ` +
        `médiane=${median(perPersonB)?.toFixed(3) ?? 'n/a'}`,
    )
    console.log(
      `  agrégat plan (min par image, médiane sur le plan) : ${aggregate?.toFixed(3) ?? 'null'} ` +
        `(${pairs.length} images appariées, ${nullFrames} sans shoulderRatio des deux côtés)`,
    )
    console.log('')
  }
}

// --- 2 & 3. La population des plans splittés --------------------------------

function reportSplitPopulation(): void {
  console.log('=== 2 & 3. La population des plans qui splittent aujourd’hui ===\n')
  const { samples, skipped } = sweepCorpus({ population: 'splits' })
  console.log(`Population mesurée : ${samples.length} plans splittés, ${skipped.length} projet(s) ignoré(s).`)
  for (const s of skipped) console.log(`  ignoré — ${s.project} : ${s.why}`)
  console.log('')

  if (samples.length === 0) {
    console.log('Aucun plan splitté — projects/ absent ou vide sur cette machine.')
    return
  }

  let unknownAloneCount = 0
  const aggregates: number[] = []
  let undefinedAggregate = 0

  for (const sample of samples) {
    const pairs = pairedFrames(sample.frames)
    if (pairs.length === 0) {
      undefinedAggregate += 1
      continue
    }

    const unknownLosses = pairs.filter((p) => loserFacing(p) === 'unknown').length
    if (unknownLosses / pairs.length > 0.9) unknownAloneCount += 1

    const minPerFrame = pairs.map(minShoulderRatio).filter((v): v is number => v !== null)
    const aggregate = median(minPerFrame)
    if (aggregate === null) undefinedAggregate += 1
    else aggregates.push(aggregate)
  }

  console.log(
    `2. Branche 'unknown' seule : ${unknownAloneCount} / ${samples.length} plans ` +
      `(${((unknownAloneCount / samples.length) * 100).toFixed(1)} %) ont un perdant 'unknown' ` +
      `sur plus de 90 % de leurs images appariées.`,
  )
  console.log('')

  console.log(
    `3. Agrégat shoulderRatio-min-median : défini sur ${aggregates.length} / ${samples.length} plans, ` +
      `${undefinedAggregate} indéfinis (aucune image appariée avec les deux shoulderRatio).`,
  )
  const sorted = [...aggregates].sort((a, b) => a - b)
  const points = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.999]
  console.log(
    '  déciles : ' + points.map((p) => decile(sorted, p).toFixed(3)).join('  '),
  )
}

reportNamedCases()
reportSplitPopulation()
