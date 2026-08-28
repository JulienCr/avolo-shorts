/**
 * La séquence de doublage improvisé : géométrie mesurée et détecteur.
 *
 * Composition OBS, pas un plan de caméra — un film plein cadre, un PiP
 * circulaire fixe en haut à droite qui montre les deux comédiens, une bande
 * synchro pleine largeur en bas. Ce module ne fait que reconnaître la séquence
 * et poser sa géométrie ; rien ici ne rend, rien ne consomme encore ce qui en
 * sort (PR2).
 *
 * **Aucun couplage d'exécution avec `framing.ts`.** `isForeground` est
 * inatteignable sur une boîte contenue dans le disque (elle exige `y1 >= 0,97`,
 * le disque plafonne `y1` à 0,42), et `afterSizeFloor` serait activement faux :
 * les comédiens du disque font environ 0,35 de la hauteur de l'image contre
 * 0,9 pour un acteur du film, donc le plancher de taille (0,5) les jetterait
 * précisément quand le film montre quelqu'un. `Cell` reste un import de type
 * seul.
 */

import type { Cell } from '@/core/framing'
import { POINT, POINT_COUNT } from '@/core/shots'
import type { PersonBox } from '@/core/shots'

/** Les trois pavés d'une composition de doublage, en fractions de la source. */
export type DubbingCells = { film: Cell; pip: Cell; strip: Cell }

/** Une géométrie d'habillage observée, mesurée sur le corpus. */
export type DubbingAnchor = {
  /** Identifiant stable, p. ex. 'top-right-2026'. */
  id: string
  /** La boîte englobante du disque des comédiens, mesure exacte, sans marge. */
  pip: Cell
  /** La bande synchro, pleine largeur, ancrée en bas. */
  strip: Cell
}

/**
 * Le seul habillage mesuré à ce jour (amendement A1 du contrat) : disque en
 * haut à droite, centre ~(0,881 ; 0,215), rayon ~0,108 de la largeur. Ajusté
 * sur huit images couvrant les trois séquences d'`entre-nous` et celle de
 * `caro-mdlm` ; les deux émissions s'accordent à moins de 1 %.
 *
 * Un habillage top-left resterait à ajouter si `2025-12-07-doublage.mp4` est
 * un jour ingéré (hors périmètre ici) — c'est pour ça que c'est une liste.
 */
export const DUBBING_ANCHORS: readonly DubbingAnchor[] = [
  {
    id: 'top-right-2026',
    pip: { x0: 0.773, y0: 0.022, x1: 0.988, y1: 0.411 },
    // Bande à deux pistes, la plus haute des deux mesurées (voir le corps de
    // la PR) : un doublage à une seule piste active laisse donc un peu de film
    // visible en haut du pavé, plutôt que de rogner une piste sur deux.
    strip: { x0: 0, y0: 0.9, x1: 1, y1: 1 },
  },
]

/**
 * La part de la largeur que le pavé film conserve. 1 = pleine largeur.
 * PR3 est autorisée à changer cette seule ligne selon le verdict du spike.
 */
export const DUBBING_FILM_WIDTH = 1

/**
 * La hauteur du bandeau comédiens, en fraction de la hauteur du disque.
 * 0,476 = le serrage « têtes + épaules » retenu sur maquette (200 px sur 420).
 */
export const DUBBING_PIP_BAND_HEIGHT = 0.476

/**
 * Les trois pavés déduits d'une ancre et du regard le plus haut mesuré sur la
 * séquence (amendement A7, corrigé par l'amendement 3 du contrat). Le bandeau
 * comédiens est **placé**, pas recadré à une fraction fixe : son bord haut
 * vaut `eyeLevel - hauteur/3`, glissé — jamais réduit — pour rester dans le
 * disque. Il prend **toute la largeur du disque**, jamais une corde inscrite :
 * `args.ts` masque ses coins par l'arc du cercle, ce que le viewer voyait déjà
 * dans le flux d'origine.
 */
export function dubbingCellsFor(anchor: DubbingAnchor, eyeLevel: number): DubbingCells {
  const { pip } = anchor
  const ry = (pip.y1 - pip.y0) / 2

  const height = DUBBING_PIP_BAND_HEIGHT * ry * 2
  let top = eyeLevel - height / 3
  let bottom = top + height
  if (top < pip.y0) {
    bottom += pip.y0 - top
    top = pip.y0
  }
  if (bottom > pip.y1) {
    top -= bottom - pip.y1
    bottom = pip.y1
  }

  return {
    film: { x0: 0, y0: 0, x1: DUBBING_FILM_WIDTH, y1: 1 },
    pip: { x0: pip.x0, x1: pip.x1, y0: top, y1: bottom },
    strip: anchor.strip,
  }
}

