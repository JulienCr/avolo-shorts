import { describe, expect, it } from 'vitest'

import type { Segment } from '@/core/edl'
import {
  blockGeometry,
  fractionOf,
  placeInLanes,
  spanOf,
  timeAtClick,
  type Interval,
} from '@/core/coverage'

function seg(start: number, end: number): Segment {
  return { start, end }
}

function span(i: Interval | null): [number, number] | null {
  return i === null ? null : [i.start, i.end]
}

describe('spanOf', () => {
  it('va du premier début à la dernière fin, trou compris', () => {
    // Un clip est une liste de segments, et retirer un passage par le milieu
    // laisse un trou : le clip occupe toujours la même place dans l'émission, il
    // en garde seulement moins. La bande décrit la couverture, pas la durée.
    expect(span(spanOf([seg(100, 130), seg(150, 200)]))).toEqual([100, 200])
  })

  it('ne dépend pas de l’ordre des segments', () => {
    expect(span(spanOf([seg(150, 200), seg(100, 130)]))).toEqual([100, 200])
  })

  it('rend null sur une liste vide', () => {
    // Un clip dont tous les mots ont été retirés n'occupe aucune place, et lui
    // dessiner un bloc de largeur nulle mettrait une cible invisible mais
    // cliquable sur la bande.
    expect(spanOf([])).toBeNull()
  })

  it('rend null sur des bornes qui ne décrivent aucune étendue', () => {
    expect(spanOf([seg(Number.NaN, 10)])).toBeNull()
    expect(spanOf([seg(10, 10)])).toBeNull()
  })
})

describe('placeInLanes', () => {
  const bounds = (i: Interval) => i

  it('range sur une seule voie ce qui ne se chevauche pas', () => {
    const { placed, lanes } = placeInLanes(
      [
        { start: 0, end: 10 },
        { start: 20, end: 30 },
      ],
      bounds,
    )
    expect(lanes).toBe(1)
    expect(placed.map((p) => p.lane)).toEqual([0, 0])
  })

  it('sépare deux clips qui se chevauchent', () => {
    // L'exigence explicite du retour d'usage. Empilés sur une ligne, le second
    // efface le premier et le survol n'en désigne qu'un sans dire lequel.
    const { placed, lanes } = placeInLanes(
      [
        { start: 0, end: 60 },
        { start: 30, end: 90 },
      ],
      bounds,
    )
    expect(lanes).toBe(2)
    expect(placed.map((p) => p.lane)).toEqual([0, 1])
  })

  it('partage une voie entre deux clips qui se touchent sans se chevaucher', () => {
    // Les traiter comme un chevauchement ajouterait une voie à toute une
    // émission pour un point de contact.
    const { lanes } = placeInLanes(
      [
        { start: 0, end: 60 },
        { start: 60, end: 120 },
      ],
      bounds,
    )
    expect(lanes).toBe(1)
  })

  it('n’utilise jamais plus de voies que le recouvrement maximal', () => {
    // Le glouton sur les débuts donne le nombre chromatique d'un graphe
    // d'intervalles : trois clips simultanés, trois voies, et pas quatre même
    // avec un quatrième clip ailleurs.
    const { lanes } = placeInLanes(
      [
        { start: 0, end: 100 },
        { start: 10, end: 110 },
        { start: 20, end: 120 },
        { start: 200, end: 300 },
      ],
      bounds,
    )
    expect(lanes).toBe(3)
  })

  it('réutilise une voie libérée plutôt que d’en ouvrir une', () => {
    const { placed, lanes } = placeInLanes(
      [
        { start: 0, end: 50 },
        { start: 10, end: 60 },
        { start: 70, end: 80 },
      ],
      bounds,
    )
    expect(lanes).toBe(2)
    expect(placed[2].lane).toBe(0)
  })

  it('départage deux clips au même début dans l’ordre reçu', () => {
    // Un tri stable est ici une propriété du rendu : sans lui, deux relevés
    // successifs échangeraient les voies de deux clips voisins et la bande
    // clignoterait.
    const { placed } = placeInLanes(
      [
        { name: 'a', start: 0, end: 10 },
        { name: 'b', start: 0, end: 10 },
      ],
      (x) => ({ start: x.start, end: x.end }),
    )
    expect(placed.map((p) => [p.item.name, p.lane])).toEqual([
      ['a', 0],
      ['b', 1],
    ])
  })

  it('trie par début même quand la liste ne l’est pas', () => {
    const { placed } = placeInLanes(
      [
        { name: 'tard', start: 100, end: 110 },
        { name: 'tôt', start: 0, end: 10 },
      ],
      (x) => ({ start: x.start, end: x.end }),
    )
    expect(placed.map((p) => p.item.name)).toEqual(['tôt', 'tard'])
  })

  it('ne réordonne pas la liste de l’appelant', () => {
    const items = [
      { start: 100, end: 110 },
      { start: 0, end: 10 },
    ]
    placeInLanes(items, bounds)
    expect(items[0].start).toBe(100)
  })

  it('écarte silencieusement ce qui n’a pas d’étendue', () => {
    const { placed, lanes } = placeInLanes([{ vide: true }], () => null)
    expect(placed).toEqual([])
    expect(lanes).toBe(0)
  })
})

describe('la géométrie de la bande', () => {
  it('rapporte un instant à la durée', () => {
    expect(fractionOf(30, 120)).toBe(0.25)
  })

  it('bounds des deux côtés', () => {
    // La durée vient de `ProjectSummary` et les bornes des clips du repérage :
    // les deux se sont déjà contredites d'une poignée de secondes en fin
    // d'émission, et un bloc à 101 % déborde de son conteneur.
    expect(fractionOf(-5, 120)).toBe(0)
    expect(fractionOf(200, 120)).toBe(1)
  })

  it('replie la bande sur elle-même plutôt que de propager un NaN', () => {
    expect(fractionOf(30, 0)).toBe(0)
    expect(fractionOf(Number.NaN, 120)).toBe(0)
    expect(fractionOf(30, Number.NaN)).toBe(0)
  })

  it('pose un bloc en pour cent de la bande', () => {
    expect(blockGeometry({ start: 30, end: 60 }, 120)).toEqual({ left: 25, width: 25 })
  })

  it('rend une largeur nulle plutôt que négative sur une étendue hors durée', () => {
    // C'est au rendu de donner une largeur minimale en CSS : élargir ici ferait
    // glisser le bord gauche de tout ce qui suit.
    expect(blockGeometry({ start: 200, end: 300 }, 120)).toEqual({ left: 100, width: 0 })
  })

  it('traduit un clic en instant de la source', () => {
    expect(timeAtClick(300, 1_200, 6_000)).toBe(1_500)
  })

  it('bounds le clic aux deux bouts de l’émission', () => {
    expect(timeAtClick(-10, 1_200, 6_000)).toBe(0)
    expect(timeAtClick(2_000, 1_200, 6_000)).toBe(6_000)
  })

  it('rend zéro tant que la bande n’est pas mise en page', () => {
    expect(timeAtClick(300, 0, 6_000)).toBe(0)
    expect(timeAtClick(300, 1_200, 0)).toBe(0)
  })
})
