/**
 * Résout un `FramingCase` contre le disque : construit la requête de cadrage,
 * appelle le vrai chemin de rendu (`computeFraming`), et rapporte ce qui a
 * bougé depuis l'étiquetage.
 *
 * **L'intervalle enregistré est un témoin, jamais une clé.** `analysis.json`
 * est régénéré et gitignoré, `worker/detect.py` change sous nos pieds : la
 * sélection se fait toujours par instant, jamais en cherchant l'intervalle
 * enregistré dans l'analyse du jour.
 */

import fs from 'node:fs'
import {
  computeFraming,
  computeShotSplit,
  FRAMING_DEFAULTS,
  type ClipFraming,
  type FramingOptions,
  type FramingRequest,
  type ShotFraming,
  type SplitRejection,
} from '@/core/framing'
import type { Shot } from '@/core/shots'
import type { Ratio, Segment } from '@/core/edl'
import { analysisPath, projectDir } from '@/server/paths'
import { lireAnalysis, type Analysis } from '@/server/steps/analysis'
import { projectOf, type CaseBaseline, type CaseScope, type FramingCase, type ProjectId } from './cases'

/**
 * Les segments qu'un cas couvre, dans la source.
 *
 * `{ over: 'source' }` est **le seul foyer** de cet idiome — il existe
 * aujourd'hui en trois copies dans le worktree `../avolo-shorts-imageboard`.
 * `{ over: 'shot' }` a besoin du plan résolu du jour, passé par l'appelant :
 * `CaseScope` ne le porte pas lui-même, pour ne pas dupliquer ce que l'anchor
 * du cas et la résolution par instant savent déjà.
 */
export function segmentsForScope(scope: CaseScope, analysis: Analysis, shot?: Shot): Segment[] {
  switch (scope.over) {
    case 'source':
      return [{ start: 0, end: Math.max(...analysis.shots.map((s) => s.end), 0) }]
    case 'shot':
      if (shot === undefined) {
        throw new Error("scope 'shot' exige le plan résolu ; aucun n'a été passé.")
      }
      return [{ start: shot.start, end: shot.end }]
    case 'clip':
      // Résoudre un clip demande la base (`getClips`), hors de portée d'une
      // fonction qui ne lit qu'une analyse. C'est le travail du lot `ingest` ;
      // aucun des treize cas initiaux n'utilise ce scope.
      throw new Error(`scope 'clip' (${scope.clipId}) n'est pas résolu par segmentsForScope.`)
  }
}

function findShotByInstant(analysis: Analysis, instant: number): Shot | undefined {
  return analysis.shots.find((s) => s.start <= instant && instant < s.end)
}

/**
 * La requête de cadrage d'un cas donné, sur une analyse donnée.
 *
 * **`fps` vient toujours de `analysis.fps`**, jamais des options : c'est la
 * cadence d'échantillonnage qui a produit les boîtes de *cette* analyse, pas
 * un réglage qu'on voudrait balayer. Nommée `analysisFps` pour ne jamais se
 * confondre avec la cadence vidéo.
 */
export function caseFramingRequest(
  c: FramingCase,
  analysis: Analysis,
  options: Partial<FramingOptions> = {},
): FramingRequest {
  const shot = c.anchor.at === 'shot' ? findShotByInstant(analysis, c.anchor.instants[0]) : undefined
  const analysisFps = analysis.fps
  return {
    ...FRAMING_DEFAULTS,
    ...options,
    segments: segmentsForScope(c.scope, analysis, shot),
    shots: analysis.shots,
    people: analysis.boxes,
    srcW: analysis.source.w,
    srcH: analysis.source.h,
    fps: analysisFps,
    ratio: 'auto',
    cropMode: 'auto',
  }
}

/** La requête de cadrage sur la source entière — le cas `{ over: 'source' }` sans passer par un `FramingCase`. */
export function sourceFramingRequest(
  analysis: Analysis,
  options: Partial<FramingOptions> = {},
): FramingRequest {
  const analysisFps = analysis.fps
  return {
    ...FRAMING_DEFAULTS,
    ...options,
    segments: segmentsForScope({ over: 'source' }, analysis),
    shots: analysis.shots,
    people: analysis.boxes,
    srcW: analysis.source.w,
    srcH: analysis.source.h,
    fps: analysisFps,
    ratio: 'auto',
    cropMode: 'auto',
  }
}

