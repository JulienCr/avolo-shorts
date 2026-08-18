import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GET as getClipRoute, PATCH as patchClipRoute } from '@/app/api/clips/[id]/route'
import { GET as getCandidats } from '@/app/api/projects/[id]/candidates/route'
import { GET as getProjet } from '@/app/api/projects/[id]/route'
import { POST as postRun } from '@/app/api/projects/[id]/run/route'
import { GET as listerProjets } from '@/app/api/projects/route'
import type { Clip } from '@/core/edl'
import type { CandidateClip, ClipDetail, ProjectStatus, ProjectSummary } from '@/lib/api'
import { closeDb, getDb, putClip, upsertProject } from '@/server/db'
import { statutPour } from '@/server/http'
import { GeminiBlockedError } from '@/server/steps/candidates'

/**
 * Les routes, appelées comme Next les appelle.
 *
 * Ce qui se vérifie ici est **ce qui ne doit pas traverser la frontière** :
 * les chemins absolus du serveur, un statut `exported` posé par le client, un
 * champ d'identité modifié en douce, et une liste de segments qui se chevauche.
 * Quatre défauts silencieux, chacun visible seulement le jour où il coûte
 * quelque chose.
 */

const PROJET = '2026-01-11-méchante'
const CLIP = `${PROJET}_000060000-000090000`

let racine: string

/** Le contexte que Next passe : des paramètres déjà décodés, dans une promesse. */
function contexte(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

function clipDeBase(): Clip {
  return {
    id: CLIP,
    projectId: PROJET,
    segments: [{ start: 60, end: 90 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'Le canapé',
    description: "C'était pas moi.",
    status: 'candidate',
    pass: 1,
  }
}

/** Un transcript minuscule, à la forme de WhisperX. */
function poserTranscript(): void {
  const dossier = path.join(racine, 'projects', PROJET, `${PROJET}.avolo`)
  fs.mkdirSync(dossier, { recursive: true })
  const segments = Array.from({ length: 40 }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 8,
    text: `phrase ${i}`,
    words: [
      { word: 'phrase', start: i * 10, end: i * 10 + 4 },
      { word: String(i), start: i * 10 + 4, end: i * 10 + 8 },
    ],
  }))
  fs.writeFileSync(
    path.join(dossier, 'transcript.json'),
    JSON.stringify({ language: 'fr', segments }),
  )
}

beforeEach(() => {
  racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-api-'))
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
    createdAt: 1_787_019_419_976,
  })
})

afterEach(() => {
  closeDb()
  fs.rmSync(racine, { recursive: true, force: true })
})

describe('GET /api/projects', () => {
  it('ne publie ni sourcePath ni stagedPath', async () => {
    const réponse = await listerProjets()
    expect(réponse.status).toBe(200)
    const projets = (await réponse.json()) as ProjectSummary[]

    expect(projets).toHaveLength(1)
    expect(Object.keys(projets[0]).sort()).toEqual(['createdAt', 'durationSec', 'id', 'title'])
    // Le corps entier, pas seulement les clés : un chemin qui se glisserait dans
    // une valeur ne se verrait pas autrement.
    expect(JSON.stringify(projets)).not.toContain(racine)
  })

  it('dérive le titre du nom de fichier', async () => {
    const projets = (await (await listerProjets()).json()) as ProjectSummary[]
    expect(projets[0].title).toBe('méchante — 11 janvier 2026')
  })
})

describe('GET /api/projects/:id', () => {
  it('rend les étapes présentes et ce qui tourne', async () => {
    fs.mkdirSync(path.join(racine, 'projects', PROJET), { recursive: true })
    fs.writeFileSync(path.join(racine, 'projects', PROJET, 'proxy.mp4'), '')
    poserTranscript()

    const réponse = await getProjet(new Request('http://x'), contexte(PROJET))
    expect(réponse.status).toBe(200)
    const état = (await réponse.json()) as ProjectStatus
    expect(état.steps).toEqual({
      proxy: true,
      audio: false,
      transcript: true,
      candidates: false,
      renders: false,
    })
    expect(état.running).toBeNull()
  })

  it('rend 404 sur un projet inconnu', async () => {
    const réponse = await getProjet(new Request('http://x'), contexte('jamais-vu'))
    expect(réponse.status).toBe(404)
  })
})

describe('GET /api/projects/:id/candidates', () => {
  it('prépare l’aperçu côté serveur et laisse la vignette nulle sans proxy', async () => {
    poserTranscript()
    putClip(getDb(), clipDeBase())

    const réponse = await getCandidats(new Request('http://x'), contexte(PROJET))
    const candidats = (await réponse.json()) as CandidateClip[]
    expect(candidats).toHaveLength(1)
    expect(candidats[0].preview).toBe('phrase 6 phrase 7 phrase 8')
    // Pas de proxy encore encodé : `null`, jamais une URL morte.
    expect(candidats[0].thumbnailUrl).toBeNull()
  })

  it('propose la vignette dès que le proxy existe', async () => {
    poserTranscript()
    fs.writeFileSync(path.join(racine, 'projects', PROJET, 'proxy.mp4'), '')
    putClip(getDb(), clipDeBase())

    const candidats = (await (
      await getCandidats(new Request('http://x'), contexte(PROJET))
    ).json()) as CandidateClip[]
    // L'identifiant porte un accent : sans encodage, l'URL serait cassée.
    expect(candidats[0].thumbnailUrl).toBe(
      `/api/clips/${encodeURIComponent(CLIP)}/thumb`,
    )
  })
})

