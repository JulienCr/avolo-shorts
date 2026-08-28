import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Clip } from '@/core/edl'
import { closeDb, getDb, putClip, upsertProject } from '@/server/db'

vi.mock('@/server/ffmpeg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/ffmpeg')>()
  return {
    ...actual,
    runFfmpeg: vi.fn(async (args: string[]) => {
      fs.writeFileSync(args[args.length - 1], Buffer.from('jpeg'))
    }),
  }
})

const { runFfmpeg } = await import('@/server/ffmpeg')
const { filmstrip, filmstripPath } = await import('@/server/thumbs')
const { GET } = await import('@/app/api/clips/[id]/filmstrip/route')

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

function writeProxy(): void {
  const proxyDir = path.join(root, 'projects', PROJECT)
  fs.mkdirSync(proxyDir, { recursive: true })
  fs.writeFileSync(path.join(proxyDir, 'proxy.mp4'), Buffer.from('proxy'))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-filmstrip-'))
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

describe('filmstripPath', () => {
  it('range la planche à côté des vignettes', () => {
    expect(filmstripPath('p1', 'c1')).toMatch(/projects[/\\]p1[/\\]thumbs[/\\]c1\.strip\.jpg$/)
  })

  it('refuse un identifiant qui remonte l’arborescence', () => {
    expect(() => filmstripPath('p1', '../secret')).toThrow(/invalide/)
  })
})

describe('filmstrip', () => {
  it('rend null sans proxy', async () => {
    putClip(getDb(), baseClip())
    expect(await filmstrip(baseClip())).toBeNull()
  })

  it('rend null pour un clip vidé de ses segments', async () => {
    const clip = { ...baseClip(), segments: [] }
    putClip(getDb(), clip)
    writeProxy()
    expect(await filmstrip(clip)).toBeNull()
  })

  it('produit la planche puis la réutilise', async () => {
    putClip(getDb(), baseClip())
    writeProxy()
    const first = await filmstrip(baseClip())
    expect(first).not.toBeNull()
    expect(fs.existsSync(first as string)).toBe(true)
    expect(runFfmpeg).toHaveBeenCalledTimes(1)

    const second = await filmstrip(baseClip())
    expect(second).toBe(first)
    expect(runFfmpeg).toHaveBeenCalledTimes(1)
  })
})

describe('GET /api/clips/:id/filmstrip', () => {
  it('sert la planche du proxy', async () => {
    putClip(getDb(), baseClip())
    writeProxy()

    const response = await GET(new Request('http://x'), context(CLIP))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/jpeg')
  })

  it('404 sans proxy', async () => {
    putClip(getDb(), baseClip())

    const response = await GET(new Request('http://x'), context(CLIP))
    expect(response.status).toBe(404)
  })

  it('404 pour un clip inconnu', async () => {
    const response = await GET(new Request('http://x'), context('inconnu'))
    expect(response.status).toBe(404)
  })
})
