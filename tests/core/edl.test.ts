import { describe, it, expect } from 'vitest'
import { clipDuration } from '@/core/edl'

describe('clipDuration', () => {
  it('somme les segments et ignore les trous', () => {
    expect(
      clipDuration([
        { start: 2841.2, end: 2856.9 },
        { start: 2874.1, end: 2931.4 },
      ]),
    ).toBeCloseTo(73.0, 3)
  })

  it('vaut zéro sans segment', () => {
    expect(clipDuration([])).toBe(0)
  })

  // Le `Math.max(0, …)` de l'implémentation était documenté mais pas exercé
  // (Copilot). Sans ce cas, une régression rendrait la durée négative — et une
  // durée négative se propage en silence, puisqu'elle s'additionne.
  it('compte un segment inversé pour zéro plutôt que de retrancher du temps', () => {
    expect(clipDuration([{ start: 2, end: 1 }])).toBe(0)
    expect(clipDuration([{ start: 0, end: 10 }, { start: 2, end: 1 }])).toBe(10)
  })
})
