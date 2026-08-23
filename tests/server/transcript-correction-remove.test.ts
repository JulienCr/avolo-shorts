import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Project } from '@/server/db'
import { placeSidecar } from '@/server/paths'
import { removeCorrectionEntry, undoCorrectionEntry, readCorrectionLog } from '@/server/steps/transcript-correction'
import { ExecutionInCurrentError } from '@/server/run'
import type { CorrectionLog } from '@/core/correction'

/**
 * `removeCorrectionEntry` — le rattrapage de dernier recours (issues #134,
 * #138) pour une entrée dont l'ancre est devenue périmée et dont
 * `undoCorrectionEntry` ne peut plus rien faire.
 *
 * **Ces tests touchent au disque**, comme `transcript-correction-undo.test.ts` :
 * l'écriture réelle est ce qui compte.
 */

const SOURCE = '2026-03-08-caro-mdlm.mp4'
const ID = '2026-03-08-caro-mdlm'

let root: string
let project: Project

function writeTranscript(words: string[]): void {
  const placement = placeSidecar(SOURCE, ID)
  fs.writeFileSync(
    placement.transcript,
    JSON.stringify({
      language: 'fr',
      segments: [
        {
          start: 0,
          end: words.length,
          text: words.join(' '),
          words: words.map((word, i) => ({ word, start: i, end: i + 1 })),
        },
      ],
    }),
  )
}

function writeLog(log: CorrectionLog): void {
  const placement = placeSidecar(SOURCE, ID)
  fs.writeFileSync(placement.correction, JSON.stringify(log))
}

function readTranscriptWords(): string[] {
  const placement = placeSidecar(SOURCE, ID)
  const raw = JSON.parse(fs.readFileSync(placement.transcript, 'utf8')) as {
    segments: { words: { word: string }[] }[]
  }
  return raw.segments[0].words.map((w) => w.word)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-remove-'))
  const replay = path.join(root, 'Replay')
  const stage = path.join(root, 'stage')
  const projects = path.join(root, 'projects')
  for (const d of [replay, stage, projects]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(replay, SOURCE), 'pas vraiment une vidéo')

  process.env.REPLAY_DIR = replay
  process.env.STAGE_DIR = stage
  process.env.PROJECTS_DIR = projects

  project = {
    id: ID,
    sourcePath: SOURCE,
    stagedPath: path.join(stage, SOURCE),
    durationSec: 100,
    sizeBytes: 1,
    mtimeMs: 0,
    createdAt: 0,
  } as Project
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('removeCorrectionEntry', () => {
  it('un identifiant inconnu est un refus nommé', async () => {
    writeTranscript(['a'])
    writeLog({ entries: [] })
    const outcome = await removeCorrectionEntry(project, 'jamais-vu')
    expect(outcome).toEqual({ ok: false, reason: 'unknown-entry' })
  })

  it('retire une entrée bloquée par une correction manuelle antérieure (#138), sans toucher au transcript', async () => {
    // Le scénario de l'issue : une correction manuelle a inséré un mot plus
    // tôt dans la phrase sans jamais recaler le journal — `from: 1` désigne
    // maintenant un autre mot que celui que l'entrée croit corriger.
    writeTranscript(['inséré', 'autrechose', 'suite'])
    writeLog({
      entries: [{ id: 'A', lineId: 'l0', from: 1, expected: ['a'], replacement: 'à', timecode: 0 }],
    })

    // `undoCorrectionEntry` refuse pour toujours : c'est le symptôme de
    // l'issue, pas ce que ce test vérifie.
    const undone = await undoCorrectionEntry(project, 'A')
    expect(undone).toEqual({ ok: false, reason: 'anchor-mismatch' })

    const outcome = await removeCorrectionEntry(project, 'A')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.entries).toEqual([])
    // Rien n'a bougé sur le disque : ce geste ne touche que le journal.
    expect(readTranscriptWords()).toEqual(['inséré', 'autrechose', 'suite'])
    expect((await readCorrectionLog(project)).entries).toEqual([])
  })

  it('refuse juste avant d’écrire si une exécution démarre entre-temps (relevé par Codex, PR #143)', async () => {
    // Le point d'appel (`route.ts`) vérifie `progression` une fois, avant
    // d'attendre la sonde `editingResponds` puis de lire/écrire le journal —
    // une fenêtre où une retranscription peut démarrer. `removeCorrectionEntry`
    // doit donc revérifier lui-même, juste avant l'écriture, plutôt que
    // faire confiance à une garde posée plus tôt par l'appelant.
    writeTranscript(['a'])
    writeLog({
      entries: [{ id: 'A', lineId: 'l0', from: 0, expected: ['x'], replacement: 'a', timecode: 0 }],
    })

    await expect(removeCorrectionEntry(project, 'A', () => true)).rejects.toThrow(ExecutionInCurrentError)
    // Rien n'a été écrit : l'entrée est toujours là.
    expect((await readCorrectionLog(project)).entries.map((e) => e.id)).toEqual(['A'])
  })

  it('laisse les autres entrées intactes', async () => {
    writeTranscript(['à', 'x'])
    writeLog({
      entries: [
        { id: 'A', lineId: 'l0', from: 0, expected: ['a'], replacement: 'à', timecode: 0 },
        { id: 'B', lineId: 'l0', from: 1, expected: ['y'], replacement: 'x', timecode: 1 },
      ],
    })

    const outcome = await removeCorrectionEntry(project, 'A')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.entries.map((e) => e.id)).toEqual(['B'])
  })
})
