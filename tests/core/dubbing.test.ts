import { describe, expect, it } from 'vitest'
import {
  DUBBING_ANCHORS,
  DUBBING_FILM_WIDTH,
  DUBBING_PIP_BAND,
  detectDubbingRuns,
  dubbingCellsFor,
  mapCellInto,
} from '@/core/dubbing'
import type { DubbingAnchor } from '@/core/dubbing'
import type { PersonBox } from '@/core/shots'

const ANCHOR = DUBBING_ANCHORS[0]
const PIP = ANCHOR.pip

/** Un point au centre du disque de l'ancre — toujours contenu, jamais au bord. */
const INSIDE = { x0: PIP.x0 + 0.05, y0: PIP.y0 + 0.05, x1: PIP.x1 - 0.05, y1: PIP.y1 - 0.05 }
/** Ailleurs dans l'image, sans rapport avec le disque. */
const OUTSIDE = { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 }

function box(t: number, geometry: { x0: number; y0: number; x1: number; y1: number }, score = 1): PersonBox {
  return { t, score, ...geometry }
}

/** Une boîte à chaque `step` s de `from` à `to` inclus, toutes à la même géométrie. */
function series(
  from: number,
  to: number,
  step: number,
  geometry: { x0: number; y0: number; x1: number; y1: number },
  score = 1,
): PersonBox[] {
  const out: PersonBox[] = []
  for (let t = from; t <= to + 1e-9; t += step) out.push(box(t, geometry, score))
  return out
}

describe('dubbingCellsFor', () => {
  it('rend le film pleine largeur et la bande telle quelle', () => {
    const cells = dubbingCellsFor(ANCHOR)
    expect(cells.film).toEqual({ x0: 0, y0: 0, x1: DUBBING_FILM_WIDTH, y1: 1 })
    expect(cells.strip).toEqual(ANCHOR.strip)
  })

  it("rend le disque entier tant que DUBBING_PIP_BAND vaut l'identité", () => {
    expect(DUBBING_PIP_BAND).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 })
    expect(dubbingCellsFor(ANCHOR).pip).toEqual(ANCHOR.pip)
  })

  it('mapCellInto place un pavé selon les fractions de son conteneur, pas de la source', () => {
    const outer = { x0: 0.6, y0: 0.0, x1: 1.0, y1: 0.4 }
    const band = { x0: 0.25, y0: 0.5, x1: 0.75, y1: 1 }
    expect(mapCellInto(outer, band)).toEqual({ x0: 0.7, x1: 0.9, y0: 0.2, y1: 0.4 })
  })

  it("l'identité renvoie le conteneur inchangé, quel qu'il soit", () => {
    const outer = { x0: 0.12, y0: 0.34, x1: 0.56, y1: 0.78 }
    expect(mapCellInto(outer, { x0: 0, y0: 0, x1: 1, y1: 1 })).toEqual(outer)
  })
})

describe('detectDubbingRuns — le vote', () => {
  // onDelay/offDelay à 0 et fenêtre nulle : chaque image vote pour elle-même,
  // sans lissage ni hystérésis, pour isoler le seul critère du vote.
  const isolate = { windowSeconds: 0, onDelaySeconds: 0, offDelaySeconds: 0, minVoteShare: 0.5 }

  it('une boîte entièrement dans le disque, au score suffisant, vote', () => {
    const runs = detectDubbingRuns(series(0, 5, 1, INSIDE), isolate)
    expect(runs).toHaveLength(1)
    expect(runs[0].start).toBe(0)
  })

  it('une boîte hors du disque ne vote jamais', () => {
    expect(detectDubbingRuns(series(0, 5, 1, OUTSIDE), isolate)).toEqual([])
  })

  it('une boîte qui déborde du disque ne vote pas, même de peu', () => {
    const straddling = { x0: PIP.x0 - 0.01, y0: PIP.y0 + 0.05, x1: PIP.x1 - 0.05, y1: PIP.y1 - 0.05 }
    expect(detectDubbingRuns(series(0, 5, 1, straddling), isolate)).toEqual([])
  })

  it('containmentTolerance rattrape un léger débordement, à la demande seulement', () => {
    const straddling = { x0: PIP.x0 - 0.01, y0: PIP.y0 + 0.05, x1: PIP.x1 - 0.05, y1: PIP.y1 - 0.05 }
    const withTolerance = detectDubbingRuns(series(0, 5, 1, straddling), { ...isolate, containmentTolerance: 0.02 })
    expect(withTolerance).toHaveLength(1)
  })

  it('un score sous le seuil ne vote pas ; au seuil, inclusif, il vote', () => {
    const below = detectDubbingRuns(series(0, 5, 1, INSIDE, 0.49), { ...isolate, minScore: 0.5 })
    expect(below).toEqual([])
    const atThreshold = detectDubbingRuns(series(0, 5, 1, INSIDE, 0.5), { ...isolate, minScore: 0.5 })
    expect(atThreshold).toHaveLength(1)
  })

  it('un score NaN ne vote jamais — il ne doit pas franchir un seuil par accident', () => {
    expect(detectDubbingRuns(series(0, 5, 1, INSIDE, Number.NaN), isolate)).toEqual([])
  })

  it('une géométrie dégénérée (largeur nulle) ne vote pas', () => {
    const degenerate = { x0: PIP.x0 + 0.05, y0: PIP.y0 + 0.05, x1: PIP.x0 + 0.05, y1: PIP.y1 - 0.05 }
    expect(detectDubbingRuns(series(0, 5, 1, degenerate), isolate)).toEqual([])
  })
})