/**
 * Ce qui règle `detectDubbingRuns`. Chaque seuil a un défaut mesuré — voir
 * `DUBBING_DEFAULTS` et le corps de la PR pour ce qu'il coûte.
 */
export type DubbingOptions = {
  /** Le score minimal pour qu'une boîte compte dans le vote. */
  minScore?: number
  /**
   * La marge ajoutée à `anchor.pip` pour le seul test de confinement, en
   * fraction de la source. `0` par défaut (amendement A3) : `anchor.pip` sert
   * aussi à la composition, et une marge y dessinerait un liseré de film
   * visible autour d'un PiP découpé en cercle.
   */
  containmentTolerance?: number
  /**
   * La largeur de la fenêtre glissante, en secondes réelles, centrée sur
   * chaque instant — pas un nombre d'images, pour que les instants manquants
   * dégradent la part plutôt que la fausser.
   */
  windowSeconds?: number
  /** La part d'images votantes à partir de laquelle la fenêtre est « dedans ». */
  minVoteShare?: number
  /**
   * Le temps que la part doit tenir au-dessus du seuil avant qu'une séquence
   * démarre. Réglé au-dessus des ~25 s de faux positifs connus : c'est ce qui
   * les sépare des séquences réelles (4 à 7 min) sans heuristique dédiée.
   */
  onDelaySeconds?: number
  /**
   * Le temps que la part doit tenir en dessous du seuil avant qu'une séquence
   * se termine. Généreux exprès : les comédiens sortent du champ du disque
   * sans que le doublage s'arrête.
   */
  offDelaySeconds?: number
  /**
   * La confiance minimale d'un point de pose (yeux, nez) pour compter dans le
   * calcul du regard le plus haut — même défaut que `torsoMinScore` dans
   * `framing.ts`, mesuré sur le même détecteur de pose.
   */
  pointMinScore?: number
}

/**
 * Les défauts de `DubbingOptions`, mesurés sur le corpus par
 * `scripts/measure-dubbing.ts` — voir le corps de la PR pour le détail.
 */
export const DUBBING_DEFAULTS: Readonly<Required<DubbingOptions>> = Object.freeze({
  minScore: 0.5,
  containmentTolerance: 0,
  windowSeconds: 10,
  minVoteShare: 0.2,
  onDelaySeconds: 30,
  offDelaySeconds: 45,
  pointMinScore: 0.5,
})

/** Un réglage, ou son défaut — `??` laisserait passer un `NaN`. */
function setting(value: number | undefined, defaultValue: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue
}

export type DubbingRun = {
  start: number
  end: number
  anchor: DubbingAnchor
  /**
   * Le regard le plus haut du cercle, fraction de hauteur source, médiane sur
   * la séquence. La composition y pose le tiers supérieur de son bandeau.
   */
  eyeLevel: number
}

/**
 * Le regard d'une boîte : les deux yeux si confiants, sinon le nez, sinon le
 * haut de la boîte. Même doctrine que `eyeLevelOf` dans `src/core/framing.ts`
 * (priorités du split-écran) — réimplémentée ici pour l'amendement A2 (zéro
 * import de valeur depuis `framing.ts`) ; les deux copies doivent évoluer
 * ensemble si la doctrine change.
 */
function eyeLevelOf(box: PersonBox, threshold: number): number {
  const k = box.k
  if (k !== undefined && k.length === POINT_COUNT * 3) {
    const leftY = k[POINT.LEFT_EYE * 3 + 1]
    const leftScore = k[POINT.LEFT_EYE * 3 + 2]
    const rightY = k[POINT.RIGHT_EYE * 3 + 1]
    const rightScore = k[POINT.RIGHT_EYE * 3 + 2]
    if (Number.isFinite(leftY) && Number.isFinite(rightY) && leftScore >= threshold && rightScore >= threshold) {
      return (leftY + rightY) / 2
    }
    const noseY = k[POINT.NOSE * 3 + 1]
    const noseScore = k[POINT.NOSE * 3 + 2]
    if (Number.isFinite(noseY) && noseScore >= threshold) return noseY
  }
  return box.y0
}

