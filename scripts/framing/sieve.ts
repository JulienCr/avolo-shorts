/**
 * Le tamis (issue #191 lot 5) : trouve des plans qui méritent un œil, sur
 * `ShotSample[]` pur — aucun accès disque ici, `sweepCorpus` s'en charge en
 * amont. Deux familles, parce que ni l'une ni l'autre ne dépend d'une règle
 * candidate à comparer : les extrémités d'une distribution, et le voisinage
 * d'un seuil. La troisième famille qui compterait le plus — deux règles en
 * désaccord — attend #190 et ses règles, et n'a pas sa place ici.
 *
 * **Trois mécanismes de déterminisme, chacun pour une fuite différente** :
 * un ordre total indépendant du système de fichiers, un choix à l'intérieur
 * d'un panier par hachage par élément (jamais un PRNG, qui reméla­ngerait
 * tout au sixième spectacle ajouté), et une graine par défaut fixe.
 */

import { createHash } from 'node:crypto'

import type { Shot } from '@/core/shots'
import { shotStartMs } from '@/core/shots'
import { PROJECTS, type ProjectId } from './cases'
import type { ShotSample, PersonFrame } from './corpus'
import type { ShotMetric } from './metrics'

export type Family =
  | { kind: 'extremes'; n: number; spread: boolean }
  | { kind: 'around'; threshold: number; width: number; n: number }

export type SievePick = {
  /** La même forme que `caseId`, pour qu'un pick se greffe sur le registre. */
  id: string
  project: ProjectId
  shot: Shot
  instants: readonly number[]
  metric: string
  value: number
  side: 'low' | 'high' | 'below' | 'above'
  rank: number
}

const PROJECT_TO_SHOW = new Map<ProjectId, string>(
  Object.entries(PROJECTS).map(([show, id]) => [id, show]),
)

type Scored = { sample: ShotSample; value: number }

/** L'ordre total, indépendant de `readdirSync` : valeur, puis projet, puis clé de plan. */
function totalOrder(a: Scored, b: Scored): number {
  return (
    a.value - b.value ||
    a.sample.project.localeCompare(b.sample.project) ||
    shotStartMs(a.sample.shot.shot) - shotStartMs(b.sample.shot.shot)
  )
}

/**
 * Le rang par hachage d'un plan, en hexadécimal — comparable lexicographiquement
 * comme un nombre puisque `sha256` rend une longueur fixe. Jamais un PRNG qui
 * marche la liste : celui-là remélangerait tout au sixième spectacle ajouté.
 */
function hashRank(seed: string, sample: ShotSample): string {
  return createHash('sha256')
    .update(`${seed}|${sample.project}|${shotStartMs(sample.shot.shot)}`)
    .digest('hex')
}

/** L'image la plus proche de la valeur d'agrégat, celle que le pick doit montrer. */
function pickInstants(metric: ShotMetric, sample: ShotSample, value: number): number[] {
  let best: PersonFrame | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const f of sample.frames) {
    const perFrame = metric.perFrame(f, sample)
    if (perFrame === null) continue
    const distance = Math.abs(perFrame - value)
    if (distance < bestDistance) {
      bestDistance = distance
      best = f
    }
  }
  return best === undefined ? [] : [best.t]
}

function makePick(
  metric: ShotMetric,
  entry: Scored,
  side: SievePick['side'],
  rank: number,
): SievePick {
  const instants = pickInstants(metric, entry.sample, entry.value)
  const anchor = instants[0] ?? entry.sample.shot.shot.start
  const show = PROJECT_TO_SHOW.get(entry.sample.project)
  const id = `${show ?? entry.sample.project}-${Math.round(anchor * 1000)}`
  return {
    id,
    project: entry.sample.project,
    shot: entry.sample.shot.shot,
    instants,
    metric: metric.name,
    value: entry.value,
    side,
    rank,
  }
}

/** Prend les `n` plus petits par hachage, puis remet le lot dans l'ordre total pour l'affichage. */
function hashSelect(candidates: readonly Scored[], n: number, seed: string): Scored[] {
  return [...candidates]
    .sort((a, b) => {
      const ha = hashRank(seed, a.sample)
      const hb = hashRank(seed, b.sample)
      return ha < hb ? -1 : ha > hb ? 1 : 0
    })
    .slice(0, Math.max(0, n))
    .sort(totalOrder)
}

/**
 * Un côté de la famille `extremes`, en mode « spread » : la décile est
 * partagée en `n` tranches contiguës aussi égales que possible, et une
 * pioche par tranche — au hachage, jamais au rang littéral, sinon un
 * cinquième plan ajouté à la tranche déplacerait la pioche des voisines.
 *
 * Une tranche vide (plus de tranches que de plans dans la décile) ne rend
 * rien : mieux vaut moins de picks que le même plan compté deux fois.
 */
