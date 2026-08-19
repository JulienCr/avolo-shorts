import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PATCH as patchClipRoute } from '@/app/api/clips/[id]/route'
import { DEFAULT_CAPTION_STYLE } from '@/core/captions/ass'
import type { Clip } from '@/core/edl'
import { closeDb, getClip, getDb, putClip, upsertProject } from '@/server/db'
import type { Artefact, OptionsArtefact } from '@/server/ffmpeg'
import type { Sondage } from '@/server/ffprobe'
import { sortieNommée, sortiesDuClip } from '@/server/rendus'
import {
  cheminsRendu,
  lireEmpreinte,
  renderClip,
  VERSION_EMPREINTE,
} from '@/server/steps/render'

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

/**
 * `true` par défaut pour tous les tests de ce fichier — seul celui qui vérifie
 * l'ordre du repli local dans `currentCaptionsDocument` le bascule à `false`.
 */
let montageRéponds = true

vi.mock('@/server/steps/ingest', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/steps/ingest')>()
  return {
    ...original,
    montageRépond: async (): Promise<boolean> => montageRéponds,
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
  montageRéponds = true

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

type SegmentDeTranscript = {
  start: number
  end: number
  text: string
  words: { word: string; start: number; end: number }[]
}

/** Écrit le transcript à côté de l'original, avec les segments donnés. */
function écrireTranscript(segments: SegmentDeTranscript[]): void {
  const dossier = path.join(replay, `${ID}.avolo`)
  fs.mkdirSync(dossier, { recursive: true })
  fs.writeFileSync(path.join(dossier, 'transcript.json'), JSON.stringify({ language: 'fr', segments }))
}

/**
 * Le repli du transcript **dans le projet**, distinct de celui à côté de
 * l'original qu'écrit `écrireTranscript`. C'est celui que `chercherSidecar`
 * consulte en premier, avant tout sondage du montage.
 */
function écrireTranscriptRepli(segments: SegmentDeTranscript[]): void {
  const dossier = path.join(projets, ID, `${ID}.avolo`)
  fs.mkdirSync(dossier, { recursive: true })
  fs.writeFileSync(path.join(dossier, 'transcript.json'), JSON.stringify({ language: 'fr', segments }))
}

/**
 * Un transcript minuscule à côté de l'original, pour les cas qui incrustent
 * vraiment des sous-titres. Les autres tournent avec `captions: false`.
 */
function poserTranscript(): void {
  écrireTranscript([
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
function marquesIncrustées(chemin: string): string[] {
  return (lireEmpreinte(chemin)?.marques ?? []).map((m) => m.nom)
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
    for (const chemin of [chemins.mp4, chemins.variant9x16, chemins.texts, chemins.empreinte]) {
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

  it("laisse gagner la base aussi quand c'est le PATCH qui écrit en dernier", async () => {
    // L'autre sens, et c'est la même règle : le `.txt` porte l'état de la base
    // au moment de son écriture, quel que soit le chemin qui l'écrit.
    putClip(getDb(), clip())
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })

    await patcher({ title: 'Retitré après coup' })

    expect(fs.readFileSync(chemins.texts, 'utf8')).toContain('Retitré après coup')
  })
})

/**
 * **Le quatrième cas de l'issue**, mesuré sur les trois rendus du 18 août : ils
 * ne portent aucune marque incrustée alors que `branding` valait `true` au rendu
 * comme aujourd'hui. Aucune empreinte n'existait pour le dire, et
 * `sauterLeRendu` constatant des fichiers, l'export les sautait pour toujours.
 */
describe('un rendu sans empreinte, déjà sur le disque', () => {
  it('est refait plutôt que sauté, sans avoir à connaître --force', async () => {
    putClip(getDb(), clip())
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    poser([chemins.mp4, chemins.variant9x16, chemins.texts])

    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(false)
    expect(encodages).toEqual([chemins.mp4, chemins.variant9x16])
    // Et il en laisse une, donc le cas ne se reproduit qu'une fois par clip.
    expect(marquesIncrustées(chemins.empreinte)).toEqual(['logo.png', 'twitch.png'])
  })

  it('le dit au journal, plutôt que de refaire en silence', async () => {
    putClip(getDb(), clip())
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    poser([chemins.mp4, chemins.variant9x16, chemins.texts])

    const messages: string[] = []
    const avant = console.warn
    console.warn = (...args: unknown[]) => void messages.push(args.join(' '))
    try {
      await renderClip(CLIP, { db: getDb(), brandDir })
    } finally {
      console.warn = avant
    }

    expect(messages.some((m) => m.includes('aucune empreinte'))).toBe(true)
  })

  it("se tait sous `force`, où la décision ne vient pas de l'empreinte", async () => {
    putClip(getDb(), clip())
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    poser([chemins.mp4, chemins.variant9x16, chemins.texts])

    const messages: string[] = []
    const avant = console.warn
    console.warn = (...args: unknown[]) => void messages.push(args.join(' '))
    try {
      await renderClip(CLIP, { db: getDb(), brandDir, force: true })
    } finally {
      console.warn = avant
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
    expect(marquesIncrustées(cheminsRendu(ID, CLIP, '1:1').empreinte)).toEqual(['logo.png'])

    fs.writeFileSync(path.join(brandDir, 'twitch.png'), 'pas vraiment un PNG')
    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(false)
    expect(marquesIncrustées(cheminsRendu(ID, CLIP, '1:1').empreinte)).toEqual([
      'logo.png',
      'twitch.png',
    ])
  })

  it('périme le rendu quand une marque est retirée du dossier', async () => {
    putClip(getDb(), clip())
    await renderClip(CLIP, { db: getDb(), brandDir })

    fs.rmSync(path.join(brandDir, 'twitch.png'))
    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(false)
    expect(marquesIncrustées(cheminsRendu(ID, CLIP, '1:1').empreinte)).toEqual(['logo.png'])
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

    for (const nom of ['logo.png', 'twitch.png']) fs.rmSync(path.join(brandDir, nom))
    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(true)
    expect(encodages).toEqual([])
  })
  /**
   * **Le nom ne suffit pas**, et c'est la façon normale de changer de marque :
   * les deux fichiers portent des noms fixes, on remplace le contenu sous le
   * même nom. Une empreinte réduite aux noms sauterait l'export et continuerait
   * de livrer l'ancienne image. (relevé par Codex)
   */
  it('périme le rendu quand un logo est remplacé sous le même nom', async () => {
    putClip(getDb(), clip())
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    const avant = lireEmpreinte(chemins.empreinte)?.marques

    fs.writeFileSync(path.join(brandDir, 'logo.png'), 'une tout autre image')
    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(false)
    expect(encodages).toContain(chemins.mp4)
    // Le nom n'a pas bougé, le contenu si.
    expect(marquesIncrustées(chemins.empreinte)).toEqual(['logo.png', 'twitch.png'])
    expect(lireEmpreinte(chemins.empreinte)?.marques).not.toEqual(avant)
  })

  it('ne périme rien quand le fichier est réécrit à l’identique', async () => {
    // Une synchronisation de dossier change la date sans changer l'image :
    // c'est pourquoi l'empreinte porte un condensat et non un `mtime`.
    putClip(getDb(), clip())
    await renderClip(CLIP, { db: getDb(), brandDir })

    fs.writeFileSync(path.join(brandDir, 'logo.png'), 'pas vraiment un PNG')
    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(true)
    expect(encodages).toEqual([])
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
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    poser([chemins.mp4, chemins.variant9x16, chemins.texts])

    const sorties = sortiesDuClip(c)

    expect(sorties.mp4Url).toBeNull()
    expect(sorties.textsUrl).toBeNull()
    expect(sorties.variant9x16Url).toBeNull()
    // **Mais la variante reste due**, et le `null` ci-dessus ne veut pas dire
    // « n'existera jamais » : les deux `null` ne se confondent pas.
    expect(sorties.variant9x16Due).toBe(true)
  })

  it('les publie dès que l’export a laissé son empreinte', async () => {
    putClip(getDb(), clip())
    await renderClip(CLIP, { db: getDb(), brandDir })

    const àJour = getClip(getDb(), CLIP)
    expect(àJour?.status).toBe('exported')
    const sorties = sortiesDuClip(àJour as Clip)
    expect(sorties.mp4Url).not.toBeNull()
    expect(sorties.variant9x16Url).not.toBeNull()
    expect(sorties.textsUrl).not.toBeNull()
  })

  it("ne sert pas l'empreinte comme si elle était une sortie", async () => {
    putClip(getDb(), clip())
    await renderClip(CLIP, { db: getDb(), brandDir })
    const àJour = getClip(getDb(), CLIP) as Clip

    expect(sortieNommée(àJour, `${CLIP}.rendu.json`)).toBeNull()
    // Le contrôle vaut quelque chose : le vrai nom, lui, se sert.
    expect(sortieNommée(àJour, `${CLIP}.mp4`)).not.toBeNull()
  })

  it("cesse de les publier quand un PATCH périme le rendu, empreinte comprise", async () => {
    putClip(getDb(), clip())
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    expect(fs.existsSync(chemins.empreinte)).toBe(true)

    await patcher({ cropX: 0.1 })

    expect(fs.existsSync(chemins.empreinte)).toBe(false)
    expect(fs.existsSync(chemins.mp4)).toBe(false)
    expect(getClip(getDb(), CLIP)?.status).toBe('kept')
  })
})

/** La recette de rendu, et le seul champ de l'empreinte qui ne décrive pas le clip. */
describe('la version de recette', () => {
  it('périme un rendu produit sous une version antérieure', async () => {
    putClip(getDb(), clip())
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })

    const empreinte = lireEmpreinte(chemins.empreinte)
    expect(empreinte?.version).toBe(VERSION_EMPREINTE)
    fs.writeFileSync(
      chemins.empreinte,
      JSON.stringify({ ...empreinte, version: VERSION_EMPREINTE - 1 }),
    )

    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(false)
    expect(encodages).toContain(chemins.mp4)
  })
})

/**
 * Le preset de sous-titres : il change l'image, donc il entre dans l'empreinte.
 * (relevé par Copilot)
 */
describe('le preset de sous-titres', () => {
  const AUTRE = { ...DEFAULT_CAPTION_STYLE, fontSize: DEFAULT_CAPTION_STYLE.fontSize + 8 }

  it("ne laisse pas sauter un rendu produit avec un autre preset", async () => {
    poserTranscript()
    putClip(getDb(), clip({ captions: true }))
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir, style: AUTRE })
    expect(lireEmpreinte(chemins.empreinte)?.sousTitres).toBeTypeOf('string')

    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(false)
    expect(encodages).toContain(chemins.mp4)
  })

  it('saute quand le preset est le même — le cas nominal reste vrai', async () => {
    poserTranscript()
    putClip(getDb(), clip({ captions: true }))
    await renderClip(CLIP, { db: getDb(), brandDir, style: AUTRE })

    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir, style: AUTRE })

    expect(résultat.skipped).toBe(true)
    expect(encodages).toEqual([])
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
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    const polices = path.join(racine, 'fonts')
    await renderClip(CLIP, { db: getDb(), brandDir, fontsDir: polices })
    const sansPolice = lireEmpreinte(chemins.empreinte)?.sousTitres

    // Anton arrive.
    fs.mkdirSync(polices, { recursive: true })
    fs.writeFileSync(path.join(polices, 'Anton-Regular.ttf'), 'pas vraiment une police')
    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir, fontsDir: polices })

    expect(résultat.skipped).toBe(false)
    expect(encodages).toContain(chemins.mp4)
    expect(lireEmpreinte(chemins.empreinte)?.sousTitres).not.toBe(sansPolice)
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
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    const polices = path.join(racine, 'fonts')
    fs.mkdirSync(polices, { recursive: true })
    fs.writeFileSync(path.join(polices, 'Anton-Regular.ttf'), 'la version d’hier')
    await renderClip(CLIP, { db: getDb(), brandDir, fontsDir: polices })
    const avant = lireEmpreinte(chemins.empreinte)?.sousTitres

    fs.writeFileSync(path.join(polices, 'Anton-Regular.ttf'), 'la version d’aujourd’hui')
    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir, fontsDir: polices })

    expect(résultat.skipped).toBe(false)
    expect(lireEmpreinte(chemins.empreinte)?.sousTitres).not.toBe(avant)
  })

  it("ignore un fichier du dossier qui n'est pas une police", async () => {
    // Le condensat ne doit pas réagir à un `README.md` déposé à côté d'Anton :
    // libass ne le chargera pas.
    poserTranscript()
    putClip(getDb(), clip({ captions: true }))
    const polices = path.join(racine, 'fonts')
    fs.mkdirSync(polices, { recursive: true })
    fs.writeFileSync(path.join(polices, 'Anton-Regular.ttf'), 'pas vraiment une police')
    await renderClip(CLIP, { db: getDb(), brandDir, fontsDir: polices })

    fs.writeFileSync(path.join(polices, 'README.md'), 'où trouver Anton')
    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir, fontsDir: polices })

    expect(résultat.skipped).toBe(true)
    expect(encodages).toEqual([])
  })

  it("ne note aucun preset quand aucun mot ne tombe dans les segments", async () => {
    // Le clip demande des sous-titres, le transcript n'en fournit aucun sur ses
    // segments : le rendu part sans, et l'empreinte le consigne plutôt que de
    // certifier un preset qui n'a rien décrit.
    poserTranscript()
    putClip(getDb(), clip({ captions: true, segments: [{ start: 800, end: 820 }] }))
    const chemins = cheminsRendu(ID, CLIP, '1:1')

    await renderClip(CLIP, { db: getDb(), brandDir })

    const empreinte = lireEmpreinte(chemins.empreinte)
    expect(empreinte?.captions).toBe(true)
    expect(empreinte?.sousTitres).toBeNull()
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
    const chemins = cheminsRendu(ID, CLIP, '1:1')

    pendantLEncodage = () => {
      fs.writeFileSync(path.join(brandDir, 'logo.png'), 'un logo tout neuf')
    }

    await expect(renderClip(CLIP, { db: getDb(), brandDir })).rejects.toThrow(
      /ne sont plus celles qui ont servi/,
    )
    // Aucune empreinte : l'export suivant refera les deux sorties.
    expect(fs.existsSync(chemins.empreinte)).toBe(false)
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
    const chemins = cheminsRendu(ID, CLIP, '1:1')

    pendantLEncodage = () => {
      for (const nom of ['logo.png', 'twitch.png']) fs.rmSync(path.join(brandDir, nom))
    }

    await expect(renderClip(CLIP, { db: getDb(), brandDir })).rejects.toThrow(
      /ne sont plus celles qui ont servi/,
    )
    expect(fs.existsSync(chemins.empreinte)).toBe(false)
  })

  /**
   * **L'empreinte d'avant part avant le premier encodage.** Elle certifie les
   * MP4 qu'on remplace : la laisser le temps des deux ffmpeg laisse
   * `livraisonÀJour` répondre vrai sur une paire à moitié réécrite, et rien ne
   * le signale puisqu'un `GET` ne sonde pas le dossier des marques.
   * (relevé par Copilot)
   */
  it("n'attend pas la fin du rendu pour retirer l'empreinte d'avant", async () => {
    putClip(getDb(), clip())
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    expect(fs.existsSync(chemins.empreinte)).toBe(true)

    // Le dossier change, donc le rendu se refait ; il échoue en cours de route.
    fs.writeFileSync(path.join(brandDir, 'logo.png'), 'un logo tout neuf')
    pendantLEncodage = () => {
      throw new Error('ffmpeg a rendu l’âme')
    }

    await expect(renderClip(CLIP, { db: getDb(), brandDir })).rejects.toThrow(/l’âme/)
    // Plus rien ne certifie ce qui reste sur le disque.
    expect(fs.existsSync(chemins.empreinte)).toBe(false)
    const àJour = getClip(getDb(), CLIP) as Clip
    expect(sortiesDuClip(àJour).mp4Url).toBeNull()
  })
})

