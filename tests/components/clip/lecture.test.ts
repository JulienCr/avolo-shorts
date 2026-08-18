/**
 * La position de lecture, et le mot qu'elle désigne.
 *
 * Ce petit état vit à part du store d'édition pour une raison mesurable : la
 * position change quatre fois par seconde, et la faire passer par un `useState`
 * de la page rendrait l'arbre entier — transcript virtualisé et superposition de
 * cadrage compris — à cette cadence. Ici, chaque mot s'abonne à « suis-je le mot
 * actif », et deux mots seulement se rendent à chaque changement.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { motÀ, useLecture } from '@/components/clip/lecture'

const mots = [
  { start: 10, end: 10.4 },
  { start: 10.4, end: 10.9 },
  { start: 30, end: 30.5 },
]

describe('motÀ', () => {
  it('rend le mot qui contient la position', () => {
    expect(motÀ(mots, 10.5)).toBe(1)
  })

  it('rend `null` avant le premier mot', () => {
    expect(motÀ(mots, 2)).toBeNull()
  })

  it('garde le dernier mot prononcé pendant un silence', () => {
    // Sans cela, le surlignage clignote entre chaque mot et disparaît à chaque
    // respiration : la position ne se lirait plus dans le texte, ce qui est
    // toute la raison d'être de ce surlignage.
    expect(motÀ(mots, 20)).toBe(1)
  })

  it('rend `null` sur un transcript vide', () => {
    expect(motÀ([], 12)).toBeNull()
  })

  it('trouve le bon mot sur un transcript d’émission entière', () => {
    // Vingt mille mots : la recherche est dichotomique, pas linéaire — elle
    // s'exécute à chaque `timeupdate`, donc quatre fois par seconde.
    const longs = Array.from({ length: 20_000 }, (_, i) => ({ start: i, end: i + 0.5 }))
    expect(motÀ(longs, 19_998.2)).toBe(19_998)
  })
})

describe('useLecture', () => {
  beforeEach(() => {
    useLecture.getState().reinitialiser()
  })

  it('recalcule le mot actif quand la position bouge', () => {
    useLecture.getState().definirMots(mots)
    useLecture.getState().definirPosition(10.5)
    expect(useLecture.getState().motActif).toBe(1)
  })

  it('recalcule le mot actif quand le transcript change sous la lecture', () => {
    // Le transcript est réindexé à chaque coupe : le mot d'index 1 d'avant n'est
    // pas celui d'après, et un index gardé tel quel surlignerait un mot au
    // hasard.
    useLecture.getState().definirMots(mots)
    useLecture.getState().definirPosition(30.2)
    expect(useLecture.getState().motActif).toBe(2)

    useLecture.getState().definirMots([{ start: 30, end: 30.5 }])
    expect(useLecture.getState().motActif).toBe(0)
  })

  it('garde le même mot actif tant que la position reste dedans', () => {
    // Quatre `timeupdate` par seconde tombent presque tous dans le même mot.
    // C'est cette stabilité qui permet au surlignage de s'abonner à « suis-je le
    // mot actif » plutôt qu'à la position : sinon chaque mot rendu se rendrait à
    // nouveau quatre fois par seconde.
    useLecture.getState().definirMots(mots)
    const vus = new Set<number | null>()
    for (const t of [10.41, 10.55, 10.7, 10.89]) {
      useLecture.getState().definirPosition(t)
      vus.add(useLecture.getState().motActif)
    }
    expect([...vus]).toEqual([1])
  })
})
