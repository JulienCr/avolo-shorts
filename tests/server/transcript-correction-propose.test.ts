import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '@/server/db'
import { applySettings, closeDb, getDb, upsertProject } from '@/server/db'
import { placeSidecar } from '@/server/paths'
import { proposeTranscriptCorrections } from '@/server/steps/transcript-correction'

/**
 * `proposeTranscriptCorrections` — l'orchestration de la correction par
 * modèle (spec §9, étage 2), distincte de `correctTranscript` (l'écriture
 * manuelle, déjà couverte par `transcript-correction.test.ts`) : découpe en
 * empans, traduction des offsets, refus agrégés, arrêt entre deux empans.
 *
 * **Ollama, pas Gemini** — même raison qu'`hook.test.ts` : pas de clé à
 * fournir, et une adresse fixe pour ne pas faire résoudre la passerelle WSL.
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

function ollamaResponse(corrections: unknown[]): Response {
  return new Response(JSON.stringify({ message: { content: JSON.stringify({ corrections }) } }), {
    status: 200,
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-propose-'))
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
  upsertProject(getDb(), project)

  applySettings(getDb(), { ai: { correctionProvider: 'ollama', ollamaBaseUrl: 'http://127.0.0.1:11434' } })
})

afterEach(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('proposeTranscriptCorrections', () => {
  it('rend no-transcript sans sidecar', async () => {
    const outcome = await proposeTranscriptCorrections(getDb(), project)
    expect(outcome).toEqual({ ok: false, reason: 'no-transcript' })
  })

  it('découpe en empans de 120 mots et traduit les offsets du second empan', async () => {
    // 130 mots : deux empans, [0,120) et [120,130). Le mot à corriger est
    // le 6e du second empan (index global 125) — sa correction doit revenir
    // avec `from`/`to` à l'index global, pas à l'index local à l'empan.
    const words = Array.from({ length: 130 }, () => 'mot')
    words[125] = 'et'
    writeTranscript(words)

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ollamaResponse([])) // premier empan : rien à corriger
      .mockResolvedValueOnce(ollamaResponse([{ i: 5, w: 'est' }])) // 120+5 = 125
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await proposeTranscriptCorrections(getDb(), project)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(outcome.proposals).toHaveLength(1)
    expect(outcome.proposals[0]).toMatchObject({
      lineId: 'l0',
      original: 'et',
      replacement: 'est',
      correction: { from: 125, to: 125 },
    })
  })

  it('agrège les refus par catégorie', async () => {
    const words = Array.from({ length: 10 }, () => 'mot')
    writeTranscript(words)

    // `w` vide : refusé structurellement, avant même la garde phonétique.
    const fetchMock = vi.fn().mockResolvedValueOnce(ollamaResponse([{ i: 0, w: '' }]))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await proposeTranscriptCorrections(getDb(), project)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.proposals).toHaveLength(0)
    expect(outcome.rejected).toEqual({ 'empty-word': 1 })
  })

  it('arrête avant l’empan suivant si une exécution démarre entre-temps', async () => {
    const words = Array.from({ length: 130 }, () => 'mot')
    writeTranscript(words)

    const fetchMock = vi.fn().mockResolvedValueOnce(ollamaResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    let calls = 0
    const isRunning = (): boolean => {
      calls += 1
      return calls > 1 // libre pour le premier empan, prise juste après
    }

    await expect(proposeTranscriptCorrections(getDb(), project, { isRunning })).rejects.toThrow(
      /exécution est déjà en cours/,
    )
    // Le second empan n'a jamais atteint le modèle : la sonde a arrêté avant.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
