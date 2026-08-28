import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET as getTranscript, POST as postCorrection } from '@/app/api/projects/[id]/transcript/route'
import type { Clip } from '@/core/edl'
import type { TranscriptLine } from '@/lib/editing'
import { closeDb, getDb, putClip, upsertProject } from '@/server/db'
import * as run from '@/server/run'

/**
 * `progression` reste la vraie implémentation par défaut (`inCurrent` est vide
 * en test) ; un seul test la remplace (`vi.spyOn`) pour simuler une exécution
 * en cours, sans avoir à faire tourner `launch()` pour de vrai.
 */
vi.mock('@/server/run', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/run')>()
  return { ...original }
})

/**
 * `GET`/`POST /api/projects/:id/transcript`, appelées comme Next les appelle.
 *
 * Les mêmes conventions que `tests/server/api.test.ts` : un `PROJECTS_DIR` de
 * test, un projet posé en base, un transcript posé sur le disque à la forme de
 * WhisperX.
 */

const PROJECT = '2026-01-11-méchante'

let root: string

function context(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

function postRequest(body: unknown): Request {
  return new Request('http://test/api/projects/x/transcript', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Deux phrases, à la forme de WhisperX — comme un vrai `transcript.json`. */
function writeTranscriptFixture(): void {
  const dir = path.join(root, 'projects', PROJECT, `${PROJECT}.avolo`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'transcript.json'),
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

function baseClip(): Clip {
  return {
    id: `${PROJECT}_000060000-000090000`,
    projectId: PROJECT,
    segments: [{ start: 60, end: 90 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    footer: true,
    title: 'Le canapé',
    description: '',
    status: 'kept',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-transcript-route-'))
  process.env.REPLAY_DIR = path.join(root, 'replays')
  process.env.STAGE_DIR = path.join(root, 'stage')
  process.env.PROJECTS_DIR = path.join(root, 'projects')
  fs.mkdirSync(process.env.REPLAY_DIR, { recursive: true })
  fs.writeFileSync(path.join(process.env.REPLAY_DIR, `${PROJECT}.mp4`), '')

  upsertProject(getDb(), {
    id: PROJECT,
    sourcePath: path.join(root, 'replays', `${PROJECT}.mp4`),
    stagedPath: path.join(root, 'stage', `${PROJECT}.mp4`),
    durationSec: 400,
    sizeBytes: 12,
    mtimeMs: 0,
    createdAt: 1,
  })
})

afterEach(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('GET /api/projects/:id/transcript', () => {
  it('rend le transcript entier, pas seulement une fenêtre autour d’un clip', async () => {
    writeTranscriptFixture()
    const response = await getTranscript(new Request('http://test'), context(PROJECT))
    expect(response.status).toBe(200)
    const lines = (await response.json()) as TranscriptLine[]
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({
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
    const response = await getTranscript(new Request('http://test'), context(PROJECT))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  it('404 sur un projet inconnu', async () => {
    const response = await getTranscript(new Request('http://test'), context('fantome'))
    expect(response.status).toBe(404)
  })
})

describe('POST /api/projects/:id/transcript', () => {
  it('applique une correction et la rend telle qu’écrite', async () => {
    writeTranscriptFixture()
    const response = await postCorrection(
      postRequest({ lineId: 'l0', from: 0, to: 0, expected: ['Bonjour'], replacement: ['Salut'] }),
      context(PROJECT),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { line: TranscriptLine; clipsTouched: { id: string; title: string }[] }
    expect(body.line.words[0]).toEqual({ word: 'Salut', start: 60, end: 60.6 })

    // Se relit vraiment sur le disque, pas seulement dans ce que la route rend.
    const reread = await getTranscript(new Request('http://test'), context(PROJECT))
    const lines = (await reread.json()) as TranscriptLine[]
    expect(lines[0].words[0].word).toBe('Salut')
  })

  it('409 quand une retranscription est en cours pour ce projet', async () => {
    writeTranscriptFixture()
    const spy = vi.spyOn(run, 'progression').mockReturnValue({ step: 'transcript', progress: 0.4 })
    try {
      const response = await postCorrection(
        postRequest({ lineId: 'l0', from: 0, to: 0, expected: ['Bonjour'], replacement: ['Salut'] }),
        context(PROJECT),
      )
      expect(response.status).toBe(409)

      // Rien n'a été écrit : le refus arrive avant toute lecture du sidecar.
      const reread = await getTranscript(new Request('http://test'), context(PROJECT))
      const lines = (await reread.json()) as TranscriptLine[]
      expect(lines[0].words[0].word).toBe('Bonjour')
    } finally {
      spy.mockRestore()
    }
  })

  it('409 quand une exécution démarre entre le premier refus et l’écriture', async () => {
    // Le premier appel (dans la route) rend `null` : la requête passe la
    // première garde. Le second (dans `correctTranscript`, juste avant
    // l'écriture) rend un état en cours : c'est la seconde sonde qui doit
    // refuser, pas la première.
    writeTranscriptFixture()
    const spy = vi
      .spyOn(run, 'progression')
      .mockReturnValueOnce(null)
      .mockReturnValue({ step: 'transcript', progress: 0.1 })
    try {
      const response = await postCorrection(
        postRequest({ lineId: 'l0', from: 0, to: 0, expected: ['Bonjour'], replacement: ['Salut'] }),
        context(PROJECT),
      )
      expect(response.status).toBe(409)

      const reread = await getTranscript(new Request('http://test'), context(PROJECT))
      const lines = (await reread.json()) as TranscriptLine[]
      expect(lines[0].words[0].word).toBe('Bonjour')
    } finally {
      spy.mockRestore()
    }
  })

  it('nomme les clips touchés par la phrase corrigée', async () => {
    writeTranscriptFixture()
    const db = getDb()
    putClip(db, baseClip())

    const response = await postCorrection(
      postRequest({ lineId: 'l0', from: 0, to: 0, expected: ['Bonjour'], replacement: ['Salut'] }),
      context(PROJECT),
    )
    const body = (await response.json()) as { clipsTouched: { id: string; title: string }[] }
    expect(body.clipsTouched).toEqual([{ id: baseClip().id, title: 'Le canapé' }])
  })

  it('ne nomme pas un clip sans sous-titres incrustés — la correction ne périme aucun rendu', async () => {
    writeTranscriptFixture()
    const db = getDb()
    putClip(db, { ...baseClip(), captions: false })

    const response = await postCorrection(
      postRequest({ lineId: 'l0', from: 0, to: 0, expected: ['Bonjour'], replacement: ['Salut'] }),
      context(PROJECT),
    )
    const body = (await response.json()) as { clipsTouched: { id: string; title: string }[] }
    expect(body.clipsTouched).toEqual([])
  })

  it('ne nomme pas un clip que seule l’enveloppe de la phrase recouvre, pas le mot corrigé', async () => {
    // Une phrase longue (60-160 s) dont on corrige le dernier mot, à 159 s.
    // Un clip limité à son tout début (60-70 s) ne doit pas être signalé :
    // seul l'empan réellement corrigé compte, pas toute l'enveloppe.
    const dir = path.join(root, 'projects', PROJECT, `${PROJECT}.avolo`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'transcript.json'),
      JSON.stringify({
        language: 'fr',
        segments: [
          {
            start: 60,
            end: 160,
            text: 'Une longue phrase qui finit tard',
            words: [
              { word: 'Une', start: 60, end: 60.5 },
              { word: 'longue', start: 60.6, end: 61 },
              { word: 'phrase', start: 61.1, end: 61.5 },
              { word: 'qui', start: 61.6, end: 61.9 },
              { word: 'finit', start: 61.95, end: 62 },
              { word: 'tard', start: 159, end: 160 },
            ],
          },
        ],
      }),
    )
    const db = getDb()
    putClip(db, { ...baseClip(), segments: [{ start: 60, end: 70 }] })

    const response = await postCorrection(
      postRequest({ lineId: 'l0', from: 5, to: 5, expected: ['tard'], replacement: ['tardivement'] }),
      context(PROJECT),
    )
    const body = (await response.json()) as { clipsTouched: { id: string; title: string }[] }
    expect(body.clipsTouched).toEqual([])
  })

  it('ne nomme pas un clip que la phrase ne recouvre pas', async () => {
    writeTranscriptFixture()
    const db = getDb()
    putClip(db, baseClip())

    // La seconde phrase (200-201) est hors du clip (60-90).
    const response = await postCorrection(
      postRequest({ lineId: 'l1', from: 0, to: 0, expected: ['Autre'], replacement: ['Une'] }),
      context(PROJECT),
    )
    const body = (await response.json()) as { clipsTouched: { id: string; title: string }[] }
    expect(body.clipsTouched).toEqual([])
  })

  it('409 sur une ancre qui ne correspond plus', async () => {
    writeTranscriptFixture()
    const response = await postCorrection(
      postRequest({ lineId: 'l0', from: 0, to: 0, expected: ['pas-le-bon-mot'], replacement: ['x'] }),
      context(PROJECT),
    )
    expect(response.status).toBe(409)
  })

  it('404 sur une phrase inconnue', async () => {
    writeTranscriptFixture()
    const response = await postCorrection(
      postRequest({ lineId: 'l99', from: 0, to: 0, expected: ['x'], replacement: ['y'] }),
      context(PROJECT),
    )
    expect(response.status).toBe(404)
  })

  it('404 sur un projet inconnu', async () => {
    const response = await postCorrection(
      postRequest({ lineId: 'l0', from: 0, to: 0, expected: [], replacement: [] }),
      context('fantome'),
    )
    expect(response.status).toBe(404)
  })

  it('400 sur un corps mal formé', async () => {
    const response = await postCorrection(postRequest({ lineId: 'l0' }), context(PROJECT))
    expect(response.status).toBe(400)
  })

  it('400 sur un remplacement qui colle plusieurs mots dans un seul token', async () => {
    writeTranscriptFixture()
    const response = await postCorrection(
      postRequest({ lineId: 'l0', from: 0, to: 0, expected: ['Bonjour'], replacement: ['deux mots'] }),
      context(PROJECT),
    )
    expect(response.status).toBe(400)
  })

  it('400 sur un mot vide ailleurs qu’une suppression d’empan', async () => {
    writeTranscriptFixture()
    const response = await postCorrection(
      postRequest({ lineId: 'l0', from: 0, to: 0, expected: ['Bonjour'], replacement: [''] }),
      context(PROJECT),
    )
    expect(response.status).toBe(400)
  })
})
