import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GET as getTranscript, POST as postCorrection } from '@/app/api/projects/[id]/transcript/route'
import type { Clip } from '@/core/edl'
import type { TranscriptLine } from '@/lib/editing'
import { closeDb, getDb, putClip, upsertProject } from '@/server/db'

/**
 * `GET`/`POST /api/projects/:id/transcript`, appelées comme Next les appelle.
 *
 * Les mêmes conventions que `tests/server/api.test.ts` : un `PROJECTS_DIR` de
 * test, un projet posé en base, un transcript posé sur le disque à la forme de
 * WhisperX.
 */

const PROJET = '2026-01-11-méchante'

let racine: string

function contexte(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

function requêtePost(corps: unknown): Request {
  return new Request('http://test/api/projects/x/transcript', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corps),
  })
}

/** Deux phrases, à la forme de WhisperX — comme un vrai `transcript.json`. */
function poserTranscript(): void {
  const dossier = path.join(racine, 'projects', PROJET, `${PROJET}.avolo`)
  fs.mkdirSync(dossier, { recursive: true })
  fs.writeFileSync(
    path.join(dossier, 'transcript.json'),
    JSON.stringify({
      language: 'fr',
      segments: [
        {
          start: 60,
          end: 62,
          text: 'Bonjour à tous',
          words: [
            { word: 'Bonjour', start: 60, end: 60.6 },
            { word: 'à', start: 60.7, end: 60.8 },
            { word: 'tous', start: 60.9, end: 62 },
          ],
        },
        {
          start: 200,
          end: 201,
          text: 'Autre phrase',
          words: [
            { word: 'Autre', start: 200, end: 200.5 },
            { word: 'phrase', start: 200.6, end: 201 },
          ],
        },
      ],
    }),
  )
}

function clipDeBase(): Clip {
  return {
    id: `${PROJET}_000060000-000090000`,
    projectId: PROJET,
    segments: [{ start: 60, end: 90 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'Le canapé',
    description: '',
    status: 'kept',
    pass: 1,
  }
}

beforeEach(() => {
  racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-transcript-route-'))
  process.env.REPLAY_DIR = path.join(racine, 'replays')
  process.env.STAGE_DIR = path.join(racine, 'stage')
  process.env.PROJECTS_DIR = path.join(racine, 'projects')
  fs.mkdirSync(process.env.REPLAY_DIR, { recursive: true })
  fs.writeFileSync(path.join(process.env.REPLAY_DIR, `${PROJET}.mp4`), '')

  upsertProject(getDb(), {
    id: PROJET,
    sourcePath: path.join(racine, 'replays', `${PROJET}.mp4`),
    stagedPath: path.join(racine, 'stage', `${PROJET}.mp4`),
    durationSec: 400,
    sizeBytes: 12,
    mtimeMs: 0,
    createdAt: 1,
  })
})

afterEach(() => {
  closeDb()
  fs.rmSync(racine, { recursive: true, force: true })
})

describe('GET /api/projects/:id/transcript', () => {
  it('rend le transcript entier, pas seulement une fenêtre autour d’un clip', async () => {
    poserTranscript()
    const réponse = await getTranscript(new Request('http://test'), contexte(PROJET))
    expect(réponse.status).toBe(200)
    const lignes = (await réponse.json()) as TranscriptLine[]
    expect(lignes).toHaveLength(2)
    expect(lignes[0]).toEqual({
      id: 'l0',
      start: 60,
      end: 62,
      words: [
        { word: 'Bonjour', start: 60, end: 60.6 },
        { word: 'à', start: 60.7, end: 60.8 },
        { word: 'tous', start: 60.9, end: 62 },
      ],
    })
  })

  it('rend une liste vide sans échouer quand il n’y a pas encore de transcript', async () => {
    const réponse = await getTranscript(new Request('http://test'), contexte(PROJET))
    expect(réponse.status).toBe(200)
    expect(await réponse.json()).toEqual([])
  })

  it('404 sur un projet inconnu', async () => {
    const réponse = await getTranscript(new Request('http://test'), contexte('fantome'))
    expect(réponse.status).toBe(404)
  })
})

describe('POST /api/projects/:id/transcript', () => {
  it('applique une correction et la rend telle qu’écrite', async () => {
    poserTranscript()
    const réponse = await postCorrection(
      requêtePost({ lineId: 'l0', from: 0, to: 0, expected: ['Bonjour'], replacement: ['Salut'] }),
      contexte(PROJET),
    )
    expect(réponse.status).toBe(200)
    const body = (await réponse.json()) as { line: TranscriptLine; clipsTouched: { id: string; title: string }[] }
    expect(body.line.words[0]).toEqual({ word: 'Salut', start: 60, end: 60.6 })

    // Se relit vraiment sur le disque, pas seulement dans la réponse.
    const relu = await getTranscript(new Request('http://test'), contexte(PROJET))
    const lignes = (await relu.json()) as TranscriptLine[]
    expect(lignes[0].words[0].word).toBe('Salut')
  })

  it('nomme les clips touchés par la phrase corrigée', async () => {
    poserTranscript()
    const db = getDb()
    putClip(db, clipDeBase())

    const réponse = await postCorrection(
      requêtePost({ lineId: 'l0', from: 0, to: 0, expected: ['Bonjour'], replacement: ['Salut'] }),
      contexte(PROJET),
    )
    const body = (await réponse.json()) as { clipsTouched: { id: string; title: string }[] }
    expect(body.clipsTouched).toEqual([{ id: clipDeBase().id, title: 'Le canapé' }])
  })

  it('ne nomme pas un clip que la phrase ne recouvre pas', async () => {
    poserTranscript()
    const db = getDb()
    putClip(db, clipDeBase())

    // La seconde phrase (200-201) est hors du clip (60-90).
    const réponse = await postCorrection(
      requêtePost({ lineId: 'l1', from: 0, to: 0, expected: ['Autre'], replacement: ['Une'] }),
      contexte(PROJET),
    )
    const body = (await réponse.json()) as { clipsTouched: { id: string; title: string }[] }
    expect(body.clipsTouched).toEqual([])
  })

  it('409 sur une ancre qui ne correspond plus', async () => {
    poserTranscript()
    const réponse = await postCorrection(
      requêtePost({ lineId: 'l0', from: 0, to: 0, expected: ['pas-le-bon-mot'], replacement: ['x'] }),
      contexte(PROJET),
    )
    expect(réponse.status).toBe(409)
  })

  it('404 sur une phrase inconnue', async () => {
    poserTranscript()
    const réponse = await postCorrection(
      requêtePost({ lineId: 'l99', from: 0, to: 0, expected: ['x'], replacement: ['y'] }),
      contexte(PROJET),
    )
    expect(réponse.status).toBe(404)
  })

  it('404 sur un projet inconnu', async () => {
    const réponse = await postCorrection(
      requêtePost({ lineId: 'l0', from: 0, to: 0, expected: [], replacement: [] }),
      contexte('fantome'),
    )
    expect(réponse.status).toBe(404)
  })

  it('400 sur un corps mal formé', async () => {
    const réponse = await postCorrection(requêtePost({ lineId: 'l0' }), contexte(PROJET))
    expect(réponse.status).toBe(400)
  })
})
