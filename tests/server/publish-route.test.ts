import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST as publishRoute } from '@/app/api/clips/[id]/publish/route'
import { GET as publicationsRoute } from '@/app/api/clips/[id]/publications/route'
import type { PlatformOutcome, PublicationAdapter, PublicationJob } from '@/server/publication/adapter'
import type { Platform } from '@/core/publication'
import type { Clip } from '@/core/edl'
import { closeDb, getDb, getPublications, putClip, upsertProject, upsertPublication } from '@/server/db'
import type { Artifact, OptionsArtifact } from '@/server/ffmpeg'
import type { Probe } from '@/server/ffprobe'
import { forgetAll } from '@/server/publication/registry'
import { renderClip } from '@/server/steps/render'

/**
 * Les routes `POST /api/clips/:id/publish` et `GET /api/clips/:id/publications`,
 * appelées comme Next les appelle — même convention que
 * `tests/server/transcript-route.test.ts`.
 *
 * **`renderClip` tourne pour de vrai**, ffmpeg et ffprobe simulés comme le fait
 * déjà `tests/server/empreinte.test.ts` : `launchPublish` exige un rendu à jour
 * (spec §6.4), et rien ne le prouve mieux que le vrai calcul de péremption.
 */

vi.mock('@/server/ffmpeg', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/ffmpeg')>()
  return {
    ...original,
    produceArtifact: async (o: OptionsArtifact): Promise<Artifact> => {
      o.args(`${o.dst}.partiel`)
      fs.mkdirSync(path.dirname(o.dst), { recursive: true })
      fs.writeFileSync(o.dst, 'un MP4 pour de faux')
      return { path: o.dst, skipped: false }
    },
  }
})

vi.mock('@/server/ffprobe', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/ffprobe')>()
  return {
    ...original,
    probe: async (): Promise<Probe> => ({ durationSec: 20, width: 1080, height: 1080, fps: 30 }),
  }
})

/** Le connecteur de test, remplacé à chaque cas. */
let fakeAdapter: PublicationAdapter

vi.mock('@/server/publication/upload-post', () => ({
  createUploadPostAdapter: () => fakeAdapter,
}))

function resolvedAdapter(outcome: (platform: Platform) => PlatformOutcome): PublicationAdapter {
  return {
    platforms: ['instagram', 'facebook', 'tiktok', 'youtube'],
    availability: async () => {
      throw new Error('non utilisé par ces tests')
    },
    publish: async (_job: PublicationJob, platforms: readonly Platform[]) => {
      const outcomes = {} as Record<Platform, PlatformOutcome>
      for (const platform of platforms) outcomes[platform] = outcome(platform)
      return outcomes
    },
    poll: async () => {
      throw new Error('non utilisé par ces tests')
    },
  }
}

/** Un adaptateur dont `publish` ne se règle jamais — pour observer la réservation en vol. */
function pendingAdapter(): PublicationAdapter {
  return {
    platforms: ['instagram', 'facebook', 'tiktok', 'youtube'],
    availability: async () => {
      throw new Error('non utilisé par ces tests')
    },
    publish: () => new Promise<Record<Platform, PlatformOutcome>>(() => {}),
    poll: async () => {
      throw new Error('non utilisé par ces tests')
    },
  }
}

const SOURCE = '2025-06-15-cqlp.mp4'
const PROJECT_ID = '2025-06-15-cqlp'
const CLIP_ID = 'clip_0001'

let root: string
const envStart = { ...process.env }

function baseClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: CLIP_ID,
    projectId: PROJECT_ID,
    segments: [{ start: 10, end: 30 }],
    ratio: '1:1',
    cropX: 0.5,
    captions: false,
    branding: false,
    title: 'La chute',
    description: 'Une impro qui part en vrille',
    status: 'kept',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    ...overrides,
  }
}

function context(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

function postRequest(body: unknown): Request {
  return new Request('http://test/api/clips/x/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-publish-route-'))
  process.env.REPLAY_DIR = path.join(root, 'replay')
  process.env.STAGE_DIR = path.join(root, 'stage')
  process.env.PROJECTS_DIR = path.join(root, 'projects')
  process.env.FFMPEG_ENCODER = 'x264'
  fs.mkdirSync(process.env.REPLAY_DIR, { recursive: true })
  fs.mkdirSync(process.env.STAGE_DIR, { recursive: true })
  fs.writeFileSync(path.join(process.env.REPLAY_DIR, SOURCE), 'pas vraiment une vidéo')
  fs.writeFileSync(path.join(process.env.STAGE_DIR, SOURCE), 'pas vraiment une vidéo')

  upsertProject(getDb(), {
    id: PROJECT_ID,
    sourcePath: path.join(process.env.REPLAY_DIR, SOURCE),
    stagedPath: path.join(process.env.STAGE_DIR, SOURCE),
    durationSec: 5936,
    sizeBytes: 1,
    mtimeMs: 1,
    createdAt: 1,
  })

  fakeAdapter = resolvedAdapter((platform) => ({
    status: platform === 'tiktok' ? 'submitted' : 'published',
    remoteId: 'p1',
    remoteUrl: 'https://example.test/p1',
  }))
})

