import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET as poolRoute } from '@/app/api/planning/pool/route'
import { GET as scheduleGetRoute, POST as scheduleRoute } from '@/app/api/planning/schedule/route'
import { POST as unscheduleRoute } from '@/app/api/planning/unschedule/route'
import type { Clip } from '@/core/edl'
import {
  closeDb,
  getDb,
  getPublications,
  putClip,
  schedulePublications,
  upsertProject,
  upsertPublication,
} from '@/server/db'
import { proxyPath } from '@/server/paths'

/**
 * Les quatre routes `/api/planning/**`, appelées comme Next les appelle —
 * même convention que `tests/server/publish-route.test.ts`.
 *
 * **`deliveryToDay` et `clipOutputs` sont simulés** : leur vraie forme lit un
 * fichier d'empreinte ou un rendu sur le disque (`tests/server/empreinte.test.ts`
 * le prouve via un vrai rendu), ce que ces routes n'ont pas à refaire — seul
 * leur propre calcul (vivier, calendrier, `stale`) est sous test ici.
 */
const fresh = new Set<string>()

vi.mock('@/server/renders', () => ({
  deliveryToDay: (clip: Clip) => fresh.has(clip.id),
  clipOutputs: (clip: Clip) => ({
    mp4Url: null,
    mp4Due: false,
    variant9x16Url: `/api/clips/${encodeURIComponent(clip.id)}/renders/${encodeURIComponent(clip.id)}-9x16.mp4`,
    variant9x16Due: true,
    textsUrl: null,
  }),
}))

const PROJECT_ID = '2026-04-01-emission'

function baseClip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    projectId: PROJECT_ID,
    segments: [{ start: 10, end: 30 }],
    ratio: '1:1',
    cropX: 0.5,
    captions: false,
    branding: false,
    title: `Titre ${id}`,
    description: '',
    status: 'exported',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
    ...overrides,
  }
}

let root: string
const envStart = { ...process.env }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-planning-route-'))
  process.env.PROJECTS_DIR = path.join(root, 'projects')
  fresh.clear()
  upsertProject(getDb(), {
    id: PROJECT_ID,
    sourcePath: '/replay/x.mp4',
    stagedPath: '/stage/x.mp4',
    durationSec: 1000,
    sizeBytes: 1,
    mtimeMs: 1,
    createdAt: 1,
  })
})

afterEach(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
  // Mutation, jamais réassignation : casserait `process.loadEnvFile` pour le
  // reste du process (tests/scripts/dev-common.test.ts:39-47).
  for (const name of Object.keys(process.env)) {
    if (!(name in envStart)) delete process.env[name]
  }
  Object.assign(process.env, envStart)
})

function getRequest(url: string): Request {
  return new Request(url)
}

function postRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /api/planning/pool', () => {
  it('exclut un clip `kept`, un clip exporté périmé, et un clip déjà programmé', async () => {
    putClip(getDb(), baseClip('gardé', { status: 'kept' }))
    fresh.add('gardé')

    putClip(getDb(), baseClip('périmé'))
    // pas d'entrée dans `fresh` : `deliveryToDay` rend faux.

    putClip(getDb(), baseClip('déjà-programmé'))
    fresh.add('déjà-programmé')
    schedulePublications(getDb(), ['déjà-programmé'], 5000, 1000)

    putClip(getDb(), baseClip('éligible'))
    fresh.add('éligible')

    const response = await poolRoute()
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { clips: { clipId: string; duration: number }[] }
    expect(payload.clips.map((c) => c.clipId)).toEqual(['éligible'])
    expect(payload.clips[0].duration).toBe(20)
  })

  // Le piège que `schedulePublications` pose : son UPSERT ne réécrit jamais
  // une ligne au résultat déjà arrêté (`WHERE status = 'planned'`). Un clip
  // dont les quatre lignes portent déjà un résultat n'a donc plus rien à
  // programmer, et doit sortir du vivier plutôt que produire un succès vide.
  it("exclut un clip dont les quatre plateformes portent déjà un résultat", async () => {
    putClip(getDb(), baseClip('épuisé'))
    fresh.add('épuisé')
    for (const platform of ['instagram', 'facebook', 'tiktok', 'youtube'] as const) {
      upsertPublication(getDb(), {
        clipId: 'épuisé',
        platform,
        status: 'published',
        remoteId: 'p1',
        remoteUrl: 'https://example.test/p1',
        requestId: null,
        error: null,
        publishedFingerprint: null,
        createdAt: 1000,
        updatedAt: 1000,
        scheduledAt: null,
      })
    }

    const response = await poolRoute()
    const payload = (await response.json()) as { clips: { clipId: string }[] }
    expect(payload.clips.map((c) => c.clipId)).toEqual([])
  })

  it('rend la description, les sorties et les statuts du clip', async () => {
    putClip(getDb(), baseClip('complet', { description: 'Une scène.' }))
    fresh.add('complet')
    upsertPublication(getDb(), {
      clipId: 'complet',
      platform: 'instagram',
      status: 'published',
      remoteId: 'p1',
      remoteUrl: 'https://example.test/p1',
      requestId: null,
      error: null,
      publishedFingerprint: null,
      createdAt: 1000,
      updatedAt: 1000,
      scheduledAt: null,
    })

    const response = await poolRoute()
    const payload = (await response.json()) as {
      clips: { clipId: string; description: string; outputs: { variant9x16Url: string | null }; statuses: Record<string, string> }[]
    }
    const clip = payload.clips[0]
    expect(clip.description).toBe('Une scène.')
    expect(clip.outputs.variant9x16Url).not.toBeNull()
    expect(clip.statuses).toEqual({ instagram: 'published' })
  })

  /**
   * `urlVignette(clip, true)` : le vivier ne teste plus le proxy avant de
   * publier l'URL — `deliveryToDay` venant d'être vérifié, la route du thumb
   * peut servir l'affiche du rendu même sans lui.
   */
  it("rend l'URL de l'affiche même sans proxy, pour un clip à jour", async () => {
    putClip(getDb(), baseClip('sans-proxy'))
    fresh.add('sans-proxy')

    const response = await poolRoute()
    const payload = (await response.json()) as { clips: { thumbnailUrl: string | null }[] }
    expect(payload.clips[0].thumbnailUrl).toBe(`/api/clips/${encodeURIComponent('sans-proxy')}/thumb?poster=render`)
  })

  it("rend l'URL de l'affiche quand le proxy est aussi présent", async () => {
    putClip(getDb(), baseClip('avec-proxy'))
    fresh.add('avec-proxy')
    const proxy = proxyPath(PROJECT_ID)
    fs.mkdirSync(path.dirname(proxy), { recursive: true })
    fs.writeFileSync(proxy, '')

    const response = await poolRoute()
    const payload = (await response.json()) as { clips: { thumbnailUrl: string | null }[] }
    expect(payload.clips[0].thumbnailUrl).toBe(`/api/clips/${encodeURIComponent('avec-proxy')}/thumb?poster=render`)
  })
})

