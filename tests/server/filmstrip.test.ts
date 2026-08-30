import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Clip } from '@/core/edl'
import { closeDb, getClip, getDb, putClip, replaceClips, upsertProject } from '@/server/db'

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
const { filmstrip, filmstripCounts, filmstripPath, vignette, vignettePath } = await import('@/server/thumbs')
const { FILMSTRIP_COUNT_DEFAULT, FILMSTRIP_COUNT_MAX, FILMSTRIP_COUNT_MIN, parseFilmstripCount } = await import(
  '@/lib/filmstrip',
)
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
  it('range la planche à côté des vignettes, le compte dans le nom', () => {
    expect(filmstripPath('p1', 'c1', 12)).toMatch(/projects[/\\]p1[/\\]thumbs[/\\]c1\.strip\.12\.jpg$/)
  })

  it('deux comptes ne partagent pas de fichier', () => {
    expect(filmstripPath('p1', 'c1', 12)).not.toBe(filmstripPath('p1', 'c1', 16))
  })

  it('refuse un identifiant qui remonte l’arborescence', () => {
    expect(() => filmstripPath('p1', '../secret', 12)).toThrow(/invalide/)
  })
})

describe('filmstripCounts', () => {
  it('couvre tout l’intervalle valide, et rien au-delà', () => {
    const counts = filmstripCounts()
    expect(Math.min(...counts)).toBe(FILMSTRIP_COUNT_MIN)
    expect(Math.max(...counts)).toBe(FILMSTRIP_COUNT_MAX)
    expect(counts.length).toBe(FILMSTRIP_COUNT_MAX - FILMSTRIP_COUNT_MIN + 1)
  })
})

