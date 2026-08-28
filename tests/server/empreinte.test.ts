import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PATCH as patchClipRoute } from '@/app/api/clips/[id]/route'
import { DEFAULT_CAPTION_STYLE } from '@/core/captions/ass'
import type { Clip } from '@/core/edl'
import { applySettings, closeDb, getClip, getDb, putClip, schedulePublications, upsertProject } from '@/server/db'
import type { Artifact, OptionsArtifact } from '@/server/ffmpeg'
import type { Probe } from '@/server/ffprobe'
import { outputNamed, clipOutputs } from '@/server/renders'
import {
  pathsRender,
  lireFingerprint,
  renderClip,
  VERSION_FINGERPRINT,
} from '@/server/steps/render'
import type { ResolvedFraming } from '@/server/clip-framing'
import type { DubbingCells } from '@/core/dubbing'

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
 * Ce qui est simulé se limite à deux frontières déjà étanches : `produceArtifact`,
 * qui pose un fichier et rend la main, et `probe`, qui dit des dimensions. Le
 * reste — décision de saut, écriture de l'empreinte, statut, sous-titres — est
 * le vrai code.
 */

/** Ce que la simulation d'encodage exécute au milieu, quand un test en pose un. */
let duringLEncoding: (() => void | Promise<void>) | null = null

/** Les encodages demandés, dans l'ordre, par chemin de destination. */
let encodings: string[] = []

/** L'argv réellement construit pour chaque destination — voir `produceArtifact` ci-dessous. */
let capturedArgs: Record<string, string[]> = {}

vi.mock('@/server/ffmpeg', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/ffmpeg')>()
  return {
    ...original,
    /**
     * Le contrat de `produceArtifact` tenu sans ffmpeg : le fichier de
     * destination existe au retour, et pas avant.
     *
     * `o.args(...)` est appelé pour de vrai — c'est gratuit, et cela garde sous
     * test le fait que la construction des arguments n'explose pas. Son
     * résultat est gardé (`capturedArgs`) pour comparer l'argv du natif entre
     * deux rendus, sans lancer ffmpeg.
     */
    produceArtifact: async (o: OptionsArtifact): Promise<Artifact> => {
      encodings.push(o.dst)
      capturedArgs[o.dst] = o.args(`${o.dst}.partiel`)
      if (duringLEncoding !== null) {
        const hook = duringLEncoding
        duringLEncoding = null
        await hook()
      }
      fs.mkdirSync(path.dirname(o.dst), { recursive: true })
      fs.writeFileSync(o.dst, 'un MP4 pour de faux')
      return { path: o.dst, skipped: false }
    },
  }
})

/**
 * Le cadrage résolu qu'un test impose au rendu, sans écrire d'`analysis.json`
 * ni piloter le détecteur de doublage — `null` fait retomber sur le vrai
 * `clipFraming` (repli manuel), comme tous les autres tests de ce fichier.
 */
let framingOverride: ResolvedFraming | null = null

vi.mock('@/server/clip-framing', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/clip-framing')>()
  return {
    ...original,
    clipFraming: (c: Clip, globals?: Parameters<typeof original.clipFraming>[1]) =>
      framingOverride ?? original.clipFraming(c, globals),
  }
})

/**
 * `RENDER_NATIVE` vaut `false` en production (`src/core/render-flags.ts`) et
 * le reste pour tous les tests de ce fichier, sauf celui qui a besoin des
 * DEUX sorties à la fois pour prouver que `nativePieces` ignore `dubbing` —
 * un getter, pas une valeur figée à l'import, pour que ce seul test puisse la
 * faire basculer sans affecter les autres.
 */
let renderNativeOverride = false
vi.mock('@/core/render-flags', () => ({
  get RENDER_NATIVE() {
    return renderNativeOverride
  },
}))

vi.mock('@/server/ffprobe', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/ffprobe')>()
  return {
    ...original,
    /** 1000x996 pour les PNG de marque, 1920x1080 pour le reste : les vraies tailles. */
    probe: async (file: string): Promise<Probe> =>
      file.endsWith('.png')
        ? { durationSec: null, width: 1000, height: 996, fps: null }
        : { durationSec: 5936, width: 1920, height: 1080, fps: 30 },
  }
})

/**
 * `true` par défaut pour tous les tests de ce fichier — seul celui qui vérifie
 * l'ordre du repli local dans `currentCaptionsDocument` le bascule à `false`.
 */
let editingRespond = true

vi.mock('@/server/steps/ingest', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/steps/ingest')>()
  return {
    ...original,
    editingResponds: async (): Promise<boolean> => editingRespond,
  }
})

const SOURCE = '2025-06-15-cqlp.mp4'
const ID = '2025-06-15-cqlp'
const CLIP = 'clip_0001'

let root: string
let replay: string
let stage: string
let projects: string
let brandDir: string
const envStart = { ...process.env }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-empreinte-'))
  replay = path.join(root, 'Replay')
  stage = path.join(root, 'stage')
  projects = path.join(root, 'projects')
  brandDir = path.join(root, 'brand')
  for (const d of [replay, stage, projects, brandDir]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(replay, SOURCE), 'pas vraiment une vidéo')
  fs.writeFileSync(path.join(stage, SOURCE), 'pas vraiment une vidéo')
  // Les deux marques, présentes : sans elles la porte de #37 refuserait avant
  // tout encodage et ces tests ne prouveraient rien du rendu.
  fs.writeFileSync(path.join(brandDir, 'logo.png'), 'pas vraiment un PNG')
  fs.writeFileSync(path.join(brandDir, 'twitch.png'), 'pas vraiment un PNG')

  process.env.REPLAY_DIR = replay
  process.env.STAGE_DIR = stage
  process.env.PROJECTS_DIR = projects
  // L'encodeur est nommé : `encoderName()` sonderait NVENC en lançant ffmpeg.
  process.env.FFMPEG_ENCODER = 'x264'

  encodings = []
  capturedArgs = {}
  duringLEncoding = null
  editingRespond = true
  framingOverride = null
  renderNativeOverride = false

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
  fs.rmSync(root, { recursive: true, force: true })
  process.env = { ...envStart }
})

function clip(overrides: Partial<Clip> = {}): Clip {
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
    footer: true,
    title: 'Une vanne qui tient',
    description: 'La chute arrive au bon moment. #impro',
    status: 'kept',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
    ...overrides,
  }
}

type TranscriptSegment = {
  start: number
  end: number
  text: string
  words: { word: string; start: number; end: number }[]
}

/** Écrit le transcript à côté de l'original, avec les segments donnés. */
function writeTranscript(segments: TranscriptSegment[]): void {
  const folder = path.join(replay, `${ID}.avolo`)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'transcript.json'), JSON.stringify({ language: 'fr', segments }))
}