/** La médiane d'un tableau déjà trié — même convention que `framing.ts`. */
function median(sorted: readonly number[]): number {
  const m = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

/** Une géométrie exploitable, dupliquée à dessein — voir le docblock du module. */
function hasFiniteGeometry(box: Pick<PersonBox, 'x0' | 'x1' | 'y0' | 'y1'>): boolean {
  return (
    Number.isFinite(box.x0) &&
    Number.isFinite(box.x1) &&
    Number.isFinite(box.y0) &&
    Number.isFinite(box.y1) &&
    box.x1 > box.x0 &&
    box.y1 > box.y0
  )
}

/** `box` entièrement dans `cell`, élargie de `tolerance` de chaque côté. */
function fullyContained(box: Pick<PersonBox, 'x0' | 'x1' | 'y0' | 'y1'>, cell: Cell, tolerance: number): boolean {
  return (
    box.x0 >= cell.x0 - tolerance &&
    box.x1 <= cell.x1 + tolerance &&
    box.y0 >= cell.y0 - tolerance &&
    box.y1 <= cell.y1 + tolerance
  )
}

/**
 * Les boîtes votantes d'une image pour une ancre : entièrement dans le
 * disque. Score et géométrie seuls décident — aucune heuristique de taille
 * au-delà du confinement (amendement A4/A2) : `isForeground` et le plancher de
 * taille de `framing.ts` sont hors de propos ici, voir le docblock du module.
 * Rend la liste, pas un booléen : le regard le plus haut (A7) en a besoin.
 */
function votingBoxesOf(
  boxes: readonly PersonBox[],
  anchor: DubbingAnchor,
  options: Required<DubbingOptions>,
): PersonBox[] {
  return boxes.filter(
    (b) =>
      // `b.score >= seuil`, jamais `<` : un score `NaN` doit être exclu, pas retenu.
      b.score >= options.minScore &&
      hasFiniteGeometry(b) &&
      fullyContained(b, anchor.pip, options.containmentTolerance),
  )
}

type Instant = { t: number; boxes: readonly PersonBox[] }

/**
 * Le calendrier global : l'ensemble trié des instants distincts de `people`,
 * indépendant de toute ancre (amendement A4). Les clés sont arrondies à la
 * milliseconde, comme `shotStartMs` : deux écritures du même instant flottant
 * ne doivent pas s'y voir comme deux images.
 */
function timelineOf(people: readonly PersonBox[]): Instant[] {
  const byKey = new Map<number, { t: number; boxes: PersonBox[] }>()
  for (const b of people) {
    if (!Number.isFinite(b.t)) continue
    const key = Math.round(b.t * 1000)
    const entry = byKey.get(key)
    if (entry) entry.boxes.push(b)
    else byKey.set(key, { t: b.t, boxes: [b] })
  }
  return [...byKey.values()].sort((a, b) => a.t - b.t)
}

/**
 * La part d'images votantes sur une fenêtre glissante centrée sur chaque
 * instant, en une passe à deux curseurs — le calendrier est trié et la
 * fenêtre a une largeur constante, donc ses deux bornes n'avancent jamais en
 * arrière quand `t` grandit.
 */
function shareSeries(timeline: readonly Instant[], votesAt: readonly boolean[], windowSeconds: number): number[] {
  const half = Math.max(0, windowSeconds) / 2
  const shares = new Array<number>(timeline.length).fill(0)
  let lo = 0
  let hi = 0
  let hits = 0
  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i].t
    while (lo < timeline.length && timeline[lo].t < t - half) {
      if (votesAt[lo]) hits -= 1
      lo += 1
    }
    while (hi < timeline.length && timeline[hi].t <= t + half) {
      if (votesAt[hi]) hits += 1
      hi += 1
    }
    const total = hi - lo
    shares[i] = total === 0 ? 0 : hits / total
  }
  return shares
}

/**
 * L'hystérésis : une séquence démarre au vrai franchissement, confirmé
 * `onDelaySeconds` plus tard, et se termine symétriquement. Une séquence
 * encore active à la dernière image se referme sur elle, plutôt que de
 * disparaître sans borne de fin.
 */
