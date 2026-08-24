import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Platform } from '@/core/publication'
import type { PublicationJob } from '@/server/publication/adapter'
import {
  UploadPostAccountMisconfiguredError,
  UploadPostFileRefusedError,
  UploadPostRateLimitError,
  UploadPostTokenExpiredError,
} from '@/server/publication/errors'
import { createUploadPostAdapter, forgetAvailabilityCache } from '@/server/publication/upload-post'

/**
 * Le connecteur Upload Post, contre un `fetch` injecté — jamais le réseau.
 * `tests/server/publish-route.test.ts` couvre l'écriture en base à partir de
 * ces mêmes sorties ; ce fichier-ci couvre le mapping et les erreurs nommées.
 */

let root: string
let videoPath: string

function job(overrides: Partial<PublicationJob> = {}): PublicationJob {
  return {
    clipId: 'clip_0001',
    videoPath,
    title: 'La chute',
    description: 'Une impro qui part en vrille',
    fingerprint: 'abc123',
    ...overrides,
  }
}

function jsonResponse(status: number, body: unknown, statusText = ''): Response {
  return new Response(JSON.stringify(body), { status, statusText })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-upload-post-'))
  videoPath = path.join(root, 'clip.mp4')
  fs.writeFileSync(videoPath, 'un MP4 pour de faux')
  forgetAvailabilityCache()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const ENV = { UPLOAD_POST_API_KEY: 'k', UPLOAD_POST_USER: 'perso' }

describe('publish', () => {
  it('envoie une seule requête pour plusieurs plateformes', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, {
        request_id: 'r1',
        results: {
          instagram: { success: true, url: 'https://instagram.test/p1', post_id: 'p1' },
          tiktok: { success: true, post_id: 'p2' },
        },
      }),
    )
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    await adapter.publish(job(), ['instagram', 'tiktok'])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.upload-post.com/api/upload')
    const form = init.body as FormData
    expect(form.getAll('platform[]')).toEqual(['instagram', 'tiktok'])
  })

  it('un résultat mixte donne un succès et un échec, indépendants l’un de l’autre', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        request_id: 'r1',
        results: {
          instagram: { success: true, url: 'https://instagram.test/p1', post_id: 'p1' },
          tiktok: { success: false, error: 'compte non connecté' },
        },
      }),
    )
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    const outcomes = await adapter.publish(job(), ['instagram', 'tiktok'])

    expect(outcomes.instagram).toEqual({
      status: 'published',
      remoteId: 'p1',
      remoteUrl: 'https://instagram.test/p1',
    })
    expect(outcomes.tiktok).toEqual({ status: 'failed', error: 'compte non connecté' })
  })

  it('un dépôt TikTok réussi est `submitted`, jamais `published`', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { request_id: 'r1', results: { tiktok: { success: true, post_id: 'p2' } } }),
    )
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    const outcomes = await adapter.publish(job(), ['tiktok'])
    expect(outcomes.tiktok.status).toBe('submitted')
  })

  it('une réussite Instagram est `published`, avec son URL', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { request_id: 'r1', results: { instagram: { success: true, url: 'https://x.test/1', post_id: 'p1' } } }),
    )
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    const outcomes = await adapter.publish(job(), ['instagram'])
    expect(outcomes.instagram).toEqual({ status: 'published', remoteId: 'p1', remoteUrl: 'https://x.test/1' })
  })

  it('un 429 lève une erreur nommée qui cite le quota', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { usage: { count: 10, limit: 10 }, message: 'quota' }))
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    await expect(adapter.publish(job(), ['instagram'])).rejects.toThrow(UploadPostRateLimitError)
    await expect(adapter.publish(job(), ['instagram'])).rejects.toThrow(/10\/10/)
  })

  it('un 401 lève UploadPostTokenExpiredError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { message: 'jeton invalide' }))
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    await expect(adapter.publish(job(), ['instagram'])).rejects.toThrow(UploadPostTokenExpiredError)
  })

  it('un 422 lève UploadPostFileRefusedError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(422, { message: 'durée refusée' }))
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    await expect(adapter.publish(job(), ['instagram'])).rejects.toThrow(UploadPostFileRefusedError)
  })

  it('un 400 lève UploadPostAccountMisconfiguredError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { message: 'compte invalide' }))
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    await expect(adapter.publish(job(), ['instagram'])).rejects.toThrow(UploadPostAccountMisconfiguredError)
  })

  it('sans clé ni profil, rejette sans jamais appeler `fetch`', async () => {
    const fetchImpl = vi.fn()
    const adapter = createUploadPostAdapter({}, fetchImpl)
    await expect(adapter.publish(job(), ['instagram'])).rejects.toThrow(UploadPostAccountMisconfiguredError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('une clé encore non résolue (op://…) est un compte mal configuré, pas un jeton expiré', async () => {
    const fetchImpl = vi.fn()
    const adapter = createUploadPostAdapter({ UPLOAD_POST_API_KEY: 'op://Personal/x/y', UPLOAD_POST_USER: 'perso' }, fetchImpl)
    await expect(adapter.publish(job(), ['instagram'])).rejects.toThrow(UploadPostAccountMisconfiguredError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sur Instagram, la légende part dans `title` — le seul champ que la plateforme lit', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { request_id: 'r1', results: {} }))
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    // Comme `platformTexts` le rend pour une plateforme hors YouTube : le titre
    // est vide, la légende entière est dans `description`.
    await adapter.publish(job({ title: '', description: 'Titre\n\nDescription #motdiese' }), ['instagram'])

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const form = init.body as FormData
    expect(form.get('title')).toBe('Titre\n\nDescription #motdiese')
  })

  it('sur YouTube, titre et description restent séparés', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { request_id: 'r1', results: {} }))
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    await adapter.publish(job({ title: 'Titre', description: 'Description' }), ['youtube'])

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const form = init.body as FormData
    expect(form.get('title')).toBe('Titre')
    expect(form.get('description')).toBe('Description')
  })

  it('une republication forcée varie la clé d’idempotence', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { request_id: 'r1', results: {} }))
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    await adapter.publish(job(), ['instagram'])
    await adapter.publish(job({ force: true }), ['instagram'])

    const [, initFirst] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const [, initForced] = fetchImpl.mock.calls[1] as [string, RequestInit]
    const headersFirst = initFirst.headers as Record<string, string>
    const headersForced = initForced.headers as Record<string, string>
    expect(headersForced['Idempotency-Key']).not.toBe(headersFirst['Idempotency-Key'])
  })
})

