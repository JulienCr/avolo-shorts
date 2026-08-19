import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Project } from '@/server/db'
import { placeSidecar } from '@/server/paths'
import { correctTranscript } from '@/server/steps/transcript'

/**
 * La correction manuelle, écrite sur un vrai sidecar.
 *
 * **Ces tests touchent au disque**, comme ceux de `paths.test.ts` : le repli du
 * sidecar et la relecture après écriture sont des questions d'écriture réelle,
 * pas de bits de permission ni de mock. `correctTranscript` promet de se
 * relire avant de rendre la main — un test qui simulerait `fs` ne prouverait
 * rien de cette promesse-là.
 */

const SOURCE = '2026-03-08-caro-mdlm.mp4'
const ID = '2026-03-08-caro-mdlm'

let root: string
let replay: string
let project: Project
const initialEnv = { ...process.env }

function writeTranscript(segments: unknown[]): void {
  const placement = placeSidecar(SOURCE, ID)
  fs.writeFileSync(placement.transcript, JSON.stringify({ language: 'fr', segments }, null, 2))
}

function readFile(): { language: string; segments: { start: number; end: number; text: string; words: unknown[] }[] } {
  const placement = placeSidecar(SOURCE, ID)
  return JSON.parse(fs.readFileSync(placement.transcript, 'utf8'))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-correction-'))
  replay = path.join(root, 'Replay')
  const stage = path.join(root, 'stage')
  const projets = path.join(root, 'projects')
  for (const d of [replay, stage, projets]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(replay, SOURCE), 'pas vraiment une vidéo')

  process.env.REPLAY_DIR = replay
  process.env.STAGE_DIR = stage
  process.env.PROJECTS_DIR = projets

  project = {
    id: ID,
    sourcePath: SOURCE,
    stagedPath: path.join(stage, SOURCE),
    durationSec: 100,
    sizeBytes: 1,
    mtimeMs: 0,
    createdAt: 0,
  } as Project

  writeTranscript([
    {
      start: 10,
      end: 12,
      text: 'Bonjour à tous',
      words: [
        { word: 'Bonjour', start: 10, end: 10.6 },
        { word: 'à', start: 10.7, end: 10.8 },
        { word: 'tous', start: 10.9, end: 12 },
      ],
    },
    {
      start: 20,
      end: 21,
      text: 'Deuxième phrase',
      words: [
        { word: 'Deuxième', start: 20, end: 20.5 },
        { word: 'phrase', start: 20.6, end: 21 },
      ],
    },
  ])
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  process.env = { ...initialEnv }
})

