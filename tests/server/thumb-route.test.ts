import fs from 'node:fs'
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
 * `GET /api/clips/:id/thumb` : l'affiche du rendu livré passe devant le
 * repère du proxy, qui reste le repli d'un candidat sans rendu — le seul cas
 * que l'écran de tri exerce encore.
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
      const marque = Buffer.concat([Buffer.from('image-de:'), fs.readFileSync(src)])
      fs.writeFileSync(args[args.length - 1], marque)
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

function poserRendu(): void {
  const folder = path.join(root, 'projects', PROJECT, 'renders')
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, `${CLIP}-9x16.mp4`), Buffer.from('rendu'))
}

function poserFingerprint(clip: Clip): void {
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

function poserProxy(): void {
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
  it('sert l’affiche du rendu livré quand elle est à jour', async () => {
    putClip(getDb(), baseClip())
    poserRendu()
    poserFingerprint(baseClip())

    const response = await GET(new Request('http://x'), context(CLIP))
    expect(response.status).toBe(200)
  })

  it('se rabat sur la vignette du proxy sans rendu à jour', async () => {
    putClip(getDb(), { ...baseClip(), status: 'candidate' })
    poserProxy()

    const response = await GET(new Request('http://x'), context(CLIP))
    expect(response.status).toBe(200)
  })

  it('404 quand ni le rendu ni le proxy n’existent', async () => {
    putClip(getDb(), { ...baseClip(), status: 'candidate' })

    const response = await GET(new Request('http://x'), context(CLIP))
    expect(response.status).toBe(404)
  })

  /**
   * Préférer le rendu ne se prouve pas par un code HTTP : les trois tests
   * au-dessus ne posent jamais les deux fichiers à la fois, donc inverser en
   * `vignette(clip) ?? renderPoster(clip)` les laisserait tous verts. Ici les
   * deux existent, et seuls les octets servis départagent lequel a été lu.
   */
  it('sert les octets du rendu, pas ceux du proxy, quand les deux existent', async () => {
    putClip(getDb(), baseClip())
    poserRendu()
    poserProxy()
    poserFingerprint(baseClip())

    const response = await GET(new Request('http://x'), context(CLIP))
    const body = Buffer.from(await response.arrayBuffer()).toString()
    expect(body).toBe('image-de:rendu')
    expect(body).not.toBe('image-de:proxy')
  })
})
