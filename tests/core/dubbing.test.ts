import { describe, expect, it } from 'vitest'
import {
  DUBBING_ANCHORS,
  DUBBING_FILM_WIDTH,
  DUBBING_PIP_BAND_HEIGHT,
  detectDubbingRuns,
  dubbingCellsFor,
} from '@/core/dubbing'
import type { DubbingAnchor } from '@/core/dubbing'
import { POINT, POINT_COUNT } from '@/core/shots'
import type { PersonBox } from '@/core/shots'

const ANCHOR = DUBBING_ANCHORS[0]
const PIP = ANCHOR.pip

/** Un point au centre du disque de l'ancre — toujours contenu, jamais au bord. */
const INSIDE = { x0: PIP.x0 + 0.05, y0: PIP.y0 + 0.05, x1: PIP.x1 - 0.05, y1: PIP.y1 - 0.05 }
/** Ailleurs dans l'image, sans rapport avec le disque. */
const OUTSIDE = { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 }

function box(
  t: number,
  geometry: { x0: number; y0: number; x1: number; y1: number },
  score = 1,
  k?: number[],
): PersonBox {
  return { t, score, ...geometry, ...(k ? { k } : {}) }
}

/** Un squelette COCO minimal, seuls le nez et les yeux étant renseignés. */
function poseK(overrides: {
  nose?: { y: number; score: number }
  leftEye?: { y: number; score: number }
  rightEye?: { y: number; score: number }
}): number[] {
  const k = new Array<number>(POINT_COUNT * 3).fill(0)
  const set = (idx: number, y: number, score: number) => {
    k[idx * 3] = 0.5
    k[idx * 3 + 1] = y
    k[idx * 3 + 2] = score
  }
  if (overrides.nose) set(POINT.NOSE, overrides.nose.y, overrides.nose.score)
  if (overrides.leftEye) set(POINT.LEFT_EYE, overrides.leftEye.y, overrides.leftEye.score)
  if (overrides.rightEye) set(POINT.RIGHT_EYE, overrides.rightEye.y, overrides.rightEye.score)
  return k
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

const CY = (PIP.y0 + PIP.y1) / 2
const RY = (PIP.y1 - PIP.y0) / 2
const BAND_HEIGHT = DUBBING_PIP_BAND_HEIGHT * RY * 2

describe('dubbingCellsFor', () => {
  it('rend le film pleine largeur et la bande telle quelle', () => {
    const cells = dubbingCellsFor(ANCHOR, CY)
    expect(cells.film).toEqual({ x0: 0, y0: 0, x1: DUBBING_FILM_WIDTH, y1: 1 })
    expect(cells.strip).toEqual(ANCHOR.strip)
  })

  it('place le bord haut du bandeau au tiers sous le regard mesuré, loin des bords du disque', () => {
    const cells = dubbingCellsFor(ANCHOR, CY)
    expect(cells.pip.y0).toBeCloseTo(CY - BAND_HEIGHT / 3, 9)
    expect(cells.pip.y1 - cells.pip.y0).toBeCloseTo(BAND_HEIGHT, 9)
  })

  it('glisse le bandeau, sans le réduire, quand le regard mesuré est au bord haut du disque', () => {
    const cells = dubbingCellsFor(ANCHOR, PIP.y0)
    expect(cells.pip.y0).toBeCloseTo(PIP.y0, 9)
    expect(cells.pip.y1 - cells.pip.y0).toBeCloseTo(BAND_HEIGHT, 9)
  })

  it('glisse le bandeau, sans le réduire, quand le regard mesuré déborde sous le disque', () => {
    const cells = dubbingCellsFor(ANCHOR, PIP.y1 + 0.05)
    expect(cells.pip.y1).toBeCloseTo(PIP.y1, 9)
    expect(cells.pip.y1 - cells.pip.y0).toBeCloseTo(BAND_HEIGHT, 9)
  })

  // **Amendement 3 du contrat** : plus de corde inscrite, le pavé prend toute
  // la largeur du disque quel que soit le regard mesuré — l'arc du cercle en
  // masque les coins dans `args.ts`, jamais un rectangle rétréci.
  it('occupe toute la largeur du disque, quel que soit le regard mesuré ou le glissement', () => {
    const plausible = [
      PIP.y0,
      PIP.y0 + 0.01,
      CY,
      PIP.y1 - 0.01,
      PIP.y1,
      PIP.y0 - 0.05, // au-dessus du disque : force le glissement vers le bas
      PIP.y1 + 0.05, // sous le disque : force le glissement vers le haut
    ]
    for (const eyeLevel of plausible) {
      const cells = dubbingCellsFor(ANCHOR, eyeLevel)
      expect(cells.pip.x0).toBe(PIP.x0)
      expect(cells.pip.x1).toBe(PIP.x1)
    }
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

describe('detectDubbingRuns — le regard le plus haut (amendement A7)', () => {
  it('les deux yeux, confiants, donnent leur moyenne', () => {
    const k = poseK({
      leftEye: { y: 0.1, score: 0.9 },
      rightEye: { y: 0.12, score: 0.9 },
      nose: { y: 0.5, score: 0.9 },
    })
    const runs = detectDubbingRuns(series(0, 40, 1, INSIDE).map((b) => ({ ...b, k })), {})
    expect(runs).toHaveLength(1)
    expect(runs[0].eyeLevel).toBeCloseTo(0.11, 9)
  })

  it("un œil peu confiant cède le regard au nez", () => {
    const k = poseK({
      leftEye: { y: 0.1, score: 0.1 },
      rightEye: { y: 0.12, score: 0.9 },
      nose: { y: 0.2, score: 0.9 },
    })
    const runs = detectDubbingRuns(series(0, 40, 1, INSIDE).map((b) => ({ ...b, k })), {})
    expect(runs[0].eyeLevel).toBeCloseTo(0.2, 9)
  })

  it('sans point de pose exploitable, le haut de la boîte fait office de regard', () => {
    const runs = detectDubbingRuns(series(0, 40, 1, INSIDE), {})
    expect(runs[0].eyeLevel).toBeCloseTo(INSIDE.y0, 9)
  })

  it('le regard le plus haut par image, puis la médiane sur toute la séquence — jamais la moyenne', () => {
    // Une boîte par seconde sur 100 s, le regard cyclant sur cinq valeurs à
    // parts égales : la médiane tombe dans le bloc du milieu (0,07), très loin
    // de la moyenne (0,118).
    const highs = [0.05, 0.06, 0.07, 0.2, 0.21]
    const people: PersonBox[] = []
    for (let t = 0; t <= 99; t++) {
      const eyeY = highs[t % highs.length]
      const k = poseK({ leftEye: { y: eyeY, score: 0.9 }, rightEye: { y: eyeY, score: 0.9 } })
      people.push(box(t, INSIDE, 1, k))
    }
    const runs = detectDubbingRuns(people, {})
    expect(runs).toHaveLength(1)
    expect(runs[0].eyeLevel).toBeCloseTo(0.07, 9)
  })

  it('un comédien du film hors du disque ne déplace jamais le regard mesuré', () => {
    const insideK = poseK({ leftEye: { y: 0.1, score: 0.9 }, rightEye: { y: 0.1, score: 0.9 } })
    const outsideK = poseK({ leftEye: { y: 0.9, score: 0.9 }, rightEye: { y: 0.9, score: 0.9 } })
    const people: PersonBox[] = []
    for (let t = 0; t <= 40; t++) {
      people.push(box(t, INSIDE, 1, insideK))
      people.push(box(t, OUTSIDE, 1, outsideK))
    }
    const runs = detectDubbingRuns(people, {})
    expect(runs).toHaveLength(1)
    expect(runs[0].eyeLevel).toBeCloseTo(0.1, 9)
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
