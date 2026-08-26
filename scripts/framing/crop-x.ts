/**
 * Dérive le `cropX` d'un repli « 9:16 sur une personne » (issue #190) — la
 * méthode documentée dans `scripts/framing/boards/2026-08-26-replis-du-split.ts`,
 * rendue exécutable plutôt que recopiée en prose à chaque nouveau cas.
 *
 *     PROJECTS_DIR=… pnpm tsx scripts/framing/crop-x.ts <sélecteur>
 *
 * `sélecteur` suit la grammaire de `selectCases` (`scripts/framing/cases.ts`).
 *
 * Sur les images du plan à exactement deux personnes retenues
 * (`retainedBoxes`), triées gauche/droite par le centre de `personBounds`, le
 * côté choisi est celui dont la tête (`headBounds`) est présente sur le plus
 * grand nombre d'images ; à égalité de présence, celui dont le score moyen
 * — la moyenne **brute**, non filtrée, des cinq points de tête (nez, yeux,
 * oreilles) — est le plus haut. Le `cropX` rendu est la médiane du centre de
 * `headBounds` de ce côté, sur les seules images où sa tête est présente.
 *
 * **Refuse plutôt que trancher au hasard** (`CLAUDE.md`, « distinguer
 * l'absence d'information de son ambiguïté ») dans deux cas : aucun des deux
 * côtés ne montre jamais de tête, ou une égalité exacte à la fois sur le
 * nombre d'images et sur le score moyen — deux hypothèses à une voix chacune
 * ne se départagent pas par un défaut.
 */

import { pathToFileURL } from 'node:url'
import { headBounds, personBounds, retainedBoxes, FRAMING_DEFAULTS } from '@/core/framing'
import { POINT, type PersonBox } from '@/core/shots'
import { resolveCases } from './case-registry'
import { selectCases } from './cases'
import { chargerEnv, quit } from '../dev-common'

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Moyenne brute des cinq points de tête, non filtrée : un point manquant vaut 0, il ne sort pas de la moyenne. */
function headScore(box: PersonBox): number {
  const k = box.k
  if (k === undefined) return 0
  const ranks = [POINT.NOSE, POINT.LEFT_EYE, POINT.RIGHT_EYE, POINT.LEFT_EAR, POINT.RIGHT_EAR]
  const scores = ranks.map((r) => k[r * 3 + 2])
  return scores.reduce((a, b) => a + b, 0) / scores.length
}

function centerOf(box: PersonBox): number {
  const { x0, x1 } = personBounds(box, FRAMING_DEFAULTS)
  return (x0 + x1) / 2
}

type SideStats = { headCount: number; headCenters: number[]; scores: number[] }

function emptyStats(): SideStats {
  return { headCount: 0, headCenters: [], scores: [] }
}

/** Le `cropX` dérivé pour un cas, ou l'explication du refus. */
export type CropXResult =
  | { outcome: 'derived'; cropX: number; side: 'left' | 'right'; leftFrames: number; rightFrames: number }
  | { outcome: 'refused'; why: string }

export function deriveCropX(boxesInShot: PersonBox[]): CropXResult {
  const byT = new Map<number, PersonBox[]>()
  for (const box of boxesInShot) {
    const arr = byT.get(box.t) ?? []
    arr.push(box)
    byT.set(box.t, arr)
  }

  const left = emptyStats()
  const right = emptyStats()
  let framesWithTwo = 0

  for (const boxes of byT.values()) {
    if (boxes.length !== 2) continue
    framesWithTwo += 1
    const [l, r] = [...boxes].sort((a, b) => centerOf(a) - centerOf(b))
    for (const [box, side] of [[l, left] as const, [r, right] as const]) {
      side.scores.push(headScore(box))
      const head = headBounds(box, FRAMING_DEFAULTS)
      if (head !== null) {
        side.headCount += 1
        side.headCenters.push((head.x0 + head.x1) / 2)
      }
    }
  }

  if (framesWithTwo === 0) {
    return { outcome: 'refused', why: 'aucune image à exactement deux personnes retenues sur ce plan.' }
  }
  if (left.headCount === 0 && right.headCount === 0) {
    return { outcome: 'refused', why: "aucun des deux côtés ne montre jamais de tête ('headBounds' toujours nul)." }
  }

  const meanOf = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
  const leftMean = meanOf(left.scores)
  const rightMean = meanOf(right.scores)

  if (left.headCount === right.headCount && leftMean === rightMean) {
    return {
      outcome: 'refused',
      why:
        `égalité exacte entre les deux côtés (présence de tête ${left.headCount}/${framesWithTwo} des deux, ` +
        `score moyen ${leftMean} des deux) — rien ne les départage.`,
    }
  }

  const pickLeft = left.headCount !== right.headCount ? left.headCount > right.headCount : leftMean > rightMean
  const winner = pickLeft ? left : right
  return {
    outcome: 'derived',
    cropX: median(winner.headCenters),
    side: pickLeft ? 'left' : 'right',
    leftFrames: left.headCount,
    rightFrames: right.headCount,
  }
}

async function main(): Promise<number> {
  await chargerEnv()
  const selector = process.argv[2]
  if (selector === undefined) {
    console.error('Usage : pnpm tsx scripts/framing/crop-x.ts <sélecteur>')
    return 1
  }

  const cases = selectCases(selector)
  const { resolved, missing } = resolveCases(cases)
  for (const m of missing) {
    console.error(`${m.case.id} : ${m.why}`)
  }

  let failed = missing.length > 0
  for (const r of resolved) {
    const shotBoxes = retainedBoxes(
      r.analysis.boxes.filter((b) => b.t >= r.shot.shot.start && b.t < r.shot.shot.end),
      FRAMING_DEFAULTS,
    )
    const result = deriveCropX(shotBoxes)
    if (result.outcome === 'refused') {
      failed = true
      console.error(`${r.case.id} : refusé — ${result.why}`)
      continue
    }
    console.log(
      `${r.case.id}  cropX=${result.cropX.toFixed(4)}  côté=${result.side}  ` +
        `têtes gauche=${result.leftFrames} droite=${result.rightFrames}`,
    )
  }

  return failed ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().then(quit, (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e))
    quit(1)
  })
}
