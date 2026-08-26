/**
 * Résout un projet en ce qu'une planche a besoin de décoder — issue #191,
 * lot 3.
 *
 * **Ne calcule aucun cadrage.** Ce fichier ne fait que trouver le fichier
 * réellement décodé et ses dimensions sondées ; `framing.ts` appelle le vrai
 * chemin de cadrage, `still.ts` le vrai chemin de rendu.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

import type { FramingSettings } from '@/core/framing'
import { ffprobeBin } from '@/server/ffmpeg'
import { probe } from '@/server/ffprobe'
import { closeDb, effectiveSettings, getDb, getProject } from '@/server/db'
import { workingInput } from '@/server/steps/ingest'
import { analysisPath, projectDir, proxyPath } from '@/server/paths'
import { lireAnalysis, type Analysis } from '@/server/steps/analysis'

export type BoardInput = {
  projectId: string
  analysis: Analysis
  /** Le fichier réellement décodé, et ses dimensions SONDÉES. */
  decoded: { file: string; w: number; h: number; videoFps: number; fromProxy: boolean; durationSec: number | null }
  hasAudio: boolean
  globals: FramingSettings
}

/**
 * Le fichier à décoder, par le même choix que la production
 * (`workingInput`, `src/server/steps/ingest.ts:525`), le proxy en dernier
 * recours et **déclaré**, jamais silencieux.
 *
 * Pas le proxy par défaut, pour trois raisons : `blurredVariantArgs` part de
 * la source (le correctif #22), le proxy est 960x540 où la question posée —
 * « ce visage se lit-il dans cette cellule » — se juge mal une fois agrandi
 * 3,55x pour remplir un canevas 1080x1920, et un rééchelonnage à la main des
 * rectangles de crop rendrait des composantes impaires que libx264 refuse.
 */
function sourceFileOf(projectId: string): { file: string; fromProxy: boolean } {
  const db = getDb()
  const project = getProject(db, projectId)
  if (project !== undefined) {
    const chosen = workingInput(project)
    if (fs.existsSync(chosen.path)) return { file: chosen.path, fromProxy: false }
  }
  const proxy = proxyPath(projectId)
  if (fs.existsSync(proxy)) {
    console.warn(
      `${projectId} : ni original ni copie de travail sur le disque — repli sur le proxy ` +
        '960x540. La planche sera molle.',
    )
    return { file: proxy, fromProxy: true }
  }
  throw new Error(
    `${projectId} : ni original, ni copie de travail, ni proxy sur le disque. Rien à décoder.`,
  )
}

/**
 * Refuse en amont un fichier sans piste audio. `buildRender` mappe `[0:a]`
 * sans `?` — un silence en amont produirait un échec ffmpeg qui ne nomme pas
 * la cause, bien après que la planche a commencé à rendre.
 */
function assertHasAudio(file: string): void {
  const out = execFileSync(
    ffprobeBin(),
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', '--', file],
    { encoding: 'utf8' },
  ).trim()
  if (out === '') {
    throw new Error(`${file} : aucune piste audio — buildRender exige "[0:a]", le rendu échouerait sans le dire.`)
  }
}

export async function loadBoardInput(projectId: string): Promise<BoardInput> {
  if (!fs.existsSync(projectDir(projectId))) {
    throw new Error(`loadBoardInput : projet introuvable — ${projectId} n'existe pas dans projects/.`)
  }
  const analysis = lireAnalysis(analysisPath(projectId))

  const { file, fromProxy } = sourceFileOf(projectId)
  assertHasAudio(file)

  const dims = await probe(file)
  // Même garde que `dimensionsSource` (`src/server/steps/render.ts:1633`) :
  // aucune dimension supposée, `cropRect` sur des dimensions fausses ne lève
  // jamais et ne se voit qu'à l'image.
  if (dims.width === null || dims.height === null || dims.width <= 0 || dims.height <= 0) {
    throw new Error(`loadBoardInput : ffprobe n'a pas su dire les dimensions de ${file}.`)
  }
  if (dims.fps === null || dims.fps <= 0) {
    throw new Error(`loadBoardInput : ffprobe n'a pas su dire la cadence de ${file}.`)
  }

  const globals = effectiveSettings(getDb()).framing
  closeDb()

  return {
    projectId,
    analysis,
    decoded: { file, w: dims.width, h: dims.height, videoFps: dims.fps, fromProxy, durationSec: dims.durationSec },
    hasAudio: true,
    globals,
  }
}