describe('GET /api/clips/:id', () => {
  it('fenêtre le transcript sur l’étendue **d’origine**, pas sur les segments courants', async () => {
    poserTranscript()
    // L'artefact du repérage garde les bornes proposées ; l'édition n'y touche pas.
    fs.writeFileSync(
      path.join(racine, 'projects', PROJET, 'candidates.json'),
      JSON.stringify([{ ...clipDeBase(), segments: [{ start: 60, end: 90 }] }]),
    )
    // Le clip en base a été vidé de tous ses mots : c'est un état que l'écran de
    // clip produit, et celui où l'on a le plus besoin de relire le transcript.
    putClip(getDb(), { ...clipDeBase(), segments: [] })

    const réponse = await getClipRoute(new Request('http://x'), contexte(CLIP))
    expect(réponse.status).toBe(200)
    const détail = (await réponse.json()) as ClipDetail
    expect(détail.clip.segments).toEqual([])
    expect(détail.lines.length).toBeGreaterThan(0)
    // Deux minutes de contexte de part et d'autre de [60, 90].
    expect(détail.lines[0].start).toBe(0)
    expect(détail.lines[détail.lines.length - 1].end).toBeLessThanOrEqual(218)
    expect(détail.proxyUrl).toBeNull()
  })

  it('rend 404 sur un clip inconnu', async () => {
    const réponse = await getClipRoute(new Request('http://x'), contexte('jamais-vu'))
    expect(réponse.status).toBe(404)
  })
})

describe('PATCH /api/clips/:id', () => {
  const patcher = (corps: unknown, id = CLIP): Promise<Response> =>
    patchClipRoute(
      new Request('http://x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corps),
      }),
      contexte(id),
    )

  beforeEach(() => {
    putClip(getDb(), clipDeBase())
  })

  it('refuse `status: exported` venant du client', async () => {
    const réponse = await patcher({ status: 'exported' })
    // Un clip devient exporté parce qu'un MP4 a été produit, jamais parce que
    // quelqu'un l'a écrit — et `mergeCandidates` le ferait survivre à toutes les
    // passes suivantes.
    expect(réponse.status).toBe(400)
  })

  it('refuse les champs d’identité', async () => {
    for (const corps of [{ id: 'autre' }, { projectId: 'autre' }, { pass: 9 }]) {
      expect((await patcher(corps)).status).toBe(400)
    }
  })

  it('refuse un cropX hors de l’image', async () => {
    expect((await patcher({ cropX: 1.5 })).status).toBe(400)
  })

  it('normalise les segments avant écriture', async () => {
    const réponse = await patcher({
      segments: [
        { start: 80, end: 95 },
        { start: 60, end: 82 },
        { start: 120, end: 120 },
      ],
    })
    expect(réponse.status).toBe(200)
    const clip = (await réponse.json()) as Clip
    // Triés, fusionnés puisqu'ils se chevauchent, et le segment vide écarté.
    expect(clip.segments).toEqual([{ start: 60, end: 95 }])
  })

  it('accepte les trois statuts humains et les enregistre', async () => {
    const réponse = await patcher({ status: 'kept' })
    expect(réponse.status).toBe(200)
    expect(((await réponse.json()) as Clip).status).toBe('kept')
    const relu = (await (
      await getClipRoute(new Request('http://x'), contexte(CLIP))
    ).json()) as ClipDetail
    expect(relu.clip.status).toBe('kept')
  })

  it('rejette un corps illisible', async () => {
    const réponse = await patchClipRoute(
      new Request('http://x', { method: 'PATCH', body: 'pas du json' }),
      contexte(CLIP),
    )
    expect(réponse.status).toBe(400)
  })
})

describe('POST /api/projects/:id/run', () => {
  const lancerRoute = (corps: unknown, id = PROJET): Promise<Response> =>
    postRun(
      new Request('http://x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corps),
      }),
      contexte(id),
    )

  it('rend le plan, et un plan vide quand tout est là', async () => {
    poserTranscript()
    fs.writeFileSync(path.join(racine, 'projects', PROJET, 'candidates.json'), '[]')

    const réponse = await lancerRoute({ target: 'candidates' })
    expect(réponse.status).toBe(202)
    expect(await réponse.json()).toEqual({ projectId: PROJET, plan: [] })
  })

  it('refuse `renders` : un rendu se demande par clip', async () => {
    expect((await lancerRoute({ target: 'renders' })).status).toBe(400)
    expect((await lancerRoute({ target: 'nimporte' })).status).toBe(400)
    expect((await lancerRoute({ target: 'candidates', inconnu: 1 })).status).toBe(400)
  })

  it('rend 404 sur un projet inconnu', async () => {
    expect((await lancerRoute({ target: 'candidates' }, 'jamais-vu')).status).toBe(404)
  })
})

describe('les codes d’erreur', () => {
  it('distinguent les trois natures d’échec de la tâche 9', () => {
    // Ni la faute de l'appelant, ni un défaut du serveur : rien à réessayer.
    expect(statutPour(new GeminiBlockedError('refusé'))).toBe(422)
    // Une panne de service ou de réseau : tout à réessayer.
    expect(statutPour(new Error('503 Service Unavailable'))).toBe(503)
    expect(statutPour(new Error('fetch failed'))).toBe(503)
    // Le reste est un défaut de ce programme.
    expect(statutPour(new Error('Transcript illisible dans le sidecar'))).toBe(500)
  })
})