/**
 * Le repli du transcript **dans le projet**, distinct de celui à côté de
 * l'original qu'écrit `writeTranscript`. C'est celui que `findSidecar`
 * consulte en premier, avant tout sondage du montage.
 */
function writeTranscriptFallback(segments: TranscriptSegment[]): void {
  const folder = path.join(projects, ID, `${ID}.avolo`)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'transcript.json'), JSON.stringify({ language: 'fr', segments }))
}

/**
 * Un transcript minuscule à côté de l'original, pour les cas qui incrustent
 * vraiment des sous-titres. Les autres tournent avec `captions: false`.
 */
function poserTranscript(): void {
  writeTranscript([
    {
      start: 100,
      end: 110,
      text: 'une vanne qui tient',
      words: [
        { word: 'une', start: 100, end: 101 },
        { word: 'vanne', start: 101, end: 103 },
        { word: 'qui', start: 103, end: 104 },
        { word: 'tient', start: 104, end: 106 },
      ],
    },
  ])
}

/** Les noms des marques que l'empreinte dit incrustées, triés. */
function markersBurnedIn(path: string): string[] {
  return (lireFingerprint(path)?.marks ?? []).map((m) => m.name)
}

/** Le `PATCH` réel, tel que Next l'appelle. */
async function patch(fields: Record<string, unknown>): Promise<void> {
  const response = await patchClipRoute(
    new Request('http://x', { method: 'PATCH', body: JSON.stringify(fields) }),
    { params: Promise.resolve({ id: CLIP }) },
  )
  expect(response.status).toBe(200)
}

function poser(paths: (string | null)[]): void {
  for (const filePath of paths) {
    if (filePath === null) continue
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'un rendu d’avant')
  }
}

/**
 * **Le point 1 de l'issue, et le plus grave.** Un `PATCH` qui déplace une borne
 * pendant l'encodage ne change pas le statut du clip, donc `markExported` ne
 * voyait rien et posait `exported` sur des fichiers qui décrivent le montage
 * d'avant.
 */
describe("un PATCH pendant l'encodage", () => {
  it('ne laisse pas le clip finir en « exported »', async () => {
    const c = clip()
    putClip(getDb(), c)

    duringLEncoding = async () => {
      await patch({ segments: [{ start: 100, end: 104 }] })
    }

    await expect(renderClip(CLIP, { db: getDb(), brandDir })).rejects.toThrow(/modifié pendant/)
    expect(getClip(getDb(), CLIP)?.status).not.toBe('exported')
  })

  it("ne laisse derrière lui aucune sortie qui décrive le montage d'avant", async () => {
    const c = clip()
    putClip(getDb(), c)
    const paths = pathsRender(ID, CLIP, '1:1')

    duringLEncoding = async () => {
      await patch({ cropX: 0.2 })
    }

    await expect(renderClip(CLIP, { db: getDb(), brandDir })).rejects.toThrow(/modifié pendant/)
    for (const path of [paths.mp4, paths.variant9x16, paths.texts, paths.fingerprint]) {
      if (path !== null) expect(fs.existsSync(path)).toBe(false)
    }
  })

  /**
   * **La garde interne de `renderClip` (#205), vérifiée sous une échéance
   * `planned` réelle.** Les deux tests ci-dessus prouvent déjà le geste sans
   * planning ; celui-ci reprend exactement la même course — un montage qui
   * bouge pendant l'encodage — sur un clip que `hasPendingSchedule` dit vrai,
   * pour prouver que la réserve du planning ne fuit jamais dans les deux
   * appels internes de `renderClip`. Si `keepScheduledOutputs` y valait
   * `true`, ce test échouerait : l'empreinte et les fichiers, produits pour le
   * montage d'avant l'édition, survivraient au lieu d'être écartés.
   */
  it("écarte quand même l'empreinte sur un clip programmé (#205)", async () => {
    const c = clip()
    putClip(getDb(), c)
    schedulePublications(getDb(), [CLIP], Date.now() + 86_400_000, Date.now())
    const paths = pathsRender(ID, CLIP, '1:1')

    duringLEncoding = async () => {
      await patch({ segments: [{ start: 100, end: 104 }] })
    }

    await expect(renderClip(CLIP, { db: getDb(), brandDir })).rejects.toThrow(/modifié pendant/)
    for (const path of [paths.mp4, paths.variant9x16, paths.texts, paths.fingerprint]) {
      if (path !== null) expect(fs.existsSync(path)).toBe(false)
    }
  })
})

/**
 * **Le point 2 de l'issue.** `sauterRender` constatait trois `existsSync` : un
 * jeu de fichiers laissé par un montage abandonné faisait sauter l'export, qui
 * répondait `skipped: true` sur une livraison fausse.
 */
describe('des sorties complètes sous un montage qui a changé', () => {
  it("ne fait pas sauter l'export", async () => {
    const c = clip()
    putClip(getDb(), c)
    const paths = pathsRender(ID, CLIP, '1:1')
    poser([paths.mp4, paths.variant9x16, paths.texts])

    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(false)
    expect(encodings).toContain(paths.variant9x16)
  })

  it('saute quand le rendu décrit bien le clip — le cas nominal reste vrai', async () => {
    putClip(getDb(), clip())
    const paths = pathsRender(ID, CLIP, '1:1')

    const first = await renderClip(CLIP, { db: getDb(), brandDir })
    expect(first.skipped).toBe(false)
    expect(paths.variant9x16 !== null && fs.existsSync(paths.variant9x16)).toBe(true)

    encodings = []
    const second = await renderClip(CLIP, { db: getDb(), brandDir })
    expect(second.skipped).toBe(true)
    expect(encodings).toEqual([])
    expect(getClip(getDb(), CLIP)?.status).toBe('exported')
  })
})

/**
 * **Le critère 4 de l'issue #205, la régression qui compte.** Un clip
 * programmé, édité après son export, garde ses sorties (`PATCH` épargne via
 * `keepScheduledOutputs`) — mais un ré-export explicite ne doit pas s'y laisser
 * prendre : ses deux appels internes à `discardRenderStale` gardent le défaut,
 * jamais la réserve, sous peine de sauter silencieusement un encodage dû.
 */
