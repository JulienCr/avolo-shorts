import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST as postProposal } from '@/app/api/projects/[id]/transcript/correction/route'
import { applySettings, closeDb, getDb, upsertProject } from '@/server/db'
import { placeSidecar } from '@/server/paths'
import * as run from '@/server/run'

vi.mock('@/server/run', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/run')>()
  return { ...original }
})

/**
 * `POST /api/projects/:id/transcript/correction` — les garanties opérationnelles
 * propres à cette route : 404 sans projet ou sans transcript, 409 pendant une
 * exécution, et la traduction de la réponse HTTP. `transcript-correction-propose.test.ts`
 * couvre déjà l'orchestration elle-même (empans, offsets, refus, arrêt).
 */

const SOURCE = '2026-03-08-caro-mdlm.mp4'
const ID = '2026-03-08-caro-mdlm'

let root: string

function context(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
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

function ollamaResponse(corrections: unknown[]): Response {
  return new Response(JSON.stringify({ message: { content: JSON.stringify({ corrections }) } }), {
    status: 200,
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-propose-route-'))
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

  applySettings(getDb(), { ai: { correctionProvider: 'ollama', ollamaBaseUrl: 'http://127.0.0.1:11434' } })
})

afterEach(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('POST /api/projects/:id/transcript/correction', () => {
  it('404 sur un projet inconnu', async () => {
    const response = await postProposal(new Request('http://test', { method: 'POST' }), context('inconnu'))
    expect(response.status).toBe(404)
  })

  it("404 quand le projet n'a pas encore de transcript", async () => {
    const response = await postProposal(new Request('http://test', { method: 'POST' }), context(ID))
    expect(response.status).toBe(404)
  })

  it('409 quand une exécution est en cours pour ce projet', async () => {
    writeTranscript(['Bonjour', 'à', 'tous'])
    const spy = vi.spyOn(run, 'progression').mockReturnValue({ step: 'transcript', progress: 0.4 })
    try {
      const response = await postProposal(new Request('http://test', { method: 'POST' }), context(ID))
      expect(response.status).toBe(409)
    } finally {
      spy.mockRestore()
    }
  })

  it('rend les propositions et le compte des refus, sans rien écrire', async () => {
    const words = ['Bonjour', 'à', 'tous', 'et', 'bienvenue']
    writeTranscript(words)
    const fetchMock = vi.fn().mockResolvedValueOnce(ollamaResponse([{ i: 3, w: 'est' }]))
    vi.stubGlobal('fetch', fetchMock)

    const response = await postProposal(new Request('http://test', { method: 'POST' }), context(ID))
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      proposals: { request: { lineId: string; from: number; to: number }; original: string; replacement: string }[]
      rejected: Record<string, number>
    }
    expect(body.proposals).toHaveLength(1)
    expect(body.proposals[0]).toMatchObject({
      request: { lineId: 'l0', from: 3, to: 3 },
      original: 'et',
      replacement: 'est',
    })
    expect(body.rejected).toEqual({})

    // Rien n'est écrit : le sidecar porte encore le texte d'origine.
    const placement = placeSidecar(SOURCE, ID)
    const onDisk = JSON.parse(fs.readFileSync(placement.transcript, 'utf8')) as { segments: { text: string }[] }
    expect(onDisk.segments[0].text).toBe(words.join(' '))
  })
})
