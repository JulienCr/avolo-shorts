import { describe, expect, it } from 'vitest'

import {
  canTargetPlatform,
  clipEligibilityFromStatus,
  clipExportEligibility,
  defaultPlatformAvailability,
  isPublicationStale,
  PLATFORMS,
  selectablePlatforms,
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
    const résultat = clipExportEligibility(false)
    expect(résultat.eligible).toBe(false)
    if (!résultat.eligible) expect(résultat.reason.length).toBeGreaterThan(0)
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

function record(champs: Partial<PublicationRecord> = {}): PublicationRecord {
  return { status: 'published', remoteUrl: 'https://example.test/p/1', publishedFingerprint: null, ...champs }
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
