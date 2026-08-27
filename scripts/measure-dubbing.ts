/**
 * Ce que le détecteur de doublage trouve sur le corpus, et ce qu'il rate.
 *
 *     pnpm tsx scripts/measure-dubbing.ts [projectId ...]
 *
 * Sans argument, balaie les cinq projets qui portent une `analysis.json`.
 * Quatre mesures par projet :
 *
 * 1. **Les séquences détectées** — début, fin, durée, et les plans qu'elles
 *    couvrent.
 * 2. **Le hull du disque** — l'enveloppe des boîtes qui ont voté, à comparer à
 *    `anchor.pip` : c'est la preuve, tirée des boîtes et non des pixels, que le
 *    disque mesuré (amendement A1) est bien celui que `detectDubbingRuns` voit.
 * 3. **Les faux positifs** — toute séquence détectée hors des fenêtres connues
 *    (section 2 du contrat). Le seul chiffre qui compte pour le critère
 *    d'acceptation 3.
 * 4. **Le regard mesuré et le bandeau qui en découle** (amendement A7) — la
 *    preuve que la position du bandeau s'adapte à la séquence plutôt que
 *    d'être fixe.
 */

import fs from 'node:fs'

import { DUBBING_ANCHORS, DUBBING_DEFAULTS, detectDubbingRuns, dubbingCellsFor } from '@/core/dubbing'
import type { DubbingRun } from '@/core/dubbing'
import { analysisPath, projectDir } from '@/server/paths'
import { lireAnalysis, type Analysis } from '@/server/steps/analysis'
import { chargerEnv, quit } from './dev-common'

/**
 * Les fenêtres connues du contrat (section 2), en secondes — pour départager
 * une séquence attendue d'un faux positif. Un recouvrement partiel suffit :
 * elles bornent le crible du scan grossier, pas l'extent visuel exact.
 */
const KNOWN_WINDOWS: Readonly<Record<string, readonly [number, number][]>> = {
  '2026-22-02-entre-nous': [
    [2359.0, 2681.5],
    [4605.5, 4938.5],
    [6308.5, 6576.5],
  ],
  '2026-03-08-caro-mdlm': [[5113.0, 5583.0]],
  '2025-06-15-cqlp': [],
  '2026-04-24-fmr': [],
  '2026-05-31-nabla': [],
}

const PROJECTS = Object.keys(KNOWN_WINDOWS)

function overlapsAny(run: DubbingRun, windows: readonly [number, number][]): boolean {
  return windows.some(([lo, hi]) => Math.min(run.end, hi) > Math.max(run.start, lo))
}

function shotsOf(analysis: Analysis, run: DubbingRun): { start: number; end: number }[] {
  return analysis.shots.filter((s) => Math.min(s.end, run.end) > Math.max(s.start, run.start))
}

/** L'enveloppe des boîtes votantes, pour comparer au `pip` mesuré sans repasser par les pixels. */
function discHull(analysis: Analysis, run: DubbingRun): { x0: number; y0: number; x1: number; y1: number } | null {
  const { pip } = run.anchor
  const voting = analysis.boxes.filter(
    (b) =>
      b.t >= run.start &&
      b.t <= run.end &&
      b.score >= DUBBING_DEFAULTS.minScore &&
      b.x0 >= pip.x0 &&
      b.x1 <= pip.x1 &&
      b.y0 >= pip.y0 &&
      b.y1 <= pip.y1,
  )
  if (voting.length === 0) return null
  return {
    x0: Math.min(...voting.map((b) => b.x0)),
    y0: Math.min(...voting.map((b) => b.y0)),
    x1: Math.max(...voting.map((b) => b.x1)),
    y1: Math.max(...voting.map((b) => b.y1)),
  }
}

function measure(projectId: string): number {
  const file = analysisPath(projectId)
  if (!fs.existsSync(projectDir(projectId)) || !fs.existsSync(file)) {
    // Un projet absent ne doit pas compter comme "zero faux positif" : ce
    // script sert de gate sur le corpus, une execution partielle ne peut pas
    // valider le critere d'acceptation 3.
    throw new Error(`${projectId} : analysis.json introuvable, corpus incomplet`)
  }
  const analysis = lireAnalysis(file)
  const runs = detectDubbingRuns(analysis.boxes)
  const known = KNOWN_WINDOWS[projectId] ?? []

  console.log(`\n=== ${projectId} — ${analysis.boxes.length} boîtes, ${analysis.shots.length} plans ===`)
  if (runs.length === 0) {
    console.log('  aucune séquence détectée')
  }
  let falsePositives = 0
  for (const run of runs) {
    const duration = run.end - run.start
    const isKnown = overlapsAny(run, known)
    if (!isKnown) falsePositives += 1
    const shots = shotsOf(analysis, run)
    const hull = discHull(analysis, run)
    console.log(
      `  ${isKnown ? 'connue ' : 'INCONNUE'}  [${run.start.toFixed(1)}; ${run.end.toFixed(1)}]` +
        `  (${duration.toFixed(1)} s, ${shots.length} plans, ancre ${run.anchor.id})`,
    )
    if (hull !== null) {
      console.log(
        `    hull des boîtes votantes : x[${hull.x0.toFixed(3)}; ${hull.x1.toFixed(3)}]` +
          ` y[${hull.y0.toFixed(3)}; ${hull.y1.toFixed(3)}]` +
          ` (pip x[${run.anchor.pip.x0}; ${run.anchor.pip.x1}] y[${run.anchor.pip.y0}; ${run.anchor.pip.y1}])`,
      )
    }
    const band = dubbingCellsFor(run.anchor, run.eyeLevel).pip
    console.log(
      `    regard le plus haut (médiane) : y=${run.eyeLevel.toFixed(3)}` +
        ` — bandeau x[${band.x0.toFixed(3)}; ${band.x1.toFixed(3)}] y[${band.y0.toFixed(3)}; ${band.y1.toFixed(3)}]`,
    )
  }
  console.log(`  faux positifs (hors fenêtres connues) : ${falsePositives}`)
  return falsePositives
}

async function main(): Promise<number> {
  await chargerEnv()
  const requested = process.argv.slice(2)
  const projects = requested.length > 0 ? requested : PROJECTS

  let totalFalsePositives = 0
  for (const p of projects) totalFalsePositives += measure(p)

  console.log(`\nTotal faux positifs sur ${projects.length} projet(s) : ${totalFalsePositives}`)
  console.log(`Ancres évaluées : ${DUBBING_ANCHORS.map((a) => a.id).join(', ')}`)
  return totalFalsePositives > 0 ? 1 : 0
}

void main().then(quit, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quit(1)
})