describe('detectDubbingRuns — la part de la fenêtre glissante', () => {
  /** 20 images, une par seconde, votantes seulement à t=9 et t=10. */
  function timelineWithABurst(): PersonBox[] {
    const out: PersonBox[] = []
    for (let t = 0; t < 20; t++) out.push(box(t, t === 9 || t === 10 ? INSIDE : OUTSIDE))
    return out
  }

  it('une fenêtre étroite laisse une brève salve franchir le seuil', () => {
    const runs = detectDubbingRuns(timelineWithABurst(), {
      windowSeconds: 2,
      minVoteShare: 0.5,
      onDelaySeconds: 0,
      offDelaySeconds: 0,
    })
    expect(runs.length).toBeGreaterThan(0)
  })

  it('la même salve, diluée par une fenêtre large, ne franchit plus rien', () => {
    const runs = detectDubbingRuns(timelineWithABurst(), {
      windowSeconds: 20,
      minVoteShare: 0.5,
      onDelaySeconds: 0,
      offDelaySeconds: 0,
    })
    expect(runs).toEqual([])
  })

  it('le seuil de part est inclusif : à égalité pile, il compte', () => {
    // Deux images dans une fenêtre qui les couvre toutes les deux : une seule vote, part = 0,5 pile.
    const people = [box(0, OUTSIDE), box(1, INSIDE)]
    const common = { windowSeconds: 2, onDelaySeconds: 0, offDelaySeconds: 0 }
    expect(detectDubbingRuns(people, { ...common, minVoteShare: 0.5 })).not.toEqual([])
    expect(detectDubbingRuns(people, { ...common, minVoteShare: 0.51 })).toEqual([])
  })
})

describe("detectDubbingRuns — l'hystérésis", () => {
  /** Vote continu de 10 à 24 s (15 s), hors disque avant et après, jusqu'à 59 s. */
  function shortBurst(): PersonBox[] {
    const out: PersonBox[] = []
    for (let t = 0; t <= 59; t++) out.push(box(t, t >= 10 && t <= 24 ? INSIDE : OUTSIDE))
    return out
  }

  const noWindow = { windowSeconds: 0, offDelaySeconds: 0, minVoteShare: 0.5 }

  it('une salve plus courte que onDelaySeconds ne produit aucune séquence', () => {
    expect(detectDubbingRuns(shortBurst(), { ...noWindow, onDelaySeconds: 20 })).toEqual([])
  })

  it('la même salve, avec un onDelaySeconds plus court qu\'elle, produit une séquence', () => {
    const runs = detectDubbingRuns(shortBurst(), { ...noWindow, onDelaySeconds: 10 })
    expect(runs).toHaveLength(1)
  })

  it("le départ rapporté est le vrai franchissement, jamais l'instant retardé par onDelaySeconds", () => {
    const runs = detectDubbingRuns(shortBurst(), { ...noWindow, onDelaySeconds: 10 })
    expect(runs[0].start).toBe(10)
  })

  /** Vote continu sur 0-59 s, sauf un creux de `gap` s à partir de 30 s. */
  function withGap(gap: number): PersonBox[] {
    const out: PersonBox[] = []
    for (let t = 0; t <= 59; t++) {
      const inGap = t >= 30 && t < 30 + gap
      out.push(box(t, inGap ? OUTSIDE : INSIDE))
    }
    return out
  }

  it('un creux plus court que offDelaySeconds ne coupe pas la séquence en deux', () => {
    const runs = detectDubbingRuns(withGap(5), { windowSeconds: 0, onDelaySeconds: 0, minVoteShare: 0.5, offDelaySeconds: 10 })
    expect(runs).toHaveLength(1)
    expect(runs[0].start).toBe(0)
    expect(runs[0].end).toBe(59)
  })

  it('le même creux, avec un offDelaySeconds plus court que lui, coupe la séquence en deux', () => {
    const runs = detectDubbingRuns(withGap(5), { windowSeconds: 0, onDelaySeconds: 0, minVoteShare: 0.5, offDelaySeconds: 3 })
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ start: 0, end: 30 })
    expect(runs[1]).toMatchObject({ start: 35, end: 59 })
  })
})

describe('detectDubbingRuns — cas limites', () => {
  it('aucune boîte ne rend aucune séquence', () => {
    expect(detectDubbingRuns([])).toEqual([])
  })

  it('chaque séquence porte son ancre', () => {
    const runs = detectDubbingRuns(series(0, 40, 1, INSIDE), {})
    expect(runs.length).toBeGreaterThan(0)
    for (const r of runs) expect(r.anchor).toBe(ANCHOR)
  })

  it('DUBBING_ANCHORS porte la géométrie mesurée (amendement A1) et rien de plus tant que le top-left est hors périmètre', () => {
    expect(DUBBING_ANCHORS).toHaveLength(1)
    const anchor: DubbingAnchor = DUBBING_ANCHORS[0]
    expect(anchor.id).toBe('top-right-2026')
    expect(anchor.pip).toEqual({ x0: 0.773, y0: 0.022, x1: 0.988, y1: 0.411 })
  })
})