describe('parseFilmstripCount', () => {
  it('retombe sur le défaut sans paramètre', () => {
    expect(parseFilmstripCount(null)).toBe(FILMSTRIP_COUNT_DEFAULT)
  })

  it('retombe sur le défaut sur une valeur non entière', () => {
    expect(parseFilmstripCount('12.5')).toBe(FILMSTRIP_COUNT_DEFAULT)
    expect(parseFilmstripCount('abc')).toBe(FILMSTRIP_COUNT_DEFAULT)
  })

  it('borne un compte hors intervalle plutôt que de le refuser', () => {
    // Un compte hors bornes est un tuilage ffmpeg dimensionné par
    // l'appelant : le borner plutôt que le refuser sert quand même la
    // planche, au pire rapport plutôt qu'à aucun.
    expect(parseFilmstripCount('1000')).toBe(FILMSTRIP_COUNT_MAX)
    expect(parseFilmstripCount('0')).toBe(FILMSTRIP_COUNT_MIN)
    expect(parseFilmstripCount('-5')).toBe(FILMSTRIP_COUNT_MIN)
  })

  it('accepte un compte valide tel quel', () => {
    expect(parseFilmstripCount('18')).toBe(18)
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

  it('un compte différent régénère, sur un fichier différent', async () => {
    putClip(getDb(), baseClip())
    writeProxy()
    // Le mock n'est jamais nettoyé entre les tests (relevé plus bas dans ce
    // fichier) : sans ce `mockClear`, le compte inclut les appels d'avant.
    vi.mocked(runFfmpeg).mockClear()
    const twelve = await filmstrip(baseClip(), 12)
    const seize = await filmstrip(baseClip(), 16)
    expect(twelve).not.toBe(seize)
    expect(fs.existsSync(twelve as string)).toBe(true)
    expect(fs.existsSync(seize as string)).toBe(true)
    expect(runFfmpeg).toHaveBeenCalledTimes(2)
  })

  it('rend null et efface le temporaire si les bornes bougent pendant le rendu', async () => {
    putClip(getDb(), baseClip())
    writeProxy()
    vi.mocked(runFfmpeg).mockImplementationOnce(async (args: string[]) => {
      putClip(getDb(), { ...baseClip(), segments: [{ start: 60, end: 80 }] })
      fs.writeFileSync(args[args.length - 1], Buffer.from('jpeg'))
    })

    const result = await filmstrip(baseClip())
    expect(result).toBeNull()

    const destination = filmstripPath(PROJECT, CLIP, FILMSTRIP_COUNT_DEFAULT)
    expect(fs.existsSync(destination)).toBe(false)
    const leftovers = fs.readdirSync(path.dirname(destination)).filter((f) => f.includes('.partiel-'))
    expect(leftovers).toEqual([])
  })

  /**
   * **La course #274, sans timing à deviner.** On intercepte `fsp.rename` :
   * si l'appel a lieu, on joue dedans l'éviction concurrente exacte du
   * rapport — elle ne trouve rien à effacer puisque le fichier n'existe pas
   * encore — avant de renommer pour de vrai. Sur l'ancien code, l'appel a
   * lieu et publie une planche périmée. Le correctif n'appelle plus jamais
   * `fsp.rename` : `fs.renameSync` ne laisse aucun point d'attente entre la
   * garde et la publication où une telle éviction pourrait s'intercaler.
   */
  it('ne publie jamais une planche périmée si une éviction concurrente s’intercale dans le renommage', async () => {
    putClip(getDb(), baseClip())
    writeProxy()

    const originalRename = fsp.rename
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (src, dst) => {
      fs.rmSync(dst.toString(), { force: true })
      putClip(getDb(), { ...baseClip(), segments: [{ start: 60, end: 80 }] })
      return originalRename.call(fsp, src, dst)
    })

    const destination = filmstripPath(PROJECT, CLIP, FILMSTRIP_COUNT_DEFAULT)
    try {
      await filmstrip(baseClip())
      expect(renameSpy).not.toHaveBeenCalled()
    } finally {
      renameSpy.mockRestore()
    }
    expect(getClip(getDb(), CLIP)?.segments).toEqual([{ start: 60, end: 90 }])
    expect(fs.existsSync(destination)).toBe(true)
  })
})

describe('vignette', () => {
  it('rend null sans proxy', async () => {
    putClip(getDb(), baseClip())
    expect(await vignette(baseClip())).toBeNull()
  })

  it('produit la vignette puis la réutilise', async () => {
    putClip(getDb(), baseClip())
    writeProxy()
    const first = await vignette(baseClip())
    expect(first).not.toBeNull()
    expect(fs.existsSync(first as string)).toBe(true)

    const second = await vignette(baseClip())
    expect(second).toBe(first)
  })

  /**
   * #275 : `momentVignette` doit normaliser avant de lire `segments[0]`. Un
   * clip écrit par `putClip` (non gardé) peut porter des segments non
   * triés — la seule voie qui atteint réellement le défaut visé.
   */
  it('vise le début du premier segment une fois trié, même écrit non trié', async () => {
    const clip = { ...baseClip(), segments: [{ start: 70, end: 90 }, { start: 60, end: 65 }] }
    putClip(getDb(), clip)
    writeProxy()

    // Le mock n'est jamais nettoyé entre les tests (relevé par Copilot) :
    // sans ce `mockClear`, l'appel lu ici peut être celui d'un test précédent.
    vi.mocked(runFfmpeg).mockClear()
    await vignette(clip)

    const args = vi.mocked(runFfmpeg).mock.calls[0][0]
    expect(args[args.indexOf('-ss') + 1]).toBe('60')
  })

  /**
   * Alignement avec `filmstrip` : un clip disparu pendant l'extraction ne
   * publie rien — `vignette` publiait auparavant sur ce cas (`toDay !==
   * undefined && …`), au lieu de fermer comme `filmstrip`.
   */
  it('rend null et ne publie rien pour un clip effacé pendant l’extraction', async () => {
    putClip(getDb(), baseClip())
    writeProxy()
    vi.mocked(runFfmpeg).mockImplementationOnce(async (args: string[]) => {
      replaceClips(getDb(), PROJECT, [])
      fs.writeFileSync(args[args.length - 1], Buffer.from('jpeg'))
    })

    const result = await vignette(baseClip())
    expect(result).toBeNull()

    const destination = vignettePath(PROJECT, CLIP)
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('ne publie jamais une vignette périmée si une éviction concurrente s’intercale dans le renommage', async () => {
    putClip(getDb(), baseClip())
    writeProxy()

    const originalRename = fsp.rename
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (src, dst) => {
      fs.rmSync(dst.toString(), { force: true })
      putClip(getDb(), { ...baseClip(), segments: [{ start: 65, end: 90 }] })
      return originalRename.call(fsp, src, dst)
    })

    const destination = vignettePath(PROJECT, CLIP)
    try {
      await vignette(baseClip())
      expect(renameSpy).not.toHaveBeenCalled()
    } finally {
      renameSpy.mockRestore()
    }
    expect(getClip(getDb(), CLIP)?.segments).toEqual([{ start: 60, end: 90 }])
    expect(fs.existsSync(destination)).toBe(true)
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

  it('sert le compte demandé par `?count=`, un fichier par compte', async () => {
    putClip(getDb(), baseClip())
    writeProxy()

    await GET(new Request('http://x?count=18'), context(CLIP))
    expect(fs.existsSync(filmstripPath(PROJECT, CLIP, 18))).toBe(true)
    expect(fs.existsSync(filmstripPath(PROJECT, CLIP, FILMSTRIP_COUNT_DEFAULT))).toBe(false)
  })

  it('borne un `count` hors intervalle plutôt que de le passer à ffmpeg tel quel', async () => {
    putClip(getDb(), baseClip())
    writeProxy()

    await GET(new Request('http://x?count=100000'), context(CLIP))
    expect(fs.existsSync(filmstripPath(PROJECT, CLIP, FILMSTRIP_COUNT_MAX))).toBe(true)
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
