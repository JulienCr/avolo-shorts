/**
 * L'état de livraison d'un clip — la dérivation qui décide du bouton
 * primaire du rail (spec du 23 août, §3.4). Pure, sans DOM : les trois lignes
 * de la table s'y vérifient chacune.
 */

import { describe, expect, it } from 'vitest'

import { deriveDeliveryState } from '@/components/clip/export-panel'

const nothing = { mp4Url: null, variant9x16Url: null }

describe('deriveDeliveryState', () => {
  it('jamais livré : pas encore exporté, aucune vidéo', () => {
    expect(deriveDeliveryState('kept', nothing)).toBe('never')
    expect(deriveDeliveryState('candidate', nothing)).toBe('never')
  })

  it('périmé : déjà exporté, mais plus aucune vidéo sur le disque', () => {
    expect(deriveDeliveryState('exported', nothing)).toBe('stale')
  })

  it('livré et à jour : une vidéo au moins, quel que soit le statut', () => {
    expect(deriveDeliveryState('exported', { mp4Url: '/c1.mp4', variant9x16Url: null })).toBe(
      'delivered',
    )
    // Un clip dont le natif est désactivé (`RENDER_NATIVE`) n'a jamais de
    // `mp4Url` : c'est la variante seule qui dit qu'il est livré, y compris
    // pour un statut qui ne serait pas encore repassé à `exported`.
    expect(deriveDeliveryState('kept', { mp4Url: null, variant9x16Url: '/c1-9x16.mp4' })).toBe(
      'delivered',
    )
  })
})
