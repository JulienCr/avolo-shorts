import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_CAPTION_STYLE } from '@/core/captions/ass'
import type { Clip } from '@/core/edl'
import { clipFraming } from '@/server/clip-framing'
import { closeDb, getDb, putClip, upsertProject } from '@/server/db'
import {
  pathsRender,
  renderedFraming,
  renderedShape,
  renderFingerprint,
} from '@/server/steps/render'

/**
 * `renderPoster` : la règle de fraîcheur (une affiche plus vieille que son
 * rendu est refaite, une plus récente est réutilisée), et son `null` sans
 * livraison à jour. L'exécution ffmpeg est mockée — la pixel elle-même n'est
 * pas ce qui se joue ici, voir `tests/core/ffmpeg-args.test.ts` pour `posterArgs`.
 */

vi.mock('@/server/ffmpeg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/ffmpeg')>()
  return {
    ...actual,
    runFfmpeg: vi.fn(async (args: string[]) => {
      fs.writeFileSync(args[args.length - 1], Buffer.from('jpeg'))
    }),
  }
})

const { renderPoster, posterPath } = await import('@/server/thumbs')
const ffmpegMock = await import('@/server/ffmpeg')

const PROJECT = '2026-01-11-méchante'
const CLIP = `${PROJECT}_000060000-000090000`

let root: string

function baseClip(): Clip {
  return {
    id: CLIP,
    projectId: PROJECT,
    segments: [{ start: 60, end: 90 }],
    ratio: '1:1',
    cropX: 0.5,
    captions: true,
    branding: true,
    footer: true,
    title: 'Le canapé',
    description: "C'était pas moi.",
    status: 'exported',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
  }
}

const RENDER_BYTES = Buffer.from('rendu')

/** Pose la variante 9:16 dans `renders/`, comme un export l'aurait produite. */
function writeRender(): void {
  const folder = path.join(root, 'projects', PROJECT, 'renders')
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, `${CLIP}-9x16.mp4`), RENDER_BYTES)
}

/** L'empreinte qu'un export aurait laissée à côté du rendu (#48). */
function writeFingerprint(clip: Clip): void {
  const framing = clipFraming(clip)
  const filePath = pathsRender(clip.projectId, clip.id, framing.ratio).fingerprint
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      renderFingerprint(
        renderedShape(clip, renderedFraming(framing)),
        [],
        {
          burnedIn: clip.captions,
          look: { style: DEFAULT_CAPTION_STYLE, fonts: 'peu importe : ces tests ne rendent pas' },
          text: null,
        },
        null,
      ),
    ),
  )
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-poster-'))
  process.env.REPLAY_DIR = path.join(root, 'replays')
  process.env.STAGE_DIR = path.join(root, 'stage')
  process.env.PROJECTS_DIR = path.join(root, 'projects')
  fs.mkdirSync(process.env.REPLAY_DIR, { recursive: true })
  fs.writeFileSync(path.join(process.env.REPLAY_DIR, `${PROJECT}.mp4`), '')

  upsertProject(getDb(), {
    id: PROJECT,
    sourcePath: path.join(root, 'replays', `${PROJECT}.mp4`),
    stagedPath: path.join(root, 'stage', `${PROJECT}.mp4`),
    durationSec: 400,
    sizeBytes: 12,
    mtimeMs: 0,
    createdAt: 1_787_019_419_976,
  })
  vi.mocked(ffmpegMock.runFfmpeg).mockClear()
})

