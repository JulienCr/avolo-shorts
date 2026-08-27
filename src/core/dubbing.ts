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
 * Le pavé comédiens, en fractions du **disque** et non de l'image : la
 * composition ne garde que les visages, pas le disque entier. `{x0:0, y0:0,
 * x1:1, y1:1}` = le disque en entier. Une mesure d'un spike sœur remplacera
 * cette seule constante dans une PR ultérieure.
 */
export const DUBBING_PIP_BAND: Cell = { x0: 0, y0: 0, x1: 1, y1: 1 }

/**
 * `outer` en fractions de la source, `inner` en fractions de `outer` : la
 * position de `inner` dans la source. Exportée pour être éprouvée sur un
 * pavé quelconque, indépendamment de la valeur actuelle de
 * `DUBBING_PIP_BAND`, qui vaut l'identité tant que le spike n'a pas mesuré
 * le vrai pavé visages.
 */
export function mapCellInto(outer: Cell, inner: Cell): Cell {
  const w = outer.x1 - outer.x0
  const h = outer.y1 - outer.y0
  return {
    x0: outer.x0 + inner.x0 * w,
    x1: outer.x0 + inner.x1 * w,
    y0: outer.y0 + inner.y0 * h,
    y1: outer.y0 + inner.y1 * h,
  }
}

/**
 * Les trois pavés déduits d'une ancre. Pure, testable sans corpus.
 *
 * **`pip` n'est pas rendu tel quel** : `DUBBING_PIP_BAND` le recadre sur les
 * visages, `anchor.pip` restant la mesure exacte du disque (voir son
 * commentaire) — mélanger les deux rendrait l'une impossible à corriger sans
 * perturber l'autre.
 */
export function dubbingCellsFor(anchor: DubbingAnchor): DubbingCells {
  return {
    film: { x0: 0, y0: 0, x1: DUBBING_FILM_WIDTH, y1: 1 },
    pip: mapCellInto(anchor.pip, DUBBING_PIP_BAND),
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
})

/** Un réglage, ou son défaut — `??` laisserait passer un `NaN`. */
function setting(value: number | undefined, defaultValue: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue
}

export type DubbingRun = { start: number; end: number; anchor: DubbingAnchor }

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
 * Le vote d'une image pour une ancre : au moins une boîte retenue entièrement
 * dans le disque. Score et géométrie seuls décident — aucune heuristique de
 * taille au-delà du confinement (amendement A4/A2) : `isForeground` et le
 * plancher de taille de `framing.ts` sont hors de propos ici, voir le docblock
 * du module.
 */
function frameVotes(boxes: readonly PersonBox[], anchor: DubbingAnchor, options: Required<DubbingOptions>): boolean {
  return boxes.some(
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
    minScore: setting(options.minScore, DUBBING_DEFAULTS.minScore),
    containmentTolerance: Math.max(0, setting(options.containmentTolerance, DUBBING_DEFAULTS.containmentTolerance)),
    windowSeconds: Math.max(0, setting(options.windowSeconds, DUBBING_DEFAULTS.windowSeconds)),
    minVoteShare: setting(options.minVoteShare, DUBBING_DEFAULTS.minVoteShare),
    onDelaySeconds: Math.max(0, setting(options.onDelaySeconds, DUBBING_DEFAULTS.onDelaySeconds)),
    offDelaySeconds: Math.max(0, setting(options.offDelaySeconds, DUBBING_DEFAULTS.offDelaySeconds)),
  }

  const timeline = timelineOf(people)
  if (timeline.length === 0) return []

  const runs: DubbingRun[] = []
  for (const anchor of DUBBING_ANCHORS) {
    const votesAt = timeline.map(({ boxes }) => frameVotes(boxes, anchor, opts))
    const shares = shareSeries(timeline, votesAt, opts.windowSeconds)
    const rawRuns = hysteresis(timeline, shares, opts.minVoteShare, opts.onDelaySeconds, opts.offDelaySeconds)
    for (const r of rawRuns) runs.push({ ...r, anchor })
  }
  return runs.sort((a, b) => a.start - b.start)
}
