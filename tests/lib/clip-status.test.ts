import { describe, expect, it } from 'vitest'

import { toggleStatus, isDiscarded, isGuard } from '@/lib/clip-status'

describe('isGuard', () => {
  it('compte exported comme gardé : c’est une décision humaine, pas une proposition', () => {
    expect(isGuard('kept')).toBe(true)
    expect(isGuard('exported')).toBe(true)
    expect(isGuard('candidate')).toBe(false)
    expect(isGuard('discarded')).toBe(false)
  })
})

describe('isDiscarded', () => {
  it('ne reconnaît que discarded', () => {
    expect(isDiscarded('discarded')).toBe(true)
    expect(isDiscarded('candidate')).toBe(false)
  })
})

describe('toggleStatus', () => {
  it('garde une proposition', () => {
    expect(toggleStatus('candidate', 'kept')).toBe('kept')
  })

  it('écarte une proposition', () => {
    expect(toggleStatus('candidate', 'discarded')).toBe('discarded')
  })

  it('reprend sa décision quand on rappuie sur le même bouton', () => {
    expect(toggleStatus('kept', 'kept')).toBe('candidate')
    expect(toggleStatus('discarded', 'discarded')).toBe('candidate')
  })

  it('un clip exporté se reprend aussi par le bouton « Gardé »', () => {
    // Le défaut trouvé en review : le bouton s'affichait « Gardé » sur un clip
    // exporté, mais le clic l'envoyait vers `kept` — un changement d'état
    // invisible, qui perdait la trace de l'export sans rien montrer.
    expect(toggleStatus('exported', 'kept')).toBe('candidate')
  })

  it('un clip gardé s’écarte directement, sans repasser par proposition', () => {
    expect(toggleStatus('kept', 'discarded')).toBe('discarded')
    expect(toggleStatus('discarded', 'kept')).toBe('kept')
  })
})