describe('correctTranscript', () => {
  it('corrige un mot, sans toucher aux timings de la phrase', async () => {
    const result = await correctTranscript(project, 'l0', {
      from: 0,
      to: 0,
      expected: ['Bonjour'],
      replacement: ['Salut'],
    })
    expect(result).toEqual({
      ok: true,
      line: {
        id: 'l0',
        start: 10,
        end: 12,
        words: [
          { word: 'Salut', start: 10, end: 10.6 },
          { word: 'à', start: 10.7, end: 10.8 },
          { word: 'tous', start: 10.9, end: 12 },
        ],
      },
      correctedSpan: { start: 10, end: 10.6 },
    })
  })

  it('écrit la correction sur le disque, et le texte suit les mots', async () => {
    await correctTranscript(project, 'l0', {
      from: 0,
      to: 0,
      expected: ['Bonjour'],
      replacement: ['Salut'],
    })
    const file = readFile()
    expect(file.segments[0].text).toBe('Salut à tous')
    expect(file.segments[0].words).toEqual([
      { word: 'Salut', start: 10, end: 10.6 },
      { word: 'à', start: 10.7, end: 10.8 },
      { word: 'tous', start: 10.9, end: 12 },
    ])
    // La phrase voisine n'a pas bougé.
    expect(file.segments[1].text).toBe('Deuxième phrase')
  })

  it('ne touche pas au start/end du segment, même quand le premier mot change', async () => {
    await correctTranscript(project, 'l0', {
      from: 0,
      to: 0,
      expected: ['Bonjour'],
      replacement: [],
    })
    const file = readFile()
    expect(file.segments[0].start).toBe(10)
    expect(file.segments[0].end).toBe(12)
  })

  it('refuse une ancre qui ne correspond plus, sans rien écrire', async () => {
    const result = await correctTranscript(project, 'l0', {
      from: 0,
      to: 0,
      expected: ['pas-le-bon-mot'],
      replacement: ['x'],
    })
    expect(result).toEqual({ ok: false, reason: 'anchor-mismatch' })
    expect(readFile().segments[0].words[0]).toEqual({ word: 'Bonjour', start: 10, end: 10.6 })
  })

  it("refuse un identifiant de phrase qui n'existe pas", async () => {
    const result = await correctTranscript(project, 'l99', {
      from: 0,
      to: 0,
      expected: ['Bonjour'],
      replacement: ['x'],
    })
    expect(result).toEqual({ ok: false, reason: 'unknown-line' })
  })

  it("rend 'no-transcript' quand le sidecar n'existe pas encore", async () => {
    const placement = placeSidecar(SOURCE, ID)
    fs.rmSync(placement.transcript, { force: true })
    const result = await correctTranscript(project, 'l0', {
      from: 0,
      to: 0,
      expected: ['Bonjour'],
      replacement: ['x'],
    })
    expect(result).toEqual({ ok: false, reason: 'no-transcript' })
  })

  it('scinde un mot en deux mots qui se partagent son empan', async () => {
    const result = await correctTranscript(project, 'l1', {
      from: 0,
      to: 0,
      expected: ['Deuxième'],
      replacement: ['Deux', 'ième'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('inattendu')
    expect(result.line.words[0].start).toBe(20)
    expect(result.line.words[1].end).toBe(20.5)
    expect(result.line.words.map((w) => w.word)).toEqual(['Deux', 'ième', 'phrase'])
  })

  it('ne retire pas un mot non aligné ni un champ additionnel des phrases non corrigées', async () => {
    const placement = placeSidecar(SOURCE, ID)
    fs.writeFileSync(
      placement.transcript,
      JSON.stringify({
        language: 'fr',
        segments: [
          {
            start: 10,
            end: 12,
            text: 'Bonjour à tous',
            words: [
              { word: 'Bonjour', start: 10, end: 10.6 },
              { word: 'à', start: 10.7, end: 10.8 },
              { word: 'tous', start: 10.9, end: 12 },
            ],
          },
          {
            start: 20,
            end: 21,
            text: 'Deuxième phrase 3',
            speaker: 'SPEAKER_01',
            words: [
              { word: 'Deuxième', start: 20, end: 20.5 },
              { word: 'phrase', start: 20.6, end: 21 },
              // Mot sans horodatage : WhisperX en émet pour les chiffres et
              // la ponctuation non alignés. `lireTranscript` l'écarterait.
              { word: '3', probability: 0.12 },
            ],
          },
        ],
      }),
    )

    const result = await correctTranscript(project, 'l0', {
      from: 0,
      to: 0,
      expected: ['Bonjour'],
      replacement: ['Salut'],
    })
    expect(result.ok).toBe(true)

    const file = readFile() as { segments: Record<string, unknown>[] }
    expect(file.segments[1].words).toEqual([
      { word: 'Deuxième', start: 20, end: 20.5 },
      { word: 'phrase', start: 20.6, end: 21 },
      { word: '3', probability: 0.12 },
    ])
    expect(file.segments[1].speaker).toBe('SPEAKER_01')
  })

  it('deux corrections lancées ensemble sur des phrases différentes tiennent toutes les deux', async () => {
    const [first, second] = await Promise.all([
      correctTranscript(project, 'l0', { from: 0, to: 0, expected: ['Bonjour'], replacement: ['Salut'] }),
      correctTranscript(project, 'l1', { from: 0, to: 0, expected: ['Deuxième'], replacement: ['Seconde'] }),
    ])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)

    const file = readFile()
    expect(file.segments[0].text).toBe('Salut à tous')
    expect(file.segments[1].text).toBe('Seconde phrase')
  })
})