/** Le plan d'un cadrage déjà calculé qui contient `t` — prédicat semi-ouvert, comme `computeFraming`. */
export function shotAt(framing: ClipFraming, t: number): ShotFraming | undefined {
  return framing.shots.find((s) => s.shot.start <= t && t < s.shot.end)
}

/** Ratio, split et raison de refus, tels que le code les produit aujourd'hui — comparables à un `CaseBaseline`. */
export type FramingSnapshot = { ratio: Ratio; split: boolean; rejection: SplitRejection | null }

/** Ce qui a bougé entre l'étiquetage d'un cas et l'analyse du jour. Un rapport, jamais une décision. */
export type CaseDrift =
  | { kind: 'shotMoved'; recorded: Shot; today: Shot }
  | { kind: 'shotGone'; recorded: Shot }
  | { kind: 'instantOutsideShot'; instant: number; shot: Shot }
  | { kind: 'nearBoundary'; instant: number; distance: number; frame: number }
  | { kind: 'framingChanged'; field: 'ratio'; baseline: Ratio; today: Ratio }
  | { kind: 'framingChanged'; field: 'split'; baseline: boolean; today: boolean }
  | { kind: 'framingChanged'; field: 'rejection'; baseline: SplitRejection | null; today: SplitRejection | null }

/**
 * Une observation, pas une dérive : un instant posé pile sur `shot.start` se
 * résout de façon déterministe par le prédicat semi-ouvert (`start <= t <
 * end`), il ne peut donc pas basculer comme le ferait un instant à quelques
 * dizaines de ms d'une frontière. Le confondre avec `nearBoundary` noierait
 * les deux cas qui éprouvent vraiment le décalage d'horloge (`cqlp-2138000`,
 * `caro-mdlm-652500`) sous huit alertes permanentes — mesuré : 8 des 13 cas
 * ancrent leur instant sur `shot.start`.
 */
export type CaseNote = { kind: 'anchoredOnStart'; instant: number; shot: Shot }

export type ResolvedCase = {
  case: FramingCase
  projectId: ProjectId
  analysis: Analysis
  framing: ClipFraming
  shot: ShotFraming
  drift: readonly CaseDrift[]
  notes: readonly CaseNote[]
}

const SHOT_TOLERANCE_S = 0.001

/** Le plan de `shots` qui recouvre le plus `recorded` — recouvrement maximal, comme les dérogations de crop. */
function bestOverlap(shots: readonly Shot[], recorded: Shot): Shot | undefined {
  let best: Shot | undefined
  let bestAmount = 0
  for (const s of shots) {
    const amount = Math.min(s.end, recorded.end) - Math.max(s.start, recorded.start)
    if (amount > bestAmount) {
      bestAmount = amount
      best = s
    }
  }
  return best
}

function computeDrift(
  c: FramingCase,
  analysis: Analysis,
  analysisFps: number,
): { drift: CaseDrift[]; notes: CaseNote[] } {
  const drift: CaseDrift[] = []
  const notes: CaseNote[] = []
  const instant = c.anchor.instants[0]

  if (c.anchor.at === 'shot') {
    const recorded = c.anchor.shot
    const today = bestOverlap(analysis.shots, recorded)
    if (today === undefined) {
      drift.push({ kind: 'shotGone', recorded })
    } else if (
      Math.abs(today.start - recorded.start) > SHOT_TOLERANCE_S ||
      Math.abs(today.end - recorded.end) > SHOT_TOLERANCE_S
    ) {
      drift.push({ kind: 'shotMoved', recorded, today })
    }
  }

  const current = findShotByInstant(analysis, instant)
  if (current === undefined) {
    const fallback = c.anchor.at === 'shot' ? c.anchor.shot : { start: instant, end: instant }
    drift.push({ kind: 'instantOutsideShot', instant, shot: fallback })
  } else {
    const distance = Math.min(Math.abs(instant - current.start), Math.abs(instant - current.end))
    const boundaryTolerance = 1 / analysisFps
    if (distance === 0) {
      notes.push({ kind: 'anchoredOnStart', instant, shot: current })
    } else if (distance < boundaryTolerance) {
      drift.push({ kind: 'nearBoundary', instant, distance, frame: Math.round(instant * analysisFps) })
    }
  }

  return { drift, notes }
}