function hysteresis(
  timeline: readonly Instant[],
  shares: readonly number[],
  minVoteShare: number,
  onDelaySeconds: number,
  offDelaySeconds: number,
): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = []
  let active = false
  let aboveSince: number | null = null
  let belowSince: number | null = null
  let runStart = 0

  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i].t
    const above = shares[i] >= minVoteShare
    if (!active) {
      if (above) {
        aboveSince ??= t
        if (t - aboveSince >= onDelaySeconds) {
          active = true
          runStart = aboveSince
          belowSince = null
        }
      } else {
        aboveSince = null
      }
    } else {
      if (!above) {
        belowSince ??= t
        if (t - belowSince >= offDelaySeconds) {
          runs.push({ start: runStart, end: belowSince })
          active = false
          aboveSince = null
          belowSince = null
        }
      } else {
        belowSince = null
      }
    }
  }
  if (active) {
    runs.push({ start: runStart, end: timeline[timeline.length - 1].t })
  }
  return runs
}

/**
 * Le regard le plus haut du cercle à chaque image votante de la séquence,
 * médiane sur l'ensemble — jamais par image, car le bandeau est fixe pour
 * toute la séquence (même doctrine que la médiane du split-écran). Une boîte
 * hors du disque ne peut jamais y contribuer : seules les boîtes votantes
 * entrent dans `perFrame`. `fallback` ne sert qu'en dernier recours théorique
 * (aucune image votante dans l'intervalle), qui ne se produit pas en pratique
 * puisque l'hystérésis n'ouvre une séquence qu'où le vote est déjà là.
 */
function eyeLevelForRun(
  timeline: readonly Instant[],
  votingByInstant: readonly (readonly PersonBox[])[],
  run: { start: number; end: number },
  pointMinScore: number,
  fallback: number,
): number {
  const perFrame: number[] = []
  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i].t
    if (t < run.start || t > run.end) continue
    const voting = votingByInstant[i]
    if (voting.length === 0) continue
    perFrame.push(Math.min(...voting.map((b) => eyeLevelOf(b, pointMinScore))))
  }
  if (perFrame.length === 0) return fallback
  perFrame.sort((a, b) => a - b)
  return median(perFrame)
}

/**
 * Les séquences de doublage détectées, une ancre à la fois puis concaténées
 * (amendement A4). Prend la liste **complète** des boîtes, jamais filtrée aux
 * segments d'un clip : l'extent d'une séquence est une propriété de
 * l'émission, pas du clip qui la traverse.
 */
export function detectDubbingRuns(
  people: readonly PersonBox[],
  options: DubbingOptions = {},
): DubbingRun[] {
  const opts: Required<DubbingOptions> = {
    minScore: Math.max(0, setting(options.minScore, DUBBING_DEFAULTS.minScore)),
    containmentTolerance: Math.max(0, setting(options.containmentTolerance, DUBBING_DEFAULTS.containmentTolerance)),
    windowSeconds: Math.max(0, setting(options.windowSeconds, DUBBING_DEFAULTS.windowSeconds)),
    minVoteShare: Math.max(0, setting(options.minVoteShare, DUBBING_DEFAULTS.minVoteShare)),
    onDelaySeconds: Math.max(0, setting(options.onDelaySeconds, DUBBING_DEFAULTS.onDelaySeconds)),
    offDelaySeconds: Math.max(0, setting(options.offDelaySeconds, DUBBING_DEFAULTS.offDelaySeconds)),
    pointMinScore: Math.max(0, setting(options.pointMinScore, DUBBING_DEFAULTS.pointMinScore)),
  }

  const timeline = timelineOf(people)
  if (timeline.length === 0) return []

  const runs: DubbingRun[] = []
  for (const anchor of DUBBING_ANCHORS) {
    const votingByInstant = timeline.map(({ boxes }) => votingBoxesOf(boxes, anchor, opts))
    const votesAt = votingByInstant.map((v) => v.length > 0)
    const shares = shareSeries(timeline, votesAt, opts.windowSeconds)
    const rawRuns = hysteresis(timeline, shares, opts.minVoteShare, opts.onDelaySeconds, opts.offDelaySeconds)
    const fallbackEyeLevel = (anchor.pip.y0 + anchor.pip.y1) / 2
    for (const r of rawRuns) {
      const eyeLevel = eyeLevelForRun(timeline, votingByInstant, r, opts.pointMinScore, fallbackEyeLevel)
      runs.push({ ...r, anchor, eyeLevel })
    }
  }
  return runs.sort((a, b) => a.start - b.start)
}