describe('la réserve du planning ne trompe pas renderClip (#205)', () => {
  it("un ré-export explicite écarte l'empreinte épargnée et réencode, malgré l'échéance", async () => {
    const db = getDb()
    putClip(db, clip())
    schedulePublications(db, [CLIP], Date.now() + 86_400_000, Date.now())

    const first = await renderClip(CLIP, { db, brandDir })
    expect(first.skipped).toBe(false)
    const paths = pathsRender(ID, CLIP, '1:1')

    // Le montage bouge : le rendu de tout à l'heure devient périmé, mais le
    // clip garde son échéance `planned`, donc le `PATCH` épargne ses sorties.
    await patch({ segments: [{ start: 100, end: 108 }] })
    expect(getClip(db, CLIP)?.status).toBe('kept')
    // Ratio 1:1, natif désactivé : la variante est la seule sortie vidéo due.
    expect(fs.existsSync(paths.variant9x16 as string)).toBe(true)
    expect(fs.existsSync(paths.fingerprint)).toBe(true)

    encodings = []
    const second = await renderClip(CLIP, { db, brandDir })

    // **Preuve que l'encodage a eu lieu**, pas seulement qu'aucune erreur n'a
    // été levée : `sauterRender` a vu une empreinte qui ne décrit plus le clip
    // et a rallumé ffmpeg.
    expect(second.skipped).toBe(false)
    expect(encodings).toContain(paths.variant9x16)
    expect(getClip(db, CLIP)?.status).toBe('exported')
  })
})

/**
 * **Le point 3 de l'issue.** La route `PATCH` et `renderClip` écrivent tous deux
 * le `.txt`, et rien ne disait laquelle des deux versions survit.
 */
describe("l'ordre d'écriture du .txt", () => {
  it("laisse gagner l'état de la base, pas l'instantané du début de l'export", async () => {
    putClip(getDb(), clip())
    const paths = pathsRender(ID, CLIP, '1:1')

    duringLEncoding = async () => {
      await patch({ description: 'Corrigée pendant l’export. #impro' })
    }

    await renderClip(CLIP, { db: getDb(), brandDir })

    expect(fs.readFileSync(paths.texts, 'utf8')).toContain('Corrigée pendant l’export.')
  })

  it("laisse gagner la base aussi quand c'est le PATCH qui écrit en dernier", async () => {
    // L'autre sens, et c'est la même règle : le `.txt` porte l'état de la base
    // au moment de son écriture, quel que soit le chemin qui l'écrit.
    putClip(getDb(), clip())
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })

    await patch({ title: 'Retitré après coup' })

    expect(fs.readFileSync(paths.texts, 'utf8')).toContain('Retitré après coup')
  })
})

/**
 * **Le quatrième cas de l'issue**, mesuré sur les trois rendus du 18 août : ils
 * ne portent aucune marque incrustée alors que `branding` valait `true` au rendu
 * comme aujourd'hui. Aucune empreinte n'existait pour le dire, et
 * `sauterRender` constatant des fichiers, l'export les sautait pour toujours.
 */
describe('un rendu sans empreinte, déjà sur le disque', () => {
  it('est refait plutôt que sauté, sans avoir à connaître --force', async () => {
    putClip(getDb(), clip())
    const paths = pathsRender(ID, CLIP, '1:1')
    poser([paths.mp4, paths.variant9x16, paths.texts])

    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(false)
    expect(encodings).toEqual([paths.variant9x16])
    // Et il en laisse une, donc le cas ne se reproduit qu'une fois par clip.
    expect(markersBurnedIn(paths.fingerprint)).toEqual(['logo.png', 'twitch.png'])
  })

  it('le dit au journal, plutôt que de refaire en silence', async () => {
    putClip(getDb(), clip())
    const paths = pathsRender(ID, CLIP, '1:1')
    poser([paths.mp4, paths.variant9x16, paths.texts])

    const messages: string[] = []
    const before = console.warn
    console.warn = (...args: unknown[]) => void messages.push(args.join(' '))
    try {
      await renderClip(CLIP, { db: getDb(), brandDir })
    } finally {
      console.warn = before
    }

    expect(messages.some((m) => m.includes('aucune empreinte'))).toBe(true)
  })

  it("se tait sous `force`, où la décision ne vient pas de l'empreinte", async () => {
    putClip(getDb(), clip())
    const paths = pathsRender(ID, CLIP, '1:1')
    poser([paths.mp4, paths.variant9x16, paths.texts])

    const messages: string[] = []
    const before = console.warn
    console.warn = (...args: unknown[]) => void messages.push(args.join(' '))
    try {
      await renderClip(CLIP, { db: getDb(), brandDir, force: true })
    } finally {
      console.warn = before
    }

    expect(messages.some((m) => m.includes('empreinte'))).toBe(false)
  })
})

/**
 * Ce que l'empreinte porte au-delà des cinq champs : les marques réellement
 * incrustées. C'est ce qui distingue « le clip demandait des marques » de « ce
 * fichier en porte ».
 */
describe('les marques incrustées', () => {
  it("périme le rendu quand une marque est déposée après coup", async () => {
    fs.rmSync(path.join(brandDir, 'twitch.png'))
    putClip(getDb(), clip())
    await renderClip(CLIP, { db: getDb(), brandDir })
    expect(markersBurnedIn(pathsRender(ID, CLIP, '1:1').fingerprint)).toEqual(['logo.png'])

    fs.writeFileSync(path.join(brandDir, 'twitch.png'), 'pas vraiment un PNG')
    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(false)
    expect(markersBurnedIn(pathsRender(ID, CLIP, '1:1').fingerprint)).toEqual([
      'logo.png',
      'twitch.png',
    ])
  })

  it('périme le rendu quand une marque est retirée du dossier', async () => {
    putClip(getDb(), clip())
    await renderClip(CLIP, { db: getDb(), brandDir })

    fs.rmSync(path.join(brandDir, 'twitch.png'))
    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(false)
    expect(markersBurnedIn(pathsRender(ID, CLIP, '1:1').fingerprint)).toEqual(['logo.png'])
  })

  /**
   * **Le dossier vidé ne périme rien**, et c'est l'exception à écrire une fois.
   * Un clip qui demande des marques dont aucune n'est exploitable ne peut pas se
   * rendre (#37) : périmer transformerait une livraison correcte en export qui
   * refuse. Les deux PNG ont vraiment disparu d'`assets/brand/` le 18 août.
   */
  it("laisse sauter quand le dossier est vidé, plutôt que de refuser l'export", async () => {
    putClip(getDb(), clip())
    await renderClip(CLIP, { db: getDb(), brandDir })

    for (const name of ['logo.png', 'twitch.png']) fs.rmSync(path.join(brandDir, name))
    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(true)
    expect(encodings).toEqual([])
  })
  /**
   * **Le nom ne suffit pas**, et c'est la façon normale de changer de marque :
   * les deux fichiers portent des noms fixes, on remplace le contenu sous le
   * même nom. Une empreinte réduite aux noms sauterait l'export et continuerait
   * de livrer l'ancienne image. (relevé par Codex)
   */
  it('périme le rendu quand un logo est remplacé sous le même nom', async () => {
    putClip(getDb(), clip())
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    const before = lireFingerprint(paths.fingerprint)?.marks

    fs.writeFileSync(path.join(brandDir, 'logo.png'), 'une tout autre image')
    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(false)
    expect(encodings).toContain(paths.variant9x16)
    // Le nom n'a pas bougé, le contenu si.
    expect(markersBurnedIn(paths.fingerprint)).toEqual(['logo.png', 'twitch.png'])
    expect(lireFingerprint(paths.fingerprint)?.marks).not.toEqual(before)
  })

  it('ne périme rien quand le fichier est réécrit à l’identique', async () => {
    // Une synchronisation de dossier change la date sans changer l'image :
    // c'est pourquoi l'empreinte porte un condensat et non un `mtime`.
    putClip(getDb(), clip())
    await renderClip(CLIP, { db: getDb(), brandDir })

    fs.writeFileSync(path.join(brandDir, 'logo.png'), 'pas vraiment un PNG')
    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(true)
    expect(encodings).toEqual([])
  })
})

