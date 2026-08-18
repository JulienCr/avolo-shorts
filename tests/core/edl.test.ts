import { describe, it, expect } from 'vitest'
import { clipDuration, normalizeSegments, removeRange, moveBoundary } from '@/core/edl'

describe('clipDuration', () => {
  it('somme les segments et ignore les trous', () => {
    expect(
      clipDuration([
        { start: 2841.2, end: 2856.9 },
        { start: 2874.1, end: 2931.4 },
      ]),
    ).toBeCloseTo(73.0, 3)
  })

  it('vaut zéro sans segment', () => {
    expect(clipDuration([])).toBe(0)
  })

  // Le `Math.max(0, …)` de l'implémentation était documenté mais pas exercé
  // (Copilot). Sans ce cas, une régression rendrait la durée négative — et une
  // durée négative se propage en silence, puisqu'elle s'additionne.
  it('compte un segment inversé pour zéro plutôt que de retrancher du temps', () => {
    expect(clipDuration([{ start: 2, end: 1 }])).toBe(0)
    expect(clipDuration([{ start: 0, end: 10 }, { start: 2, end: 1 }])).toBe(10)
  })
})

describe('normalizeSegments', () => {
  it('trie, fusionne les chevauchements et jette les segments vides', () => {
    expect(
      normalizeSegments([
        { start: 30, end: 40 },
        { start: 10, end: 20 },
        { start: 15, end: 25 },
        { start: 50, end: 50 },
      ]),
    ).toEqual([
      { start: 10, end: 25 },
      { start: 30, end: 40 },
    ])
  })

  // La fusion écrit `last.end`. Si `last` désignait un segment de l'appelant
  // plutôt qu'une copie, l'EDL affichée à l'écran changerait sous les pieds de
  // l'utilisateur pendant un simple calcul de durée.
  it("ne modifie ni le tableau ni les segments qu'on lui passe", () => {
    const entree = [
      { start: 30, end: 40 },
      { start: 10, end: 20 },
      { start: 15, end: 25 },
    ]
    normalizeSegments(entree)
    expect(entree).toEqual([
      { start: 30, end: 40 },
      { start: 10, end: 20 },
      { start: 15, end: 25 },
    ])
  })

  it('colle deux segments qui se touchent, puisque la source y est continue', () => {
    expect(
      normalizeSegments([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ]),
    ).toEqual([{ start: 0, end: 20 }])
  })
})

describe('removeRange', () => {
  it('coupe un segment en deux quand on retire son milieu', () => {
    expect(removeRange([{ start: 0, end: 100 }], 40, 60)).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ])
  })

  it('raccourcit quand le retrait mord sur une borne', () => {
    expect(removeRange([{ start: 0, end: 100 }], 90, 200)).toEqual([{ start: 0, end: 90 }])
  })

  it('supprime un segment entièrement couvert', () => {
    expect(
      removeRange(
        [
          { start: 0, end: 10 },
          { start: 20, end: 30 },
        ],
        0,
        15,
      ),
    ).toEqual([{ start: 20, end: 30 }])
  })

  it('ne touche à rien si le retrait tombe dans un trou', () => {
    expect(
      removeRange(
        [
          { start: 0, end: 10 },
          { start: 20, end: 30 },
        ],
        12,
        18,
      ),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ])
  })

  it('la durée est un résultat, sans plafond', () => {
    const long = [{ start: 0, end: 300 }]
    expect(clipDuration(removeRange(long, 10, 20))).toBe(290)
  })

  // Retirer les hésitations, c'est le même appel répété (spec §5). Le vérifier
  // ici parce que c'est la composition qui porte la promesse, pas l'appel seul :
  // chaque sortie doit rester une entrée valide pour le suivant.
  it("s'enchaîne : quatre retraits sur un même segment laissent cinq morceaux", () => {
    let edl = [{ start: 0, end: 100 }]
    for (const [from, to] of [
      [10, 12],
      [30, 31],
      [55, 60],
      [80, 81],
    ]) {
      edl = removeRange(edl, from, to)
    }
    expect(edl).toEqual([
      { start: 0, end: 10 },
      { start: 12, end: 30 },
      { start: 31, end: 55 },
      { start: 60, end: 80 },
      { start: 81, end: 100 },
    ])
    expect(clipDuration(edl)).toBe(91)
  })

  it('un intervalle vide ou inversé ne retire rien', () => {
    expect(removeRange([{ start: 0, end: 100 }], 50, 50)).toEqual([{ start: 0, end: 100 }])
    expect(removeRange([{ start: 0, end: 100 }], 60, 40)).toEqual([{ start: 0, end: 100 }])
  })

  it("rend une liste normalisée même sur une entrée qui ne l'était pas", () => {
    expect(
      removeRange(
        [
          { start: 30, end: 40 },
          { start: 10, end: 25 },
        ],
        0,
        5,
      ),
    ).toEqual([
      { start: 10, end: 25 },
      { start: 30, end: 40 },
    ])
  })

  // Aristarque : `normalizeSegments` avait son test de non-mutation, les deux
  // autres non. L'invariant vaut pour les trois — c'est lui qui autorise
  // l'interface à garder une référence sur l'EDL affichée pendant un calcul.
  it("ne modifie ni le tableau ni les segments qu'on lui passe", () => {
    const entree = [
      { start: 0, end: 100 },
      { start: 200, end: 300 },
    ]
    removeRange(entree, 40, 250)
    expect(entree).toEqual([
      { start: 0, end: 100 },
      { start: 200, end: 300 },
    ])
  })
})

