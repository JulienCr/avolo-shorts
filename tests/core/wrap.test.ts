import { describe, it, expect } from 'vitest'
import { wrapCard } from '@/core/captions/wrap'

describe('wrapCard', () => {
  it('ne casse rien sur un tableau vide', () => {
    expect(wrapCard([], () => 0, 10)).toEqual([])
  })

  it('ne coupe jamais un mot seul', () => {
    expect(wrapCard(['un'], () => 0, 10)).toEqual([false])
  })

  // Le seuil est inclusif : une largeur pile égale à `maxWidth` ne coupe pas.
  // C'est la même convention que le reste du dépôt (CLAUDE.md, « une valeur
  // notée qu'on compare à un seuil inclusif ne s'arrondit pas »).
  it('ne coupe pas quand la candidate mesure exactement maxWidth', () => {
    const measure = (t: string) => t.length
    expect(wrapCard(['aa', 'bb'], measure, 5)).toEqual([false, false])
  })

  it('coupe dès que la candidate dépasse maxWidth d’une unité', () => {
    const measure = (t: string) => t.length
    expect(wrapCard(['aa', 'bb'], measure, 4)).toEqual([true, false])
  })

  it('coupe plusieurs fois quand chaque mot dépasse déjà seul le reste de la ligne', () => {
    const measure = (t: string) => t.length
    expect(wrapCard(['aaaa', 'bbbb', 'cccc'], measure, 4)).toEqual([true, true, false])
  })

  it('ne coupe jamais un mot seul même s’il dépasse maxWidth à lui seul', () => {
    const measure = (t: string) => t.length
    expect(wrapCard(['tresverylongword'], measure, 4)).toEqual([false])
  })
})
