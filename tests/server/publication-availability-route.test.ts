import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { closeDb } from '@/server/db'
import { forgetAvailabilityCache } from '@/server/publication/upload-post'

/**
 * `GET /api/publication/availability` — même discipline que
 * `GET /api/llm/availability` (contrat B.1) : le secret ne quitte jamais le
 * serveur, mais un connecteur configuré le lit bien pour interroger Upload
 * Post, et cette route fait un aller-retour réseau (contrairement à la
 * version LLM, synchrone). (relevé par Copilot)
 */

const envStart = { ...process.env }

/**
 * Les quatre plateformes sont portées par trois connecteurs, et Meta se dit
 * configuré sur un **fichier de jetons** plutôt que sur une variable : effacer
 * les seules clés d'Upload Post laissait Meta se déclarer disponible dès que
 * `projects/meta-tokens.json` existait, donc vert en worktree et rouge sur une
 * machine réellement appairée.
 */
function isolateConnectors(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'availability-'))
  process.env.PROJECTS_DIR = path.join(root, 'projects')
  for (const name of Object.keys(process.env)) {
    if (/^(UPLOAD_POST|META|TIKTOK)_/.test(name)) delete process.env[name]
  }
  return root
}

let root: string | undefined

afterEach(() => {
  forgetAvailabilityCache()
  process.env = { ...envStart }
  closeDb()
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllGlobals()
  // Un test qui appelle `vi.resetModules()` laisse le registre réinitialisé
  // pour les suivants, hors d'atteinte de `forgetAvailabilityCache()` ci-dessus
  // (lié à l'import statique d'origine). (relevé par Aristarque)
  vi.resetModules()
})

describe('GET /api/publication/availability', () => {
  it('200, quatre plateformes `not_configured` sans connecteur branché', async () => {
    root = isolateConnectors()
    const { GET } = await import('@/app/api/publication/availability/route')

    const response = await GET()
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, { available: boolean; reason?: string }>
    expect(Object.keys(body).sort()).toEqual(['facebook', 'instagram', 'tiktok', 'youtube'])
    for (const platform of Object.values(body)) {
      expect(platform).toEqual({ available: false, reason: 'not_configured' })
    }
  })

  it('200, Instagram `available: true` avec un jeton système persisté', async () => {
    root = isolateConnectors()
    mkdirSync(path.join(root, 'projects'), { recursive: true })
    writeFileSync(
      path.join(root, 'projects', 'meta-tokens.json'),
      JSON.stringify({
        instagramUserId: 'ig1',
        instagramAccessToken: 'tok1',
        // `null` : jeton système, la seule forme que `availability` vérifie
        // sans passer par `META_APP_ID`/`META_APP_SECRET`.
        instagramTokenExpiresAt: null,
      }),
    )
    // Le seul appel réseau que ce chemin déclenche : la vérification du jeton
    // auprès du Graph API. `checkFacebook` n'est jamais atteint sans
    // `META_PAGE_ID`, donc un seul stub suffit.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'ig1' }), { status: 200 })))
    vi.resetModules()

    const { GET } = await import('@/app/api/publication/availability/route')
    const response = await GET()
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, { available: boolean; reason?: string }>
    expect(body.instagram).toEqual({ available: true })
  })
})
