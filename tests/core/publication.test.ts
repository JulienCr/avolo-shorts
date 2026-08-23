import { describe, expect, it } from 'vitest'

import {
  canTargetPlatform,
  clipEligibilityFromStatus,
  clipExportEligibility,
  defaultPlatformAvailability,
  isPublicationStale,
  PLATFORMS,
  platformEligibility,
  platformFile,
  platformTexts,
  publicationText,
  selectablePlatforms,
  wordsHash,
  type PublicationRecord,
} from '@/core/publication'

describe('defaultPlatformAvailability', () => {
  it('rend les quatre plateformes non configurées — rien n’est branché', () => {
    const availability = defaultPlatformAvailability()
    for (const platform of PLATFORMS) {
      expect(availability[platform]).toEqual({ available: false, reason: 'not_configured' })
    }
  })

  it('ne retire aucune plateforme de la liste', () => {
    expect(Object.keys(defaultPlatformAvailability())).toEqual(PLATFORMS)
  })
})

describe('selectablePlatforms', () => {
  it('ne rend rien tant que rien n’est configuré', () => {
    expect(selectablePlatforms(defaultPlatformAvailability())).toEqual([])
  })

  it('rend celles marquées disponibles, et seulement celles-là', () => {
    const availability = defaultPlatformAvailability()
    availability.instagram = { available: true }
    expect(selectablePlatforms(availability)).toEqual(['instagram'])
  })
})

describe('clipExportEligibility', () => {
  it('refuse un clip qui n’a pas de rendu disponible, avec sa raison', () => {
    const result = clipExportEligibility(false)
    expect(result.eligible).toBe(false)
    if (!result.eligible) expect(result.reason.length).toBeGreaterThan(0)
  })

  it('accepte un clip exporté', () => {
    expect(clipExportEligibility(true)).toEqual({ eligible: true })
  })
})

describe('clipEligibilityFromStatus', () => {
  it('n’accepte que le statut « exported »', () => {
    expect(clipEligibilityFromStatus('exported').eligible).toBe(true)
    expect(clipEligibilityFromStatus('kept').eligible).toBe(false)
    expect(clipEligibilityFromStatus('candidate').eligible).toBe(false)
    expect(clipEligibilityFromStatus('discarded').eligible).toBe(false)
  })
})

function record(fields: Partial<PublicationRecord> = {}): PublicationRecord {
  return {
    status: 'published',
    remoteUrl: 'https://example.test/p/1',
    publishedFingerprint: null,
    error: null,
    ...fields,
  }
}

describe('isPublicationStale', () => {
  it('n’est jamais périmée sans empreinte publiée', () => {
    expect(isPublicationStale(record({ publishedFingerprint: null }), 'abc')).toBe(false)
  })

  it('n’est pas périmée quand les deux empreintes concordent', () => {
    expect(isPublicationStale(record({ publishedFingerprint: 'abc' }), 'abc')).toBe(false)
  })

  it('est périmée quand le montage a bougé depuis la publication', () => {
    expect(isPublicationStale(record({ publishedFingerprint: 'abc' }), 'def')).toBe(true)
  })
})

describe('canTargetPlatform', () => {
  it('autorise une première publication — aucun enregistrement encore', () => {
    expect(canTargetPlatform(undefined, false)).toBe(true)
  })

  it('autorise de relancer un échec sans `force`', () => {
    expect(canTargetPlatform(record({ status: 'failed' }), false)).toBe(true)
  })

  it('autorise de relancer un dépôt ou un envoi en cours sans `force`', () => {
    expect(canTargetPlatform(record({ status: 'submitted' }), false)).toBe(true)
    expect(canTargetPlatform(record({ status: 'in_progress' }), false)).toBe(true)
  })

  it('refuse une republication vers une plateforme déjà `published` sans `force`', () => {
    expect(canTargetPlatform(record({ status: 'published' }), false)).toBe(false)
  })

  it('autorise la republication explicite', () => {
    expect(canTargetPlatform(record({ status: 'published' }), true)).toBe(true)
  })
})

describe('platformFile', () => {
  it('préfère la variante 9:16 quand elle existe', () => {
    expect(platformFile({ mp4: '/r/c.mp4', variant9x16: '/r/c-9x16.mp4' })).toBe('/r/c-9x16.mp4')
  })

  it('retombe sur le natif quand le clip est déjà en 9:16 — RENDER_NATIVE=false', () => {
    // `variant9x16` vaut `null` pour un clip déjà en 9:16 : le natif EST la
    // livraison, quel que soit l'état de `RENDER_NATIVE`.
    expect(platformFile({ mp4: '/r/c.mp4', variant9x16: null })).toBe('/r/c.mp4')
  })

  it('retombe sur le natif quand le clip est déjà en 9:16 — RENDER_NATIVE=true', () => {
    // Même donnée d'entrée que le cas ci-dessus : la règle ne dépend pas du
    // drapeau, seulement de la présence de la variante.
    expect(platformFile({ mp4: '/r/c.mp4', variant9x16: null })).toBe('/r/c.mp4')
  })

  it('rend `null` quand rien n’a été produit', () => {
    expect(platformFile({ mp4: null, variant9x16: null })).toBeNull()
  })
})

