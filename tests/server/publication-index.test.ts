import { afterEach, describe, expect, it, vi } from 'vitest'

import { forgetAvailabilityCache } from '@/server/publication/upload-post'

/**
 * `src/server/publication/index.ts` — le registre canonique de la « SHARED
 * SEAM » (contrat de la PR « Wave B (UI) ») : `adapterFor` doit rendre un
 * connecteur pour chacune des quatre plateformes (Meta pour Instagram et
 * Facebook, Upload Post pour TikTok et YouTube), et `publicationAvailability`
 * doit rendre `defaultPlatformAvailability()` faute de clé — sans appel réseau.
 */

const envStart = { ...process.env }

afterEach(() => {
  forgetAvailabilityCache()
  process.env = { ...envStart }
  vi.unstubAllGlobals()
})

describe('adapterFor', () => {
  it('rend un connecteur pour chacune des quatre plateformes', async () => {
    const { adapterFor } = await import('@/server/publication')
    for (const platform of ['instagram', 'facebook', 'tiktok', 'youtube'] as const) {
      expect(adapterFor(platform)?.platforms).toContain(platform)
    }
  })

  it('rend la même instance à deux appels sur des plateformes du même connecteur (regroupement, issue #146)', async () => {
    // `service.ts` groupe les plateformes par identité d'objet de l'adaptateur
    // (`groupByAdapter`) : deux instances distinctes pour un même connecteur
    // feraient manquer tout regroupement, comme mesuré en revue sur cette PR.
    const { adapterFor } = await import('@/server/publication')
    expect(adapterFor('instagram')).toBe(adapterFor('facebook'))
    expect(adapterFor('tiktok')).toBe(adapterFor('youtube'))
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
