import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCaptionMeasure } from '@/server/caption-measure'

/**
 * Comme `hook-image.test.ts` : `fontsDir` pointe sur le vrai `fonts/` du
 * dépôt, pour mesurer avec la vraie police Anton plutôt qu'un repli système
 * imprévisible. Aucun pixel verrouillé, seulement les propriétés
 * structurelles qu'un texte rendu doit tenir quel que soit le moteur.
 */
const FONTS_DIR = path.join(process.cwd(), 'fonts')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createCaptionMeasure', () => {
  it('mesure une chaîne vide à zéro', () => {
    const measure = createCaptionMeasure(FONTS_DIR, 'Anton', 18)
    expect(measure('')).toBe(0)
  })

  it('mesure plus large à mesure que le texte grandit', () => {
    const measure = createCaptionMeasure(FONTS_DIR, 'Anton', 18)
    expect(measure('BONJOUR')).toBeGreaterThan(measure('BON'))
    expect(measure('BON')).toBeGreaterThan(measure('B'))
  })

  it('mesure plus large à taille de police plus grande, texte identique', () => {
    const small = createCaptionMeasure(FONTS_DIR, 'Anton', 18)
    const large = createCaptionMeasure(FONTS_DIR, 'Anton', 36)
    expect(large('BONJOUR')).toBeGreaterThan(small('BONJOUR'))
  })

  it('ne jette pas quand le dossier de polices est introuvable, et mesure quand même', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const measure = createCaptionMeasure('/dossier/inexistant', 'Anton', 18)
    expect(measure('BONJOUR')).toBeGreaterThan(0)
    expect(warn).toHaveBeenCalled()
  })
})
