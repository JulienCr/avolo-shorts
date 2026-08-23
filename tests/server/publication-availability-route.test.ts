import { afterEach, describe, expect, it, vi } from 'vitest'

import { forgetAvailabilityCache } from '@/server/publication/upload-post'

/**
 * `GET /api/publication/availability` — même discipline que
 * `GET /api/llm/availability` (contrat B.1) : rend l'état honnête sans
 * jamais lire un secret, et fait bien un aller-retour réseau (contrairement
 * à la version LLM, synchrone).
 */

const envStart = { ...process.env }

afterEach(() => {
  forgetAvailabilityCache()
  process.env = { ...envStart }
  vi.unstubAllGlobals()
})

describe('GET /api/publication/availability', () => {
  it('200, quatre plateformes `not_configured` sans connecteur branché', async () => {
    delete process.env.UPLOAD_POST_API_KEY
    delete process.env.UPLOAD_POST_USER
    const { GET } = await import('@/app/api/publication/availability/route')

    const response = await GET()
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, { available: boolean; reason?: string }>
    expect(Object.keys(body).sort()).toEqual(['facebook', 'instagram', 'tiktok', 'youtube'])
    for (const platform of Object.values(body)) {
      expect(platform).toEqual({ available: false, reason: 'not_configured' })
    }
  })
})
