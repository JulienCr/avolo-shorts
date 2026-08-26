import { describe, expect, it } from 'vitest'
import { buildCard, type BoardImage } from '../../scripts/framing/board/card'
import { assertShare } from '../../scripts/framing/board/share'
import type { ShotState } from '../../scripts/framing/board/share'
import type { Shot } from '@/core/shots'

const SHOT: Shot = { start: 2107, end: 2138 }

function state(id: string, instant: number): ShotState {
  return {
    state: { id, label: id },
    share: { count: 10, total: 20, fraction: 0.5 },
    instant,
    run: { start: instant - 1, end: instant + 1, share: { count: 4, total: 20, fraction: 0.2 } },
  }
}

function image(variantId: string): BoardImage {
  return {
    variantId,
    variantLabel: variantId,
    dataUri: 'data:image/png;base64,AAAA',
    alt: `alt ${variantId}`,
    decision: { ratio: '1:1', split: false, cropX: 0.5, canvas: 'vertical' },
  }
}

describe('assertShare', () => {
  it('refuse `undefined`', () => {
    expect(() => assertShare(undefined, 'x')).toThrow()
  })
  it('refuse une fraction `NaN`', () => {
    expect(() => assertShare({ count: 1, total: 1, fraction: NaN }, 'x')).toThrow()
  })
  it('refuse une fraction négative', () => {
    expect(() => assertShare({ count: -1, total: 1, fraction: -0.1 }, 'x')).toThrow()
  })
  it('refuse une fraction supérieure à 1', () => {
    expect(() => assertShare({ count: 2, total: 1, fraction: 2 }, 'x')).toThrow()
  })
})

describe('buildCard : `key`', () => {
  it('est stable pour les mêmes entrées', () => {
    const card1 = buildCard({ caseId: 'c1', projectId: 'cqlp', shot: SHOT, state: state('a', 2120), instant: 2120, images: [image('v1')], stake: 'stake' })
    const card2 = buildCard({ caseId: 'c1', projectId: 'cqlp', shot: SHOT, state: state('a', 2120), instant: 2120, images: [image('v1')], stake: 'stake' })
    expect(card1.key).toBe(card2.key)
  })

  it('distingue deux états du même plan', () => {
    const cardA = buildCard({ caseId: 'c1', projectId: 'cqlp', shot: SHOT, state: state('de-face', 2120), instant: 2120, images: [image('v1')], stake: 'stake' })
    const cardB = buildCard({ caseId: 'c1', projectId: 'cqlp', shot: SHOT, state: state('de-profil', 2125), instant: 2125, images: [image('v1')], stake: 'stake' })
    expect(cardA.key).not.toBe(cardB.key)
  })
})

describe('buildCard : `caseId`', () => {
  it('se retrouve tel quel sur la carte — le lien entre une carte et le cas qui la produit', () => {
    const card = buildCard({ caseId: 'cqlp-1366033', projectId: 'cqlp', shot: SHOT, state: state('a', 2120), instant: 2120, images: [image('v1')], stake: 'stake' })
    expect(card.caseId).toBe('cqlp-1366033')
  })
})

describe('BoardImage', () => {
  it("n'a pas de champ temporel", () => {
    const img = image('v1')
    // @ts-expect-error BoardImage ne porte aucun champ temporel : `at`, `instant`, `t` et `segments` n'existent pas sur son type.
    void img.instant
  })
})
