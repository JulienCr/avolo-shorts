import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Project } from '@/server/db'
import { placeSidecar } from '@/server/paths'
import { undoCorrectionEntry, readCorrectionLog } from '@/server/steps/transcript-correction'
import type { CorrectionLog } from '@/core/correction'

/**
 * `undoCorrectionEntry` — l'inverse d'une substitution, par le même chemin
 * d'écriture que la correction manuelle (`correctTranscript`), mêmes gardes.
 *
 * **Ces tests touchent au disque**, comme `transcript-correction.test.ts` :
 * l'atomicité et la relecture après écriture sont des questions d'écriture
 * réelle.
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-undo-'))
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

describe('undoCorrectionEntry', () => {
  it('un identifiant inconnu est un refus nommé', async () => {
    writeTranscript(['a'])
    writeLog({ nextId: 1, entries: [] })
    const outcome = await undoCorrectionEntry(project, 'jamais-vu')
    expect(outcome).toEqual({ ok: false, reason: 'unknown-entry' })
  })

  it('rien à défaire quand le journal n’existe pas encore', async () => {
    writeTranscript(['a'])
    const outcome = await undoCorrectionEntry(project, 'x')
    expect(outcome).toEqual({ ok: false, reason: 'unknown-entry' })
  })

  it('retire la substitution du fichier et du transcript', async () => {
    writeTranscript(['à', 'suite'])
    writeLog({
      nextId: 2,
      entries: [{ id: '1', lineId: 'l0', from: 0, expected: ['a'], replacement: 'à', timecode: 0 }],
    })

    const outcome = await undoCorrectionEntry(project, '1')
    expect(outcome.ok).toBe(true)
    expect(readTranscriptWords()).toEqual(['a', 'suite'])
    expect(readCorrectionLog(project).entries).toEqual([])
  })

  it('refuse quand le texte a changé sous les yeux', async () => {
    // L'entrée dit que le mot actuel est « à » ; le disque porte autre chose —
    // une correction manuelle est passée entretemps, par exemple.
    writeTranscript(['autre chose', 'suite'])
    writeLog({
      nextId: 2,
      entries: [{ id: '1', lineId: 'l0', from: 0, expected: ['a'], replacement: 'à', timecode: 0 }],
    })

    const outcome = await undoCorrectionEntry(project, '1')
    expect(outcome).toEqual({ ok: false, reason: 'anchor-mismatch' })
    // Le journal n'a pas bougé : rien n'a été écrit sur la promesse d'un
    // défaire qui a en réalité échoué.
    expect(readCorrectionLog(project).entries).toHaveLength(1)
  })

  it('409 quand une exécution est en cours', async () => {
    writeTranscript(['à'])
    writeLog({
      nextId: 2,
      entries: [{ id: '1', lineId: 'l0', from: 0, expected: ['a'], replacement: 'à', timecode: 0 }],
    })

    const outcome = await undoCorrectionEntry(project, '1', () => true)
    expect(outcome).toEqual({ ok: false, reason: 'run-in-progress' })
    expect(readCorrectionLog(project).entries).toHaveLength(1)
  })

  // La propriété centrale de la review du plan : défaire une fusion recalcule
  // les entrées voisines de la même phrase, il ne les jette pas — elles
  // restent défaisables, à la bonne position, sur deux défaires enchaînés.
  it('recalcule les entrées voisines après avoir défait une fusion', async () => {
    // État courant, après deux corrections déjà appliquées sur la même
    // phrase : `a` -> `à` (simple), `deux mots` -> `deuxmots` (fusion,
    // 2 mots -> 1), `y` -> `x` (simple, plus loin dans la phrase).
    writeTranscript(['à', 'deuxmots', 'x'])
    writeLog({
      nextId: 4,
      entries: [
        { id: 'A', lineId: 'l0', from: 0, expected: ['a'], replacement: 'à', timecode: 0 },
        { id: 'B', lineId: 'l0', from: 1, expected: ['deux', 'mots'], replacement: 'deuxmots', timecode: 1 },
        { id: 'C', lineId: 'l0', from: 2, expected: ['y'], replacement: 'x', timecode: 2 },
      ],
    })

    // Défaire la fusion réinsère un mot : la phrase grandit de 1, et tout ce
    // qui la suit — ici, seulement C — doit avancer d'autant.
    const first = await undoCorrectionEntry(project, 'B')
    expect(first.ok).toBe(true)
    expect(readTranscriptWords()).toEqual(['à', 'deux', 'mots', 'x'])

    const afterFirst = readCorrectionLog(project).entries
    expect(afterFirst.find((e) => e.id === 'A')).toMatchObject({ from: 0 })
    expect(afterFirst.find((e) => e.id === 'B')).toBeUndefined()
    expect(afterFirst.find((e) => e.id === 'C')).toMatchObject({ from: 3 })

    // Défaire C, à sa position recalculée, retrouve bien le bon mot.
    const second = await undoCorrectionEntry(project, 'C')
    expect(second.ok).toBe(true)
    expect(readTranscriptWords()).toEqual(['à', 'deux', 'mots', 'y'])

    const afterSecond = readCorrectionLog(project).entries
    expect(afterSecond).toEqual([{ id: 'A', lineId: 'l0', from: 0, expected: ['a'], replacement: 'à', timecode: 0 }])
  })
})
