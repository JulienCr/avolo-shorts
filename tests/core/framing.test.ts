import { describe, it, expect } from 'vitest'
import { RATIOS, cropRect, outputSize, resolveRatio } from '@/core/framing'
import type { Ratio } from '@/core/edl'

const TOUS: Ratio[] = ['9:16', '4:5', '1:1', '16:9']

describe('RATIOS', () => {
  it('donne la largeur pour une hauteur de 1', () => {
    expect(RATIOS['9:16']).toBeCloseTo(9 / 16, 10)
    expect(RATIOS['4:5']).toBeCloseTo(4 / 5, 10)
    expect(RATIOS['1:1']).toBe(1)
    expect(RATIOS['16:9']).toBeCloseTo(16 / 9, 10)
  })

  it('couvre les quatre ratios et rien de plus', () => {
    expect(Object.keys(RATIOS).sort()).toEqual([...TOUS].sort())
  })
})

describe('resolveRatio', () => {
  it("en itération 0, 'auto' vaut 9:16 — il n'y a pas encore de cadrage automatique", () => {
    expect(resolveRatio('auto')).toBe('9:16')
  })

  it('un ratio explicite passe tel quel', () => {
    expect(resolveRatio('1:1')).toBe('1:1')
    for (const r of TOUS) expect(resolveRatio(r)).toBe(r)
  })
})

describe('outputSize', () => {
  it('sort en 1080 de large en portrait et en carré, 1920 en paysage', () => {
    expect(outputSize('9:16')).toEqual({ w: 1080, h: 1920 })
    expect(outputSize('4:5')).toEqual({ w: 1080, h: 1350 })
    expect(outputSize('1:1')).toEqual({ w: 1080, h: 1080 })
    expect(outputSize('16:9')).toEqual({ w: 1920, h: 1080 })
  })

  it('respecte le ratio demandé et reste en dimensions paires', () => {
    for (const r of TOUS) {
      const { w, h } = outputSize(r)
      expect(w / h).toBeCloseTo(RATIOS[r], 3)
      expect(w % 2).toBe(0)
      expect(h % 2).toBe(0)
    }
  })
})

describe('cropRect', () => {
  it("un 9:16 pleine hauteur couvre 31,6 % de la largeur d'une image 16:9", () => {
    const r = cropRect('9:16', 0.5, 1920, 1080)
    expect(r.h).toBe(1080)
    expect(r.w).toBe(608) // 1080 * 9/16 = 607,5, arrondi au pair
    expect(r.x).toBe(656) // centré
    expect(r.y).toBe(0)
  })

  it("un 16:9 prend toute l'image", () => {
    expect(cropRect('16:9', 0.5, 1920, 1080)).toMatchObject({ w: 1920, x: 0 })
  })

  it('ne sort jamais du cadre, quel que soit cropX', () => {
    for (const cx of [0, 0.01, 0.5, 0.99, 1]) {
      const r = cropRect('1:1', cx, 1920, 1080)
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w).toBeLessThanOrEqual(1920)
    }
  })

  // Les valeurs viennent d'une base et d'un curseur d'interface : une borne
  // dépassée ne doit pas produire un rectangle hors cadre, qui ferait échouer
  // ffmpeg au lieu de rogner.
  it('borne cropX hors de [0, 1] au lieu de le propager', () => {
    expect(cropRect('9:16', -3, 1920, 1080).x).toBe(0)
    expect(cropRect('9:16', 4, 1920, 1080).x).toBe(1920 - 608)
  })

  it.each([
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('retombe sur le centre quand cropX vaut %s', (_nom, cx) => {
    expect(cropRect('9:16', cx, 1920, 1080)).toEqual(cropRect('9:16', 0.5, 1920, 1080))
  })

  it('les dimensions sont paires, sinon libx264 refuse', () => {
    for (const ratio of TOUS) {
      const r = cropRect(ratio, 0.5, 1920, 1080)
      expect(r.w % 2).toBe(0)
      expect(r.h % 2).toBe(0)
    }
  })

  // yuv420p sous-échantillonne la chrominance d'un facteur deux : une origine
  // impaire décale le plan de chrominance d'un demi-pixel.
  it("l'origine aussi est paire, à n'importe quel cropX", () => {
    for (const cx of [0, 0.077, 0.31, 0.5, 0.618, 0.93, 1]) {
      const r = cropRect('4:5', cx, 1920, 1080)
      expect(r.x % 2).toBe(0)
      expect(r.y % 2).toBe(0)
    }
  })

  it('suit cropX : plus il monte, plus le rectangle va vers la droite', () => {
    const gauche = cropRect('1:1', 0.25, 1920, 1080)
    const centre = cropRect('1:1', 0.5, 1920, 1080)
    expect(gauche.x).toBeLessThan(centre.x)
    expect(centre.x).toBe(Math.trunc((1920 - centre.w) / 2 / 2) * 2)
  })

  // Le crop est pleine hauteur *dans une image 16:9*. Sur une source plus
  // étroite — un 4:3, un portrait — la pleine hauteur déborderait en largeur :
  // c'est alors la largeur qui borne, et le ratio demandé est conservé.
  it('bascule sur la pleine largeur quand la pleine hauteur ne tient pas', () => {
    const r = cropRect('16:9', 0.5, 1440, 1080)
    expect(r.w).toBeLessThanOrEqual(1440)
    expect(r.h).toBeLessThanOrEqual(1080)
    expect(r.w / r.h).toBeCloseTo(16 / 9, 2)
    expect(r.y).toBeGreaterThan(0)
    expect(r.y + r.h).toBeLessThanOrEqual(1080)
  })

  it('reste dans le cadre sur toutes les combinaisons ratio × source', () => {
    for (const ratio of TOUS) {
      for (const [sw, sh] of [
        [1920, 1080],
        [1440, 1080],
        [1080, 1920],
        [3840, 2160],
      ]) {
        const r = cropRect(ratio, 0.5, sw, sh)
        expect(r.w).toBeGreaterThan(0)
        expect(r.h).toBeGreaterThan(0)
        expect(r.x).toBeGreaterThanOrEqual(0)
        expect(r.y).toBeGreaterThanOrEqual(0)
        expect(r.x + r.w).toBeLessThanOrEqual(sw)
        expect(r.y + r.h).toBeLessThanOrEqual(sh)
        expect(r.w % 2).toBe(0)
        expect(r.h % 2).toBe(0)
      }
    }
  })
})
