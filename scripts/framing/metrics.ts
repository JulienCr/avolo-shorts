/**
 * Huit instruments de mesure sur un `ShotSample` (issue #191 lot 5, § « Le
 * tamis » ; `head-absence-worst` et `head-containment-worst` ajoutés par
 * #190). **Descriptifs, jamais des règles candidates** — c'est l'arbitrage de
 * l'issue : #191 livre le tamis, #190 apporte les mailles.
 *
 * `null` n'est pas 0 : une métrique qui ne se définit pas sur un plan (pas de
 * paire, pas de squelette) doit **sortir de la distribution**, pas en
 * occuper une extrémité. `sieve.ts` s'appuie là-dessus pour compter
 * `undefinedCount` séparément des picks.
 */

import {
  computeShotHeadInstrument,
  computeShotSplit,
  FRAMING_DEFAULTS,
  type FrameHeadStats,
  hasValidGeometry,
  headBounds,
  isForeground,
  orientationOf,
  requiredWidths,
  retainedCountByFrame,
  type FramingOptions,
} from '@/core/framing'
import type { PersonBox } from '@/core/shots'
import type { PersonFrame, ShotSample } from './corpus'

export type ShotMetric = {
  name: string
  /** Ce qu'elle mesure, en une phrase, imprimée en tête de sortie. */
  what: string
  unit: string
  /** La valeur du plan, ou `null` quand elle NE SE DÉFINIT PAS. */
  of: (s: ShotSample) => number | null
  /** La valeur d'une image, pour choisir quel instant rendre. */
  perFrame: (f: PersonFrame, s: ShotSample) => number | null
}

/** La médiane au sens strict : le milieu des deux valeurs centrales sur un compte pair. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const m = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

function flatten(s: ShotSample): PersonBox[] {
  return s.frames.flatMap((f) => f.boxes)
}

/**
 * Les boîtes qu'`isForeground`/le plancher de taille retiendraient dans cette
 * image, rejouées à partir des primitives exportées de `@/core/framing` —
 * jamais depuis `k` directement. `retainedCountByFrame` fait ce calcul pour
 * tout un plan mais ne le rend pas image par image ; c'est ce que `perFrame`
 * exige.
 */
function retainedInFrame(f: PersonFrame, options: FramingOptions): PersonBox[] {
  const threshold = options.minScore ?? FRAMING_DEFAULTS.minScore
  const survivors = f.boxes.filter(
    (b) => hasValidGeometry(b) && b.score >= threshold && !isForeground(b, options),
  )
  if (survivors.length === 0) return []
  const floor = Math.min(1, Math.max(0, options.sizeFloor ?? FRAMING_DEFAULTS.sizeFloor))
  const tallest = Math.max(...survivors.map((b) => b.y1 - b.y0))
  return survivors.filter((b) => b.y1 - b.y0 >= floor * tallest)
}

function headHeightsOf(boxes: readonly PersonBox[]): number[] {
  const heights: number[] = []
  for (const b of boxes) {
    const hb = headBounds(b)
    if (hb === null) continue
    const h = hb.y1 - hb.y0
    if (Number.isFinite(h) && h > 0) heights.push(h)
  }
  return heights
}

/** Le split que `computeShotSplit` calculerait pour ce plan, avec le ratio qu'il a réellement reçu. */
function splitOf(s: ShotSample): ReturnType<typeof computeShotSplit> {
  return computeShotSplit(
    flatten(s),
    s.shot.shot,
    s.shot.ratio,
    s.srcW,
    s.srcH,
    FRAMING_DEFAULTS,
    [s.shot.shot],
  )
}

/** Le minimum de frontalité des deux personnes d'une image à deux, ou `null` (pas deux, ou l'une `'unknown'`). */
function pairMinFrontality(f: PersonFrame): number | null {
  const retained = retainedInFrame(f, FRAMING_DEFAULTS)
  if (retained.length !== 2) return null
  const [a, b] = retained
  const fa = orientationOf(a).frontality
  const fb = orientationOf(b).frontality
  if (fa === null || fb === null) return null
  return Math.min(fa, fb)
}

/**
 * L'instrument de tête (#190) que `computeShotSplit` calculerait pour ce plan —
 * même appariement, mêmes cellules, jamais une seconde dérivation.
 */
function headInstrumentOf(s: ShotSample): ReturnType<typeof computeShotHeadInstrument> {
  return computeShotHeadInstrument(
    flatten(s),
    s.shot.shot,
    s.shot.ratio,
    s.srcW,
    s.srcH,
    FRAMING_DEFAULTS,
    [s.shot.shot],
  )
}

/**
 * L'entrée de `headInstrumentOf(s).perFrame` pour l'instant de `f` — jamais
 * redérivée depuis la proximité d'une cellule. C'était le bug du checkpoint
 * du 27 août : assigner chaque boîte à sa cellule la plus proche n'est pas
 * bijectif, et sur une image où les deux personnes se rapprochent, les deux
 * peuvent tomber du même côté pendant que l'autre cellule n'a personne.
 * `computeShotHeadInstrument` porte l'appariement réel — trié par centre à
 * l'intérieur de l'image, jamais comparé à un rectangle fixe — donc le lire
 * ici ne peut pas reproduire ce défaut.
 */
function frameHeadStatsAt(f: PersonFrame, s: ShotSample): FrameHeadStats | undefined {
  const frames = headInstrumentOf(s).perFrame
  return frames?.find((entry) => entry.t === f.t)
}

