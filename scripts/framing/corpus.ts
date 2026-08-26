/**
 * Balaie tous les projets sur le disque et rend un plan par échantillon —
 * la brique commune à la découverte de cas difficiles (issue #191 § 4).
 *
 * **Aucun cache.** Mesuré sur cette machine : 2,8 s pour le corpus entier,
 * 4364 plans, 489 splittés. C'est en dessous du coût d'invalider un cache
 * correctement quand `worker/detect.py` change, donc aucun n'est construit ici.
 */

import fs from 'node:fs'
import { computeFraming, type FramingOptions, type ShotFraming } from '@/core/framing'
import type { PersonBox } from '@/core/shots'
import { analysisPath, projectsDir } from '@/server/paths'
import { lireAnalysis, type Analysis } from '@/server/steps/analysis'
import { sourceFramingRequest } from './case-registry'
import type { ProjectId } from './cases'

export type CorpusOptions = {
  projects?: readonly ProjectId[]
  framing?: Partial<FramingOptions>
  population: 'shots' | 'splits'
}

export type PersonFrame = { t: number; boxes: readonly PersonBox[] }

export type ShotSample = {
  project: ProjectId
  shot: ShotFraming
  frames: readonly PersonFrame[]
  analysisFps: number
  srcW: number
  srcH: number
}

function framesForShot(analysis: Analysis, shot: ShotFraming): PersonFrame[] {
  const byInstant = new Map<number, PersonBox[]>()
  for (const b of analysis.boxes) {
    if (b.t < shot.shot.start || b.t >= shot.shot.end) continue
    const boxes = byInstant.get(b.t) ?? []
    boxes.push(b)
    byInstant.set(b.t, boxes)
  }
  return [...byInstant.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, boxes]) => ({ t, boxes }))
}

/**
 * Un plan par échantillon, sur tous les projets analysés du disque (ou le
 * sous-ensemble de `o.projects`).
 *
 * Un projet **sans `analysis.json` va dans `skipped`, jamais absorbé en
 * silence** — c'est ainsi que « quatre projets » a fini par périmer dans la
 * skill `cadrage`.
 */
export function sweepCorpus(o: CorpusOptions): {
  samples: ShotSample[]
  skipped: { project: string; why: string }[]
} {
  const samples: ShotSample[] = []
  const skipped: { project: string; why: string }[] = []

  const dir = projectsDir()
  const entries = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
    : []
  const wanted = o.projects === undefined ? undefined : new Set<string>(o.projects)

  for (const entry of entries) {
    const projectId = entry.name
    if (wanted !== undefined && !wanted.has(projectId)) continue

    const file = analysisPath(projectId)
    if (!fs.existsSync(file)) {
      skipped.push({ project: projectId, why: `analyse absente (${file})` })
      continue
    }

    const analysis = lireAnalysis(file)
    const framing = computeFraming(sourceFramingRequest(analysis, o.framing))

    for (const shot of framing.shots) {
      if (o.population === 'splits' && shot.split === undefined) continue
      samples.push({
        project: projectId as ProjectId,
        shot,
        frames: framesForShot(analysis, shot),
        analysisFps: analysis.fps,
        srcW: analysis.source.w,
        srcH: analysis.source.h,
      })
    }
  }

  return { samples, skipped }
}
