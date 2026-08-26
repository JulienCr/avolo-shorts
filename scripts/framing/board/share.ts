/**
 * Découpe un plan en états classifiables et dit, pour chacun, quelle part du
 * plan il occupe et quel instant le représente — issue #191, lot 2.
 *
 * **Le dénominateur est toujours la grille complète de l'analyse**
 * (`gridCount(shot.start, shot.end, analysisFps)`), jamais le nombre d'images
 * détectées. `analysis.boxes` ne porte rien pour une image où le détecteur a
 * perdu tout le monde ; compter sur les images présentes annoncerait « 100 % »
 * pour un état qui ne tient que la moitié du plan. C'est la leçon de la PR
 * #187 (voir `CLAUDE.md`, section « décisions à ne pas défaire par réflexe »).
 * Les images non classables sont donc **montrées**, jamais absorbées dans un
 * état.
 */

import { gridInstants } from '@/core/framing'
import type { PersonBox, Shot } from '@/core/shots'

export type Frame = { t: number; boxes: PersonBox[] }

export type FrameClassifier = {
  id: string
  label: string
  states: readonly { id: string; label: string }[]
  /** `null` = non classable : image absente d'un état comme des autres. */
  classify: (frame: Frame) => string | null
}

export type Share = { count: number; total: number; fraction: number }

export type ShotState = {
  state: { id: string; label: string }
  share: Share
  instant: number
  run: { start: number; end: number; share: Share }
}

export type ShotPartition = {
  shot: Shot
  analysisFps: number
  grid: number
  unclassified: Share
  states: readonly [ShotState, ...ShotState[]]
}

/**
 * Associe chaque image détectée à l'instant de grille le plus proche, par
 * l'indice `round(t · fps)` plutôt que par une tolérance flottante : deux
 * images voisines de moins d'une demi-période ne peuvent alors jamais se
 * disputer le même instant.
 */
function frameIndexOf(t: number, fps: number): number {
  return Math.round(t * fps)
}

export function partitionShot(o: {
  shot: Shot
  boxes: PersonBox[]
  analysisFps: number
  classifier: FrameClassifier
}): ShotPartition {
  const { shot, boxes, analysisFps, classifier } = o
  const grid = gridInstants(shot.start, shot.end, analysisFps)
  if (grid.length === 0) {
    throw new Error(
      `partitionShot : grille vide pour le plan [${shot.start}, ${shot.end}) à ${analysisFps} im/s.`,
    )
  }

  const firstIndex = frameIndexOf(grid[0], analysisFps)
  const byIndex = new Map<number, PersonBox[]>()
  for (const box of boxes) {
    if (box.t < shot.start || box.t >= shot.end) continue
    const key = frameIndexOf(box.t, analysisFps) - firstIndex
    if (key < 0 || key >= grid.length) continue
    const bucket = byIndex.get(key)
    if (bucket) bucket.push(box)
    else byIndex.set(key, [box])
  }

  const assignment: (string | null)[] = grid.map((t, i) => {
    const frameBoxes = byIndex.get(i)
    return frameBoxes ? classifier.classify({ t, boxes: frameBoxes }) : null
  })

  if (assignment.every((a) => a === null)) {
    throw new Error(
      `partitionShot : aucune image classable pour le plan [${shot.start}, ${shot.end}) (classifieur "${classifier.id}").`,
    )
  }

  const total = grid.length
  const unclassifiedCount = assignment.filter((a) => a === null).length
  const stateIds = [...new Set(assignment.filter((a): a is string => a !== null))]

  const states: ShotState[] = stateIds.map((id) => {
    const label = classifier.states.find((s) => s.id === id)?.label ?? id
    const count = assignment.filter((a) => a === id).length
    const share: Share = { count, total, fraction: count / total }

    // La plus longue plage continue d'`id` dans l'ordre de la grille.
    let bestStart = -1
    let bestLen = 0
    let curStart = -1
    for (let i = 0; i <= assignment.length; i += 1) {
      const isMatch = i < assignment.length && assignment[i] === id
      if (isMatch && curStart === -1) curStart = i
      if (!isMatch && curStart !== -1) {
        const len = i - curStart
        if (len > bestLen) {
          bestLen = len
          bestStart = curStart
        }
        curStart = -1
      }
    }

    const runShare: Share = { count: bestLen, total, fraction: bestLen / total }
    // Le milieu de la plage, pas la médiane des images de l'état : une
    // médiane peut tomber sur un clignotement isolé entre deux plages de
    // l'autre état, et présenterait alors un accident comme représentatif.
    const midIndex = bestStart + Math.floor((bestLen - 1) / 2)
    const instant = grid[midIndex]

    return {
      state: { id, label },
      share,
      instant,
      run: { start: grid[bestStart], end: grid[bestStart + bestLen - 1], share: runShare },
    }
  })

  states.sort((a, b) => b.share.fraction - a.share.fraction)

  return {
    shot,
    analysisFps,
    grid: total,
    unclassified: { count: unclassifiedCount, total, fraction: unclassifiedCount / total },
    states: states as [ShotState, ...ShotState[]],
  }
}

export function formatShare(s: Share): string {
  const pct = (s.fraction * 100).toFixed(1).replace('.', ',')
  return `${pct} % · ${s.count} / ${s.total} images`
}

export function assertShare(s: Share | undefined, where: string): asserts s is Share {
  if (!s) throw new Error(`assertShare (${where}) : part absente.`)
  if (!Number.isFinite(s.count) || !Number.isFinite(s.total) || !Number.isFinite(s.fraction)) {
    throw new Error(`assertShare (${where}) : valeur non finie (${JSON.stringify(s)}).`)
  }
  if (s.fraction < 0 || s.fraction > 1) {
    throw new Error(`assertShare (${where}) : fraction hors [0, 1] (${s.fraction}).`)
  }
}
