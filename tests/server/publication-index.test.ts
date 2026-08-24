import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applySettings, closeDb, getDb } from '@/server/db'
import { forgetTikTokTokenCache } from '@/server/publication/tiktok-tokens'
import { forgetAvailabilityCache } from '@/server/publication/upload-post'

/**
 * `src/server/publication/index.ts` — le registre canonique de la « SHARED
 * SEAM » (contrat de la PR « Wave B (UI) ») : `adapterFor` doit rendre un
 * connecteur pour chacune des quatre plateformes (Meta pour Instagram et
 * Facebook, TikTok direct pour TikTok, Upload Post pour YouTube), et
 * `publicationAvailability` doit rendre `defaultPlatformAvailability()` faute
 * de clé — sans appel réseau.
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
  forgetTikTokTokenCache()
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
  })

  it('sépare désormais TikTok de YouTube (connecteur TikTok direct, cette PR)', async () => {
    // Avant cette PR, Upload Post portait les deux et cette même assertion
    // vérifiait le regroupement inverse (`toBe`) : le devenir `not.toBe` est
    // le signe que TikTok a bien son propre connecteur, pas une régression.
    const { adapterFor } = await import('@/server/publication')
    expect(adapterFor('tiktok')).not.toBe(adapterFor('youtube'))
    expect(adapterFor('tiktok')?.id).toBe('tiktok')
  })

  it('`auto` reproduit l’ordre de priorité d’aujourd’hui, sans réglage', async () => {
    // TikTok direct existe désormais (cette PR) et passe devant Upload Post
    // pour la plateforme `tiktok` — gratuit l'emporte, comme Meta le fait déjà
    // pour Instagram et Facebook.
    const { adapterFor } = await import('@/server/publication')
    expect(adapterFor('instagram')?.id).toBe('meta')
    expect(adapterFor('facebook')?.id).toBe('meta')
    expect(adapterFor('tiktok')?.id).toBe('tiktok')
    expect(adapterFor('youtube')?.id).toBe('upload-post')
  })

  it('une préférence vers un connecteur enregistré l’emporte sur l’ordre du tableau', async () => {
    applySettings(getDb(), { publication: { facebook: 'upload-post' } })
    const { adapterFor } = await import('@/server/publication')
    expect(adapterFor('facebook')?.id).toBe('upload-post')
  })

  it('une préférence vers un connecteur absent du registre retombe sur l’ordre de priorité, sans lever', async () => {
    // Le cas que ce test protégeait à l'origine — `tiktok` valide côté
    // réglages mais sans adaptateur enregistré — s'est refermé quand cette PR
    // a enregistré TikTok : `applySettings` et `effectiveSettings` valident
    // tous deux contre le même enum, donc une valeur qui n'y figure pas
    // n'atteint jamais `adapterFor` (voir `tests/server/db.test.ts`, « ignore
    // une valeur corrompue en base au profit du défaut »). Le garde-fou reste
    // réel — un connecteur qu'on retirerait du registre sans toucher l'enum
    // rouvrirait le même écart —, donc on le simule en mockant le registre.
    vi.resetModules()
    vi.doMock('@/server/publication/tiktok', () => ({
      createTikTokAdapter: () => ({ id: 'upload-post', platforms: [], availability: async () => ({}) }),
    }))
    try {
      applySettings(getDb(), { publication: { tiktok: 'tiktok' } })
      const { adapterFor } = await import('@/server/publication')
      expect(() => adapterFor('tiktok')).not.toThrow()
      expect(adapterFor('tiktok')?.id).toBe('upload-post')
    } finally {
      vi.doUnmock('@/server/publication/tiktok')
      vi.resetModules()
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

  it('résout chaque plateforme depuis l’adaptateur que `adapterFor` choisirait, pas depuis l’ordre de priorité (relevé par Copilot)', async () => {
    // Meta répond `available`, Upload Post répond `not_configured` : sans le
    // routage par préférence, la boucle d'origine agrégeait par ordre de
    // priorité et ne pouvait pas distinguer ce cas d'un simple renversement de
    // l'ordre. Facebook est explicitement basculé vers Upload Post — son état
    // affiché doit donc suivre Upload Post, pas Meta, malgré que Meta réponde
    // en premier dans le registre.
    const metaAvailability = vi.fn(async () => ({
      instagram: { available: true },
      facebook: { available: true },
      tiktok: { available: false, reason: 'not_configured' as const },
      youtube: { available: false, reason: 'not_configured' as const },
    }))
    const uploadPostAvailability = vi.fn(async () => ({
      instagram: { available: false, reason: 'not_configured' as const },
      facebook: { available: false, reason: 'not_configured' as const },
      tiktok: { available: false, reason: 'not_configured' as const },
      youtube: { available: false, reason: 'not_configured' as const },
    }))

    // Le registre de `@/server/publication` mémorise ses adaptateurs au
    // premier appel (`publicationAdapters`) : un test précédent, dans ce même
    // fichier, l'a déjà rempli avec les vrais Meta/Upload Post. Sans reset,
    // ce mock arriverait trop tard pour être vu.
    vi.resetModules()
    vi.doMock('@/server/publication/meta', () => ({
      createMetaAdapter: () => ({
        id: 'meta',
        platforms: ['instagram', 'facebook'],
        availability: metaAvailability,
      }),
    }))
    vi.doMock('@/server/publication/upload-post', () => ({
      createUploadPostAdapter: () => ({
        id: 'upload-post',
        platforms: ['instagram', 'facebook', 'tiktok', 'youtube'],
        availability: uploadPostAvailability,
      }),
    }))

    try {
      applySettings(getDb(), { publication: { facebook: 'upload-post' } })
      const { publicationAvailability } = await import('@/server/publication')
      const availability = await publicationAvailability()

      expect(availability.instagram).toEqual({ available: true })
      expect(availability.facebook).toEqual({ available: false, reason: 'not_configured' })

      // Meta ne porte qu'Instagram ici (Facebook est allé à Upload Post) et
      // Upload Post porte les trois autres : chacun n'est interrogé qu'une
      // seule fois, malgré deux plateformes résolues par Upload Post.
      expect(metaAvailability).toHaveBeenCalledTimes(1)
      expect(uploadPostAvailability).toHaveBeenCalledTimes(1)
    } finally {
      vi.doUnmock('@/server/publication/meta')
      vi.doUnmock('@/server/publication/upload-post')
      vi.resetModules()
    }
  })
})