afterEach(() => {
  forgetAll()
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
  process.env = { ...envStart }
})

/** Rend le clip, réellement — c'est ce qui rend `launchPublish` franchissable. */
async function exportClip(overrides: Partial<Clip> = {}): Promise<void> {
  putClip(getDb(), baseClip(overrides))
  await renderClip(CLIP_ID, { db: getDb() })
}

describe('POST /api/clips/:id/publish', () => {
  it('404 sur un clip inconnu', async () => {
    const response = await publishRoute(postRequest({ platforms: ['instagram'] }), context('inconnu'))
    expect(response.status).toBe(404)
  })

  it('lance la publication et rend les lignes in_progress', async () => {
    await exportClip()
    const response = await publishRoute(postRequest({ platforms: ['instagram'] }), context(CLIP_ID))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { publications: { platform: string; status: string }[] }
    expect(payload.publications).toHaveLength(1)
    expect(payload.publications[0]).toMatchObject({ platform: 'instagram', status: 'in_progress' })
  })

  it('409 sur un second lancement pendant qu’une publication est en vol', async () => {
    await exportClip()
    fakeAdapter = pendingAdapter()

    const first = await publishRoute(postRequest({ platforms: ['instagram'] }), context(CLIP_ID))
    expect(first.status).toBe(200)

    const second = await publishRoute(postRequest({ platforms: ['instagram'] }), context(CLIP_ID))
    expect(second.status).toBe(409)
  })

  it('refuse sans `force` une plateforme déjà publiée', async () => {
    await exportClip()
    upsertPublication(getDb(), {
      clipId: CLIP_ID,
      platform: 'instagram',
      status: 'published',
      remoteId: 'p0',
      remoteUrl: 'https://example.test/p0',
      requestId: null,
      error: null,
      publishedFingerprint: null,
      createdAt: 1,
      updatedAt: 1,
    })

    const refused = await publishRoute(postRequest({ platforms: ['instagram'] }), context(CLIP_ID))
    expect(refused.status).toBe(409)

    const forced = await publishRoute(postRequest({ platforms: ['instagram'], force: true }), context(CLIP_ID))
    expect(forced.status).toBe(200)
  })

  it('400 sur un clip qui n’est pas exporté', async () => {
    putClip(getDb(), baseClip({ status: 'kept' }))
    const response = await publishRoute(postRequest({ platforms: ['instagram'] }), context(CLIP_ID))
    expect(response.status).toBe(400)
  })

  it('écrit en base le résultat une fois l’envoi détaché résolu', async () => {
    await exportClip()
    const response = await publishRoute(postRequest({ platforms: ['tiktok'] }), context(CLIP_ID))
    expect(response.status).toBe(200)
    // Laisse le microtask détaché se dérouler.
    await new Promise((resolve) => setImmediate(resolve))
    const rows = getPublications(getDb(), CLIP_ID)
    expect(rows).toEqual([
      expect.objectContaining({ platform: 'tiktok', status: 'submitted', remoteId: 'p1' }),
    ])
  })
})

describe('GET /api/clips/:id/publications', () => {
  it('404 sur un clip inconnu', async () => {
    const response = await publicationsRoute(new Request('http://test'), context('inconnu'))
    expect(response.status).toBe(404)
  })

  it('rend les lignes existantes', async () => {
    await exportClip()
    upsertPublication(getDb(), {
      clipId: CLIP_ID,
      platform: 'youtube',
      status: 'published',
      remoteId: 'y1',
      remoteUrl: 'https://youtube.test/y1',
      requestId: null,
      error: null,
      publishedFingerprint: 'abc',
      createdAt: 1,
      updatedAt: 1,
    })
    const response = await publicationsRoute(new Request('http://test'), context(CLIP_ID))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { publications: { platform: string }[] }
    expect(payload.publications.map((p) => p.platform)).toEqual(['youtube'])
  })
})