describe('poll', () => {
  it('lit `results` comme un tableau — la forme réelle de /api/uploadposts/status', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, {
        status: 'completed',
        results: [
          { platform: 'instagram', success: true, post_url: 'https://instagram.test/p1', platform_post_id: 'p1' },
          { platform: 'tiktok', success: false, error_message: 'compte non connecté' },
        ],
      }),
    )
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    const outcomes = await adapter.poll('r1', ['instagram', 'tiktok'])

    expect(outcomes.instagram).toEqual({
      status: 'published',
      remoteId: 'p1',
      remoteUrl: 'https://instagram.test/p1',
    })
    expect(outcomes.tiktok).toEqual({ status: 'failed', error: 'compte non connecté' })
  })

  it('un succès sondé porte son URL et son identifiant, pas `null`', async () => {
    // Capture réelle (compte de Julien, 23 août 2026) : le sondage d'un envoi
    // YouTube résolu porte `post_url`/`platform_post_id`, jamais absents.
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, {
        status: 'completed',
        completed: 1,
        total: 1,
        results: [
          {
            platform: 'youtube',
            success: true,
            platform_post_id: 'fake0Video1d',
            post_url: 'https://www.youtube.com/watch?v=fake0Video1d',
            error_message: null,
            error_code: null,
            failure_stage: null,
          },
        ],
      }),
    )
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    const outcomes = await adapter.poll('r1', ['youtube'])
    expect(outcomes.youtube).toEqual({
      status: 'published',
      remoteId: 'fake0Video1d',
      remoteUrl: 'https://www.youtube.com/watch?v=fake0Video1d',
    })
  })

  it('un échec sondé porte le message d’Upload Post, pas le message par défaut', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, {
        status: 'completed',
        results: [{ platform: 'youtube', success: false, error_message: 'quota YouTube dépassé', failure_stage: 'upload' }],
      }),
    )
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    const outcomes = await adapter.poll('r1', ['youtube'])
    expect(outcomes.youtube).toEqual({ status: 'failed', error: 'quota YouTube dépassé (upload)' })
  })

  it('une plateforme absente des résultats reste `in_progress`', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { status: 'in_progress', results: [] }))
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    const outcomes = await adapter.poll('r1', ['instagram'])
    expect(outcomes.instagram).toEqual({ status: 'in_progress', requestId: 'r1' })
  })

  it('un dépôt TikTok réussi reste `submitted` au sondage aussi', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { status: 'completed', results: [{ platform: 'tiktok', success: true }] }),
    )
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    const outcomes = await adapter.poll('r1', ['tiktok'])
    expect(outcomes.tiktok).toEqual({ status: 'submitted', remoteId: null, remoteUrl: null })
  })
})

