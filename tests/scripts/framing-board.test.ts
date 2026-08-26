import { describe, expect, it } from 'vitest'
import { deriveDefaultTitle } from '../../scripts/framing-board'
import { FRAMING_CASES, selectCases } from '../../scripts/framing/cases'
import { validateSpec, type BoardCase, type BoardSpec, type FramingVariant } from '../../scripts/framing/board/spec'

describe('deriveDefaultTitle', () => {
  it('nomme un mot-clé par son libellé et les variantes', () => {
    const cases = selectCases('drop')
    expect(deriveDefaultTitle('drop', cases, ['split-on', 'split-off'])).toBe('Cas écartés · split on/off')
  })

  it('reprend l’identifiant seul quand le sélecteur désigne un cas unique', () => {
    const id = FRAMING_CASES[0].id
    const cases = selectCases(id)
    expect(deriveDefaultTitle(id, cases, ['split-on', 'split-off'])).toBe(id)
  })

  it('formate une variante isolée', () => {
    const cases = selectCases('all')
    expect(deriveDefaultTitle('all', cases, ['split-on'])).toBe('Tous les cas · split on')
  })
})

describe("validateSpec : les champs de `FramingRequest` sur `kind: 'options'` (#190)", () => {
  function boardCase(id = 'c1'): BoardCase {
    return { id, projectId: 'p', at: 1, clipId: null, stake: 'stake' }
  }

  function specWith(variant: FramingVariant, cases: BoardCase[] = [boardCase()]): BoardSpec {
    return {
      id: 'spec',
      title: 'title',
      eyebrow: 'eyebrow',
      lede: 'lede',
      variants: [variant],
      sections: [{ title: 'section', cases }],
      classifier: 'single',
      settled: [],
    }
  }

  it('refuse un ratio inconnu', () => {
    const variant: FramingVariant = { id: 'v', label: 'v', kind: 'options', options: {}, ratio: '21:9' as never, why: 'x' }
    expect(() => validateSpec(specWith(variant))).toThrow(/ratio/)
  })

  it('refuse `cropMode: "manual"` sans `cropX`', () => {
    const variant: FramingVariant = { id: 'v', label: 'v', kind: 'options', options: {}, cropMode: 'manual', why: 'x' }
    expect(() => validateSpec(specWith(variant))).toThrow(/cropX/)
  })

  it('refuse un `cropX` numérique hors de [0, 1]', () => {
    const variant: FramingVariant = { id: 'v', label: 'v', kind: 'options', options: {}, cropX: 1.5, why: 'x' }
    expect(() => validateSpec(specWith(variant))).toThrow(/cropX/)
  })

  it('refuse une entrée de table `cropX` hors de [0, 1]', () => {
    const variant: FramingVariant = {
      id: 'v',
      label: 'v',
      kind: 'options',
      options: {},
      cropX: { c1: -0.1 },
      why: 'x',
    }
    expect(() => validateSpec(specWith(variant))).toThrow(/cropX/)
  })

  it('refuse une table `cropX` manuelle qui ne couvre pas tous les cas de la planche', () => {
    const variant: FramingVariant = {
      id: 'v',
      label: 'v',
      kind: 'options',
      options: {},
      cropMode: 'manual',
      cropX: { c1: 0.5 },
      why: 'x',
    }
    const cases = [boardCase('c1'), boardCase('c2')]
    expect(() => validateSpec(specWith(variant, cases))).toThrow(/c2/)
  })

  it('accepte un ratio connu, un `cropX` en table complète, et `cropMode: "manual"`', () => {
    const cases = [boardCase('c1'), boardCase('c2')]
    const variant: FramingVariant = {
      id: 'v',
      label: 'v',
      kind: 'options',
      options: {},
      ratio: '1:1',
      cropMode: 'manual',
      cropX: { c1: 0.2, c2: 0.8 },
      why: 'x',
    }
    expect(() => validateSpec(specWith(variant, cases))).not.toThrow()
  })
})