/** Le split déjà tenu par `ShotFraming`, ou recalculé pour porter sa raison de refus (comme `splitState`). */
export function todayFramingSnapshot(shot: ShotFraming, analysis: Analysis): FramingSnapshot {
  if (shot.split !== undefined) return { ratio: shot.ratio, split: true, rejection: null }
  const boxes = analysis.boxes.filter((b) => b.t >= shot.shot.start && b.t < shot.shot.end)
  const { rejection } = computeShotSplit(
    boxes,
    shot.shot,
    shot.ratio,
    analysis.source.w,
    analysis.source.h,
    FRAMING_DEFAULTS,
  )
  return { ratio: shot.ratio, split: false, rejection }
}

/**
 * Compare un témoin à ce que le code produit aujourd'hui — **pure, sans
 * disque**, testable sur des littéraux. `baseline: null` (aucun témoin posé)
 * ne remonte jamais rien : un témoin absent n'est pas une dérive.
 */
export function framingDrift(baseline: CaseBaseline | null, today: FramingSnapshot): CaseDrift[] {
  if (baseline === null) return []
  if (baseline.ratio !== today.ratio) {
    return [{ kind: 'framingChanged', field: 'ratio', baseline: baseline.ratio, today: today.ratio }]
  }
  if (baseline.split !== today.split) {
    return [{ kind: 'framingChanged', field: 'split', baseline: baseline.split, today: today.split }]
  }
  if (baseline.rejection !== today.rejection) {
    return [
      { kind: 'framingChanged', field: 'rejection', baseline: baseline.rejection, today: today.rejection },
    ]
  }
  return []
}

/**
 * Résout un cas contre le disque : lit l'analyse, calcule le cadrage par le
 * vrai chemin (`computeFraming`), et rapporte la dérive. Lève si le projet,
 * l'analyse, ou le plan qui porte l'instant n'existe plus — c'est
 * `resolveCases` qui transforme ça en `missing` pour une liste de cas.
 */
export function resolveCase(c: FramingCase, options: Partial<FramingOptions> = {}): ResolvedCase {
  const projectId = projectOf(c)
  if (!fs.existsSync(projectDir(projectId))) {
    throw new Error(`${c.id} : projet introuvable — ${projectId} n'existe pas dans projects/.`)
  }
  const file = analysisPath(projectId)
  if (!fs.existsSync(file)) {
    throw new Error(`${c.id} : analyse introuvable pour ${projectId} (${file}).`)
  }
  const analysis = lireAnalysis(file)
  const framing = computeFraming(caseFramingRequest(c, analysis, options))
  const instant = c.anchor.instants[0]
  const shot = shotAt(framing, instant)
  if (shot === undefined) {
    throw new Error(`${c.id} : l'instant ${instant} ne tombe plus dans aucun plan de ${projectId}.`)
  }
  const { drift, notes } = computeDrift(c, analysis, analysis.fps)
  drift.push(...framingDrift(c.baseline, todayFramingSnapshot(shot, analysis)))
  return {
    case: c,
    projectId,
    analysis,
    framing,
    shot,
    drift,
    notes,
  }
}

/** `resolveCase` sur une liste : jamais raccourcie en silence, un cas en échec va dans `missing` avec sa raison. */
export function resolveCases(
  cases: readonly FramingCase[],
  options: Partial<FramingOptions> = {},
): { resolved: ResolvedCase[]; missing: { case: FramingCase; why: string }[] } {
  const resolved: ResolvedCase[] = []
  const missing: { case: FramingCase; why: string }[] = []
  for (const c of cases) {
    try {
      resolved.push(resolveCase(c, options))
    } catch (e) {
      missing.push({ case: c, why: e instanceof Error ? e.message : String(e) })
    }
  }
  return { resolved, missing }
}