describe('availability', () => {
  it('sans clé ni profil : les quatre `not_configured`, aucun appel réseau', async () => {
    const fetchImpl = vi.fn()
    const adapter = createUploadPostAdapter({}, fetchImpl)
    const availability = await adapter.availability({})
    for (const platform of ['instagram', 'facebook', 'tiktok', 'youtube'] as Platform[]) {
      expect(availability[platform]).toEqual({ available: false, reason: 'not_configured' })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('mesure les comptes réellement connectés, pas seulement la présence de la clé', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        profiles: [
          {
            username: 'perso',
            social_accounts: { youtube: { username: 'La Scène Avolo' }, tiktok: {} },
          },
        ],
      }),
    )
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    const availability = await adapter.availability(ENV)
    expect(availability.youtube).toEqual({ available: true })
    expect(availability.tiktok).toEqual({ available: false, reason: 'not_configured' })
    expect(availability.instagram).toEqual({ available: false, reason: 'not_configured' })
    expect(availability.facebook).toEqual({ available: false, reason: 'not_configured' })
  })

  it('rend `unavailable`, pas `not_configured`, quand le relevé échoue', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    const availability = await adapter.availability(ENV)
    expect(availability.youtube).toEqual({ available: false, reason: 'unavailable' })
  })

  it('un `UPLOAD_POST_USER` qui ne correspond à aucun profil est `not_configured`, pas `unavailable`', async () => {
    // La clé répond (pas de panne réseau) mais ne désigne aucun profil connu :
    // une configuration durable à corriger, pas une panne transitoire.
    const fetchImpl = vi.fn(async () => jsonResponse(200, { profiles: [{ username: 'un-autre-profil', social_accounts: {} }] }))
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    const availability = await adapter.availability(ENV)
    expect(availability.youtube).toEqual({ available: false, reason: 'not_configured' })
  })

  it('ne rend jamais `not_paired` : Upload Post n’a pas d’étape d’appairage séparée', async () => {
    const scenarios = [
      { env: {}, fetchImpl: vi.fn() },
      { env: ENV, fetchImpl: vi.fn(async () => jsonResponse(200, { profiles: [] })) },
      {
        env: ENV,
        fetchImpl: vi.fn(async () => {
          throw new Error('ECONNREFUSED')
        }),
      },
    ]
    for (const { env, fetchImpl } of scenarios) {
      forgetAvailabilityCache()
      const adapter = createUploadPostAdapter(env, fetchImpl)
      const availability = await adapter.availability(env)
      for (const platform of ['instagram', 'facebook', 'tiktok', 'youtube'] as Platform[]) {
        expect(availability[platform].available === false && availability[platform].reason).not.toBe('not_paired')
      }
    }
  })

  it('met le relevé en cache : deux appels rapprochés ne font qu’une requête', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { profiles: [{ username: 'perso', social_accounts: {} }] }))
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    await adapter.availability(ENV)
    await adapter.availability(ENV)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('un cache oublié relance une requête', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { profiles: [{ username: 'perso', social_accounts: {} }] }))
    const adapter = createUploadPostAdapter(ENV, fetchImpl)
    await adapter.availability(ENV)
    forgetAvailabilityCache()
    await adapter.availability(ENV)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
