import { describe, expect, it } from 'vitest'
import { partitionShot, formatShare, assertShare, type Frame, type FrameClassifier } from '../../scripts/framing/board/share'
import { SINGLE_STATE } from '../../scripts/framing/board/classifiers'
import type { PersonBox, Shot } from '@/core/shots'

function box(t: number, extra: Partial<PersonBox> = {}): PersonBox {
  return { t, x0: 0.2, x1: 0.4, y0: 0.1, y1: 0.9, score: 0.9, ...extra }
}

/** Classe toute image sur son unique boîte : `'A'` ou `'B'` selon `x0`. */
const AB_CLASSIFIER: FrameClassifier = {
  id: 'ab',
  label: 'A ou B',
  states: [
    { id: 'A', label: 'État A' },
    { id: 'B', label: 'État B' },
  ],
  classify: (frame: Frame) => {
    const b = frame.boxes[0]
    if (!b) return null
    return b.x0 < 0.5 ? 'A' : 'B'
  },
}

describe('partitionShot', () => {
  it('le dénominateur est la grille, pas les images détectées', () => {
    // 10 s à 2 im/s = 20 images de grille ; détection sur les 6 premières
    // secondes seulement (12 images), un trou de 4 s (8 images).
    const shot: Shot = { start: 0, end: 10 }
    const boxes: PersonBox[] = []
    for (let i = 0; i < 12; i += 1) boxes.push(box(i * 0.5))
    const partition = partitionShot({ shot, boxes, analysisFps: 2, classifier: SINGLE_STATE })
    expect(partition.grid).toBe(20)
    expect(partition.states[0].share).toEqual({ count: 12, total: 20, fraction: 0.6 })
    expect(partition.unclassified).toEqual({ count: 8, total: 20, fraction: 0.4 })
  })

  it('parts + non classées somment à 1', () => {
    const shot: Shot = { start: 0, end: 5 }
    const boxes: PersonBox[] = [box(0), box(1), box(2)]
    const partition = partitionShot({ shot, boxes, analysisFps: 1, classifier: SINGLE_STATE })
    const sum = partition.states.reduce((n, s) => n + s.share.fraction, 0) + partition.unclassified.fraction
    expect(sum).toBeCloseTo(1, 10)
  })

  it('un plan bimodal rend deux états triés par part décroissante', () => {
    const shot: Shot = { start: 0, end: 10 }
    const boxes: PersonBox[] = []
    for (let i = 0; i < 7; i += 1) boxes.push(box(i, { x0: 0.1 })) // A, 7 images
    for (let i = 7; i < 10; i += 1) boxes.push(box(i, { x0: 0.8 })) // B, 3 images
    const partition = partitionShot({ shot, boxes, analysisFps: 1, classifier: AB_CLASSIFIER })
    expect(partition.states.map((s) => s.state.id)).toEqual(['A', 'B'])
    expect(partition.states[0].share.fraction).toBeGreaterThan(partition.states[1].share.fraction)
  })

  it("l'instant représentatif est bien classé dans son état", () => {
    const shot: Shot = { start: 0, end: 10 }
    const boxes: PersonBox[] = []
    for (let i = 0; i < 7; i += 1) boxes.push(box(i, { x0: 0.1 }))
    for (let i = 7; i < 10; i += 1) boxes.push(box(i, { x0: 0.8 }))
    const partition = partitionShot({ shot, boxes, analysisFps: 1, classifier: AB_CLASSIFIER })
    for (const state of partition.states) {
      const reclassified = AB_CLASSIFIER.classify({ t: state.instant, boxes: [box(state.instant, { x0: state.state.id === 'A' ? 0.1 : 0.8 })] })
      expect(reclassified).toBe(state.state.id)
    }
  })

  it("l'instant tombe dans la plus longue plage, pas sur un clignotement", () => {
    // Grille : A A A A A B A A A A A B B B B (indices 0..14, fps = 1).
    const shot: Shot = { start: 0, end: 15 }
    const boxes: PersonBox[] = []
    const pattern = ['A', 'A', 'A', 'A', 'A', 'B', 'A', 'A', 'A', 'A', 'A', 'B', 'B', 'B', 'B']
    pattern.forEach((label, i) => boxes.push(box(i, { x0: label === 'A' ? 0.1 : 0.8 })))
    const partition = partitionShot({ shot, boxes, analysisFps: 1, classifier: AB_CLASSIFIER })
    const bState = partition.states.find((s) => s.state.id === 'B')
    if (!bState) throw new Error('état B absent')
    // La plage continue de quatre B va des indices 11 à 14.
    expect(bState.instant).toBeGreaterThanOrEqual(11)
    expect(bState.instant).toBeLessThanOrEqual(14)
    expect(bState.run.share.count).toBe(4)
  })

  it('un état minoritaire à une seule image est rendu, avec sa part', () => {
    const shot: Shot = { start: 0, end: 10 }
    const boxes: PersonBox[] = []
    for (let i = 0; i < 9; i += 1) boxes.push(box(i, { x0: 0.1 }))
    boxes.push(box(9, { x0: 0.8 }))
    const partition = partitionShot({ shot, boxes, analysisFps: 1, classifier: AB_CLASSIFIER })
    const bState = partition.states.find((s) => s.state.id === 'B')
    expect(bState?.share).toEqual({ count: 1, total: 10, fraction: 0.1 })
  })

  it('`SINGLE_STATE` rend exactement un état à 100 %', () => {
    const shot: Shot = { start: 0, end: 5 }
    const boxes: PersonBox[] = Array.from({ length: 5 }, (_, i) => box(i))
    const partition = partitionShot({ shot, boxes, analysisFps: 1, classifier: SINGLE_STATE })
    expect(partition.states.length).toBe(1)
    expect(partition.states[0].share).toEqual({ count: 5, total: 5, fraction: 1 })
  })

  it("un plan dont aucune image n'est classable lève", () => {
    const shot: Shot = { start: 0, end: 5 }
    // Aucune boîte détectée du tout : rien n'est classable.
    expect(() => partitionShot({ shot, boxes: [], analysisFps: 1, classifier: SINGLE_STATE })).toThrow()
  })
})

describe('formatShare', () => {
  it('rend un pourcentage et un compte lisibles', () => {
    const text = formatShare({ count: 13, total: 21, fraction: 13 / 21 })
    expect(text).toContain('13 / 21')
    expect(text).toMatch(/^\d+,\d %/)
  })
})

describe('assertShare', () => {
  it('refuse `undefined`', () => {
    expect(() => assertShare(undefined, 'test')).toThrow()
  })

  it('refuse une fraction `NaN`', () => {
    expect(() => assertShare({ count: 1, total: 2, fraction: NaN }, 'test')).toThrow()
  })

  it('refuse une fraction négative', () => {
    expect(() => assertShare({ count: -1, total: 2, fraction: -0.5 }, 'test')).toThrow()
  })

  it('refuse une fraction > 1', () => {
    expect(() => assertShare({ count: 3, total: 2, fraction: 1.5 }, 'test')).toThrow()
  })

  it('accepte une part valide', () => {
    expect(() => assertShare({ count: 1, total: 2, fraction: 0.5 }, 'test')).not.toThrow()
  })
})
