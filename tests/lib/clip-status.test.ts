import { describe, expect, it } from 'vitest'

import { basculerStatut, estEcarte, estGarde } from '@/lib/clip-status'

describe('estGarde', () => {
  it('compte exported comme gardé : c’est une décision humaine, pas une proposition', () => {
    expect(estGarde('kept')).toBe(true)
    expect(estGarde('exported')).toBe(true)
    expect(estGarde('candidate')).toBe(false)
    expect(estGarde('discarded')).toBe(false)
  })
})

describe('estEcarte', () => {
  it('ne reconnaît que discarded', () => {
    expect(estEcarte('discarded')).toBe(true)
    expect(estEcarte('candidate')).toBe(false)
  })
})

describe('basculerStatut', () => {
  it('garde une proposition', () => {
    expect(basculerStatut('candidate', 'kept')).toBe('kept')
  })

  it('écarte une proposition', () => {
    expect(basculerStatut('candidate', 'discarded')).toBe('discarded')
  })

  it('reprend sa décision quand on rappuie sur le même bouton', () => {
    expect(basculerStatut('kept', 'kept')).toBe('candidate')
    expect(basculerStatut('discarded', 'discarded')).toBe('candidate')
  })

  it('un clip exporté se reprend aussi par le bouton « Gardé »', () => {
    // Le défaut trouvé en review : le bouton s'affichait « Gardé » sur un clip
    // exporté, mais le clic l'envoyait vers `kept` — un changement d'état
    // invisible, qui perdait la trace de l'export sans rien montrer.
    expect(basculerStatut('exported', 'kept')).toBe('candidate')
  })

  it('un clip gardé s’écarte directement, sans repasser par proposition', () => {
    expect(basculerStatut('kept', 'discarded')).toBe('discarded')
    expect(basculerStatut('discarded', 'kept')).toBe('kept')
  })
})
