import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PATCH as patchClipRoute } from '@/app/api/clips/[id]/route'
import type { Clip } from '@/core/edl'
import { closeDb, getClip, getDb, putClip, upsertProject } from '@/server/db'
import type { Artefact, OptionsArtefact } from '@/server/ffmpeg'
import type { Sondage } from '@/server/ffprobe'
import { cheminsRendu, renderClip } from '@/server/steps/render'

/**
 * L'empreinte de rendu (issue #48) : ce qui garde la valeur qu'avaient au rendu
 * les champs dont le rendu dépend, pour que « les fichiers sont là » cesse de
 * vouloir dire « ils décrivent le clip ».
 *
 * **Ce fichier est le seul du dépôt à simuler ffmpeg**, et il le fait pour une
 * raison qu'aucun autre n'a : les quatre défauts que l'issue ferme vivent
 * *pendant* l'encodage ou *après* lui, donc aucun ne s'observe sur le chemin du
 * saut, le seul que `tests/server/render.test.ts` sait traverser. Le runner de
 * la CI n'a pas de ffmpeg — c'est écrit dans `ROADMAP.md` — donc simuler est la
 * seule façon d'avoir ces cas sous test plutôt que sous surveillance humaine.
 *
 * Ce qui est simulé se limite à deux frontières déjà étanches : `produireArtefact`,
 * qui pose un fichier et rend la main, et `probe`, qui dit des dimensions. Le
 * reste — décision de saut, écriture de l'empreinte, statut, sous-titres — est
 * le vrai code.
 */

/** Ce que la simulation d'encodage exécute au milieu, quand un test en pose un. */
let pendantLEncodage: (() => void | Promise<void>) | null = null

/** Les encodages demandés, dans l'ordre, par chemin de destination. */
let encodages: string[] = []

vi.mock('@/server/ffmpeg', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/ffmpeg')>()
  return {
    ...original,
    /**
     * Le contrat de `produireArtefact` tenu sans ffmpeg : le fichier de
     * destination existe au retour, et pas avant.
     *
     * `o.args(...)` est appelé pour de vrai — c'est gratuit, et cela garde sous
     * test le fait que la construction des arguments n'explose pas.
     */
    produireArtefact: async (o: OptionsArtefact): Promise<Artefact> => {
      encodages.push(o.dst)
      o.args(`${o.dst}.partiel`)
      if (pendantLEncodage !== null) {
        const hook = pendantLEncodage
        pendantLEncodage = null
        await hook()
      }
      fs.mkdirSync(path.dirname(o.dst), { recursive: true })
      fs.writeFileSync(o.dst, 'un MP4 pour de faux')
      return { path: o.dst, skipped: false }
    },
  }
})

vi.mock('@/server/ffprobe', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/ffprobe')>()
  return {
    ...original,
    /** 1000x996 pour les PNG de marque, 1920x1080 pour le reste : les vraies tailles. */
    probe: async (fichier: string): Promise<Sondage> =>
      fichier.endsWith('.png')
        ? { durationSec: null, width: 1000, height: 996, fps: null }
        : { durationSec: 5936, width: 1920, height: 1080, fps: 30 },
  }
})

const SOURCE = '2025-06-15-cqlp.mp4'
const ID = '2025-06-15-cqlp'
const CLIP = 'clip_0001'

let racine: string
let replay: string
let stage: string
let projets: string
let brandDir: string
const envDépart = { ...process.env }

beforeEach(() => {
  racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-empreinte-'))
  replay = path.join(racine, 'Replay')
  stage = path.join(racine, 'stage')
  projets = path.join(racine, 'projects')
  brandDir = path.join(racine, 'brand')
  for (const d of [replay, stage, projets, brandDir]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(replay, SOURCE), 'pas vraiment une vidéo')
  fs.writeFileSync(path.join(stage, SOURCE), 'pas vraiment une vidéo')
  // Les deux marques, présentes : sans elles la porte de #37 refuserait avant
  // tout encodage et ces tests ne prouveraient rien du rendu.
  fs.writeFileSync(path.join(brandDir, 'logo.png'), 'pas vraiment un PNG')
  fs.writeFileSync(path.join(brandDir, 'twitch.png'), 'pas vraiment un PNG')

  process.env.REPLAY_DIR = replay
  process.env.STAGE_DIR = stage
  process.env.PROJECTS_DIR = projets
  // L'encodeur est nommé : `encoderName()` sonderait NVENC en lançant ffmpeg.
  process.env.FFMPEG_ENCODER = 'x264'

  encodages = []
  pendantLEncodage = null

  upsertProject(getDb(), {
    id: ID,
    sourcePath: path.join(replay, SOURCE),
    stagedPath: path.join(stage, SOURCE),
    durationSec: 5936,
    sizeBytes: 1,
    mtimeMs: 1,
    createdAt: 1,
  })
})

