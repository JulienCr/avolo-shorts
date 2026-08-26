import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Analysis } from '@/server/steps/analysis'
import { sourceFramingRequest } from '../../scripts/framing/case-registry'
import { sweepCorpus } from '../../scripts/framing/corpus'

/**
 * `sweepCorpus` doit rendre `{ samples: [], skipped: [] }`, jamais lever, sur
 * un clone frais sans `projects/` — c'est le cas que ce fichier ouvre en
 * premier, avant de fabriquer ses propres fixtures dans un dossier temporaire.
 */

function fixtureAnalysis(shots: { start: number; end: number }[]): Analysis {
  return {
    version: 2,
    fps: 2,
    source: { w: 1920, h: 1080 },
    proxy: { w: 960, h: 540 },
    shots,
    boxes: [],
  }
}

describe('sweepCorpus', () => {
  const savedProjectsDir = process.env.PROJECTS_DIR
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-corpus-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    if (savedProjectsDir === undefined) delete process.env.PROJECTS_DIR
    else process.env.PROJECTS_DIR = savedProjectsDir
  })

  it("ne lève pas et ne rend rien quand le dossier des projets n'existe pas", () => {
    process.env.PROJECTS_DIR = path.join(dir, 'absent')
    const { samples, skipped } = sweepCorpus({ population: 'shots' })
    expect(samples).toEqual([])
    expect(skipped).toEqual([])
  })

  it("range dans `skipped` un projet sans analysis.json, sans l'absorber en silence", () => {
    process.env.PROJECTS_DIR = dir
    fs.mkdirSync(path.join(dir, 'sans-analyse'))
    const { samples, skipped } = sweepCorpus({ population: 'shots' })
    expect(samples).toEqual([])
    expect(skipped).toEqual([{ project: 'sans-analyse', why: expect.stringContaining('analyse absente') }])
  })

  it('rend un échantillon par plan pour un projet analysé', () => {
    process.env.PROJECTS_DIR = dir
    const projectDir = path.join(dir, 'un-projet')
    fs.mkdirSync(projectDir)
    fs.writeFileSync(
      path.join(projectDir, 'analysis.json'),
      JSON.stringify(fixtureAnalysis([{ start: 0, end: 5 }, { start: 5, end: 10 }])),
    )
    const { samples, skipped } = sweepCorpus({ population: 'shots' })
    expect(skipped).toEqual([])
    expect(samples).toHaveLength(2)
    expect(samples.map((s) => s.project)).toEqual(['un-projet', 'un-projet'])
    expect(samples[0].analysisFps).toBe(2)
    expect(samples[0].srcW).toBe(1920)
  })

  it("`population: 'splits'` ne garde que les plans dont `split` est défini", () => {
    process.env.PROJECTS_DIR = dir
    const projectDir = path.join(dir, 'un-projet')
    fs.mkdirSync(projectDir)
    fs.writeFileSync(
      path.join(projectDir, 'analysis.json'),
      JSON.stringify(fixtureAnalysis([{ start: 0, end: 5 }])),
    )
    // Aucune boîte : aucun plan ne splitte. `splits` doit donc rendre zéro
    // échantillon là où `shots` en rend un.
    const shots = sweepCorpus({ population: 'shots' })
    const splits = sweepCorpus({ population: 'splits' })
    expect(shots.samples).toHaveLength(1)
    expect(splits.samples).toHaveLength(0)
  })
})

describe('sourceFramingRequest', () => {
  it(
    "produit `segments: [{ start: 0, end: max(shot.end) }]` — l'idiome unique que " +
      'trois copies dupliquaient avant ce lot',
    () => {
      const analysis = fixtureAnalysis([
        { start: 0, end: 4 },
        { start: 4, end: 9.5 },
        { start: 9.5, end: 12 },
      ])
      const req = sourceFramingRequest(analysis)
      expect(req.segments).toEqual([{ start: 0, end: 12 }])
    },
  )
})