/** Le pire (le plus haut) des deux indicateurs d'absence de tête, sur une image appariée. */
function perFrameHeadAbsenceWorst(f: PersonFrame, s: ShotSample): number | null {
  const entry = frameHeadStatsAt(f, s)
  if (entry === undefined) return null
  return Math.max(entry.top.absent ? 1 : 0, entry.bottom.absent ? 1 : 0)
}

/**
 * La pire (la plus basse) des deux valeurs de containment, sur une image
 * appariée — `null` dès qu'une des deux ne se définit pas, pour la même
 * raison que l'agrégat `head-containment-worst` : une cellule dégénérée ne
 * doit jamais se faire remplacer par l'autre, qui pourrait être bonne.
 */
function perFrameHeadContainmentWorst(f: PersonFrame, s: ShotSample): number | null {
  const entry = frameHeadStatsAt(f, s)
  if (entry === undefined) return null
  const { top, bottom } = entry
  return top.containment === null || bottom.containment === null
    ? null
    : Math.min(top.containment, bottom.containment)
}

export const METRICS = {
  'shot-duration': {
    name: 'shot-duration',
    what: 'la durée du plan',
    unit: 's',
    of: (s) => s.shot.shot.end - s.shot.shot.start,
    // Constante sur tout le plan : n'importe quelle image la décrit aussi
    // bien, donc la première par ordre temporel.
    perFrame: (_f, s) => s.shot.shot.end - s.shot.shot.start,
  },
  'people-median': {
    name: 'people-median',
    what: "médiane du nombre de personnes retenues par image",
    unit: 'personnes',
    // La grille complète, zéros compris : sans elle, une image où le
    // détecteur n'a personne retenu disparaît au lieu de compter pour zéro,
    // ce qui biaise précisément les extrémités que le tamis cherche — la
    // même leçon que #187 (relevé par copilot-pull-request-reviewer sur la
    // #192).
    of: (s) => {
      const counts = retainedCountByFrame(flatten(s), { ...FRAMING_DEFAULTS, fps: s.analysisFps }, [
        { start: s.shot.shot.start, end: s.shot.shot.end },
      ])
      return median(counts)
    },
    perFrame: (f) => retainedInFrame(f, FRAMING_DEFAULTS).length,
  },
  'split-bleed': {
    name: 'split-bleed',
    what: "le débordement du split dans la boîte de l'autre personne",
    unit: 'fraction de largeur',
    of: (s) => splitOf(s).bleed,
    // `worstBleedAt` est l'image qui porte `bleed` : les autres valent 0,
    // donc la recherche « au plus proche de l'agrégat » (`sieve.ts`) retombe
    // dessus sans avoir à la redésigner ici.
    perFrame: (f, s) => {
      const result = splitOf(s)
      if (result.bleed === null || result.worstBleedAt === null) return null
      return f.t === result.worstBleedAt ? result.bleed : 0
    },
  },
  'required-width': {
    name: 'required-width',
    what: 'la plus grande largeur exigée sur le plan',
    unit: 'fraction de largeur',
    of: (s) => {
      const widths = requiredWidths(flatten(s), FRAMING_DEFAULTS)
      return widths.length === 0 ? null : Math.max(...widths)
    },
    perFrame: (f) => {
      const widths = requiredWidths([...f.boxes], FRAMING_DEFAULTS)
      return widths.length === 0 ? null : Math.max(...widths)
    },
  },
  'head-height': {
    name: 'head-height',
    what: 'médiane de la hauteur de tête',
    unit: 'fraction de hauteur',
    of: (s) => median(headHeightsOf(flatten(s))),
    perFrame: (f) => median(headHeightsOf(f.boxes)),
  },
  'frontality-min-median': {
    name: 'frontality-min-median',
    what: 'médiane du minimum de frontalité des deux personnes, par image',
    unit: 'frontalité (0 à 1)',
    of: (s) => {
      const values = s.frames.map(pairMinFrontality).filter((v): v is number => v !== null)
      return median(values)
    },
    perFrame: (f) => pairMinFrontality(f),
  },
  'head-absence-worst': {
    name: 'head-absence-worst',
    what: "la pire part d'images sans tête, entre les deux cellules du split (#190)",
    unit: 'part (0 à 1)',
    of: (s) => {
      const cells = headInstrumentOf(s).cells
      if (cells === null) return null
      return Math.max(cells[0].headAbsenceShare, cells[1].headAbsenceShare)
    },
    perFrame: (f, s) => perFrameHeadAbsenceWorst(f, s),
  },
  'head-containment-worst': {
    name: 'head-containment-worst',
    what: 'la pire médiane de containment de tête, entre les deux cellules du split (#190)',
    unit: 'part (0 à 1)',
    of: (s) => {
      const cells = headInstrumentOf(s).cells
      if (cells === null) return null
      const [a, b] = cells
      // Une cellule dégénérée (`headContainmentMedian` null) rend le
      // « pire des deux » indéfini : la faire disparaître silencieusement
      // laisserait l'autre cellule répondre à sa place (checkpoint 26 août).
      if (a.headContainmentMedian === null || b.headContainmentMedian === null) return null
      return Math.min(a.headContainmentMedian, b.headContainmentMedian)
    },
    perFrame: (f, s) => perFrameHeadContainmentWorst(f, s),
  },
} as const satisfies Record<string, ShotMetric>

export type MetricName = keyof typeof METRICS