afterEach(() => {
  closeDb()
  fs.rmSync(racine, { recursive: true, force: true })
  process.env = { ...envDépart }
})

function clip(surcharges: Partial<Clip> = {}): Clip {
  return {
    id: CLIP,
    projectId: ID,
    segments: [
      { start: 100, end: 115.7 },
      { start: 130, end: 140 },
    ],
    ratio: '1:1',
    cropX: 0.5,
    // Pas de sous-titres : le transcript vit sur un Drive qui n'existe pas ici,
    // et les cas mesurés par ce fichier ne portent pas sur l'incrustation.
    captions: false,
    branding: true,
    title: 'Une vanne qui tient',
    description: 'La chute arrive au bon moment. #impro',
    status: 'kept',
    pass: 1,
    ...surcharges,
  }
}

/** Le `PATCH` réel, tel que Next l'appelle. */
async function patcher(champs: Record<string, unknown>): Promise<void> {
  const réponse = await patchClipRoute(
    new Request('http://x', { method: 'PATCH', body: JSON.stringify(champs) }),
    { params: Promise.resolve({ id: CLIP }) },
  )
  expect(réponse.status).toBe(200)
}

function poser(chemins: (string | null)[]): void {
  for (const chemin of chemins) {
    if (chemin === null) continue
    fs.mkdirSync(path.dirname(chemin), { recursive: true })
    fs.writeFileSync(chemin, 'un rendu d’avant')
  }
}

/**
 * **Le point 1 de l'issue, et le plus grave.** Un `PATCH` qui déplace une borne
 * pendant l'encodage ne change pas le statut du clip, donc `marquerExporté` ne
 * voyait rien et posait `exported` sur des fichiers qui décrivent le montage
 * d'avant.
 */
describe("un PATCH pendant l'encodage", () => {
  it('ne laisse pas le clip finir en « exported »', async () => {
    const c = clip()
    putClip(getDb(), c)

    pendantLEncodage = async () => {
      await patcher({ segments: [{ start: 100, end: 104 }] })
    }

    await expect(renderClip(CLIP, { db: getDb(), brandDir })).rejects.toThrow(/modifié pendant/)
    expect(getClip(getDb(), CLIP)?.status).not.toBe('exported')
  })

  it("ne laisse derrière lui aucune sortie qui décrive le montage d'avant", async () => {
    const c = clip()
    putClip(getDb(), c)
    const chemins = cheminsRendu(ID, CLIP, '1:1')

    pendantLEncodage = async () => {
      await patcher({ cropX: 0.2 })
    }

    await expect(renderClip(CLIP, { db: getDb(), brandDir })).rejects.toThrow(/modifié pendant/)
    for (const chemin of [chemins.mp4, chemins.variant9x16, chemins.texts]) {
      if (chemin !== null) expect(fs.existsSync(chemin)).toBe(false)
    }
  })
})

/**
 * **Le point 2 de l'issue.** `sauterLeRendu` constatait trois `existsSync` : un
 * jeu de fichiers laissé par un montage abandonné faisait sauter l'export, qui
 * répondait `skipped: true` sur une livraison fausse.
 */
describe('des sorties complètes sous un montage qui a changé', () => {
  it("ne fait pas sauter l'export", async () => {
    const c = clip()
    putClip(getDb(), c)
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    poser([chemins.mp4, chemins.variant9x16, chemins.texts])

    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(false)
    expect(encodages).toContain(chemins.mp4)
  })

  it('saute quand le rendu décrit bien le clip — le cas nominal reste vrai', async () => {
    putClip(getDb(), clip())
    const chemins = cheminsRendu(ID, CLIP, '1:1')

    const premier = await renderClip(CLIP, { db: getDb(), brandDir })
    expect(premier.skipped).toBe(false)
    expect(fs.existsSync(chemins.mp4)).toBe(true)

    encodages = []
    const second = await renderClip(CLIP, { db: getDb(), brandDir })
    expect(second.skipped).toBe(true)
    expect(encodages).toEqual([])
    expect(getClip(getDb(), CLIP)?.status).toBe('exported')
  })
})

/**
 * **Le point 3 de l'issue.** La route `PATCH` et `renderClip` écrivent tous deux
 * le `.txt`, et rien ne disait laquelle des deux versions survit.
 */
describe("l'ordre d'écriture du .txt", () => {
  it("laisse gagner l'état de la base, pas l'instantané du début de l'export", async () => {
    putClip(getDb(), clip())
    const chemins = cheminsRendu(ID, CLIP, '1:1')

    pendantLEncodage = async () => {
      await patcher({ description: 'Corrigée pendant l’export. #impro' })
    }

    await renderClip(CLIP, { db: getDb(), brandDir })

    expect(fs.readFileSync(chemins.texts, 'utf8')).toContain('Corrigée pendant l’export.')
  })
})
