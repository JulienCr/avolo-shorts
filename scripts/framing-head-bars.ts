/**
 * Rapporte les deux barres de présence de tête de l'issue #190, sur le
 * corpus entier et les huit cas de référence. Descriptif, ne câble aucune
 * des deux.
 *
 *     PROJECTS_DIR=<chemin> pnpm tsx scripts/framing-head-bars.ts
 *
 * La barre à deux points se lit sur `perFrame[].{top,bottom}.pointCount`,
 * jamais redérivée.
 */

import { computeShotHeadInstrument, FRAMING_DEFAULTS, type FrameHeadStats } from '@/core/framing'
import type { PersonBox } from '@/core/shots'
import { chargerEnv, quit } from './dev-common'
import { resolveCase } from './framing/case-registry'
import { findCase, selectCases } from './framing/cases'
import { sweepCorpus, type ShotSample } from './framing/corpus'
import { METRICS } from './framing/metrics'

function flatten(s: ShotSample): PersonBox[] {
  return s.frames.flatMap((f) => f.boxes)
}

/** Le même appel que celui de `headInstrumentOf` dans `metrics.ts` — jamais une seconde dérivation. */
function instrumentOf(s: ShotSample): ReturnType<typeof computeShotHeadInstrument> {
  return computeShotHeadInstrument(
    flatten(s),
    s.shot.shot,
    s.shot.ratio,
    s.srcW,
    s.srcH,
    { ...FRAMING_DEFAULTS, fps: s.analysisFps },
    [s.shot.shot],
  )
}

/** La part d'images appariées où une cellule voit moins de deux points de tête confiants. */
function shareBelowTwoPoints(frames: readonly FrameHeadStats[], side: 'top' | 'bottom'): number {
  if (frames.length === 0) return 0
  const below = frames.filter((f) => f[side].pointCount < 2).length
  return below / frames.length
}

/** Le pire des deux cellules pour la barre à deux points, `null` si le plan n'a pas de cellules. */
function bar2WorstOf(s: ShotSample): number | null {
  const instrument = instrumentOf(s)
  if (instrument.perFrame === null) return null
  return Math.max(
    shareBelowTwoPoints(instrument.perFrame, 'top'),
    shareBelowTwoPoints(instrument.perFrame, 'bottom'),
  )
}

function deciles(values: readonly number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const q = (p: number): number => {
    const pos = p * (sorted.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
  }
  return Array.from({ length: 9 }, (_, i) => q((i + 1) / 10))
}

function reportCorpus(): void {
  const { samples, skipped } = sweepCorpus({ population: 'splits' })
  // `s.why` porte le chemin absolu de l'analyse manquante — utile en debug
  // local, jamais dans une sortie qu'on pourrait recopier ailleurs.
  for (const s of skipped) console.log(`ignoré : ${s.project} — analyse absente`)
  console.log(`\npopulation (splits) : ${samples.length}`)

  const bar1 = samples.map((s) => METRICS['head-absence-worst'].of(s)).filter((v): v is number => v !== null)
  const bar2 = samples.map(bar2WorstOf).filter((v): v is number => v !== null)
  const containment = samples
    .map((s) => METRICS['head-containment-worst'].of(s))
    .filter((v): v is number => v !== null)
  const containmentNullCount = samples.length - containment.length

  console.log(`\nbarre ≥ 1 point (head-absence-worst, shippée)`)
  console.log(`  ${bar1.length}/${samples.length} défini, se déclenche (> 0) sur ${bar1.filter((v) => v > 0).length}`)
  console.log(`  déciles [${deciles(bar1).map((d) => d.toFixed(4)).join(', ')}]`)

  console.log(`\nbarre ≥ 2 points (mesurée, non câblée)`)
  console.log(`  ${bar2.length}/${samples.length} défini, se déclenche (> 0) sur ${bar2.filter((v) => v > 0).length}`)
  console.log(`  déciles [${deciles(bar2).map((d) => d.toFixed(4)).join(', ')}]`)

  console.log(`\nhead-containment-worst`)
  console.log(`  ${containment.length}/${samples.length} défini — ${containmentNullCount} plan(s) rendent null`)
  console.log(`  déciles [${deciles(containment).map((d) => d.toFixed(4)).join(', ')}]`)

  console.log(`\nseuils sur l'absence (barre ≥ 1 point), retire seul`)
  for (const t of [0, 0.1, 0.3, 0.5]) {
    console.log(`  > ${t} : ${bar1.filter((v) => v > t).length}`)
  }

  console.log(`\nseuils sur le containment, retire seul`)
  console.log(`  = null (dégénéré) : ${containmentNullCount}`)
  for (const t of [1, 0.95, 0.9]) {
    console.log(`  < ${t} (mesuré) : ${containment.filter((v) => v < t).length}`)
  }

  const combinedCount = samples.filter((s) => {
    const absence = METRICS['head-absence-worst'].of(s)
    const cellContainment = METRICS['head-containment-worst'].of(s)
    return (absence !== null && absence > 0) || cellContainment === null || cellContainment < 1
  }).length
  console.log(
    `\ncombiné (absence > 0, ou containment null, ou containment mesuré < 1) : ${combinedCount}/${samples.length}`,
  )
}

function reportLabelledCases(): void {
  console.log('\n-- cas de référence (labelled) --')
  for (const id of selectCases('labelled').map((c) => c.id)) {
    const c = findCase(id)
    if (c === undefined) continue
    const r = resolveCase(c)
    const boxes = r.analysis.boxes.filter((b) => b.t >= r.shot.shot.start && b.t < r.shot.shot.end)
    const instrument = computeShotHeadInstrument(
      boxes,
      r.shot.shot,
      r.shot.ratio,
      r.analysis.source.w,
      r.analysis.source.h,
      { ...FRAMING_DEFAULTS, fps: r.analysis.fps },
    )
    const verdict = c.label?.call ?? 'sans étiquette'
    if (instrument.cells === null || instrument.perFrame === null) {
      console.log(`${id}  verdict=${verdict}  cells=null`)
      continue
    }
    const [top, bottom] = instrument.cells
    const bar2Top = shareBelowTwoPoints(instrument.perFrame, 'top')
    const bar2Bottom = shareBelowTwoPoints(instrument.perFrame, 'bottom')
    const fmt = (n: number | null): string => (n === null ? 'null' : n.toFixed(4))
    console.log(
      `${id}  verdict=${verdict}\n` +
        `  haut   bar1=${top.headAbsenceShare.toFixed(4)} bar2=${bar2Top.toFixed(4)} ` +
        `containment=${fmt(top.headContainmentMedian)} points=${top.headPointCountMedian} aire=${fmt(top.headAreaMedian)}\n` +
        `  bas    bar1=${bottom.headAbsenceShare.toFixed(4)} bar2=${bar2Bottom.toFixed(4)} ` +
        `containment=${fmt(bottom.headContainmentMedian)} points=${bottom.headPointCountMedian} aire=${fmt(bottom.headAreaMedian)}`,
    )
  }
}

async function main(): Promise<number> {
  await chargerEnv()
  reportCorpus()
  reportLabelledCases()
  return 0
}

main()
  .then((code) => quit(code))
  .catch((e) => {
    console.error(e)
    quit(1)
  })
