import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PublicationJob } from '@/server/publication/adapter'
import { createMetaAdapter } from '@/server/publication/meta'
import {
  ensureFreshInstagramToken,
  forgetTokenCache,
  readMetaTokens,
  writeMetaTokens,
} from '@/server/publication/meta-tokens'

/**
 * Le connecteur Meta direct, contre un `fetch` injecté — jamais le réseau,
 * l'app Meta n'existe pas encore côté serveur de test. Le seul chemin
 * réellement exercé sur le vrai réseau, une fois, est le flux Instagram
 * décrit ici (issue #146) ; Facebook Page Reels reste non vérifié.
 */

let root: string
let videoPath: string
const envStart = { ...process.env }

function job(overrides: Partial<PublicationJob> = {}): PublicationJob {
  return {
    clipId: 'clip_0001',
    videoPath,
    title: '',
    description: 'La chute\n\nUne impro qui part en vrille',
    fingerprint: 'abc123',
    ...overrides,
  }
}

function jsonResponse(status: number, body: unknown, statusText = ''): Response {
  return new Response(JSON.stringify(body), { status, statusText })
}

const noSleep = async (): Promise<void> => {}

const ENV = { META_APP_ID: 'app1', META_APP_SECRET: 'secret1', META_PAGE_ID: 'page1', META_PAGE_TOKEN: 'pagetoken1' }

async function seedInstagramToken(token = 'OLD'): Promise<void> {
  await writeMetaTokens({ instagramUserId: 'ig1', instagramAccessToken: token, instagramTokenExpiresAt: Date.now() + 5_000_000_000 })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-meta-'))
  process.env.PROJECTS_DIR = root
  videoPath = path.join(root, 'clip.mp4')
  fs.writeFileSync(videoPath, 'un MP4 pour de faux')
  forgetTokenCache()
})

afterEach(() => {
  process.env = { ...envStart }
  fs.rmSync(root, { recursive: true, force: true })
})

type Handler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Le routeur d'un flux Instagram complet, la publication finissant par `permalink`. */
function instagramHandler(
  options: {
    pollsBeforeFinished?: number
    publishError?: { status: number; body: unknown }
    uploadFailuresBeforeOk?: number
  } = {},
): { handler: Handler; order: string[] } {
  const { pollsBeforeFinished = 1, publishError, uploadFailuresBeforeOk = 0 } = options
  const order: string[] = []
  let polls = 0
  let uploadAttempts = 0

  const handler: Handler = async (input, init) => {
    const url = input.toString()
    const method = init?.method ?? 'GET'

    if (url.includes('/oauth/access_token')) {
      order.push('refresh')
      return jsonResponse(200, { access_token: 'FRESH', expires_in: 5_184_000 })
    }
    if (method === 'POST' && url.endsWith('/ig1/media')) {
      order.push('create')
      return jsonResponse(200, { id: 'container1' })
    }
    if (url.includes('rupload.facebook.com/ig-api-upload/')) {
      uploadAttempts += 1
      order.push('upload')
      if (uploadAttempts <= uploadFailuresBeforeOk) return new Response('transient', { status: 400 })
      return new Response('', { status: 200 })
    }
    if (url.includes('/container1?fields=status_code')) {
      polls += 1
      order.push('poll')
      return jsonResponse(200, { status_code: polls < pollsBeforeFinished ? 'IN_PROGRESS' : 'FINISHED' })
    }
    if (method === 'POST' && url.endsWith('/ig1/media_publish')) {
      order.push('publish')
      if (publishError !== undefined) return jsonResponse(publishError.status, publishError.body)
      return jsonResponse(200, { id: 'media1' })
    }
    if (url.includes('/media1?fields=permalink')) {
      order.push('permalink')
      return jsonResponse(200, { permalink: 'https://www.instagram.com/reel/abc123/' })
    }
    if (url.includes('/ig1?fields=id')) return jsonResponse(200, { id: 'ig1' })
    throw new Error(`URL Instagram inattendue dans ce test : ${url}`)
  }

  return { handler, order }
}

function instagramFetch(options: Parameters<typeof instagramHandler>[0] = {}): {
  fetchImpl: typeof fetch
  order: string[]
} {
  const { handler, order } = instagramHandler(options)
  return { fetchImpl: vi.fn(handler) as unknown as typeof fetch, order }
}

