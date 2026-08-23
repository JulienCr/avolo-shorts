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