/**
 * Ce que l'interface voit. C'est là que le rendu « se dit à jour », donc c'est là
 * qu'il doit avoir de quoi le prouver.
 */
describe('les sorties publiées', () => {
  it("ne publie rien sous un rendu que rien ne certifie", () => {
    const c = { ...clip(), status: 'exported' as const }
    putClip(getDb(), c)
    const paths = pathsRender(ID, CLIP, '1:1')
    poser([paths.mp4, paths.variant9x16, paths.texts])

    const outputs = clipOutputs(c)

    expect(outputs.mp4Url).toBeNull()
    expect(outputs.textsUrl).toBeNull()
    expect(outputs.variant9x16Url).toBeNull()
    // **Mais la variante reste due**, et le `null` ci-dessus ne veut pas dire
    // « n'existera jamais » : les deux `null` ne se confondent pas.
    expect(outputs.variant9x16Due).toBe(true)
  })

  it('les publie dès que l’export a laissé son empreinte', async () => {
    putClip(getDb(), clip())
    await renderClip(CLIP, { db: getDb(), brandDir })

    const toDay = getClip(getDb(), CLIP)
    expect(toDay?.status).toBe('exported')
    const outputs = clipOutputs(toDay as Clip)
    // Le natif est désactivé pour ce ratio (1:1) : `mp4Url` reste `null` par
    // construction, `mp4Due` le dit — ce n'est pas un rendu manquant.
    expect(outputs.mp4Url).toBeNull()
    expect(outputs.mp4Due).toBe(false)
    expect(outputs.variant9x16Url).not.toBeNull()
    expect(outputs.textsUrl).not.toBeNull()
  })

  it("ne sert pas l'empreinte comme si elle était une sortie", async () => {
    putClip(getDb(), clip())
    await renderClip(CLIP, { db: getDb(), brandDir })
    const toDay = getClip(getDb(), CLIP) as Clip

    expect(outputNamed(toDay, `${CLIP}.rendu.json`)).toBeNull()
    // Le contrôle vaut quelque chose : le vrai nom, lui, se sert.
    expect(outputNamed(toDay, `${CLIP}-9x16.mp4`)).not.toBeNull()
  })

  it("cesse de les publier quand un PATCH périme le rendu, empreinte comprise", async () => {
    putClip(getDb(), clip())
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    expect(fs.existsSync(paths.fingerprint)).toBe(true)

    await patch({ cropX: 0.1 })

    expect(fs.existsSync(paths.fingerprint)).toBe(false)
    expect(paths.mp4 !== null && fs.existsSync(paths.mp4)).toBe(false)
    expect(getClip(getDb(), CLIP)?.status).toBe('kept')
  })
})

/**
 * **Le cas sans précédent de #48 : un hook change.** Les critères 3 à 6 du
 * contrat de cette PR. Deux voies distinctes, qui ne doivent pas se confondre
 * au journal :
 *
 * - un `PATCH` sur `hookText`/`hookStyle` **du clip** périme par le chemin
 *   `discardRenderStale` existant, comme n'importe quel autre champ de
 *   `ShapeRendered` ;
 * - un réglage **global** de hook ne périme rien tant que personne ne
 *   redemande le clip — ni `PUT /api/settings`, ni un `PATCH` ne l'effacent —
 *   mais `mp4Url` retombe à `null` dès la prochaine lecture, et le prochain
 *   export refuse de sauter en le disant.
 */