function spreadSide(decile: readonly Scored[], n: number, seed: string): Scored[] {
  if (n <= 0 || decile.length === 0) return []
  const picks: Scored[] = []
  for (let i = 0; i < n; i += 1) {
    const start = Math.floor((i * decile.length) / n)
    const end = Math.floor(((i + 1) * decile.length) / n)
    const bucket = decile.slice(start, end)
    if (bucket.length === 0) continue
    let chosen = bucket[0]
    let chosenHash = hashRank(seed, chosen.sample)
    for (const candidate of bucket.slice(1)) {
      const h = hashRank(seed, candidate.sample)
      if (h < chosenHash) {
        chosen = candidate
        chosenHash = h
      }
    }
    picks.push(chosen)
  }
  return picks
}

function extremesPicks(
  metric: ShotMetric,
  sorted: readonly Scored[],
  family: Extract<Family, { kind: 'extremes' }>,
  seed: string,
): SievePick[] {
  // Le bas prend la moitié inférieure de `n`, le haut le reste : sur un `n`
  // impair, le côté haut gagne l'unité en trop — un choix arbitraire, mais
  // stable d'un appel à l'autre.
  const low = Math.floor(family.n / 2)
  const high = family.n - low
  const decileLen = Math.max(1, Math.ceil(sorted.length * 0.1))
  const lowDecile = sorted.slice(0, decileLen)
  // Un corpus plus petit que les deux déciles demandées fait chevaucher les
  // tranches : sans exclure ce que le bas a déjà pris, le même plan se
  // choisirait des deux côtés (relevé par copilot-pull-request-reviewer sur
  // la #192).
  const lowSet = new Set(lowDecile)
  const highDecile = sorted.slice(Math.max(0, sorted.length - decileLen)).filter((e) => !lowSet.has(e))

  let lowPicked: Scored[]
  let highPicked: Scored[]
  if (family.spread) {
    lowPicked = spreadSide(lowDecile, low, seed)
    highPicked = spreadSide(highDecile, high, seed)
  } else {
    // `--brut` : littéralement les plus bas / plus hauts de l'ordre total,
    // sans passer par la décile ni le hachage — c'est le point de la
    // pathologie qu'on demande de voir.
    lowPicked = sorted.slice(0, low)
    highPicked = sorted.slice(Math.max(0, sorted.length - high))
  }

  return [
    ...lowPicked.map((e, i) => makePick(metric, e, 'low', i + 1)),
    ...highPicked.map((e, i) => makePick(metric, e, 'high', i + 1)),
  ]
}

function aroundPicks(
  metric: ShotMetric,
  sorted: readonly Scored[],
  family: Extract<Family, { kind: 'around' }>,
  seed: string,
): SievePick[] {
  // Bande inclusive des deux côtés : un fencepost ici change quels plans
  // répondent à la question pente-ou-falaise.
  const lo = family.threshold - family.width
  const hi = family.threshold + family.width
  const inBand = sorted.filter((e) => e.value >= lo && e.value <= hi)
  const below = inBand.filter((e) => e.value < family.threshold)
  const above = inBand.filter((e) => e.value >= family.threshold)

  // Équilibré entre les deux côtés, plutôt que le côté le plus dense : sinon
  // la planche ne montrerait que d'un côté du seuil.
  let wantBelow = Math.min(Math.ceil(family.n / 2), below.length)
  let wantAbove = Math.min(family.n - wantBelow, above.length)
  const shortfall = family.n - wantBelow - wantAbove
  if (shortfall > 0) {
    wantBelow = Math.min(wantBelow + shortfall, below.length)
    wantAbove = Math.min(family.n - wantBelow, above.length)
  }

  const belowPicked = hashSelect(below, wantBelow, seed)
  const abovePicked = hashSelect(above, wantAbove, seed)

  return [
    ...belowPicked.map((e, i) => makePick(metric, e, 'below', i + 1)),
    ...abovePicked.map((e, i) => makePick(metric, e, 'above', i + 1)),
  ]
}

/**
 * Fait passer le corpus au tamis pour une métrique et une famille données.
 *
 * `NaN` et `Infinity` sont refusés — comptés avec les `null` dans
 * `undefinedCount`, jamais triés : les deux disent « cette métrique ne
 * définit rien ici », et la distribution ne doit connaître ni l'un ni
 * l'autre.
 */
export function sieve(
  samples: readonly ShotSample[],
  metric: ShotMetric,
  family: Family,
  seed: string,
): { picks: SievePick[]; total: number; defined: number; undefinedCount: number } {
  const scored: Scored[] = []
  let undefinedCount = 0
  for (const sample of samples) {
    const value = metric.of(sample)
    if (value === null || !Number.isFinite(value)) {
      undefinedCount += 1
      continue
    }
    scored.push({ sample, value })
  }

  const sorted = [...scored].sort(totalOrder)

  const picks =
    family.kind === 'extremes'
      ? extremesPicks(metric, sorted, family, seed)
      : aroundPicks(metric, sorted, family, seed)

  return { picks, total: samples.length, defined: scored.length, undefinedCount }
}
