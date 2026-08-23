import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST as postUndo } from '@/app/api/projects/[id]/transcript/correction/undo/route'
import { closeDb, getDb, upsertProject } from '@/server/db'
import { placeSidecar } from '@/server/paths'
import * as run from '@/server/run'

/**
 * `POST /api/projects/:id/transcript/correction/undo` — les garanties propres
 * à la route : 404, 409, la forme de la réponse. `undoCorrectionEntry`
 * (`transcript-correction-undo.test.ts`) couvre déjà l'inversion elle-même —
 * l'ancre, le recalcul des entrées voisines.
 */

const SOURCE = '2026-03-08-caro-mdlm.mp4'
const ID = '2026-03-08-caro-mdlm'

let root: string

function context(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

function request(body: unknown): Request {
  return new Request('http://test', { method: 'POST', body: JSON.stringify(body) })
}

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

function writeLog(): void {
  const placement = placeSidecar(SOURCE, ID)
  fs.writeFileSync(
    placement.correction,
    JSON.stringify({
      entries: [{ id: '1', lineId: 'l0', from: 0, expected: ['a'], replacement: 'à', timecode: 0 }],
    }),
  )
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-undo-route-'))
  const replay = path.join(root, 'Replay')
  const stage = path.join(root, 'stage')
  const projects = path.join(root, 'projects')
  for (const d of [replay, stage, projects]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(replay, SOURCE), 'pas vraiment une vidéo')

  process.env.REPLAY_DIR = replay
  process.env.STAGE_DIR = stage
  process.env.PROJECTS_DIR = projects

  upsertProject(getDb(), {
    id: ID,
    sourcePath: SOURCE,
    stagedPath: path.join(stage, SOURCE),
    durationSec: 100,
    sizeBytes: 1,
    mtimeMs: 0,
    createdAt: 0,
  })
})

afterEach(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('POST /api/projects/:id/transcript/correction/undo', () => {
  it('404 sur un projet inconnu', async () => {
    const response = await postUndo(request({ id: '1' }), context('inconnu'))
    expect(response.status).toBe(404)
  })

  it('404 sur un identifiant d’entrée inconnu', async () => {
    writeTranscript(['à'])
    writeLog()
    const response = await postUndo(request({ id: 'jamais-vu' }), context(ID))
    expect(response.status).toBe(404)
  })

  it('409 quand une exécution est en cours pour ce projet', async () => {
    writeTranscript(['à'])
    writeLog()
    const spy = vi.spyOn(run, 'progression').mockReturnValue({ step: 'transcript', progress: 0.4 })
    try {
      const response = await postUndo(request({ id: '1' }), context(ID))
      expect(response.status).toBe(409)
    } finally {
      spy.mockRestore()
    }
  })

  it('défait la substitution et rend le journal et les clips touchés', async () => {
    writeTranscript(['à'])
    writeLog()

    const response = await postUndo(request({ id: '1' }), context(ID))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { entries: unknown[]; clipsTouched: unknown[] }
    expect(body.entries).toEqual([])
    expect(body.clipsTouched).toEqual([])
  })
})