describe('publishInstagram', () => {
  it('publie seulement après FINISHED, jamais pendant IN_PROGRESS', async () => {
    await seedInstagramToken()
    const { fetchImpl, order } = instagramFetch({ pollsBeforeFinished: 2 })
    const adapter = createMetaAdapter(ENV, fetchImpl, noSleep)

    const outcomes = await adapter.publish(job(), ['instagram'])

    expect(outcomes.instagram).toEqual({
      status: 'published',
      remoteId: 'media1',
      remoteUrl: 'https://www.instagram.com/reel/abc123/',
    })
    expect(order.filter((step) => step === 'poll')).toHaveLength(2)
    expect(order.indexOf('publish')).toBeGreaterThan(order.lastIndexOf('poll'))
  })

  it('téléverse le contenu réel du fichier, pas un chemin déduit', async () => {
    await seedInstagramToken()
    fs.writeFileSync(videoPath, 'contenu spécifique du test')
    const { fetchImpl } = instagramFetch()
    const adapter = createMetaAdapter(ENV, fetchImpl, noSleep)

    await adapter.publish(job(), ['instagram'])

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit | undefined][]
    const uploadCall = calls.find(([url]) => url.includes('ig-api-upload'))
    expect(uploadCall).toBeDefined()
    const body = uploadCall?.[1]?.body as Blob
    expect(await body.text()).toBe('contenu spécifique du test')
  })

  it('abandonne avec une erreur nommée après le budget de sondage, sans boucler indéfiniment', async () => {
    await seedInstagramToken()
    const { fetchImpl } = instagramFetch({ pollsBeforeFinished: 1_000 })
    const adapter = createMetaAdapter(ENV, fetchImpl, noSleep)

    const outcomes = await adapter.publish(job(), ['instagram'])

    expect(outcomes.instagram.status).toBe('failed')
    expect((outcomes.instagram as { error: string }).error).toMatch(/n'a pas atteint FINISHED/)
  })

  it('réessaie un 400 transitoire de rupload plutôt que d’abandonner (issue #146)', async () => {
    await seedInstagramToken()
    const { fetchImpl } = instagramFetch({ uploadFailuresBeforeOk: 1 })
    const adapter = createMetaAdapter(ENV, fetchImpl, noSleep)

    const outcomes = await adapter.publish(job(), ['instagram'])

    expect(outcomes.instagram.status).toBe('published')
  })

  it('un `error_subcode: 2207085` se nomme « droit manquant sur l’actif », pas le message trompeur de Meta', async () => {
    await seedInstagramToken()
    const { fetchImpl } = instagramFetch({
      publishError: {
        status: 400,
        body: { error: { message: 'Une erreur de serveur interne est survenue.', code: 1, error_subcode: 2207085 } },
      },
    })
    const adapter = createMetaAdapter(ENV, fetchImpl, noSleep)

    const outcomes = await adapter.publish(job(), ['instagram'])

    expect(outcomes.instagram.status).toBe('failed')
    expect((outcomes.instagram as { error: string }).error).toMatch(/droit sur l'actif/)
  })
})

/** Le routeur d'un flux Facebook complet, jusqu'au sondage `publishing_phase`. */
function facebookHandler(
  options: { pollPhases?: readonly string[] } = {},
): { handler: Handler; order: string[] } {
  const { pollPhases = ['complete'] } = options
  const order: string[] = []
  let polls = 0

  const handler: Handler = async (input, init) => {
    const url = input.toString()
    const method = init?.method ?? 'GET'

    if (method === 'POST' && url === 'https://graph.facebook.com/v23.0/page1/video_reels') {
      const body = (init?.body as URLSearchParams).toString()
      if (body.includes('upload_phase=start')) {
        order.push('start')
        return jsonResponse(200, { video_id: 'video1' })
      }
      order.push('finish')
      return jsonResponse(200, { success: true })
    }
    if (url.includes('rupload.facebook.com/video-upload/v23.0/video1')) {
      order.push('upload')
      return new Response('', { status: 200 })
    }
    if (url.includes('/video1?fields=status')) {
      const phase = pollPhases[Math.min(polls, pollPhases.length - 1)]
      polls += 1
      order.push('poll')
      return jsonResponse(200, { status: { publishing_phase: { status: phase } } })
    }
    if (url.includes('/page1?fields=id')) return jsonResponse(200, { id: 'page1' })
    throw new Error(`URL Facebook inattendue dans ce test : ${url}`)
  }

  return { handler, order }
}

describe('publishFacebook', () => {
  it('ne publie qu’après publishing_phase.status === complete, jamais sur le succès de finish seul', async () => {
    const { handler, order } = facebookHandler({ pollPhases: ['in_progress', 'complete'] })
    const adapter = createMetaAdapter(ENV, handler as unknown as typeof fetch, noSleep)

    const outcomes = await adapter.publish(job(), ['facebook'])

    expect(outcomes.facebook).toEqual({ status: 'published', remoteId: 'video1', remoteUrl: null })
    expect(order.filter((step) => step === 'poll')).toHaveLength(2)
    expect(order.indexOf('finish')).toBeLessThan(order.lastIndexOf('poll'))
  })

  it('échoue nommément si publishing_phase.status passe à error, sans jamais annoncer published', async () => {
    const { handler } = facebookHandler({ pollPhases: ['error'] })
    const adapter = createMetaAdapter(ENV, handler as unknown as typeof fetch, noSleep)

    const outcomes = await adapter.publish(job(), ['facebook'])

    expect(outcomes.facebook.status).toBe('failed')
    expect((outcomes.facebook as { error: string }).error).toMatch(/publishing_phase\.status=error/)
  })

  it('abandonne avec une erreur nommée après le budget de sondage, sans boucler indéfiniment', async () => {
    const { handler } = facebookHandler({ pollPhases: ['in_progress'] })
    const adapter = createMetaAdapter(ENV, handler as unknown as typeof fetch, noSleep)

    const outcomes = await adapter.publish(job(), ['facebook'])

    expect(outcomes.facebook.status).toBe('failed')
    expect((outcomes.facebook as { error: string }).error).toMatch(/n'a pas atteint publishing_phase\.status=complete/)
  })
})

describe('publish — Instagram et Facebook sont indépendants', () => {
  it('un échec Facebook n’annule pas une réussite Instagram, et réciproquement', async () => {
    await seedInstagramToken()
    const { handler: instagram } = instagramHandler()
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString()
      if (url.includes('/page1/video_reels')) {
        return jsonResponse(400, { error: { message: 'Page non autorisée', code: 200 } })
      }
      return instagram(input, init)
    }) as unknown as typeof fetch

    const adapter = createMetaAdapter(ENV, fetchImpl, noSleep)
    const outcomes = await adapter.publish(job(), ['instagram', 'facebook'])

    expect(outcomes.instagram.status).toBe('published')
    expect(outcomes.facebook.status).toBe('failed')
  })
})

