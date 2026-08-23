import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applySettings, closeDb, getDb } from '@/server/db'
import { forgetAvailabilityCache } from '@/server/publication/upload-post'

/**
 * `src/server/publication/index.ts` — le registre canonique de la « SHARED
 * SEAM » (contrat de la PR « Wave B (UI) ») : `adapterFor` doit rendre un
 * connecteur pour chacune des quatre plateformes (Meta pour Instagram et
 * Facebook, Upload Post pour TikTok et YouTube), et `publicationAvailability`
 * doit rendre `defaultPlatformAvailability()` faute de clé — sans appel réseau.
 *
 * **`adapterFor` lit désormais le réglage `publication` en base** : chaque cas
 * ouvre sa propre base dans un répertoire temporaire, comme
 * `publish-route.test.ts`, pour ne pas hériter du réglage d'un autre test.
 */

const envStart = { ...process.env }
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-publication-index-'))
  process.env.PROJECTS_DIR = path.join(root, 'projects')
})

afterEach(() => {
  closeDb()
  forgetAvailabilityCache()
  process.env = { ...envStart }
  vi.unstubAllGlobals()
  fs.rmSync(root, { recursive: true, force: true })
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

  it('`auto` reproduit l’ordre de priorité d’aujourd’hui, sans réglage', async () => {
    const { adapterFor } = await import('@/server/publication')
    expect(adapterFor('instagram')?.id).toBe('meta')
    expect(adapterFor('facebook')?.id).toBe('meta')
    expect(adapterFor('tiktok')?.id).toBe('upload-post')
    expect(adapterFor('youtube')?.id).toBe('upload-post')
  })

  it('une préférence vers un connecteur enregistré l’emporte sur l’ordre du tableau', async () => {
    applySettings(getDb(), { publication: { facebook: 'upload-post' } })
    const { adapterFor } = await import('@/server/publication')
    expect(adapterFor('facebook')?.id).toBe('upload-post')
  })

  it('une préférence vers un connecteur non enregistré retombe sur l’ordre de priorité, sans lever (protège la PR TikTok)', async () => {
    // `tiktok` est un choix valide pour ce champ (issue de la « SHARED SEAM »)
    // bien qu'aucun adaptateur ne le porte encore — c'est exactement le cas
    // qui doit retomber sur l'ordre de priorité plutôt que d'échouer.
    applySettings(getDb(), { publication: { tiktok: 'tiktok' } })
    const { adapterFor } = await import('@/server/publication')
    expect(() => adapterFor('tiktok')).not.toThrow()
    expect(adapterFor('tiktok')?.id).toBe('upload-post')
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
