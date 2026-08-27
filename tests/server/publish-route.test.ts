import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PATCH as patchClipRoute } from '@/app/api/clips/[id]/route'
import { POST as publishRoute } from '@/app/api/clips/[id]/publish/route'
import { GET as publicationsRoute } from '@/app/api/clips/[id]/publications/route'
import type { PlatformOutcome, PublicationAdapter, PublicationJob } from '@/server/publication/adapter'
import type { Platform } from '@/core/publication'
import type { Clip } from '@/core/edl'
import { RENDER_NATIVE } from '@/core/render-flags'
import {
  applySettings,
  closeDb,
  getClip,
  getDb,
  getPublications,
  putClip,
  schedulePublications,
  upsertProject,
  upsertPublication,
} from '@/server/db'
import type { Artifact, OptionsArtifact } from '@/server/ffmpeg'
import type { Probe } from '@/server/ffprobe'
import { forgetAll } from '@/server/publication/registry'
import { currentFingerprintForClip, launchPublish } from '@/server/publication/service'
import { pathsRender, renderClip } from '@/server/steps/render'

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

/**
 * `adapterFor`, mocké pour piloter la résolution que `service.ts` fait via
 * `@/server/publication` — par défaut la même valeur pour les quatre
 * plateformes, comme du temps d'un seul connecteur. Le describe « deux
 * connecteurs » le remplace pour une résolution par plateforme.
 */
let resolveAdapter: (platform: Platform) => PublicationAdapter | undefined = () => fakeAdapter

vi.mock('@/server/publication', () => ({
  adapterFor: (platform: Platform) => resolveAdapter(platform),
}))

function resolvedAdapter(outcome: (platform: Platform) => PlatformOutcome): PublicationAdapter {
  return {
    id: 'upload-post',
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
    id: 'upload-post',
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
    framingStyle: {},
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
  resolveAdapter = () => fakeAdapter
})

