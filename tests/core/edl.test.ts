import { describe, it, expect } from 'vitest'
import { clipDuration, normalizeSegments, removeRange, moveBoundary } from '@/core/edl'

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

describe('normalizeSegments', () => {
  it('trie, fusionne les chevauchements et jette les segments vides', () => {
    expect(
      normalizeSegments([
        { start: 30, end: 40 },
        { start: 10, end: 20 },
        { start: 15, end: 25 },
        { start: 50, end: 50 },
      ]),
    ).toEqual([
      { start: 10, end: 25 },
      { start: 30, end: 40 },
    ])
  })
})

describe('removeRange', () => {
  it('coupe un segment en deux quand on retire son milieu', () => {
    expect(removeRange([{ start: 0, end: 100 }], 40, 60)).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ])
  })

  it('raccourcit quand le retrait mord sur une borne', () => {
    expect(removeRange([{ start: 0, end: 100 }], 90, 200)).toEqual([{ start: 0, end: 90 }])
  })

  it('supprime un segment entièrement couvert', () => {
    expect(
      removeRange(
        [
          { start: 0, end: 10 },
          { start: 20, end: 30 },
        ],
        0,
        15,
      ),
    ).toEqual([{ start: 20, end: 30 }])
  })

  it('ne touche à rien si le retrait tombe dans un trou', () => {
    expect(
      removeRange(
        [
          { start: 0, end: 10 },
          { start: 20, end: 30 },
        ],
        12,
        18,
      ),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ])
  })

  it('la durée est un résultat, sans plafond', () => {
    const long = [{ start: 0, end: 300 }]
    expect(clipDuration(removeRange(long, 10, 20))).toBe(290)
  })
})

describe('moveBoundary', () => {
  it('déplace la borne de début du premier segment', () => {
    expect(
      moveBoundary(
        [
          { start: 10, end: 20 },
          { start: 30, end: 40 },
        ],
        'start',
        5,
      ),
    ).toEqual([
      { start: 5, end: 20 },
      { start: 30, end: 40 },
    ])
  })

  it('déplace la borne de fin du dernier segment', () => {
    expect(
      moveBoundary(
        [
          { start: 10, end: 20 },
          { start: 30, end: 40 },
        ],
        'end',
        55,
      ),
    ).toEqual([
      { start: 10, end: 20 },
      { start: 30, end: 55 },
    ])
  })
})
