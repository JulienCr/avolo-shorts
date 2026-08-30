import { describe, it, expect } from 'vitest'

import {
  ANTON_TYPO_HEIGHT,
  ANTON_UNITS_PER_EM,
  ANTON_WIN_HEIGHT,
  ASS_FONTSIZE_TO_EM,
  ASS_LINE_HEIGHT_OVER_EM,
  CSS_HALF_LEADING_OVER_EM,
} from '@/core/captions/font-metrics'

/**
 * De l'arithmétique pure, aucun DOM en jeu — ce fichier ne prouve rien sur un
 * rendu réel de police. `tests/server/font-metrics.test.ts` recoupe ces
 * mêmes nombres contre les tables lues dans `fonts/Anton-Regular.ttf`.
 */
describe('les constantes dérivées des tables d’Anton', () => {
  it('ASS_FONTSIZE_TO_EM = unitsPerEm / winHeight, ~0,576901', () => {
    expect(ASS_FONTSIZE_TO_EM).toBeCloseTo(2048 / 3550, 6)
  })

  it('ASS_LINE_HEIGHT_OVER_EM est l’inverse de ASS_FONTSIZE_TO_EM', () => {
    expect(ASS_LINE_HEIGHT_OVER_EM).toBeCloseTo(1 / ASS_FONTSIZE_TO_EM, 9)
  })

  it('CSS_HALF_LEADING_OVER_EM = (winHeight − typoHeight) / (2 × unitsPerEm), ~0,114014', () => {
    expect(CSS_HALF_LEADING_OVER_EM).toBeCloseTo((3550 - 3083) / (2 * 2048), 6)
  })

  it('les trois tables valent ce que la doc affirme', () => {
    expect(ANTON_UNITS_PER_EM).toBe(2048)
    expect(ANTON_WIN_HEIGHT).toBe(3550)
    expect(ANTON_TYPO_HEIGHT).toBe(3083)
  })
})
