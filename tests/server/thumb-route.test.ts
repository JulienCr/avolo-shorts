import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_CAPTION_STYLE } from '@/core/captions/ass'
import type { Clip } from '@/core/edl'
import { clipFraming } from '@/server/clip-framing'
import { closeDb, getDb, putClip, upsertProject } from '@/server/db'
import { runFfmpeg } from '@/server/ffmpeg'
import {
  pathsRender,
  renderedFraming,
  renderedShape,
  renderFingerprint,
} from '@/server/steps/render'

/**
 * `GET /api/clips/:id/thumb` : le proxy par défaut, le repère du rendu livré
 * seulement sous `?poster=render` — l'écran de tri en 16:9 ne le demande
 * jamais, seul le vivier du planning le pose (relevé par Codex).
 */

// **L'affiche imite le contenu de sa source**, plutôt qu'un octet constant :
// sans ça, l'affiche d'un rendu et celle d'un proxy seraient impossibles à
// distinguer par leurs octets, et un test qui préfère l'un à l'autre ne
// pourrait vérifier que le code HTTP — pas ce qui a réellement été servi.
vi.mock('@/server/ffmpeg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/ffmpeg')>()
  return {
    ...actual,
    runFfmpeg: vi.fn(async (args: string[]) => {
      const src = args[args.indexOf('-i') + 1]
      const mark = Buffer.concat([Buffer.from('image-de:'), fs.readFileSync(src)])
      fs.writeFileSync(args[args.length - 1], mark)
    }),
  }
})

const { GET } = await import('@/app/api/clips/[id]/thumb/route')

const PROJECT = '2026-01-11-méchante'
const CLIP = `${PROJECT}_000060000-000090000`

let root: string

function context(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

function baseClip(): Clip {
  return {
    id: CLIP,
    projectId: PROJECT,
    segments: [{ start: 60, end: 90 }],
    ratio: '1:1',
    cropX: 0.5,
    captions: true,
    branding: true,
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

function writeRender(): void {
  const folder = path.join(root, 'projects', PROJECT, 'renders')
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, `${CLIP}-9x16.mp4`), Buffer.from('rendu'))
}

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

function writeProxy(): void {
  const proxyDir = path.join(root, 'projects', PROJECT)
  fs.mkdirSync(proxyDir, { recursive: true })
  fs.writeFileSync(path.join(proxyDir, 'proxy.mp4'), Buffer.from('proxy'))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-thumb-'))
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
})

afterEach(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('GET /api/clips/:id/thumb', () => {
  it('sert l’affiche du rendu livré sous ?poster=render', async () => {
    putClip(getDb(), baseClip())
    writeRender()
    writeFingerprint(baseClip())

    const response = await GET(new Request('http://x?poster=render'), context(CLIP))
    expect(response.status).toBe(200)
  })

  it('se rabat sur la vignette du proxy sans rendu à jour', async () => {
    putClip(getDb(), { ...baseClip(), status: 'candidate' })
    writeProxy()

    const response = await GET(new Request('http://x?poster=render'), context(CLIP))
    expect(response.status).toBe(200)
  })

  it('404 quand ni le rendu ni le proxy n’existent', async () => {
    putClip(getDb(), { ...baseClip(), status: 'candidate' })

    const response = await GET(new Request('http://x'), context(CLIP))
    expect(response.status).toBe(404)
  })

  /**
   * Préférer le rendu ne se prouve pas par un code HTTP : les deux tests
   * précédents ne posent jamais les deux fichiers à la fois, donc inverser
   * en `vignette(clip) ?? renderPoster(clip)` les laisserait tous verts. Ici
   * les deux existent, et seuls les octets servis départagent lequel a été lu.
   */
  it('sert les octets du rendu, pas ceux du proxy, quand les deux existent avec ?poster=render', async () => {
    putClip(getDb(), baseClip())
    writeRender()
    writeProxy()
    writeFingerprint(baseClip())

    const response = await GET(new Request('http://x?poster=render'), context(CLIP))
    const body = Buffer.from(await response.arrayBuffer()).toString()
    expect(body).toBe('image-de:rendu')
    expect(body).not.toBe('image-de:proxy')
  })

  /**
   * **Un rendu qu'ffmpeg refuse ne doit pas rendre 500.** `renderPoster` jette
   * alors, et `??` n'attrape que `null` : la route répondait donc en erreur là
   * où elle servait le proxy avant que l'affiche existe (relevé par Aristarque
   * après la fusion de #222). Le repli se journalise, il ne disparaît pas.
   */
  it('se rabat sur le proxy, en le journalisant, quand l’extraction échoue', async () => {
    putClip(getDb(), baseClip())
    writeRender()
    writeProxy()
    writeFingerprint(baseClip())
    vi.mocked(runFfmpeg).mockRejectedValueOnce(new Error('moov atom not found'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await GET(new Request('http://x?poster=render'), context(CLIP))
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('image-de:proxy')
    expect(warn.mock.calls.map(([message]) => String(message)).join(' ')).toContain('moov atom not found')
    warn.mockRestore()
  })

  /**
   * Sans le paramètre, un clip gardé et déjà exporté garde son affiche 16:9 :
   * c'est le cas que l'écran de tri exerce, et que le rendu 9:16 casserait.
   */
  it('ignore le rendu livré sans ?poster=render, même à jour', async () => {
    putClip(getDb(), baseClip())
    writeRender()
    writeProxy()
    writeFingerprint(baseClip())

    const response = await GET(new Request('http://x'), context(CLIP))
    const body = Buffer.from(await response.arrayBuffer()).toString()
    expect(body).toBe('image-de:proxy')
  })
})