afterEach(() => {
  forgetAll()
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
  // Mutation, jamais réassignation : `process.env = { ... }` casse en silence
  // `process.loadEnvFile` pour le reste du process (tests/scripts/dev-common.
  // test.ts ; même défaut relevé en revue sur publication-scheduler.test.ts).
  for (const name of Object.keys(process.env)) {
    if (!(name in envStart)) delete process.env[name]
  }
  Object.assign(process.env, envStart)
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

  it('publie encore avec `publication.autoPublish` à `false` : le manuel n’est pas le drapeau de l’ordonnanceur', async () => {
    applySettings(getDb(), { publication: { autoPublish: false } })
    await exportClip()
    const response = await publishRoute(postRequest({ platforms: ['instagram'] }), context(CLIP_ID))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { publications: { platform: string; status: string }[] }
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
      scheduledAt: null,
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

  it('400 sur YouTube sans titre, avant tout téléversement', async () => {
    await exportClip({ title: '' })
    const response = await publishRoute(postRequest({ platforms: ['youtube'] }), context(CLIP_ID))
    expect(response.status).toBe(400)
    expect(getPublications(getDb(), CLIP_ID)).toEqual([])
  })

  it('un titre vide n’empêche pas les autres plateformes', async () => {
    await exportClip({ title: '' })
    const response = await publishRoute(postRequest({ platforms: ['instagram'] }), context(CLIP_ID))
    expect(response.status).toBe(200)
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
      scheduledAt: null,
    })
    const response = await publicationsRoute(new Request('http://test'), context(CLIP_ID))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { publications: { platform: string }[] }
    expect(payload.publications.map((p) => p.platform)).toEqual(['youtube'])
  })

  // issue #145 : le serveur comparait un condensat SHA-256 à un
  // `JSON.stringify` du client — deux représentations jamais égales, donc
  // `stale` valait `true` pour toute publication réussie.
  it('`stale` vaut `false` quand l’empreinte publiée est celle du rendu actuel', async () => {
    const clip = baseClip()
    await exportClip(clip)
    const fingerprint = currentFingerprintForClip(getDb(), clip)
    upsertPublication(getDb(), {
      clipId: CLIP_ID,
      platform: 'instagram',
      status: 'published',
      remoteId: 'p1',
      remoteUrl: 'https://example.test/p1',
      requestId: null,
      error: null,
      publishedFingerprint: fingerprint,
      createdAt: 1,
      updatedAt: 1,
      scheduledAt: null,
    })
    const response = await publicationsRoute(new Request('http://test'), context(CLIP_ID))
    const payload = (await response.json()) as { publications: { platform: string; stale: boolean }[] }
    expect(payload.publications).toEqual([expect.objectContaining({ platform: 'instagram', stale: false })])
  })

  it('`stale` vaut `true` quand l’empreinte publiée diffère du rendu actuel', async () => {
    await exportClip()
    upsertPublication(getDb(), {
      clipId: CLIP_ID,
      platform: 'instagram',
      status: 'published',
      remoteId: 'p1',
      remoteUrl: 'https://example.test/p1',
      requestId: null,
      error: null,
      publishedFingerprint: 'une-empreinte-perimee',
      createdAt: 1,
      updatedAt: 1,
      scheduledAt: null,
    })
    const response = await publicationsRoute(new Request('http://test'), context(CLIP_ID))
    const payload = (await response.json()) as { publications: { platform: string; stale: boolean }[] }
    expect(payload.publications).toEqual([expect.objectContaining({ platform: 'instagram', stale: true })])
  })

  it('`stale` vaut `false` sans empreinte publiée', async () => {
    await exportClip()
    upsertPublication(getDb(), {
      clipId: CLIP_ID,
      platform: 'instagram',
      status: 'in_progress',
      remoteId: null,
      remoteUrl: null,
      requestId: 'r1',
      error: null,
      publishedFingerprint: null,
      createdAt: 1,
      updatedAt: 1,
      scheduledAt: null,
    })
    const response = await publicationsRoute(new Request('http://test'), context(CLIP_ID))
    const payload = (await response.json()) as { publications: { platform: string; stale: boolean }[] }
    expect(payload.publications).toEqual([expect.objectContaining({ platform: 'instagram', stale: false })])
  })

  it('`stale` vaut `false` quand le rendu est absent ou illisible', async () => {
    putClip(getDb(), baseClip())
    upsertPublication(getDb(), {
      clipId: CLIP_ID,
      platform: 'instagram',
      status: 'published',
      remoteId: 'p1',
      remoteUrl: 'https://example.test/p1',
      requestId: null,
      error: null,
      publishedFingerprint: 'une-empreinte-quelconque',
      createdAt: 1,
      updatedAt: 1,
      scheduledAt: null,
    })
    const response = await publicationsRoute(new Request('http://test'), context(CLIP_ID))
    const payload = (await response.json()) as { publications: { platform: string; stale: boolean }[] }
    expect(payload.publications).toEqual([expect.objectContaining({ platform: 'instagram', stale: false })])
  })
})

describe('POST /api/clips/:id/publish — plateformes en double', () => {
  it('refuse une plateforme répétée à la frontière HTTP', async () => {
    await exportClip()
    const response = await publishRoute(postRequest({ platforms: ['instagram', 'instagram'] }), context(CLIP_ID))
    expect(response.status).toBe(400)
  })
})

describe('POST /api/clips/:id/publish — rendu manquant sur disque', () => {
  it('400, pas 500, quand le fichier attendu a disparu', async () => {
    await exportClip()
    const paths = pathsRender(PROJECT_ID, CLIP_ID, '1:1', RENDER_NATIVE)
    fs.rmSync((paths.variant9x16 ?? paths.mp4)!, { force: true })
    const response = await publishRoute(postRequest({ platforms: ['instagram'] }), context(CLIP_ID))
    expect(response.status).toBe(400)
  })
})

/** Un adaptateur dont `publish` rend tout `in_progress`, contrôlé par `poll`. */
function pollingAdapter(poll: PublicationAdapter['poll']): PublicationAdapter {
  return {
    id: 'upload-post',
    platforms: ['instagram', 'facebook', 'tiktok', 'youtube'],
    availability: async () => {
      throw new Error('non utilisé par ces tests')
    },
    publish: async (_job: PublicationJob, platforms: readonly Platform[]) => {
      const outcomes = {} as Record<Platform, PlatformOutcome>
      for (const platform of platforms) outcomes[platform] = { status: 'in_progress', requestId: 'r1' }
      return outcomes
    },
    poll,
  }
}

