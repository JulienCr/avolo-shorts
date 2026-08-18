import { describe, expect, it } from 'vitest'

import { cropRect, resolveRatio } from '@/core/framing'
import {
  ORDRE_RATIOS,
  clampCropX,
  cropLeftFraction,
  cropWidthFraction,
} from '@/lib/crop-preview'

describe('cropWidthFraction', () => {
  it('un 9:16 pleine hauteur couvre 31,6 % de la largeur d’une image 16:9', () => {
    // La mesure qui justifie tout le projet (spec §2) : c'est parce que ce
    // rectangle est si étroit que seuls 24 à 33 % du temps y tiennent.
    expect(cropWidthFraction('9:16')).toBeCloseTo(0.3164, 4)
  })

  it('un 1:1 en couvre 56 %, un 4:5 45 %', () => {
    expect(cropWidthFraction('1:1')).toBeCloseTo(0.5625, 4)
    expect(cropWidthFraction('4:5')).toBeCloseTo(0.45, 4)
  })

  it('un 16:9 prend toute l’image', () => {
    expect(cropWidthFraction('16:9')).toBe(1)
  })

  it('ne dépasse jamais la source, même sur une source plus étroite', () => {
    for (const r of ORDRE_RATIOS) {
      expect(cropWidthFraction(r, 1)).toBeLessThanOrEqual(1)
    }
  })
})

describe('clampCropX', () => {
  it('ne sort jamais du cadre, quel que soit cropX', () => {
    for (const r of ORDRE_RATIOS) {
      const largeur = cropWidthFraction(r)
      for (const cx of [-2, 0, 0.01, 0.5, 0.99, 1, 3]) {
        const gauche = cropLeftFraction(cx, largeur)
        expect(gauche).toBeGreaterThanOrEqual(-1e-9)
        expect(gauche + largeur).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })

  it('0 veut dire collé au bord gauche de l’image, pas au bord du monde', () => {
    const largeur = cropWidthFraction('9:16')
    expect(clampCropX(0, largeur)).toBeCloseTo(largeur / 2, 6)
    expect(cropLeftFraction(0, largeur)).toBeCloseTo(0, 6)
  })

  it('un 16:9 n’a plus qu’une position possible', () => {
    expect(clampCropX(0.2, 1)).toBe(0.5)
    expect(clampCropX(0.9, 1)).toBe(0.5)
  })

  it('une valeur absente retombe au centre', () => {
    expect(clampCropX(Number.NaN, 0.5)).toBe(0.5)
  })
})

describe("l'aperçu et le rendu", () => {
  it('dessinent le même rectangle, à l’arrondi au pair près', () => {
    // C'est le seul test qui compte vraiment ici : un aperçu qui ne montre pas
    // ce que ffmpeg découpera est pire qu'une absence d'aperçu — on cadre à
    // l'œil sur une image fausse, et on ne s'en aperçoit qu'au rendu.
    // `cropRect` arrondit chaque composante au pair (libx264 refuse une
    // dimension impaire), d'où la tolérance de deux pixels.
    for (const ratio of ORDRE_RATIOS) {
      for (const cx of [0, 0.2, 0.5, 0.9, 1]) {
        const rect = cropRect(ratio, cx, 1920, 1080)
        const largeur = cropWidthFraction(ratio)
        expect(Math.abs(largeur * 1920 - rect.w)).toBeLessThanOrEqual(2)
        expect(Math.abs(cropLeftFraction(cx, largeur) * 1920 - rect.x)).toBeLessThanOrEqual(2)
      }
    }
  })

  it("s'accordent sur ce que vaut 'auto' en itération 0", () => {
    // `resolveRatio` est le seul endroit où cette valeur par défaut est écrite ;
    // l'aperçu l'appelle plutôt que de la recopier.
    expect(resolveRatio('auto')).toBe('9:16')
  })
})