describe('le hook (#48, le cas sans précédent)', () => {
  it('un PATCH sur hookText efface les sorties et redescend le statut, par discardRenderStale', async () => {
    putClip(getDb(), clip())
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    expect(fs.existsSync(paths.fingerprint)).toBe(true)

    await patch({ hookText: 'Une accroche neuve' })

    expect(fs.existsSync(paths.fingerprint)).toBe(false)
    expect(paths.mp4 !== null && fs.existsSync(paths.mp4)).toBe(false)
    expect(getClip(getDb(), CLIP)?.status).toBe('kept')
  })

  it('un PATCH sur hookStyle périme aussi, par le même chemin', async () => {
    putClip(getDb(), clip({ hookText: 'Attends de voir ça' }))
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    expect(fs.existsSync(paths.fingerprint)).toBe(true)

    await patch({ hookStyle: { sizePermille: 120 } })

    expect(fs.existsSync(paths.fingerprint)).toBe(false)
    expect(paths.mp4 !== null && fs.existsSync(paths.mp4)).toBe(false)
    expect(getClip(getDb(), CLIP)?.status).toBe('kept')
  })

  it('un PATCH sur hookBadge périme aussi, par le même chemin', async () => {
    putClip(getDb(), clip({ hookText: 'Attends de voir ça' }))
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    expect(fs.existsSync(paths.fingerprint)).toBe(true)

    await patch({ hookBadge: 'DÉFI 10' })

    expect(fs.existsSync(paths.fingerprint)).toBe(false)
    expect(paths.mp4 !== null && fs.existsSync(paths.mp4)).toBe(false)
    expect(getClip(getDb(), CLIP)?.status).toBe('kept')
  })

  // **Un réglage de couleur du badge périme comme les autres**, alors même
  // qu'il ne vit que dans `hookStyle` : c'est `stableEntries(resolved)` qui
  // l'embarque dans `hookImageDigest`, sans une ligne écrite pour lui. Ce
  // test existe pour que ça reste vrai le jour où quelqu'un touche au
  // condensat.
  it('une couleur de badge surchargée périme le rendu', async () => {
    putClip(getDb(), clip({ hookText: 'Attends de voir ça', hookBadge: 'DÉFI 10' }))
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    expect(fs.existsSync(paths.fingerprint)).toBe(true)

    await patch({ hookStyle: { badgeBackground: '#00FF00' } })

    expect(fs.existsSync(paths.fingerprint)).toBe(false)
  })

  it("un réglage global de hook fait passer variant9x16Url à null sans que le clip ait bougé", async () => {
    putClip(getDb(), clip({ hookText: 'Attends de voir ça' }))
    await renderClip(CLIP, { db: getDb(), brandDir })
    const toDay = getClip(getDb(), CLIP) as Clip
    expect(clipOutputs(toDay).variant9x16Url).not.toBeNull()

    applySettings(getDb(), { hook: { textColor: '#00FF00' } })

    // Le clip lui-même n'a pas bougé : même statut, mêmes champs — seul le
    // réglage global a changé.
    expect(getClip(getDb(), CLIP)).toEqual(toDay)
    expect(clipOutputs(toDay).variant9x16Url).toBeNull()
  })

  /**
   * **Le point de la seconde manche de la PR #117** : `durationMs` (et
   * `enter`/`exit`) déterminent désormais le graphe ffmpeg
   * (`enable='between(t,0,…)'`, `fade=`), mais ne changent RIEN au PNG
   * rasterisé lui-même — sa géométrie ne dépend que de `sizePermille` et des
   * autres réglages de forme. Sans `durationMs` dans `hookImageDigest`
   * (`src/server/steps/render.ts`), un export resterait perpétuellement
   * « à jour » après un changement de durée, alors que la vidéo produite
   * diffère bel et bien (le hook resterait incrusté plus ou moins longtemps).
   * Ce test couvre exactement ce que le test voisin (`textColor`) ne couvre
   * pas : `textColor` change aussi le PNG, `durationMs` non.
   */
  it('un changement de durationMs périme l’export même si le PNG rendu est identique', async () => {
    putClip(getDb(), clip({ hookText: 'Attends de voir ça' }))
    await renderClip(CLIP, { db: getDb(), brandDir })
    const toDay = getClip(getDb(), CLIP) as Clip
    expect(clipOutputs(toDay).variant9x16Url).not.toBeNull()

    applySettings(getDb(), { hook: { durationMs: 5_000 } })

    expect(getClip(getDb(), CLIP)).toEqual(toDay)
    expect(clipOutputs(toDay).variant9x16Url).toBeNull()

    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir })
    expect(result.skipped).toBe(false)
    expect(encodings).toContain(pathsRender(ID, CLIP, '1:1').variant9x16)
  })

  it('le prochain export journalise « hook » et refuse de sauter après ce même réglage global', async () => {
    putClip(getDb(), clip({ hookText: 'Attends de voir ça' }))
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })

    applySettings(getDb(), { hook: { textColor: '#00FF00' } })

    const messages: string[] = []
    const before = console.warn
    console.warn = (...args: unknown[]) => void messages.push(args.join(' '))
    encodings = []
    let result: Awaited<ReturnType<typeof renderClip>>
    try {
      result = await renderClip(CLIP, { db: getDb(), brandDir })
    } finally {
      console.warn = before
    }

    expect(result.skipped).toBe(false)
    expect(encodings).toContain(paths.variant9x16)
    expect(messages.some((m) => m.includes('le hook'))).toBe(true)
  })

  it("n'est périmé par AUCUN réglage global de hook quand le clip n'a pas de hook", async () => {
    // `clip()` par défaut : `hookText: ''`, aucun hook actif.
    putClip(getDb(), clip())
    await renderClip(CLIP, { db: getDb(), brandDir })

    applySettings(getDb(), { hook: { textColor: '#00FF00', durationMs: 5000, position: 'bottom' } })

    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir })
    expect(result.skipped).toBe(true)
    expect(encodings).toEqual([])

    const toDay = getClip(getDb(), CLIP) as Clip
    expect(clipOutputs(toDay).variant9x16Url).not.toBeNull()
  })

  /**
   * **Le point 2 de la doc du champ `hook`** : sans le condensat des polices
   * dedans, un clip qui a un hook mais pas de sous-titres ne verrait jamais
   * passer un remplacement d'Anton — `captionsLook` vaut `null` pour ce clip,
   * donc rien d'autre dans l'empreinte ne porte les polices.
   */
  it('remplacer fonts/Anton-Regular.ttf périme un clip qui a un hook et pas de sous-titres', async () => {
    putClip(getDb(), clip({ hookText: 'Attends de voir ça', captions: false }))
    const paths = pathsRender(ID, CLIP, '1:1')
    const fonts = path.join(root, 'fonts')
    fs.mkdirSync(fonts, { recursive: true })
    fs.writeFileSync(path.join(fonts, 'Anton-Regular.ttf'), 'la version d’hier')
    await renderClip(CLIP, { db: getDb(), brandDir, fontsDir: fonts })
    const before = lireFingerprint(paths.fingerprint)?.hook
    expect(before).toBeTypeOf('string')

    fs.writeFileSync(path.join(fonts, 'Anton-Regular.ttf'), 'la version d’aujourd’hui')
    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir, fontsDir: fonts })

    expect(result.skipped).toBe(false)
    expect(encodings).toContain(paths.variant9x16)
    expect(lireFingerprint(paths.fingerprint)?.hook).not.toBe(before)
  })
})

/** La recette de rendu, et le seul champ de l'empreinte qui ne décrive pas le clip. */
describe('la version de recette', () => {
  it('périme un rendu produit sous une version antérieure', async () => {
    putClip(getDb(), clip())
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })

    const fingerprint = lireFingerprint(paths.fingerprint)
    expect(fingerprint?.version).toBe(VERSION_FINGERPRINT)
    fs.writeFileSync(
      paths.fingerprint,
      JSON.stringify({ ...fingerprint, version: VERSION_FINGERPRINT - 1 }),
    )

    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(false)
    expect(encodings).toContain(paths.variant9x16)
  })
})

/**
 * Le preset de sous-titres : il change l'image, donc il entre dans l'empreinte.
 * (relevé par Copilot)
 */
