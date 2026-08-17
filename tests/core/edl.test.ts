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
})