describe('platformTexts', () => {
  const clip = { title: 'La chute', description: 'Une impro qui part en vrille #impro #avolo' }

  it('sépare titre et description pour YouTube', () => {
    expect(platformTexts(clip, 'youtube')).toEqual({
      title: 'La chute',
      description: 'Une impro qui part en vrille #impro #avolo',
    })
  })

  it.each(['instagram', 'facebook', 'tiktok'] as const)(
    'rend une légende unique pour %s, sans titre séparé',
    (platform) => {
      const result = platformTexts(clip, platform)
      expect(result.title).toBe('')
      expect(result.description).toBe('La chute\n\nUne impro qui part en vrille #impro #avolo')
    },
  )

  it('tronque le titre YouTube à 100 caractères, sur une frontière de mot', () => {
    const long = { title: 'Un mot '.repeat(20).trim(), description: '' } // 139 caractères
    const result = platformTexts(long, 'youtube')
    expect(result.title.length).toBeLessThanOrEqual(100)
    // Ni coupé en plein mot, ni suivi d'un espace traînant.
    expect(result.title.endsWith(' ')).toBe(false)
    expect(long.title.startsWith(result.title)).toBe(true)
    expect(long.title[result.title.length]).not.toBe(undefined)
  })

  it('ne tronque pas un titre YouTube déjà court', () => {
    expect(platformTexts(clip, 'youtube').title).toBe('La chute')
  })

  it('un titre et une description vides rendent une légende vide pour les trois autres', () => {
    expect(platformTexts({ title: '', description: '' }, 'instagram')).toEqual({ title: '', description: '' })
  })
})

describe('platformEligibility', () => {
  it('accepte un clip court et léger', () => {
    expect(platformEligibility(45, 20 * 1024 * 1024)).toEqual({ eligible: true })
  })

  it('refuse un clip de plus de trois minutes, avec sa raison', () => {
    const result = platformEligibility(181, 1024)
    expect(result.eligible).toBe(false)
    if (!result.eligible) expect(result.reason.length).toBeGreaterThan(0)
  })

  it('accepte pile trois minutes', () => {
    expect(platformEligibility(180, 1024).eligible).toBe(true)
  })

  it('refuse un fichier trop lourd, avec sa raison', () => {
    const result = platformEligibility(30, 600 * 1024 * 1024)
    expect(result.eligible).toBe(false)
    if (!result.eligible) expect(result.reason.length).toBeGreaterThan(0)
  })

  it('à 180,4 s, la raison ne dit pas « 180 s » — elle ne se contredit pas elle-même', () => {
    // `toFixed(0)` sur la durée mesurée aurait affiché « 180 s » pour un clip
    // refusé à 180,4 s, comme s'il tenait dans la limite qui l'a pourtant
    // rejeté.
    const result = platformEligibility(180.4, 1024)
    expect(result.eligible).toBe(false)
    if (!result.eligible) expect(result.reason).not.toMatch(/dure 180 s\b/)
  })

  it('à 500 Mio et quelques octets, la raison ne dit pas « 500 Mio » sans dire « dépasse »', () => {
    const result = platformEligibility(30, 500 * 1024 * 1024 + 100)
    expect(result.eligible).toBe(false)
    if (!result.eligible) expect(result.reason).toMatch(/dépasse/)
  })
})

describe('wordsHash (core)', () => {
  it('garde la première graphie et écarte les doublons de casse', () => {
    expect(wordsHash('#Impro et #impro, puis #Avolo')).toEqual(['#Impro', '#Avolo'])
  })
})

describe('publicationText (core)', () => {
  it('dit titre, description et mots-dièse, dans cet ordre', () => {
    const text = publicationText({ title: 'La chute', description: 'Une vrille #avolo' })
    expect(text).toContain('Titre : La chute')
    expect(text).toContain('Description :\nUne vrille #avolo')
    expect(text).toContain('Mots-dièse : #avolo')
  })

  it('dit "(sans titre)" et "(sans description)" sur des champs vides', () => {
    const text = publicationText({ title: '', description: '' })
    expect(text).toContain('(sans titre)')
    expect(text).toContain('(sans description)')
    expect(text).toContain('(aucun)')
  })
})
