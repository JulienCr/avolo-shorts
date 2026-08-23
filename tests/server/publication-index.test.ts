import { afterEach, describe, expect, it, vi } from 'vitest'

import { forgetAvailabilityCache } from '@/server/publication/upload-post'

/**
 * `src/server/publication/index.ts` — le registre canonique de la « SHARED
 * SEAM » (contrat de la PR « Wave B (UI) ») : `adapterFor` doit rendre
 * l'adaptateur Upload Post pour les quatre plateformes, et `publicationAvailability`
 * doit rendre `defaultPlatformAvailability()` faute de clé — sans appel réseau.
 */

const envStart = { ...process.env }

afterEach(() => {
  forgetAvailabilityCache()
  process.env = { ...envStart }
  vi.unstubAllGlobals()
})

describe('adapterFor', () => {
  it('rend l’adaptateur Upload Post pour les quatre plateformes', async () => {
    const { adapterFor } = await import('@/server/publication')
    for (const platform of ['instagram', 'facebook', 'tiktok', 'youtube'] as const) {
      expect(adapterFor(platform)?.platforms).toContain(platform)
    }
  })
})

describe('publicationAvailability', () => {
  it('rend l’état honnête d’aujourd’hui sans clé, sans appel réseau', async () => {
    delete process.env.UPLOAD_POST_API_KEY
    delete process.env.UPLOAD_POST_USER
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    const { publicationAvailability } = await import('@/server/publication')
    const availability = await publicationAvailability()

    expect(availability).toEqual({
      instagram: { available: false, reason: 'not_configured' },
      facebook: { available: false, reason: 'not_configured' },
      tiktok: { available: false, reason: 'not_configured' },
      youtube: { available: false, reason: 'not_configured' },
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
