/**
 * Compose et rend une image de planche — issue #191, lot 3.
 *
 * **Pas une ligne du filtergraph n'est réécrite ici.** `stillArgs` construit
 * les mêmes `FramedSegment[]` que `src/server/steps/render.ts` (lignes
 * 2022-2042) et les passe telles quelles à `renderArgs`/`blurredVariantArgs` —
 * les deux fonctions privées `buildRender` reste inatteignable. Voir l'en-tête
 * de l'issue #191 pour la raison : une planche qui dériverait du rendu réel
 * arbitrerait sur une image que personne ne verra jamais.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Segment } from '@/core/edl'
import { blurredVariantArgs, renderArgs, type FramedSegment } from '@/core/ffmpeg/args'
import { cropRect, outputSize, splitCellRect } from '@/core/framing'
import { splitByShot, type ShotPiece } from '@/core/shot-split'
import { encoderName, ffmpegBin, produceArtifact } from '@/server/ffmpeg'
import type { ResolvedFraming } from '@/server/clip-framing'
import type { BoardInput } from './input'

export type StillRequest = {
  input: BoardInput
  instant: number
  framing: ResolvedFraming
  output: 'vertical' | 'native'
  shotEnd: number
}

/**
 * L'argv exact et la fenêtre, isolés pour être testés sans ffmpeg.
 *
 * La fenêtre tient deux images de la vidéo décodée (jamais de la grille
 * d'analyse à 2 im/s) pour que `concat` ait toujours au moins une frontière à
 * fusionner, bornée à 0,2 s en dessous — en dessous, une caméra à 60 im/s
 * demanderait une fenêtre de 33 ms que `MIN_PIECE_SEC` (`src/core/shot-split.ts`)
 * absorberait dans le morceau voisin.
 */
export function stillArgs(r: StillRequest & { dst: string }): { window: Segment; pieces: ShotPiece[]; args: string[] } {
  const { file, w, h, videoFps, durationSec } = r.input.decoded
  const span = Math.max(2 / videoFps, 0.2)
  // Le plan est une frontière d'analyse, pas la fin du fichier : borner à la
  // durée décodée (issue #194) laisse `window.start` intact et ne change donc
  // rien à la frame 0 extraite. Repli sur la fin du plan si la sonde n'a pas
  // su donner de durée.
  const ceiling = durationSec ?? r.shotEnd
  if (r.instant >= ceiling) {
    throw new Error(`stillArgs : instant ${r.instant} au-delà de la fin du fichier décodé (${ceiling}).`)
  }
  const window: Segment = { start: r.instant, end: Math.min(r.instant + span, ceiling) }
  if (window.end - window.start < 1.5 / videoFps) {
    throw new Error(
      `stillArgs : fenêtre [${window.start}, ${window.end}) trop courte pour tenir une image à ${videoFps} im/s.`,
    )
  }

  const pieces = splitByShot([window], r.framing.shots, { ratio: r.framing.ratio, cropX: 0.5, cropXNative: 0.5 })

  // Reproduit le geste de `render.ts`, pas son graphe : le natif ignore
  // toujours `split`, la variante lit le ratio et le crop *du plan*, jamais
  // celui du clip. Le JSDoc de `FramedSegment.split` (`args.ts`) dit à tort
  // que `renderArgs` ne le lit jamais ; c'est `render.ts` qui ne le construit
  // jamais pour le natif — corrigé en passant.
  const segments: FramedSegment[] =
    r.output === 'native'
      ? pieces.map((p) => ({
          start: p.start,
          end: p.end,
          ratio: r.framing.ratio,
          crop: cropRect(r.framing.ratio, p.cropXNative, w, h),
        }))
      : pieces.map((p) => ({
          start: p.start,
          end: p.end,
          ratio: p.ratio,
          crop: cropRect(p.ratio, p.cropX, w, h),
          split: p.split !== undefined ? [splitCellRect(p.split[0], w, h), splitCellRect(p.split[1], w, h)] : undefined,
        }))

  const args =
    r.output === 'native'
      ? renderArgs({ src: file, dst: r.dst, segments, out: outputSize(r.framing.ratio), encoder: encoderName() })
      : blurredVariantArgs({ src: file, dst: r.dst, segments, out: outputSize('9:16'), encoder: encoderName() })

  return { window, pieces, args }
}

/**
 * Rend l'image : un MP4 de deux images par le vrai chemin de rendu, puis sa
 * première image extraite en JPEG.
 *
 * **`force: true` est obligatoire** (`produceArtifact` sauterait sinon un
 * fichier déjà présent) : une planche régénérée doit montrer l'image de ce
 * commit, jamais celle d'une exécution antérieure sous la même bande de
 * reproductibilité — ce serait la pire faute que cet outil puisse commettre.
 *
 * **Pas de `-ss` sur l'extraction** : la première image du MP4 produit est,
 * par construction, celle de `window.start`. Chercher dans un fichier de deux
 * images réintroduirait une ambiguïté que le GOP déciderait à notre place.
 */
export async function renderStill(r: StillRequest, displayWidth = 540): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framing-board-'))
  try {
    const dst = path.join(dir, 'still.mp4')
    await produceArtifact({
      dst,
      force: true,
      what: 'planche cadrage — plan isolé',
      args: (destination) => stillArgs({ ...r, dst: destination }).args,
    })

    const jpg = path.join(dir, 'still.jpg')
    execFileSync(ffmpegBin(), [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-loglevel',
      'error',
      '-i',
      dst,
      '-map',
      '0:v:0',
      '-an',
      '-frames:v',
      '1',
      '-vf',
      `scale=${displayWidth}:-2:flags=lanczos`,
      '-q:v',
      '3',
      '-update',
      '1',
      '--',
      jpg,
    ])
    return fs.readFileSync(jpg)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
