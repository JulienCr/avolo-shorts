import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PublicationJob } from '@/server/publication/adapter'
import {
  createTikTokAdapter,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  planChunks,
} from '@/server/publication/tiktok'
import {
  ensureFreshTikTokToken,
  forgetTikTokTokenCache,
  readTikTokTokens,
  writeTikTokTokens,
} from '@/server/publication/tiktok-tokens'

/**
 * Le connecteur TikTok direct, contre un `fetch` injecté — jamais le réseau,
 * l'app TikTok ne peut être appairée que par un humain devant un navigateur
 * (voir le docbloc de `tiktok.ts`). Aucun de ces chemins n'a jamais touché le
 * vrai réseau.
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

const ENV = { TIKTOK_CLIENT_KEY: 'ck1', TIKTOK_CLIENT_SECRET: 'cs1' }

async function seedTikTokToken(overrides: Partial<Parameters<typeof writeTikTokTokens>[0]> = {}): Promise<void> {
  await writeTikTokTokens({
    openId: 'open1',
    accessToken: 'OLD',
    refreshToken: 'REFRESH_OLD',
    accessTokenExpiresAt: Date.now() + 20 * 3_600_000,
    refreshTokenExpiresAt: Date.now() + 300 * 86_400_000,
    ...overrides,
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-tiktok-'))
  process.env.PROJECTS_DIR = root
  videoPath = path.join(root, 'clip.mp4')
  fs.writeFileSync(videoPath, 'un MP4 pour de faux')
  forgetTikTokTokenCache()
})

afterEach(() => {
  process.env = { ...envStart }
  fs.rmSync(root, { recursive: true, force: true })
})

describe('planChunks', () => {
  it('un seul morceau pour un fichier sous la limite haute', () => {
    expect(planChunks(1024)).toEqual({ chunkSize: 1024, chunkCount: 1, lastChunkSize: 1024 })
    expect(planChunks(MAX_CHUNK_SIZE)).toEqual({
      chunkSize: MAX_CHUNK_SIZE,
      chunkCount: 1,
      lastChunkSize: MAX_CHUNK_SIZE,
    })
  })

  it('un seul morceau, légèrement au-dessus de 64 Mo, quand il n’y a personne dans qui fondre le reste', () => {
    const size = MAX_CHUNK_SIZE + MIN_CHUNK_SIZE - 1
    expect(planChunks(size)).toEqual({ chunkSize: size, chunkCount: 1, lastChunkSize: size })
  })

  it('des morceaux pleins quand le fichier se divise exactement', () => {
    const size = MAX_CHUNK_SIZE * 3
    expect(planChunks(size)).toEqual({ chunkSize: MAX_CHUNK_SIZE, chunkCount: 3, lastChunkSize: MAX_CHUNK_SIZE })
  })

  it('fond le reste dans le dernier morceau plutôt que d’en produire un sous 5 Mo', () => {
    const remainder = MIN_CHUNK_SIZE - 1
    const size = MAX_CHUNK_SIZE * 2 + remainder
    expect(planChunks(size)).toEqual({
      chunkSize: MAX_CHUNK_SIZE,
      chunkCount: 2,
      lastChunkSize: MAX_CHUNK_SIZE + remainder,
    })
  })

  it('un dernier morceau distinct quand le reste atteint déjà 5 Mo', () => {
    const size = MAX_CHUNK_SIZE * 2 + MIN_CHUNK_SIZE
    expect(planChunks(size)).toEqual({ chunkSize: MAX_CHUNK_SIZE, chunkCount: 3, lastChunkSize: MIN_CHUNK_SIZE })
  })

  it('refuse un fichier vide plutôt que de calculer un découpage absurde', () => {
    expect(() => planChunks(0)).toThrow(/vide ou illisible/)
  })
})

type Handler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function initHandler(publishId = 'publish1', uploadUrl = 'https://upload.tiktokapis.com/upload1'): Handler {
  return async (input) => {
    const url = input.toString()
    if (url.endsWith('/post/publish/inbox/video/init/')) {
      return jsonResponse(200, { data: { publish_id: publishId, upload_url: uploadUrl }, error: { code: 'ok' } })
    }
    if (url === uploadUrl) return new Response('', { status: 200 })
    throw new Error(`URL TikTok inattendue dans ce test : ${url}`)
  }
}

describe('publishTikTok (dépôt en brouillon)', () => {
  it('rend submitted, jamais published, sur un dépôt réussi', async () => {
    await seedTikTokToken()
    const fetchImpl = vi.fn(initHandler()) as unknown as typeof fetch
    const adapter = createTikTokAdapter(ENV, fetchImpl)

    const outcomes = await adapter.publish(job(), ['tiktok'])

    // Le point qui compte le plus de tout le sujet (spec §2.3, §6.3) : un test
    // qui comparerait `status` à autre chose que la chaîne littérale
    // `'submitted'` laisserait passer une régression vers `'published'`.
    expect(outcomes.tiktok).toEqual({ status: 'submitted', remoteId: 'publish1', remoteUrl: null })
  })

  it('découpe et envoie le fichier réel en un seul morceau sous la limite', async () => {
    await seedTikTokToken()
    const content = 'contenu spécifique du test'
    const contentSize = Buffer.byteLength(content, 'utf8')
    fs.writeFileSync(videoPath, content)
    const handler = initHandler()
    const fetchImpl = vi.fn(handler) as unknown as typeof fetch
    const adapter = createTikTokAdapter(ENV, fetchImpl)

    await adapter.publish(job(), ['tiktok'])

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      RequestInit | undefined,
    ][]
    const uploadCall = calls.find(([url]) => url.includes('/upload1'))
    expect(uploadCall).toBeDefined()
    const headers = uploadCall?.[1]?.headers as Record<string, string>
    expect(headers['Content-Range']).toBe(`bytes 0-${contentSize - 1}/${contentSize}`)
    const body = uploadCall?.[1]?.body as Blob
    expect(await body.text()).toBe(content)
  })

  it('envoie plusieurs morceaux dont les tailles et les Content-Range respectent le découpage', async () => {
    await seedTikTokToken()
    // Juste au-dessus de deux morceaux pleins : deux morceaux à 64 Mo, un
    // troisième de 6 Mo (>= 5 Mo, spec §2.3) — le cas « plusieurs morceaux »
    // du critère d'acceptation.
    const totalSize = MAX_CHUNK_SIZE * 2 + 6 * 1024 * 1024
    fs.writeFileSync(videoPath, Buffer.alloc(totalSize, 'x'))
    const handler = initHandler()
    const fetchImpl = vi.fn(handler) as unknown as typeof fetch
    const adapter = createTikTokAdapter(ENV, fetchImpl)

    await adapter.publish(job(), ['tiktok'])

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      RequestInit | undefined,
    ][]
    const uploadCalls = calls.filter(([url]) => url.includes('/upload1'))
    expect(uploadCalls).toHaveLength(3)
    const ranges = uploadCalls.map(([, init]) => (init?.headers as Record<string, string>)['Content-Range'])
    expect(ranges[0]).toBe(`bytes 0-${MAX_CHUNK_SIZE - 1}/${totalSize}`)
    expect(ranges[1]).toBe(`bytes ${MAX_CHUNK_SIZE}-${MAX_CHUNK_SIZE * 2 - 1}/${totalSize}`)
    expect(ranges[2]).toBe(`bytes ${MAX_CHUNK_SIZE * 2}-${totalSize - 1}/${totalSize}`)
    const sizes = await Promise.all(uploadCalls.map(([, init]) => (init?.body as Blob).size))
    expect(sizes).toEqual([MAX_CHUNK_SIZE, MAX_CHUNK_SIZE, 6 * 1024 * 1024])
  }, 20_000)

  it('nomme le jeton expiré sur un access_token_invalid, sans faire échouer les autres plateformes visées', async () => {
    await seedTikTokToken()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString()
      if (url.endsWith('/post/publish/inbox/video/init/')) {
        return jsonResponse(200, { error: { code: 'access_token_invalid', message: 'jeton révoqué' } })
      }
      throw new Error(`inattendu : ${url}`)
    }) as unknown as typeof fetch
    const adapter = createTikTokAdapter(ENV, fetchImpl)

    const outcomes = await adapter.publish(job(), ['tiktok'])

    expect(outcomes.tiktok.status).toBe('failed')
    expect((outcomes.tiktok as { error: string }).error).toMatch(/jeton révoqué/)
  })
})

describe('ensureFreshTikTokToken', () => {
  it('rafraîchit un accès sur le point d’expirer et persiste ce que TikTok rend, jamais une supposition', async () => {
    await seedTikTokToken({ accessTokenExpiresAt: Date.now() + 60_000 })
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString()
      if (url.endsWith('/oauth/token/')) {
        return jsonResponse(200, {
          access_token: 'FRESH_ACCESS',
          refresh_token: 'FRESH_REFRESH',
          expires_in: 43_200,
          refresh_expires_in: 15_768_000,
          open_id: 'open1',
        })
      }
      throw new Error(`inattendu : ${url}`)
    }) as unknown as typeof fetch

    const refreshed = await ensureFreshTikTokToken(ENV, fetchImpl)

    expect(refreshed.accessToken).toBe('FRESH_ACCESS')
    expect(refreshed.refreshToken).toBe('FRESH_REFRESH')
    const persisted = await readTikTokTokens()
    expect(persisted?.accessToken).toBe('FRESH_ACCESS')
    expect(persisted?.refreshToken).toBe('FRESH_REFRESH')
  })

  it('utilise le nouveau jeton pour l’appel suivant, pas l’ancien', async () => {
    await seedTikTokToken({ accessTokenExpiresAt: Date.now() + 60_000 })
    const seenAuthorizations: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString()
      if (url.endsWith('/oauth/token/')) {
        return jsonResponse(200, {
          access_token: 'FRESH_ACCESS',
          refresh_token: 'FRESH_REFRESH',
          expires_in: 43_200,
          refresh_expires_in: 15_768_000,
          open_id: 'open1',
        })
      }
      if (url.endsWith('/post/publish/inbox/video/init/')) {
        seenAuthorizations.push((init?.headers as Record<string, string>).Authorization)
        return jsonResponse(200, { data: { publish_id: 'p1', upload_url: 'https://u/x' }, error: { code: 'ok' } })
      }
      if (url === 'https://u/x') return new Response('', { status: 200 })
      throw new Error(`inattendu : ${url}`)
    }) as unknown as typeof fetch
    const adapter = createTikTokAdapter(ENV, fetchImpl)

    await adapter.publish(job(), ['tiktok'])

    expect(seenAuthorizations).toEqual(['Bearer FRESH_ACCESS'])
  })
})

describe('availability', () => {
  it('rend not_configured sans clé ni secret, sans appel réseau', async () => {
    const fetchImpl = vi.fn()
    const adapter = createTikTokAdapter({}, fetchImpl as unknown as typeof fetch)

    const result = await adapter.availability({})

    expect(result.tiktok).toEqual({ available: false, reason: 'not_configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rend not_configured sans jeton appairé, sans appel réseau, même avec la clé et le secret', async () => {
    const fetchImpl = vi.fn()
    const adapter = createTikTokAdapter(ENV, fetchImpl as unknown as typeof fetch)

    const result = await adapter.availability(ENV)

    expect(result.tiktok).toEqual({ available: false, reason: 'not_configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rend available une fois la clé, le secret et le jeton en place et le compte joignable', async () => {
    await seedTikTokToken()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString()
      if (url.includes('/user/info/')) return jsonResponse(200, { data: { open_id: 'open1' }, error: { code: 'ok' } })
      throw new Error(`inattendu : ${url}`)
    }) as unknown as typeof fetch
    const adapter = createTikTokAdapter(ENV, fetchImpl)

    const result = await adapter.availability(ENV)

    expect(result.tiktok).toEqual({ available: true })
  })

  it('rend unavailable quand le compte ne répond pas', async () => {
    await seedTikTokToken()
    const fetchImpl = vi.fn(async () => new Response('panne', { status: 500 })) as unknown as typeof fetch
    const adapter = createTikTokAdapter(ENV, fetchImpl)

    const result = await adapter.availability(ENV)

    expect(result.tiktok).toEqual({ available: false, reason: 'unavailable' })
  })
})
