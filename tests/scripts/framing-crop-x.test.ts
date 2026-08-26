import { describe, expect, it } from 'vitest'
import { deriveCropX } from '../../scripts/framing/crop-x'
import { POINT, POINT_COUNT } from '@/core/shots'
import type { PersonBox } from '@/core/shots'

/** Points de tête à une confiance donnée, épaules toujours confiantes — seule la tête varie ici. */
function box(t: number, centerX: number, headScore: number, halfWidth = 0.05): PersonBox {
  const k = Array.from({ length: POINT_COUNT * 3 }, () => 0)
  const put = (point: keyof typeof POINT, x: number, y: number, score: number): void => {
    k[POINT[point] * 3] = x
    k[POINT[point] * 3 + 1] = y
    k[POINT[point] * 3 + 2] = score
  }
  put('NOSE', centerX, 0.3, headScore)
  put('LEFT_EYE', centerX - 0.01, 0.3, headScore)
  put('RIGHT_EYE', centerX + 0.01, 0.3, headScore)
  put('LEFT_EAR', centerX - halfWidth, 0.3, headScore)
  put('RIGHT_EAR', centerX + halfWidth, 0.3, headScore)
  put('LEFT_SHOULDER', centerX - halfWidth, 0.5, 0.9)
  put('RIGHT_SHOULDER', centerX + halfWidth, 0.5, 0.9)
  return { t, x0: centerX - halfWidth * 2, x1: centerX + halfWidth * 2, y0: 0.2, y1: 0.9, score: 0.9, k }
}

describe('deriveCropX (#190)', () => {
  it('choisit le côté dont la tête est présente sur le plus de plans, et rend la médiane de son centre', () => {
    const boxes = [
      box(0, 0.2, 0.9),
      box(0, 0.7, 0.05),
      box(0.5, 0.22, 0.9),
      box(0.5, 0.7, 0.05),
    ]
    const result = deriveCropX(boxes)
    expect(result.outcome).toBe('derived')
    if (result.outcome !== 'derived') return
    expect(result.side).toBe('left')
    expect(result.cropX).toBeCloseTo(0.21, 5)
  })

  it('départage à égalité de présence par le score moyen', () => {
    const boxes = [box(0, 0.2, 0.9), box(0, 0.7, 0.55)]
    const result = deriveCropX(boxes)
    expect(result.outcome).toBe('derived')
    if (result.outcome !== 'derived') return
    expect(result.side).toBe('left')
  })

  it("refuse quand aucun des deux côtés ne montre jamais de tête", () => {
    const boxes = [box(0, 0.2, 0.1), box(0, 0.7, 0.1)]
    const result = deriveCropX(boxes)
    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') return
    expect(result.why).toMatch(/jamais de tête/)
  })

  it('refuse une égalité exacte de présence et de score moyen, plutôt que de trancher au hasard', () => {
    const boxes = [box(0, 0.2, 0.9), box(0, 0.7, 0.9)]
    const result = deriveCropX(boxes)
    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') return
    expect(result.why).toMatch(/égalité exacte/)
  })

  it("refuse quand aucune image n'a exactement deux personnes retenues", () => {
    const result = deriveCropX([box(0, 0.5, 0.9)])
    expect(result.outcome).toBe('refused')
  })
})