describe('le preset de sous-titres', () => {
  const OTHER = { ...DEFAULT_CAPTION_STYLE, fontSize: DEFAULT_CAPTION_STYLE.fontSize + 8 }

  it("ne laisse pas sauter un rendu produit avec un autre preset", async () => {
    poserTranscript()
    putClip(getDb(), clip({ captions: true }))
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir, style: OTHER })
    expect(lireFingerprint(paths.fingerprint)?.captionsLook).toBeTypeOf('string')

    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(false)
    expect(encodings).toContain(paths.variant9x16)
  })

  it('saute quand le preset est le même — le cas nominal reste vrai', async () => {
    poserTranscript()
    putClip(getDb(), clip({ captions: true }))
    await renderClip(CLIP, { db: getDb(), brandDir, style: OTHER })

    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir, style: OTHER })

    expect(result.skipped).toBe(true)
    expect(encodings).toEqual([])
  })

  /**
   * **La police disponible entre dans le look.** Quand `fonts/` manque, libass se
   * rabat sur fontconfig, ne trouve pas Anton et incruste dans une autre police,
   * sans un mot. Un condensat qui ne porterait que le preset serait identique
   * avant et après le retour d'Anton, et l'export sauterait indéfiniment sur la
   * vidéo rendue dans la mauvaise police. (relevé par Copilot)
   */
  it("ne laisse pas sauter un rendu incrusté sans la police du preset", async () => {
    poserTranscript()
    putClip(getDb(), clip({ captions: true }))
    const paths = pathsRender(ID, CLIP, '1:1')
    const fonts = path.join(root, 'fonts')
    await renderClip(CLIP, { db: getDb(), brandDir, fontsDir: fonts })
    const withoutFont = lireFingerprint(paths.fingerprint)?.captionsLook

    // Anton arrive.
    fs.mkdirSync(fonts, { recursive: true })
    fs.writeFileSync(path.join(fonts, 'Anton-Regular.ttf'), 'pas vraiment une police')
    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir, fontsDir: fonts })

    expect(result.skipped).toBe(false)
    expect(encodings).toContain(paths.variant9x16)
    expect(lireFingerprint(paths.fingerprint)?.captionsLook).not.toBe(withoutFont)
  })

  /**
   * **Remplacer la police en gardant son nom est la forme normale d'une mise à
   * jour**, et le dossier existe avant comme après : un booléen de présence n'y
   * verrait rien, et l'export sauterait indéfiniment sur la vidéo rendue avec
   * l'ancienne. (relevé par Codex)
   */
  it('ne laisse pas sauter un rendu incrusté avec une autre version de la police', async () => {
    poserTranscript()
    putClip(getDb(), clip({ captions: true }))
    const paths = pathsRender(ID, CLIP, '1:1')
    const fonts = path.join(root, 'fonts')
    fs.mkdirSync(fonts, { recursive: true })
    fs.writeFileSync(path.join(fonts, 'Anton-Regular.ttf'), 'la version d’hier')
    await renderClip(CLIP, { db: getDb(), brandDir, fontsDir: fonts })
    const before = lireFingerprint(paths.fingerprint)?.captionsLook

    fs.writeFileSync(path.join(fonts, 'Anton-Regular.ttf'), 'la version d’aujourd’hui')
    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir, fontsDir: fonts })

    expect(result.skipped).toBe(false)
    expect(lireFingerprint(paths.fingerprint)?.captionsLook).not.toBe(before)
  })

  it("ignore un fichier du dossier qui n'est pas une police", async () => {
    // Le condensat ne doit pas réagir à un `README.md` déposé à côté d'Anton :
    // libass ne le chargera pas.
    poserTranscript()
    putClip(getDb(), clip({ captions: true }))
    const fonts = path.join(root, 'fonts')
    fs.mkdirSync(fonts, { recursive: true })
    fs.writeFileSync(path.join(fonts, 'Anton-Regular.ttf'), 'pas vraiment une police')
    await renderClip(CLIP, { db: getDb(), brandDir, fontsDir: fonts })

    fs.writeFileSync(path.join(fonts, 'README.md'), 'où trouver Anton')
    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir, fontsDir: fonts })

    expect(result.skipped).toBe(true)
    expect(encodings).toEqual([])
  })

  it("ne note aucun preset quand aucun mot ne tombe dans les segments", async () => {
    // Le clip demande des sous-titres, le transcript n'en fournit aucun sur ses
    // segments : le rendu part sans, et l'empreinte le consigne plutôt que de
    // certifier un preset qui n'a rien décrit.
    poserTranscript()
    putClip(getDb(), clip({ captions: true, segments: [{ start: 800, end: 820 }] }))
    const paths = pathsRender(ID, CLIP, '1:1')

    await renderClip(CLIP, { db: getDb(), brandDir })

    const fingerprint = lireFingerprint(paths.fingerprint)
    expect(fingerprint?.captions).toBe(true)
    expect(fingerprint?.captionsLook).toBeNull()
  })
})

/**
 * Les marques sondées avant la décision de saut, puis rouvertes par deux ffmpeg
 * successifs : un PNG remplacé entre-temps peut n'être incrusté que dans l'une
 * des deux sorties. (relevé par Copilot)
 */
describe("une marque remplacée pendant l'export", () => {
  it("refuse de certifier ce qu'elle n'a pas pu vérifier", async () => {
    putClip(getDb(), clip())
    const paths = pathsRender(ID, CLIP, '1:1')

    duringLEncoding = () => {
      fs.writeFileSync(path.join(brandDir, 'logo.png'), 'un logo tout neuf')
    }

    await expect(renderClip(CLIP, { db: getDb(), brandDir })).rejects.toThrow(
      /ne sont plus celles qui ont servi/,
    )
    // Aucune empreinte : l'export suivant refera les deux sorties.
    expect(fs.existsSync(paths.fingerprint)).toBe(false)
    expect(getClip(getDb(), CLIP)?.status).toBe('kept')
  })

  /**
   * **La tolérance du dossier vide ne s'applique pas ici.** Elle existe pour ne
   * pas détruire une livraison déjà faite quand on ne sait plus ce qu'elle
   * porte ; certifier celle qu'on vient de faire est l'autre question, et ne pas
   * savoir n'y est pas une raison d'affirmer — un logo remplacé entre les deux
   * encodages puis retiré avant le contrôle passerait sinon inaperçu.
   * (relevé par Codex)
   */
  it("refuse aussi quand le dossier est vidé pendant l'export", async () => {
    putClip(getDb(), clip())
    const paths = pathsRender(ID, CLIP, '1:1')

    duringLEncoding = () => {
      for (const name of ['logo.png', 'twitch.png']) fs.rmSync(path.join(brandDir, name))
    }

    await expect(renderClip(CLIP, { db: getDb(), brandDir })).rejects.toThrow(
      /ne sont plus celles qui ont servi/,
    )
    expect(fs.existsSync(paths.fingerprint)).toBe(false)
  })

  /**
   * **L'empreinte d'avant part avant le premier encodage.** Elle certifie les
   * MP4 qu'on remplace : la laisser le temps des deux ffmpeg laisse
   * `deliveryToDay` répondre vrai sur une paire à moitié réécrite, et rien ne
   * le signale puisqu'un `GET` ne sonde pas le dossier des marques.
   * (relevé par Copilot)
   */
  it("n'attend pas la fin du rendu pour retirer l'empreinte d'avant", async () => {
    putClip(getDb(), clip())
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    expect(fs.existsSync(paths.fingerprint)).toBe(true)

    // Le dossier change, donc le rendu se refait ; il échoue en cours de route.
    fs.writeFileSync(path.join(brandDir, 'logo.png'), 'un logo tout neuf')
    duringLEncoding = () => {
      throw new Error('ffmpeg a rendu l’âme')
    }

    await expect(renderClip(CLIP, { db: getDb(), brandDir })).rejects.toThrow(/l’âme/)
    // Plus rien ne certifie ce qui reste sur le disque.
    expect(fs.existsSync(paths.fingerprint)).toBe(false)
    const toDay = getClip(getDb(), CLIP) as Clip
    expect(clipOutputs(toDay).variant9x16Url).toBeNull()
  })
})