describe('GET /api/planning/schedule', () => {
  it('rend les échéances dans la fenêtre, triées', async () => {
    putClip(getDb(), baseClip('a'))
    putClip(getDb(), baseClip('b'))
    fresh.add('a')
    fresh.add('b')
    schedulePublications(getDb(), ['b'], 9000, 1000)
    schedulePublications(getDb(), ['a'], 5000, 1000)

    const response = await scheduleGetRoute(getRequest('http://test/api/planning/schedule?from=0&to=10000'))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { entries: { clipId: string; scheduledAt: number }[] }
    expect(payload.entries.map((e) => e.clipId)).toEqual(['a', 'b'])
  })

  it('400 sans `from`/`to` numériques', async () => {
    const response = await scheduleGetRoute(getRequest('http://test/api/planning/schedule?from=abc&to=10000'))
    expect(response.status).toBe(400)
  })

  it('400 si `from` est omis — `Number(null)` vaut 0, un piège à ne pas laisser passer', async () => {
    const response = await scheduleGetRoute(getRequest('http://test/api/planning/schedule?to=10000'))
    expect(response.status).toBe(400)
  })

  it("400 si `from` est une chaîne vide — `Number('')` vaut aussi 0", async () => {
    const response = await scheduleGetRoute(getRequest('http://test/api/planning/schedule?from=&to=10000'))
    expect(response.status).toBe(400)
  })

  // Une plateforme déjà publiée garde l'échéance de son envoi ; les lignes
  // encore `planned` du même clip peuvent porter une date différente après
  // reprogrammation. L'entrée doit montrer la date à venir, pas l'ancienne.
  it("montre l'échéance encore à venir, pas celle d'une plateforme déjà publiée", async () => {
    putClip(getDb(), baseClip('a'))
    fresh.add('a')
    schedulePublications(getDb(), ['a'], 5000, 1000)
    upsertPublication(getDb(), {
      clipId: 'a',
      platform: 'youtube',
      status: 'published',
      remoteId: 'p1',
      remoteUrl: 'https://example.test/p1',
      requestId: null,
      error: null,
      publishedFingerprint: null,
      createdAt: 1000,
      updatedAt: 1000,
      scheduledAt: 5000,
    })
    schedulePublications(getDb(), ['a'], 9000, 2000)

    const response = await scheduleGetRoute(getRequest('http://test/api/planning/schedule?from=0&to=10000'))
    const payload = (await response.json()) as { entries: { clipId: string; scheduledAt: number }[] }
    expect(payload.entries).toEqual([expect.objectContaining({ clipId: 'a', scheduledAt: 9000 })])
  })

  // Les statuts affichés lisent toutes les lignes du clip, pas seulement
  // celles dont l'échéance tombe dans `from`/`to` : une fenêtre étroite ne
  // doit pas faire disparaître le statut d'une plateforme déjà publiée.
  it("montre le statut de toutes les plateformes, même hors fenêtre", async () => {
    putClip(getDb(), baseClip('a'))
    fresh.add('a')
    schedulePublications(getDb(), ['a'], 5000, 1000)
    upsertPublication(getDb(), {
      clipId: 'a',
      platform: 'youtube',
      status: 'published',
      remoteId: 'p1',
      remoteUrl: 'https://example.test/p1',
      requestId: null,
      error: null,
      publishedFingerprint: null,
      createdAt: 1000,
      updatedAt: 1000,
      scheduledAt: 5000,
    })
    schedulePublications(getDb(), ['a'], 9000, 2000)

    // La fenêtre exclut 5000 (l'ancienne échéance youtube), ne couvre que 9000.
    const response = await scheduleGetRoute(getRequest('http://test/api/planning/schedule?from=8000&to=10000'))
    const payload = (await response.json()) as {
      entries: { clipId: string; statuses: Record<string, { status: string }> }[]
    }
    expect(payload.entries[0].statuses.youtube?.status).toBe('published')
  })

  // Ce que les emails d'alerte lisent déjà (`notifyAbandoned`) doit
  // atteindre le planning sans passe de traduction séparée : la raison, le
  // dernier essai, et le lien si la plateforme l'a rendu.
  it("montre l'erreur, le dernier essai et le lien d'une plateforme en échec", async () => {
    putClip(getDb(), baseClip('a'))
    fresh.add('a')
    schedulePublications(getDb(), ['a'], 5000, 1000)
    upsertPublication(getDb(), {
      clipId: 'a',
      platform: 'tiktok',
      status: 'failed',
      remoteId: null,
      remoteUrl: 'https://tiktok.com/@avolo/video/1',
      requestId: 'req-1',
      error: 'Le débit TikTok est atteint.',
      publishedFingerprint: null,
      createdAt: 1000,
      updatedAt: 4242,
      scheduledAt: 5000,
    })

    const response = await scheduleGetRoute(getRequest('http://test/api/planning/schedule?from=0&to=10000'))
    const payload = (await response.json()) as {
      entries: {
        clipId: string
        statuses: Record<string, { status: string; error: string | null; updatedAt: number; remoteUrl: string | null }>
      }[]
    }
    expect(payload.entries[0].statuses.tiktok).toEqual({
      status: 'failed',
      error: 'Le débit TikTok est atteint.',
      updatedAt: 4242,
      remoteUrl: 'https://tiktok.com/@avolo/video/1',
    })
  })

  // Le cas contre-intuitif de la spec (§5.2) : le calendrier lit les
  // publications, jamais le vivier. Un clip reprogrammé qui retombe à `kept`
  // reste sur le calendrier, et son rendu périmé se signale par `stale`.
  it('montre un clip retombé à `kept` et périmé, avec `stale: true`', async () => {
    putClip(getDb(), baseClip('retombé'))
    fresh.add('retombé')
    schedulePublications(getDb(), ['retombé'], 5000, 1000)
    putClip(getDb(), baseClip('retombé', { status: 'kept' }))
    fresh.delete('retombé')

    const response = await scheduleGetRoute(getRequest('http://test/api/planning/schedule?from=0&to=10000'))
    const payload = (await response.json()) as { entries: { clipId: string; stale: boolean }[] }
    expect(payload.entries).toEqual([expect.objectContaining({ clipId: 'retombé', stale: true })])
  })
})

