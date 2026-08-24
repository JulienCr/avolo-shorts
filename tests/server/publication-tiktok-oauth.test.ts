import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  completeTikTokCallback,
  exchangeTikTokCode,
  persistPkce,
} from '@/server/publication/tiktok-oauth'
import { readTikTokTokens } from '@/server/publication/tiktok-tokens'

/**
 * `completeTikTokCallback` porte la logique de `GET /tiktok/oauth-callback` —
 * pas de composant React à monter, `fetch` toujours injecté (contre le vrai
 * réseau).
 */

let root: string
const envStart = { ...process.env }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-tiktok-oauth-'))
  process.env.PROJECTS_DIR = root
})

afterEach(() => {
  // Mutation, jamais réassignation : `process.env = { ...envStart }` casse
  // silencieusement `process.loadEnvFile` pour le reste du process (mesuré
  // dans `tests/scripts/dev-common.test.ts`).
  for (const name of Object.keys(process.env)) {
    if (!(name in envStart)) delete process.env[name]
  }
  Object.assign(process.env, envStart)
  fs.rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('completeTikTokCallback', () => {
  it("rejette un state qui ne correspond pas, sans tenter l'échange", async () => {
    await persistPkce('verifier1', 'state-attendu')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await completeTikTokCallback({
      code: 'code1',
      state: 'state-different',
      tiktokError: undefined,
      clientKey: 'ck',
      clientSecret: 'cs',
    })

    expect(result.ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ne consomme pas le vérifieur en attente quand state ne correspond pas', async () => {
    await persistPkce('verifier1', 'state-attendu')
    await completeTikTokCallback({
      code: 'code1',
      state: 'state-different',
      tiktokError: undefined,
      clientKey: 'ck',
      clientSecret: 'cs',
    })

    const pkceFile = path.join(root, '.tiktok-pkce.json')
    expect(fs.existsSync(pkceFile)).toBe(true)
  })

  it('persiste les jetons pour un state correct', async () => {
    await persistPkce('verifier1', 'state-attendu')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          access_token: 'ACCESS',
          refresh_token: 'REFRESH',
          expires_in: 86_400,
          refresh_expires_in: 31_536_000,
          open_id: 'open1',
        }),
      ),
    )

    const result = await completeTikTokCallback({
      code: 'code1',
      state: 'state-attendu',
      tiktokError: undefined,
      clientKey: 'ck',
      clientSecret: 'cs',
    })

    expect(result).toEqual({ ok: true, openId: 'open1' })
    const stored = await readTikTokTokens()
    expect(stored?.accessToken).toBe('ACCESS')
    expect(stored?.refreshToken).toBe('REFRESH')
  })

  it("rend l'erreur de TikTok telle quelle sans exchange quand `error` est déjà dans l'URL", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await completeTikTokCallback({
      code: undefined,
      state: undefined,
      tiktokError: 'access_denied',
      clientKey: 'ck',
      clientSecret: 'cs',
    })

    expect(result).toEqual({ ok: false, reason: 'access_denied' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('exchangeTikTokCode', () => {
  it('rejette une réponse sans access_token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' })))
    await expect(exchangeTikTokCode('ck', 'cs', 'code1', 'verifier1')).rejects.toThrow('invalid_grant')
  })
})