/**
 * **Le texte réellement porté par les sous-titres (issue #87).** Avant ce
 * correctif, une correction du transcript qui ne touche aucun segment d'aucun
 * clip laissait `sauterLeRendu` reprendre un MP4 qui portait encore les
 * anciens mots — le neuvième chemin de la famille de défauts que #48 avait
 * coûté cher à fermer.
 *
 * Les segments du clip par défaut sont `[100, 115.7]` et `[130, 140]` : le
 * premier transcript de test tombe dedans, un second segment à `[500, 510]`
 * en est délibérément loin pour le point 3.
 */
describe('le texte des sous-titres (#87)', () => {
  /** Les deux segments par défaut du clip de ce fichier, en transcript. */
  const SEGMENT_DANS_LE_CLIP: SegmentDeTranscript = {
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
  const SEGMENT_HORS_DU_CLIP: SegmentDeTranscript = {
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
    écrireTranscript([SEGMENT_DANS_LE_CLIP])
    putClip(getDb(), clip({ captions: true }))
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    const avant = lireEmpreinte(chemins.empreinte)?.captionsContent
    expect(avant).toBeTypeOf('string')

    // Le transcript est réécrit à l'identique — une resynchronisation de
    // dossier, par exemple — avant le second passage.
    écrireTranscript([SEGMENT_DANS_LE_CLIP])
    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(true)
    expect(encodages).toEqual([])
    expect(lireEmpreinte(chemins.empreinte)?.captionsContent).toBe(avant)
  })

  /** Le point 2 : un mot dans un segment du clip. */
  it("périme le rendu quand un mot d'un segment du clip change", async () => {
    écrireTranscript([SEGMENT_DANS_LE_CLIP])
    putClip(getDb(), clip({ captions: true }))
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    const avant = lireEmpreinte(chemins.empreinte)?.captionsContent

    écrireTranscript([
      {
        ...SEGMENT_DANS_LE_CLIP,
        words: SEGMENT_DANS_LE_CLIP.words.map((m) => (m.word === 'vanne' ? { ...m, word: 'blague' } : m)),
      },
    ])
    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(false)
    expect(encodages).toContain(chemins.mp4)
    expect(lireEmpreinte(chemins.empreinte)?.captionsContent).not.toBe(avant)
  })

  /**
   * Le point 3 : un mot change dans l'émission, mais hors des segments
   * retenus par ce clip. La correction porte sur `SEGMENT_HORS_DU_CLIP`, à
   * `[500, 510]`, loin des deux segments du clip par défaut.
   */
  it("ne périme rien quand un mot change ailleurs dans l'émission, hors des segments du clip", async () => {
    écrireTranscript([SEGMENT_DANS_LE_CLIP, SEGMENT_HORS_DU_CLIP])
    putClip(getDb(), clip({ captions: true }))
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    const avant = lireEmpreinte(chemins.empreinte)?.captionsContent
    // **Sans elle, ce test passe à vide sous ablation.** `avant` et la relecture
    // valent tous deux `undefined` si `captionsContent` n'existe pas : l'égalité
    // ne prouve alors rien. C'est le seul des quatre à devoir le dire
    // explicitement, puisque c'est le seul dont l'assertion finale est une
    // non-égalité entre deux lectures plutôt qu'un type ou un changement.
    expect(avant).toBeTypeOf('string')

    écrireTranscript([
      SEGMENT_DANS_LE_CLIP,
      {
        ...SEGMENT_HORS_DU_CLIP,
        words: SEGMENT_HORS_DU_CLIP.words.map((m) =>
          m.word === 'aparté' ? { ...m, word: 'aparté-corrigé' } : m,
        ),
      },
    ])
    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(true)
    expect(encodages).toEqual([])
    expect(lireEmpreinte(chemins.empreinte)?.captionsContent).toBe(avant)
  })

  /**
   * Le point 4 : `captions: false` garde une empreinte stable quoi qu'il
   * arrive au transcript — y compris un changement dans les segments mêmes du
   * clip, qui périmerait un clip sous-titré.
   */
  it("garde une empreinte stable pour un clip sans sous-titres, quoi qu'il arrive au transcript", async () => {
    écrireTranscript([SEGMENT_DANS_LE_CLIP])
    putClip(getDb(), clip({ captions: false }))
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    expect(lireEmpreinte(chemins.empreinte)?.captionsContent).toBeNull()

    écrireTranscript([
      {
        ...SEGMENT_DANS_LE_CLIP,
        words: SEGMENT_DANS_LE_CLIP.words.map((m) => (m.word === 'vanne' ? { ...m, word: 'blague' } : m)),
      },
    ])
    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(true)
    expect(encodages).toEqual([])
    expect(lireEmpreinte(chemins.empreinte)?.captionsContent).toBeNull()
  })

  /**
   * **La boucle que #48 avait rencontrée, et pour laquelle la comparaison du
   * texte avait été écartée à l'époque.** Un clip qui demande des sous-titres
   * mais dont aucun mot ne tombe dans ses segments rend un document `null` —
   * `sousTitresDuClip` le dit, `writeCaptionsDocument` le journalise sans
   * échouer. `captionsContent` vaut alors `null` dans l'empreinte, exactement
   * comme un clip sans sous-titres : la seconde lecture compare `null` à
   * `null`, ne trouve aucun écart, et l'export ne se reprend pas indéfiniment.
   * Rien ne garantissait ça par construction avant ce test — seulement une
   * lecture du code.
   */
  it("ne boucle pas sur un clip sous-titré dont aucun mot ne tombe dans les segments", async () => {
    // Le transcript existe, mais loin des segments du clip par défaut
    // (`[100, 115.7]` et `[130, 140]`).
    écrireTranscript([SEGMENT_HORS_DU_CLIP])
    putClip(getDb(), clip({ captions: true }))
    const chemins = cheminsRendu(ID, CLIP, '1:1')

    await renderClip(CLIP, { db: getDb(), brandDir })
    const empreinte = lireEmpreinte(chemins.empreinte)
    expect(empreinte?.captions).toBe(true)
    expect(empreinte?.sousTitres).toBeNull()
    expect(empreinte?.captionsContent).toBeNull()

    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(true)
    expect(encodages).toEqual([])
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
    écrireTranscript([SEGMENT_DANS_LE_CLIP])
    putClip(getDb(), clip({ captions: true }))
    const chemins = cheminsRendu(ID, CLIP, '1:1')
    await renderClip(CLIP, { db: getDb(), brandDir })
    expect(lireEmpreinte(chemins.empreinte)?.captionsContent).toBeTypeOf('string')

    // Plus aucun mot ne tombe dans les segments du clip : le document passe à
    // `null`, et ce n'est plus le même `null` qu'un clip sans sous-titres.
    écrireTranscript([SEGMENT_HORS_DU_CLIP])
    encodages = []
    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(false)
    expect(encodages).toContain(chemins.mp4)
    expect(lireEmpreinte(chemins.empreinte)?.captionsContent).toBeNull()
  })

  /**
   * **Le repli local d'abord, le sondage du montage seulement à l'échec**
   * (relevé par Copilot et Aristarque). `currentCaptionsDocument` sondait le
   * montage avant même de laisser `transcriptDuProjet` essayer son repli dans
   * le projet — cassant la garantie que son propre commentaire annonçait. Ce
   * test pose le montage comme muet et un transcript dans le seul repli du
   * projet : sans le correctif, il lève « le dossier des replays ne répond
   * pas » avant d'avoir seulement essayé.
   */
  it("utilise le repli du projet sans sonder le montage quand il y répond", async () => {
    écrireTranscriptRepli([SEGMENT_DANS_LE_CLIP])
    montageRéponds = false
    putClip(getDb(), clip({ captions: true }))
    const chemins = cheminsRendu(ID, CLIP, '1:1')

    const résultat = await renderClip(CLIP, { db: getDb(), brandDir })

    expect(résultat.skipped).toBe(false)
    expect(lireEmpreinte(chemins.empreinte)?.captionsContent).toBeTypeOf('string')
  })
})