afterEach(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('renderPoster', () => {
  it('rend null sans livraison à jour', async () => {
    putClip(getDb(), { ...baseClip(), status: 'kept' })
    writeRender()

    expect(await renderPoster({ ...baseClip(), status: 'kept' })).toBeNull()
    expect(ffmpegMock.runFfmpeg).not.toHaveBeenCalled()
  })

  it('produit l’affiche quand elle manque', async () => {
    putClip(getDb(), baseClip())
    writeRender()
    writeFingerprint(baseClip())

    const destination = posterPath(PROJECT, CLIP)
    expect(fs.existsSync(destination)).toBe(false)

    const result = await renderPoster(baseClip())
    expect(result).toBe(destination)
    expect(fs.existsSync(destination)).toBe(true)
    expect(ffmpegMock.runFfmpeg).toHaveBeenCalledTimes(1)
  })

  it('réutilise une affiche plus récente que le rendu', async () => {
    putClip(getDb(), baseClip())
    writeRender()
    writeFingerprint(baseClip())

    await renderPoster(baseClip())
    expect(ffmpegMock.runFfmpeg).toHaveBeenCalledTimes(1)

    await renderPoster(baseClip())
    expect(ffmpegMock.runFfmpeg).toHaveBeenCalledTimes(1)
  })

  it('régénère une affiche plus vieille que le rendu', async () => {
    putClip(getDb(), baseClip())
    writeRender()
    writeFingerprint(baseClip())

    await renderPoster(baseClip())
    expect(ffmpegMock.runFfmpeg).toHaveBeenCalledTimes(1)

    // Le rendu est réexporté après coup : sa date avance, l'affiche devient
    // la plus vieille des deux.
    const renderPath = path.join(root, 'projects', PROJECT, 'renders', `${CLIP}-9x16.mp4`)
    const future = new Date(Date.now() + 60_000)
    fs.utimesSync(renderPath, future, future)

    await renderPoster(baseClip())
    expect(ffmpegMock.runFfmpeg).toHaveBeenCalledTimes(2)
  })

  /**
   * **La course #274, sans timing à deviner.** Même patron que `vignette` et
   * `filmstrip` (`tests/server/filmstrip.test.ts`) : on intercepte `fsp.rename`
   * et on joue dedans le réexport concurrent qui invaliderait la garde. Sur
   * l'ancien code, l'appel a lieu et publie une affiche périmée ; le
   * correctif n'appelle plus jamais `fsp.rename`.
   */
  it('ne publie jamais une affiche périmée si un réexport concurrent s’intercale dans le renommage', async () => {
    putClip(getDb(), baseClip())
    writeRender()
    writeFingerprint(baseClip())

    const renderPath = path.join(root, 'projects', PROJECT, 'renders', `${CLIP}-9x16.mp4`)
    const originalRename = fsp.rename
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (src, dst) => {
      const future = new Date(Date.now() + 60_000)
      fs.utimesSync(renderPath, future, future)
      return originalRename.call(fsp, src, dst)
    })

    const destination = posterPath(PROJECT, CLIP)
    try {
      await renderPoster(baseClip())
      expect(renameSpy).not.toHaveBeenCalled()
    } finally {
      renameSpy.mockRestore()
    }
    expect(fs.existsSync(destination)).toBe(true)
  })

  /**
   * **Course #288, verrouillée par une propriété plutôt qu'un timing** — la
   * vraie granularité fs n'est pas fiable à reproduire ici (mesuré : ns).
   * L'affiche doit porter la mtime de la vidéo, pas l'instant du renommage :
   * un vrai délai avant l'appel sépare nettement les deux sur l'ancien code.
   * Tolérance de 2 ms : la conversion ms→s pour `utimesSync` perd la fraction
   * sous-milliseconde (mesuré), sans se confondre avec l'écart de l'ancien code.
   */
  it('l’affiche publiée porte la mtime de la vidéo validée, pas celle du renommage', async () => {
    putClip(getDb(), baseClip())
    writeRender()
    writeFingerprint(baseClip())

    const renderPath = path.join(root, 'projects', PROJECT, 'renders', `${CLIP}-9x16.mp4`)
    const videoMtime = fs.statSync(renderPath).mtimeMs

    // Un vrai délai avant de générer l'affiche : sur l'ancien code, la mtime
    // publiée est celle du `renameSync`, donc nettement postérieure à
    // `videoMtime`.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const destination = await renderPoster(baseClip())
    expect(destination).not.toBeNull()
    const posterMtime = fs.statSync(destination as string).mtimeMs
    expect(Math.abs(posterMtime - videoMtime)).toBeLessThan(2)
  })
})