describe('availability', () => {
  it('sans aucun identifiant Meta : `not_configured` pour les deux, aucun appel réseau', async () => {
    const fetchImpl = vi.fn()
    const adapter = createMetaAdapter({}, fetchImpl as unknown as typeof fetch, noSleep)

    const availability = await adapter.availability({})

    expect(availability.instagram).toEqual({ available: false, reason: 'not_configured' })
    expect(availability.facebook).toEqual({ available: false, reason: 'not_configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('app configurée mais jamais appairée : `not_configured`, aucun appel réseau', async () => {
    const fetchImpl = vi.fn()
    const adapter = createMetaAdapter(
      { META_APP_ID: 'app1', META_APP_SECRET: 'secret1' },
      fetchImpl as unknown as typeof fetch,
      noSleep,
    )

    const availability = await adapter.availability({ META_APP_ID: 'app1', META_APP_SECRET: 'secret1' })

    expect(availability.instagram).toEqual({ available: false, reason: 'not_configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('jeton appairé et valide : Instagram disponible', async () => {
    await seedInstagramToken()
    const { fetchImpl } = instagramFetch()
    // Aucune Page renseignée : Facebook reste `not_configured`, sans appel réseau.
    const adapter = createMetaAdapter({ META_APP_ID: 'app1', META_APP_SECRET: 'secret1' }, fetchImpl, noSleep)

    const availability = await adapter.availability({ META_APP_ID: 'app1', META_APP_SECRET: 'secret1' })

    expect(availability.instagram).toEqual({ available: true })
    expect(availability.facebook).toEqual({ available: false, reason: 'not_configured' })
  })

  it('Page et jeton renseignés et valides : Facebook disponible', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString()
      if (url.includes('/page1?fields=id')) return jsonResponse(200, { id: 'page1' })
      throw new Error(`inattendu : ${url}`)
    }) as unknown as typeof fetch
    const adapter = createMetaAdapter(ENV, fetchImpl, noSleep)

    const availability = await adapter.availability(ENV)

    expect(availability.facebook).toEqual({ available: true })
  })
})

describe('jeton Instagram', () => {
  it('persiste ce que le rafraîchissement rend, et la valeur suivante est la nouvelle — pas l’originale', async () => {
    await seedInstagramToken('OLD')

    const firstRefresh = vi.fn(async () => jsonResponse(200, { access_token: 'NEW', expires_in: 100 })) as unknown as typeof fetch
    const tokensAfterFirst = await ensureFreshInstagramToken(ENV, firstRefresh)
    expect(tokensAfterFirst.instagramAccessToken).toBe('NEW')

    const onDisk = await readMetaTokens()
    expect(onDisk?.instagramAccessToken).toBe('NEW')

    forgetTokenCache()
    const secondRefresh = vi.fn(async (input: string | URL | Request) => {
      expect(input.toString()).toContain('fb_exchange_token=NEW')
      return jsonResponse(200, { access_token: 'NEWER', expires_in: 100 })
    }) as unknown as typeof fetch
    const tokensAfterSecond = await ensureFreshInstagramToken(ENV, secondRefresh)
    expect(tokensAfterSecond.instagramAccessToken).toBe('NEWER')

    const onDiskAgain = await readMetaTokens()
    expect(onDiskAgain?.instagramAccessToken).toBe('NEWER')
  })

  it('un seul rafraîchissement par processus, même sur des appels concurrents', async () => {
    await seedInstagramToken()
    const fetchImpl = vi.fn(async () => jsonResponse(200, { access_token: 'NEW', expires_in: 100 })) as unknown as typeof fetch

    await Promise.all([ensureFreshInstagramToken(ENV, fetchImpl), ensureFreshInstagramToken(ENV, fetchImpl)])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