describe('moveBoundary', () => {
  it('déplace la borne de début du premier segment', () => {
    expect(
      moveBoundary(
        [
          { start: 10, end: 20 },
          { start: 30, end: 40 },
        ],
        'start',
        5,
      ),
    ).toEqual([
      { start: 5, end: 20 },
      { start: 30, end: 40 },
    ])
  })

  it('déplace la borne de fin du dernier segment', () => {
    expect(
      moveBoundary(
        [
          { start: 10, end: 20 },
          { start: 30, end: 40 },
        ],
        'end',
        55,
      ),
    ).toEqual([
      { start: 10, end: 20 },
      { start: 30, end: 55 },
    ])
  })

  // « Premier » et « dernier » veulent dire dans l'ordre du temps. Sans la
  // normalisation d'entrée, une liste arrivée désordonnée — d'un JSON, de la
  // base — verrait la borne d'un segment du milieu bouger sans erreur ni trace.
  it("choisit la borne dans l'ordre du temps, pas dans celui du tableau", () => {
    const desordre = [
      { start: 30, end: 40 },
      { start: 10, end: 20 },
    ]
    expect(moveBoundary(desordre, 'start', 5)).toEqual([
      { start: 5, end: 20 },
      { start: 30, end: 40 },
    ])
    expect(moveBoundary(desordre, 'end', 45)).toEqual([
      { start: 10, end: 20 },
      { start: 30, end: 45 },
    ])
  })

  it("sur une liste vide, il n'y a pas de borne à déplacer", () => {
    expect(moveBoundary([], 'start', 5)).toEqual([])
    expect(moveBoundary([], 'end', 5)).toEqual([])
  })

  // Trouvé par les trois relecteurs de la PR #6, et c'est un vrai défaut :
  // l'utilisateur demandait 35, la version précédente rendait 30. Elle ne
  // touchait que le segment extérieur, que `normalizeSegments` jetait ensuite
  // parce qu'il était devenu inversé — le voisin, lui, n'était pas rogné. La
  // valeur demandée disparaissait sans erreur.
  it('rétrécir jusque dans un autre segment tombe sur la borne demandée', () => {
    const edl = [
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]
    expect(moveBoundary(edl, 'start', 35)).toEqual([{ start: 35, end: 40 }])
    expect(moveBoundary(edl, 'end', 15)).toEqual([{ start: 10, end: 15 }])
  })

  it("rétrécir à l'intérieur du premier segment ne touche pas aux suivants", () => {
    expect(
      moveBoundary(
        [
          { start: 10, end: 20 },
          { start: 30, end: 40 },
        ],
        'start',
        15,
      ),
    ).toEqual([
      { start: 15, end: 20 },
      { start: 30, end: 40 },
    ])
  })

  it('un déplacement qui traverse la borne opposée retire le segment', () => {
    expect(
      moveBoundary(
        [
          { start: 10, end: 20 },
          { start: 30, end: 40 },
        ],
        'start',
        25,
      ),
    ).toEqual([{ start: 30, end: 40 }])
  })

  it('étendre sans plafond : une borne repoussée très loin est acceptée', () => {
    const out = moveBoundary([{ start: 10, end: 20 }], 'end', 3600)
    expect(clipDuration(out)).toBe(3590)
  })

  // Le chemin « étendre » écrit `premier.start` / `dernier.end` : c'est celui
  // qui muterait l'entrée si `normalizeSegments` cessait un jour de recopier.
  it("ne modifie ni le tableau ni les segments qu'on lui passe", () => {
    const entree = [
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]
    moveBoundary(entree, 'start', 5)
    moveBoundary(entree, 'end', 55)
    moveBoundary(entree, 'start', 35)
    expect(entree).toEqual([
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ])
  })
})
