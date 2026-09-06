import { describe, expect, it } from 'vitest'

import {
  decideStatus,
  forgetStatus,
  isDiscarded,
  isGuard,
  resyncStatus,
  toggleStatus,
} from '@/lib/clip-status'

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

/**
 * `decided` is module state, so each test below uses its own clip id — it
 * survives across `it()` blocks in this file, same as `queries.ts`'s maps.
 */
describe('decideStatus', () => {
  it('retombe sur le statut de l’appelant tant que rien n’est mémorisé', () => {
    expect(decideStatus('clip-status-1', 'candidate', 'kept')).toBe('kept')
  })

  it('toggle depuis la valeur mémorisée, pas depuis un instantané périmé', () => {
    // The second call ignores the stale `'candidate'` fallback: a second
    // rapid press must cancel the first, not repeat it (issue #330).
    expect(decideStatus('clip-status-2', 'candidate', 'kept')).toBe('kept')
    expect(decideStatus('clip-status-2', 'candidate', 'kept')).toBe('candidate')
  })
})

describe('resyncStatus et forgetStatus', () => {
  it('resyncStatus recale la mémoire sur une valeur confirmée par le serveur', () => {
    decideStatus('clip-status-3', 'candidate', 'kept')
    resyncStatus('clip-status-3', 'discarded')
    expect(decideStatus('clip-status-3', 'candidate', 'discarded')).toBe('candidate')
  })

  it('forgetStatus fait retomber sur l’instantané de l’appelant', () => {
    decideStatus('clip-status-4', 'candidate', 'kept')
    forgetStatus('clip-status-4')
    expect(decideStatus('clip-status-4', 'candidate', 'kept')).toBe('kept')
  })
})