describe('POST /api/planning/schedule', () => {
  it('pose les quatre plateformes en `planned` et les rend', async () => {
    putClip(getDb(), baseClip('a'))
    fresh.add('a')

    const response = await scheduleRoute(
      postRequest('http://test/api/planning/schedule', { clipIds: ['a'], scheduledAt: 5000 }),
    )
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      entries: { clipId: string; statuses: Record<string, string> }[]
    }
    expect(payload.entries).toHaveLength(1)
    expect(Object.keys(payload.entries[0].statuses).sort()).toEqual([
      'facebook',
      'instagram',
      'tiktok',
      'youtube',
    ])
    expect(getPublications(getDb(), 'a')).toHaveLength(4)
  })

  // Une plateforme déjà publiée à la main n'a pas d'échéance : le filtre sur
  // `scheduledAt` la faisait disparaître de la réponse alors que le GET la
  // montre. Les deux doivent s'accorder (relevé par Copilot, passe 4).
  it('montre aussi une plateforme déjà publiée manuellement, sans échéance', async () => {
    putClip(getDb(), baseClip('a'))
    upsertPublication(getDb(), {
      clipId: 'a',
      platform: 'youtube',
      status: 'published',
      remoteId: 'p1',
      remoteUrl: 'https://example.test/p1',
      requestId: null,
      error: null,
      publishedFingerprint: null,
      createdAt: 1000,
      updatedAt: 1000,
      scheduledAt: null,
    })

    const response = await scheduleRoute(
      postRequest('http://test/api/planning/schedule', { clipIds: ['a'], scheduledAt: 5000 }),
    )
    const payload = (await response.json()) as { entries: { statuses: Record<string, { status: string }> }[] }
    expect(payload.entries[0].statuses.youtube?.status).toBe('published')
  })

  it('400 sur des identifiants dupliqués', async () => {
    const response = await scheduleRoute(
      postRequest('http://test/api/planning/schedule', { clipIds: ['a', 'a'], scheduledAt: 5000 }),
    )
    expect(response.status).toBe(400)
  })

  it('400 sur un clip inconnu, plutôt qu\'une contrainte de clé étrangère non attrapée', async () => {
    const response = await scheduleRoute(
      postRequest('http://test/api/planning/schedule', { clipIds: ['fantome'], scheduledAt: 5000 }),
    )
    expect(response.status).toBe(400)
  })

  it('400 sur un clip dont les quatre plateformes portent déjà un résultat', async () => {
    putClip(getDb(), baseClip('épuisé'))
    for (const platform of ['instagram', 'facebook', 'tiktok', 'youtube'] as const) {
      upsertPublication(getDb(), {
        clipId: 'épuisé',
        platform,
        status: 'published',
        remoteId: 'p1',
        remoteUrl: 'https://example.test/p1',
        requestId: null,
        error: null,
        publishedFingerprint: null,
        createdAt: 1000,
        updatedAt: 1000,
        scheduledAt: null,
      })
    }

    const response = await scheduleRoute(
      postRequest('http://test/api/planning/schedule', { clipIds: ['épuisé'], scheduledAt: 5000 }),
    )
    expect(response.status).toBe(400)
  })
})

describe('POST /api/planning/unschedule', () => {
  it('retire les lignes `planned`, rend le compte', async () => {
    putClip(getDb(), baseClip('a'))
    schedulePublications(getDb(), ['a'], 5000, 1000)

    const response = await unscheduleRoute(
      postRequest('http://test/api/planning/unschedule', { clipIds: ['a'] }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ removed: 4 })
    expect(getPublications(getDb(), 'a')).toEqual([])
  })

  it('laisse une ligne qui porte déjà un résultat', async () => {
    putClip(getDb(), baseClip('a'))
    schedulePublications(getDb(), ['a'], 5000, 1000)
    upsertPublication(getDb(), {
      clipId: 'a',
      platform: 'youtube',
      status: 'published',
      remoteId: 'p1',
      remoteUrl: 'https://example.test/p1',
      requestId: null,
      error: null,
      publishedFingerprint: null,
      createdAt: 1000,
      updatedAt: 1000,
      scheduledAt: 5000,
    })

    const response = await unscheduleRoute(
      postRequest('http://test/api/planning/unschedule', { clipIds: ['a'] }),
    )
    expect(await response.json()).toEqual({ removed: 3 })
    expect(getPublications(getDb(), 'a').map((r) => r.platform)).toEqual(['youtube'])
  })
})
