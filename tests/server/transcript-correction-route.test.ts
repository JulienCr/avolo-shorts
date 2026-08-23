import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GET as getHistory } from '@/app/api/projects/[id]/transcript/correction/route'
import { closeDb, getDb, upsertProject } from '@/server/db'
import { placeSidecar } from '@/server/paths'

/**
 * `GET /api/projects/:id/transcript/correction` — l'historique de la
 * correction automatique (spec §9, correction du 23 août 2026). Le `POST`
 * qui proposait sans écrire n'a plus d'appelant depuis que la correction
 * s'applique d'office pendant l'analyse ; ce fichier ne couvre donc plus que
 * la lecture. `transcript-correction-apply.test.ts` couvre l'écriture,
 * `transcript-correction-propose.test.ts` l'orchestration du modèle.
 */

const SOURCE = '2026-03-08-caro-mdlm.mp4'
const ID = '2026-03-08-caro-mdlm'

let root: string

function context(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-correction-history-route-'))
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
})

describe('GET /api/projects/:id/transcript/correction', () => {
  it('404 sur un projet inconnu', async () => {
    const response = await getHistory(new Request('http://test'), context('inconnu'))
    expect(response.status).toBe(404)
  })

  it("une liste vide, pas une erreur, tant que la correction n'a pas tourné", async () => {
    const response = await getHistory(new Request('http://test'), context(ID))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  it('rend les entrées du journal telles quelles', async () => {
    const placement = placeSidecar(SOURCE, ID)
    fs.writeFileSync(
      placement.correction,
      JSON.stringify({
        nextId: 2,
        entries: [
          { id: '1', lineId: 'l0', from: 3, expected: ['et'], replacement: 'est', timecode: 3 },
        ],
      }),
    )

    const response = await getHistory(new Request('http://test'), context(ID))
    expect(response.status).toBe(200)
    const body = (await response.json()) as unknown[]
    expect(body).toEqual([
      { id: '1', lineId: 'l0', from: 3, expected: ['et'], replacement: 'est', timecode: 3 },
    ])
  })
})