/**
 * **Le texte réellement porté par les sous-titres (issue #87).** Avant ce
 * correctif, une correction du transcript qui ne touche aucun segment d'aucun
 * clip laissait `sauterRender` reprendre un MP4 qui portait encore les
 * anciens mots — le neuvième chemin de la famille de défauts que #48 avait
 * coûté cher à fermer.
 *
 * Les segments du clip par défaut sont `[100, 115.7]` et `[130, 140]` : le
 * premier transcript de test tombe dedans, un second segment à `[500, 510]`
 * en est délibérément loin pour le point 3.
 */
describe('le texte des sous-titres (#87)', () => {
  /** Les deux segments par défaut du clip de ce fichier, en transcript. */
  const SEGMENT_IN_CLIP: TranscriptSegment = {
    start: 100,
    end: 110,
    text: 'une vanne qui tient',
    words: [
      { word: 'une', start: 100, end: 101 },
      { word: 'vanne', start: 101, end: 103 },
      { word: 'qui', start: 103, end: 104 },
      { word: 'tient', start: 104, end: 106 },
    ],
  }
  /** Loin des deux segments du clip (`[100, 115.7]` et `[130, 140]`). */
  const CLIP_SEGMENT_OUTSIDE: TranscriptSegment = {
    start: 500,
    end: 510,
    text: 'un aparté sans rapport',
    words: [
      { word: 'un', start: 500, end: 501 },
      { word: 'aparté', start: 501, end: 503 },
      { word: 'sans', start: 503, end: 504 },
      { word: 'rapport', start: 504, end: 506 },
    ],
  }

  /**
   * **Le point 1 des critères de l'issue, et le plus facile à faire passer
   * pour de mauvaises raisons.** Sans lui, un condensat qui varierait à
   * matériau égal — sur l'ordre d'un objet, un horodatage non stabilisé —
   * remplacerait un rendu qui ment par un rendu qui se refait à chaque appel,
   * alors que l'export dure de dix secondes à une minute et n'est pas
   * annulable.
   */
  it('ne périme rien quand rien de textuel ne change — le cas nominal reste vrai', async () => {
    writeTranscript([SEGMENT_IN_CLIP])
    putClip(getDb(), clip({ captions: true }))
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    const before = lireFingerprint(paths.fingerprint)?.captionsContent
    expect(before).toBeTypeOf('string')

    // Le transcript est réécrit à l'identique — une resynchronisation de
    // dossier, par exemple — avant le second passage.
    writeTranscript([SEGMENT_IN_CLIP])
    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(true)
    expect(encodings).toEqual([])
    expect(lireFingerprint(paths.fingerprint)?.captionsContent).toBe(before)
  })

  /** Le point 2 : un mot dans un segment du clip. */
  it("périme le rendu quand un mot d'un segment du clip change", async () => {
    writeTranscript([SEGMENT_IN_CLIP])
    putClip(getDb(), clip({ captions: true }))
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    const before = lireFingerprint(paths.fingerprint)?.captionsContent

    writeTranscript([
      {
        ...SEGMENT_IN_CLIP,
        words: SEGMENT_IN_CLIP.words.map((m) => (m.word === 'vanne' ? { ...m, word: 'blague' } : m)),
      },
    ])
    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(false)
    expect(encodings).toContain(paths.variant9x16)
    expect(lireFingerprint(paths.fingerprint)?.captionsContent).not.toBe(before)
  })

  /**
   * Le point 3 : un mot change dans l'émission, mais hors des segments
   * retenus par ce clip. La correction porte sur `CLIP_SEGMENT_OUTSIDE`, à
   * `[500, 510]`, loin des deux segments du clip par défaut.
   */
  it("ne périme rien quand un mot change ailleurs dans l'émission, hors des segments du clip", async () => {
    writeTranscript([SEGMENT_IN_CLIP, CLIP_SEGMENT_OUTSIDE])
    putClip(getDb(), clip({ captions: true }))
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    const before = lireFingerprint(paths.fingerprint)?.captionsContent
    // **Sans elle, ce test passe à vide sous ablation.** `avant` et la relecture
    // valent tous deux `undefined` si `captionsContent` n'existe pas : l'égalité
    // ne prouve alors rien. C'est le seul des quatre à devoir le dire
    // explicitement, puisque c'est le seul dont l'assertion finale est une
    // non-égalité entre deux lectures plutôt qu'un type ou un changement.
    expect(before).toBeTypeOf('string')

    writeTranscript([
      SEGMENT_IN_CLIP,
      {
        ...CLIP_SEGMENT_OUTSIDE,
        words: CLIP_SEGMENT_OUTSIDE.words.map((m) =>
          m.word === 'aparté' ? { ...m, word: 'aparté-corrigé' } : m,
        ),
      },
    ])
    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(true)
    expect(encodings).toEqual([])
    expect(lireFingerprint(paths.fingerprint)?.captionsContent).toBe(before)
  })

  /**
   * Le point 4 : `captions: false` garde une empreinte stable quoi qu'il
   * arrive au transcript — y compris un changement dans les segments mêmes du
   * clip, qui périmerait un clip sous-titré.
   */
  it("garde une empreinte stable pour un clip sans sous-titres, quoi qu'il arrive au transcript", async () => {
    writeTranscript([SEGMENT_IN_CLIP])
    putClip(getDb(), clip({ captions: false }))
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    expect(lireFingerprint(paths.fingerprint)?.captionsContent).toBeNull()

    writeTranscript([
      {
        ...SEGMENT_IN_CLIP,
        words: SEGMENT_IN_CLIP.words.map((m) => (m.word === 'vanne' ? { ...m, word: 'blague' } : m)),
      },
    ])
    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(true)
    expect(encodings).toEqual([])
    expect(lireFingerprint(paths.fingerprint)?.captionsContent).toBeNull()
  })

  /**
   * **La boucle que #48 avait rencontrée, et pour laquelle la comparaison du
   * texte avait été écartée à l'époque.** Un clip qui demande des sous-titres
   * mais dont aucun mot ne tombe dans ses segments rend un document `null` —
   * `clipUnderTitles` le dit, `writeCaptionsDocument` le journalise sans
   * échouer. `captionsContent` vaut alors `null` dans l'empreinte, exactement
   * comme un clip sans sous-titres : la seconde lecture compare `null` à
   * `null`, ne trouve aucun écart, et l'export ne se reprend pas indéfiniment.
   * Rien ne garantissait ça par construction avant ce test — seulement une
   * lecture du code.
   */
  it("ne boucle pas sur un clip sous-titré dont aucun mot ne tombe dans les segments", async () => {
    // Le transcript existe, mais loin des segments du clip par défaut
    // (`[100, 115.7]` et `[130, 140]`).
    writeTranscript([CLIP_SEGMENT_OUTSIDE])
    putClip(getDb(), clip({ captions: true }))
    const paths = pathsRender(ID, CLIP, '1:1')

    await renderClip(CLIP, { db: getDb(), brandDir })
    const fingerprint = lireFingerprint(paths.fingerprint)
    expect(fingerprint?.captions).toBe(true)
    expect(fingerprint?.captionsLook).toBeNull()
    expect(fingerprint?.captionsContent).toBeNull()

    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(true)
    expect(encodings).toEqual([])
  })

  /**
   * **Le passage `string → null` que le point 4 ne couvrait pas.** Le test
   * ci-dessus prouve `null → null` ; il passerait même si `null` était traité
   * comme « pas sondé » plutôt que comme « sondé, rien à incruster ». Celui-ci
   * part d'un document réel, puis vide de mots les segments du clip : le
   * rendu doit se refaire, et l'empreinte finale doit porter `null`.
   * (relevé par Copilot)
   */
  it('périme le rendu quand le document passe de du texte à rien à incruster', async () => {
    writeTranscript([SEGMENT_IN_CLIP])
    putClip(getDb(), clip({ captions: true }))
    const paths = pathsRender(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    expect(lireFingerprint(paths.fingerprint)?.captionsContent).toBeTypeOf('string')

    // Plus aucun mot ne tombe dans les segments du clip : le document passe à
    // `null`, et ce n'est plus le même `null` qu'un clip sans sous-titres.
    writeTranscript([CLIP_SEGMENT_OUTSIDE])
    encodings = []
    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(false)
    expect(encodings).toContain(paths.variant9x16)
    expect(lireFingerprint(paths.fingerprint)?.captionsContent).toBeNull()
  })

  /**
   * **Le repli local d'abord, le sondage du montage seulement à l'échec**
   * (relevé par Copilot et Aristarque). `currentCaptionsDocument` sondait le
   * montage avant même de laisser `projectTranscript` essayer son repli dans
   * le projet — cassant la garantie que son propre commentaire annonçait. Ce
   * test pose le montage comme muet et un transcript dans le seul repli du
   * projet : sans le correctif, il lève « le dossier des replays ne répond
   * pas » avant d'avoir seulement essayé.
   */
  it("utilise le repli du projet sans sonder le montage quand il y répond", async () => {
    writeTranscriptFallback([SEGMENT_IN_CLIP])
    editingRespond = false
    putClip(getDb(), clip({ captions: true }))
    const paths = pathsRender(ID, CLIP, '1:1')

    const result = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(result.skipped).toBe(false)
    expect(lireFingerprint(paths.fingerprint)?.captionsContent).toBeTypeOf('string')
  })
})

/**
 * **Le point le plus facile à casser du contrat de PR3** : le doublage ne
 * touche que la variante 9:16, jamais le natif. `framingOverride` impose un
 * cadrage résolu directement (pas d'`analysis.json` ni de détecteur à
 * piloter) pour poser un pavé de doublage sur l'unique plan du clip, avec et
 * sans, et comparer l'argv **réellement construit** pour le natif — pas son
 * seul résultat sur disque, qui serait identique même si le filtre avait
 * changé.
 */
describe('la composition du doublage', () => {
  const CELLS: DubbingCells = {
    film: { x0: 0, y0: 0, x1: 1, y1: 1 },
    pip: { x0: 0.773, y0: 0.022, x1: 0.988, y1: 0.222 },
    strip: { x0: 0, y0: 0.9, x1: 1, y1: 1 },
  }

  function withOneShot(dubbing?: DubbingCells): ResolvedFraming {
    return {
      ratio: '1:1',
      origin: 'no-analysis',
      rejectedOverrides: [],
      shots: [
        {
          shot: { start: 0, end: 1000 },
          key: 0,
          ratio: '1:1',
          cropX: 0.5,
          cropXNative: 0.5,
          source: 'manual',
          dubbing,
        },
      ],
    }
  }

  it('ne bouge pas d’un octet l’argv du natif, avec ou sans pavé de doublage sur le plan', async () => {
    renderNativeOverride = true
    putClip(getDb(), clip())
    const paths = pathsRender(ID, CLIP, '1:1')
    if (paths.mp4 === null || paths.variant9x16 === null) {
      throw new Error('ce clip devrait produire les deux sorties')
    }

    framingOverride = withOneShot(undefined)
    await renderClip(CLIP, { db: getDb(), brandDir })
    const nativeWithout = capturedArgs[paths.mp4]
    const variantWithout = capturedArgs[paths.variant9x16]
    expect(nativeWithout).toBeDefined()
    expect(variantWithout.join(' ')).not.toContain('geq=')

    fs.rmSync(paths.fingerprint, { force: true })
    encodings = []
    capturedArgs = {}
    framingOverride = withOneShot(CELLS)
    const result = await renderClip(CLIP, { db: getDb(), brandDir })
    const nativeWith = capturedArgs[paths.mp4]
    const variantWith = capturedArgs[paths.variant9x16]

    expect(result.skipped).toBe(false)
    // Le natif : le même argv, au caractère près.
    expect(nativeWith).toEqual(nativeWithout)
    // La variante, elle, a bien changé — sinon la comparaison ci-dessus ne
    // prouverait rien : les deux rendus seraient simplement identiques.
    expect(variantWith).not.toEqual(variantWithout)
    expect(variantWith.join(' ')).toContain('geq=')
  })
})