describe('launchPublish — sondage d’un envoi asynchrone', () => {
  it('sonde jusqu’à un état terminal avant d’écrire le résultat', async () => {
    await exportClip()
    let pollCalls = 0
    const adapter = pollingAdapter(async (_requestId, platforms) => {
      pollCalls += 1
      const outcomes = {} as Record<Platform, PlatformOutcome>
      for (const platform of platforms) {
        outcomes[platform] =
          pollCalls < 2
            ? { status: 'in_progress', requestId: 'r1' }
            : { status: 'published', remoteId: 'p1', remoteUrl: 'https://example.test/p1' }
      }
      return outcomes
    })

    resolveAdapter = () => adapter
    const clip = getClip(getDb(), CLIP_ID)
    if (clip === undefined) throw new Error('clip introuvable')
    const { settled } = launchPublish({
      db: getDb(),
      clip,
      platforms: ['instagram'],
      force: false,
      sleep: async () => {},
    })
    await settled

    const rows = getPublications(getDb(), CLIP_ID)
    expect(rows).toEqual([expect.objectContaining({ platform: 'instagram', status: 'published', remoteId: 'p1' })])
    expect(pollCalls).toBeGreaterThanOrEqual(2)
  })

  it('abandonne après un nombre borné d’essais, honnêtement `in_progress`', async () => {
    await exportClip()
    const adapter = pollingAdapter(async (_requestId, platforms) => {
      const outcomes = {} as Record<Platform, PlatformOutcome>
      for (const platform of platforms) outcomes[platform] = { status: 'in_progress', requestId: 'r1' }
      return outcomes
    })

    resolveAdapter = () => adapter
    const clip = getClip(getDb(), CLIP_ID)
    if (clip === undefined) throw new Error('clip introuvable')
    const { settled } = launchPublish({
      db: getDb(),
      clip,
      platforms: ['instagram'],
      force: false,
      sleep: async () => {},
    })
    await settled

    const rows = getPublications(getDb(), CLIP_ID)
    expect(rows).toEqual([expect.objectContaining({ platform: 'instagram', status: 'in_progress' })])
  })
})

describe('launchPublish — deux connecteurs', () => {
  /**
   * Rouge si `groupByAdapter` disparaît de `service.ts` (issue #146) : sans
   * lui, `adapterFor(platforms[0])` enverrait `tiktok` à Meta ou `instagram`
   * à Upload Post selon l'ordre du tableau, et l'un des deux `publish` ne
   * serait jamais appelé avec les bonnes plateformes.
   */
  it('groupe par connecteur : chacun ne reçoit que ses propres plateformes', async () => {
    await exportClip()

    const metaPublish = vi.fn(async (_job: PublicationJob, platforms: readonly Platform[]) => {
      const outcomes = {} as Record<Platform, PlatformOutcome>
      for (const platform of platforms) {
        outcomes[platform] = { status: 'published', remoteId: 'm1', remoteUrl: 'https://meta.test/m1' }
      }
      return outcomes
    })
    const meta: PublicationAdapter = {
      id: 'meta',
      platforms: ['instagram', 'facebook'],
      availability: async () => {
        throw new Error('non utilisé par ces tests')
      },
      publish: metaPublish,
      poll: async () => {
        throw new Error('non utilisé par ces tests')
      },
    }

    const uploadPostPublish = vi.fn(async (_job: PublicationJob, platforms: readonly Platform[]) => {
      const outcomes = {} as Record<Platform, PlatformOutcome>
      for (const platform of platforms) {
        outcomes[platform] = { status: 'submitted', remoteId: 'u1', remoteUrl: null }
      }
      return outcomes
    })
    const uploadPost: PublicationAdapter = {
      id: 'upload-post',
      platforms: ['tiktok', 'youtube'],
      availability: async () => {
        throw new Error('non utilisé par ces tests')
      },
      publish: uploadPostPublish,
      poll: async () => {
        throw new Error('non utilisé par ces tests')
      },
    }

    resolveAdapter = (platform) => (platform === 'instagram' ? meta : uploadPost)

    const clip = getClip(getDb(), CLIP_ID)
    if (clip === undefined) throw new Error('clip introuvable')
    const { settled } = launchPublish({
      db: getDb(),
      clip,
      platforms: ['instagram', 'tiktok'],
      force: false,
      sleep: async () => {},
    })
    await settled

    expect(metaPublish).toHaveBeenCalledTimes(1)
    expect(metaPublish.mock.calls[0]?.[1]).toEqual(['instagram'])
    expect(uploadPostPublish).toHaveBeenCalledTimes(1)
    expect(uploadPostPublish.mock.calls[0]?.[1]).toEqual(['tiktok'])

    const rows = getPublications(getDb(), CLIP_ID)
    expect(rows.find((r) => r.platform === 'instagram')).toMatchObject({ status: 'published', remoteId: 'm1' })
    expect(rows.find((r) => r.platform === 'tiktok')).toMatchObject({ status: 'submitted', remoteId: 'u1' })
  })

  it('l’échec d’un connecteur n’empêche pas l’autre de publier', async () => {
    await exportClip()

    const meta: PublicationAdapter = {
      id: 'meta',
      platforms: ['instagram', 'facebook'],
      availability: async () => {
        throw new Error('non utilisé par ces tests')
      },
      publish: async () => {
        throw new Error('Meta est en panne')
      },
      poll: async () => {
        throw new Error('non utilisé par ces tests')
      },
    }
    const uploadPost = resolvedAdapter(() => ({
      status: 'published',
      remoteId: 'u2',
      remoteUrl: 'https://up.test/u2',
    }))

    resolveAdapter = (platform) => (platform === 'instagram' ? meta : uploadPost)

    const clip = getClip(getDb(), CLIP_ID)
    if (clip === undefined) throw new Error('clip introuvable')
    const { settled } = launchPublish({
      db: getDb(),
      clip,
      platforms: ['instagram', 'tiktok'],
      force: false,
      sleep: async () => {},
    })
    await settled

    const rows = getPublications(getDb(), CLIP_ID)
    expect(rows.find((r) => r.platform === 'instagram')).toMatchObject({ status: 'failed' })
    expect(rows.find((r) => r.platform === 'tiktok')).toMatchObject({ status: 'published', remoteId: 'u2' })
  })
})

