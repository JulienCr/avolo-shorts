import { describe, expect, it } from 'vitest'

import type { Segment } from '@/core/edl'
import {
  géométrie,
  instantAuClic,
  part,
  placerEnVoies,
  étendue,
  type Intervalle,
} from '@/core/couverture'

function seg(start: number, end: number): Segment {
  return { start, end }
}

function bornes(i: Intervalle | null): [number, number] | null {
  return i === null ? null : [i.début, i.fin]
}

describe('étendue', () => {
  it('va du premier début à la dernière fin, trou compris', () => {
    // Un clip est une liste de segments, et retirer un passage par le milieu
    // laisse un trou : le clip occupe toujours la même place dans l'émission, il
    // en garde seulement moins. La bande décrit la couverture, pas la durée.
    expect(bornes(étendue([seg(100, 130), seg(150, 200)]))).toEqual([100, 200])
  })

  it('ne dépend pas de l’ordre des segments', () => {
    expect(bornes(étendue([seg(150, 200), seg(100, 130)]))).toEqual([100, 200])
  })

  it('rend null sur une liste vide', () => {
    // Un clip dont tous les mots ont été retirés n'occupe aucune place, et lui
    // dessiner un bloc de largeur nulle mettrait une cible invisible mais
    // cliquable sur la bande.
    expect(étendue([])).toBeNull()
  })

  it('rend null sur des bornes qui ne décrivent aucune étendue', () => {
    expect(étendue([seg(Number.NaN, 10)])).toBeNull()
    expect(étendue([seg(10, 10)])).toBeNull()
  })
})

describe('placerEnVoies', () => {
  const borne = (i: Intervalle) => i

  it('range sur une seule voie ce qui ne se chevauche pas', () => {
    const { placés, voies } = placerEnVoies(
      [
        { début: 0, fin: 10 },
        { début: 20, fin: 30 },
      ],
      borne,
    )
    expect(voies).toBe(1)
    expect(placés.map((p) => p.voie)).toEqual([0, 0])
  })

  it('sépare deux clips qui se chevauchent', () => {
    // L'exigence explicite du retour d'usage. Empilés sur une ligne, le second
    // efface le premier et le survol n'en désigne qu'un sans dire lequel.
    const { placés, voies } = placerEnVoies(
      [
        { début: 0, fin: 60 },
        { début: 30, fin: 90 },
      ],
      borne,
    )
    expect(voies).toBe(2)
    expect(placés.map((p) => p.voie)).toEqual([0, 1])
  })

  it('partage une voie entre deux clips qui se touchent sans se chevaucher', () => {
    // Les traiter comme un chevauchement ajouterait une voie à toute une
    // émission pour un point de contact.
    const { voies } = placerEnVoies(
      [
        { début: 0, fin: 60 },
        { début: 60, fin: 120 },
      ],
      borne,
    )
    expect(voies).toBe(1)
  })

  it('n’utilise jamais plus de voies que le recouvrement maximal', () => {
    // Le glouton sur les débuts donne le nombre chromatique d'un graphe
    // d'intervalles : trois clips simultanés, trois voies, et pas quatre même
    // avec un quatrième clip ailleurs.
    const { voies } = placerEnVoies(
      [
        { début: 0, fin: 100 },
        { début: 10, fin: 110 },
        { début: 20, fin: 120 },
        { début: 200, fin: 300 },
      ],
      borne,
    )
    expect(voies).toBe(3)
  })

  it('réutilise une voie libérée plutôt que d’en ouvrir une', () => {
    const { placés, voies } = placerEnVoies(
      [
        { début: 0, fin: 50 },
        { début: 10, fin: 60 },
        { début: 70, fin: 80 },
      ],
      borne,
    )
    expect(voies).toBe(2)
    expect(placés[2].voie).toBe(0)
  })

  it('départage deux clips au même début dans l’ordre reçu', () => {
    // Un tri stable est ici une propriété du rendu : sans lui, deux relevés
    // successifs échangeraient les voies de deux clips voisins et la bande
    // clignoterait.
    const { placés } = placerEnVoies(
      [
        { nom: 'a', début: 0, fin: 10 },
        { nom: 'b', début: 0, fin: 10 },
      ],
      (x) => ({ début: x.début, fin: x.fin }),
    )
    expect(placés.map((p) => [p.item.nom, p.voie])).toEqual([
      ['a', 0],
      ['b', 1],
    ])
  })

  it('trie par début même quand la liste ne l’est pas', () => {
    const { placés } = placerEnVoies(
      [
        { nom: 'tard', début: 100, fin: 110 },
        { nom: 'tôt', début: 0, fin: 10 },
      ],
      (x) => ({ début: x.début, fin: x.fin }),
    )
    expect(placés.map((p) => p.item.nom)).toEqual(['tôt', 'tard'])
  })

  it('ne réordonne pas la liste de l’appelant', () => {
    const items = [
      { début: 100, fin: 110 },
      { début: 0, fin: 10 },
    ]
    placerEnVoies(items, borne)
    expect(items[0].début).toBe(100)
  })

  it('écarte silencieusement ce qui n’a pas d’étendue', () => {
    const { placés, voies } = placerEnVoies([{ vide: true }], () => null)
    expect(placés).toEqual([])
    expect(voies).toBe(0)
  })
})

describe('la géométrie de la bande', () => {
  it('rapporte un instant à la durée', () => {
    expect(part(30, 120)).toBe(0.25)
  })

  it('borne des deux côtés', () => {
    // La durée vient de `ProjectSummary` et les bornes des clips du repérage :
    // les deux se sont déjà contredites d'une poignée de secondes en fin
    // d'émission, et un bloc à 101 % déborde de son conteneur.
    expect(part(-5, 120)).toBe(0)
    expect(part(200, 120)).toBe(1)
  })

  it('replie la bande sur elle-même plutôt que de propager un NaN', () => {
    expect(part(30, 0)).toBe(0)
    expect(part(Number.NaN, 120)).toBe(0)
    expect(part(30, Number.NaN)).toBe(0)
  })

  it('pose un bloc en pour cent de la bande', () => {
    expect(géométrie({ début: 30, fin: 60 }, 120)).toEqual({ gauche: 25, largeur: 25 })
  })

  it('rend une largeur nulle plutôt que négative sur une étendue hors durée', () => {
    // C'est au rendu de donner une largeur minimale en CSS : élargir ici ferait
    // glisser le bord gauche de tout ce qui suit.
    expect(géométrie({ début: 200, fin: 300 }, 120)).toEqual({ gauche: 100, largeur: 0 })
  })

  it('traduit un clic en instant de la source', () => {
    expect(instantAuClic(300, 1_200, 6_000)).toBe(1_500)
  })

  it('borne le clic aux deux bouts de l’émission', () => {
    expect(instantAuClic(-10, 1_200, 6_000)).toBe(0)
    expect(instantAuClic(2_000, 1_200, 6_000)).toBe(6_000)
  })

  it('rend zéro tant que la bande n’est pas mise en page', () => {
    expect(instantAuClic(300, 0, 6_000)).toBe(0)
    expect(instantAuClic(300, 1_200, 0)).toBe(0)
  })
})
