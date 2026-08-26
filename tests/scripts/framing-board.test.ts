import { describe, expect, it } from 'vitest'
import { deriveDefaultTitle } from '../../scripts/framing-board'
import { FRAMING_CASES, selectCases } from '../../scripts/framing/cases'

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