describe('launchPublish — ignoreStaleRender (spec §5.4)', () => {
  /** Un clip exporté puis retombé en `kept` : le rendu reste sur le disque, périmé. */
  async function exportThenRevertToKept(): Promise<void> {
    await exportClip()
    putClip(getDb(), baseClip({ status: 'kept' }))
  }

  it('la voie manuelle refuse toujours un rendu périmé, et le schéma refuse `ignoreStaleRender`', async () => {
    await exportThenRevertToKept()

    const refused = await publishRoute(postRequest({ platforms: ['instagram'] }), context(CLIP_ID))
    expect(refused.status).toBe(400)

    const rejectedField = await publishRoute(
      postRequest({ platforms: ['instagram'], ignoreStaleRender: true }),
      context(CLIP_ID),
    )
    expect(rejectedField.status).toBe(400)
  })

  it('la voie ordonnancée publie un clip `kept` au rendu périmé', async () => {
    await exportThenRevertToKept()
    const clip = getClip(getDb(), CLIP_ID)
    if (clip === undefined) throw new Error('clip introuvable')

    const { settled } = launchPublish({
      db: getDb(),
      clip,
      platforms: ['instagram'],
      force: false,
      ignoreStaleRender: true,
      sleep: async () => {},
    })
    await settled

    const rows = getPublications(getDb(), CLIP_ID)
    expect(rows).toEqual([expect.objectContaining({ platform: 'instagram', status: 'published' })])
  })

  it('mais pas sans fichier sur le disque', async () => {
    await exportThenRevertToKept()
    const paths = pathsRender(PROJECT_ID, CLIP_ID, '1:1', RENDER_NATIVE)
    fs.rmSync((paths.variant9x16 ?? paths.mp4)!, { force: true })
    const clip = getClip(getDb(), CLIP_ID)
    if (clip === undefined) throw new Error('clip introuvable')

    expect(() =>
      launchPublish({ db: getDb(), clip, platforms: ['instagram'], force: false, ignoreStaleRender: true }),
    ).toThrow(/Aucun fichier à envoyer/)
  })

  it('`force` et `ignoreStaleRender` ne se substituent pas l’un à l’autre', async () => {
    await exportThenRevertToKept()
    const clip = getClip(getDb(), CLIP_ID)
    if (clip === undefined) throw new Error('clip introuvable')

    // `force` seul ne lève pas la garde de fraîcheur.
    expect(() =>
      launchPublish({ db: getDb(), clip, platforms: ['instagram'], force: true, ignoreStaleRender: false }),
    ).toThrow(/périmé/)

    // `ignoreStaleRender` seul la lève...
    const passed = launchPublish({
      db: getDb(),
      clip,
      platforms: ['facebook'],
      force: false,
      ignoreStaleRender: true,
      sleep: async () => {},
    })
    await passed.settled

    // ...mais ne republie pas un couple déjà publié sans `force`.
    expect(() =>
      launchPublish({
        db: getDb(),
        clip,
        platforms: ['facebook'],
        force: false,
        ignoreStaleRender: true,
        sleep: async () => {},
      }),
    ).toThrow(/déjà publié/)

    // Les deux ensemble républient.
    const forced = launchPublish({
      db: getDb(),
      clip,
      platforms: ['facebook'],
      force: true,
      ignoreStaleRender: true,
      sleep: async () => {},
    })
    await forced.settled
    const rows = getPublications(getDb(), CLIP_ID)
    expect(rows.find((r) => r.platform === 'facebook')).toMatchObject({ status: 'published' })
  })

  it('une ligne `planned` reste refusée à la modale manuelle même avec `force: true`', async () => {
    // Rendu frais, à la différence des cas ci-dessus : `canTargetPlatform`
    // traite `planned` comme `published` sans les distinguer, donc `force`
    // ne doit jamais traverser `planned` sans `ignoreStaleRender`.
    await exportClip()
    upsertPublication(getDb(), {
      clipId: CLIP_ID,
      platform: 'instagram',
      status: 'planned',
      remoteId: null,
      remoteUrl: null,
      requestId: null,
      error: null,
      publishedFingerprint: null,
      createdAt: 1,
      updatedAt: 1,
      scheduledAt: Date.now() + 1000,
    })
    const clip = getClip(getDb(), CLIP_ID)
    if (clip === undefined) throw new Error('clip introuvable')

    expect(() =>
      launchPublish({ db: getDb(), clip, platforms: ['instagram'], force: true, ignoreStaleRender: false }),
    ).toThrow(/programmé/)

    expect(getPublications(getDb(), CLIP_ID).find((r) => r.platform === 'instagram')).toMatchObject({
      status: 'planned',
    })
  })

  it('une ligne `in_progress` refuse le chemin manuel, même avec `force: true` — l’ordonnanceur peut être en train de l’envoyer', async () => {
    await exportClip()
    upsertPublication(getDb(), {
      clipId: CLIP_ID,
      platform: 'instagram',
      status: 'in_progress',
      remoteId: null,
      remoteUrl: null,
      requestId: null,
      error: null,
      publishedFingerprint: null,
      createdAt: 1,
      updatedAt: 1,
      scheduledAt: null,
    })
    const clip = getClip(getDb(), CLIP_ID)
    if (clip === undefined) throw new Error('clip introuvable')

    expect(() =>
      launchPublish({ db: getDb(), clip, platforms: ['instagram'], force: true, ignoreStaleRender: false }),
    ).toThrow(/en cours d.envoi/)

    // Le chemin ordonnancé, lui, doit pouvoir reprendre son propre essai
    // laissé `in_progress` (spec §5.4, réessais) — `ignoreStaleRender` seul
    // suffit, `force` n'a pas à intervenir.
    const { settled } = launchPublish({
      db: getDb(),
      clip,
      platforms: ['instagram'],
      force: false,
      ignoreStaleRender: true,
      sleep: async () => {},
    })
    await settled
    expect(getPublications(getDb(), CLIP_ID).find((r) => r.platform === 'instagram')).toMatchObject({
      status: 'published',
    })
  })

  it('publie sous le ratio que l’empreinte affirme avoir produit, pas celui recalculé maintenant', async () => {
    // Exporté en 1:1 : sous `RENDER_NATIVE = false`, seule la variante 9:16
    // existe (`clip_0001-9x16.mp4`) ; `clip_0001.mp4` n'a jamais été écrit.
    await exportThenRevertToKept()
    // Le ratio dérive lui aussi, sans passer par `discardRenderStale` : le
    // fichier survit, comme le suppose `ignoreStaleRender`, mais sous un nom
    // que le ratio actuel ne redonnerait plus.
    putClip(getDb(), baseClip({ status: 'kept', ratio: '9:16' }))
    const clip = getClip(getDb(), CLIP_ID)
    if (clip === undefined) throw new Error('clip introuvable')
    const variant = pathsRender(PROJECT_ID, CLIP_ID, '1:1', RENDER_NATIVE).variant9x16
    if (variant === null) throw new Error('variante attendue')
    expect(fs.existsSync(variant)).toBe(true)

    const { settled } = launchPublish({
      db: getDb(),
      clip,
      platforms: ['instagram'],
      force: false,
      ignoreStaleRender: true,
      sleep: async () => {},
    })
    await settled

    expect(getPublications(getDb(), CLIP_ID)).toEqual([
      expect.objectContaining({ platform: 'instagram', status: 'published' }),
    ])
  })

  it('ignore la durée des segments actuels, qui ne décrivent plus le fichier programmé', async () => {
    await exportThenRevertToKept()
    // Réédité à plus de 180 s : la voie manuelle refuserait sur la durée,
    // mais le fichier programmé, lui, dure toujours ce qu'il durait à
    // l'export — mesurer le vrai fichier demanderait un `ffprobe` que le
    // script exclut (spec §2.1).
    putClip(getDb(), baseClip({ status: 'kept', segments: [{ start: 0, end: 200 }] }))
    const clip = getClip(getDb(), CLIP_ID)
    if (clip === undefined) throw new Error('clip introuvable')

    const { settled } = launchPublish({
      db: getDb(),
      clip,
      platforms: ['instagram'],
      force: false,
      ignoreStaleRender: true,
      sleep: async () => {},
    })
    await settled

    expect(getPublications(getDb(), CLIP_ID)).toEqual([
      expect.objectContaining({ platform: 'instagram', status: 'published' }),
    ])
  })
})

/**
 * **Le critère 6 de l'issue #205, celui qui prouve qu'elle est fermée.**
 * L'exemple de la conception (§3, §5.2) au complet : lundi tu exportes,
 * mercredi tu coupes trois mots, vendredi le fichier de lundi part quand même.
 * Contrairement au describe ci-dessus, rien n'est simulé ici — le `PATCH` réel
 * traverse `discardRenderStale` et sa réserve, pas un `putClip` qui en mime le
 * résultat.
 */
describe('launchPublish après un PATCH qui a épargné les sorties (#205)', () => {
  it('un clip programmé, édité après son export, atteint quand même le connecteur', async () => {
    await exportClip()
    schedulePublications(getDb(), [CLIP_ID], Date.now() + 86_400_000, Date.now())

    // Mercredi : on coupe trois mots. Le rendu de lundi devient périmé, mais
    // l'échéance encore `planned` doit faire épargner ses sorties.
    const patched = await patchClipRoute(
      new Request('http://x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ segments: [{ start: 10, end: 24 }] }),
      }),
      context(CLIP_ID),
    )
    expect(patched.status).toBe(200)
    expect(getClip(getDb(), CLIP_ID)?.status).toBe('kept')

    const paths = pathsRender(PROJECT_ID, CLIP_ID, '1:1', RENDER_NATIVE)
    expect(fs.existsSync(paths.variant9x16 as string)).toBe(true)
    expect(fs.existsSync(paths.fingerprint)).toBe(true)

    // Vendredi 19 h : l'ordonnanceur publie le fichier de lundi, empreinte
    // comprise — sans elle, `launchPublish` lève avant même de réserver.
    const clip = getClip(getDb(), CLIP_ID)
    if (clip === undefined) throw new Error('clip introuvable')
    const { settled } = launchPublish({
      db: getDb(),
      clip,
      platforms: ['instagram'],
      force: false,
      ignoreStaleRender: true,
      sleep: async () => {},
    })
    await settled

    expect(getPublications(getDb(), CLIP_ID)).toEqual(
      expect.arrayContaining([expect.objectContaining({ platform: 'instagram', status: 'published' })]),
    )
  })
})
