import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET as serveRender } from '@/app/api/clips/[id]/renders/[file]/route'
import { GET as getClipRoute, PATCH as patchClipRoute } from '@/app/api/clips/[id]/route'
import { GET as getCandidates } from '@/app/api/projects/[id]/candidates/route'
import { GET as getProject } from '@/app/api/projects/[id]/route'
import { POST as postRun } from '@/app/api/projects/[id]/run/route'
import { POST as postStop } from '@/app/api/projects/[id]/stop/route'
import { GET as getSettingsRoute, PUT as putSettingsRoute } from '@/app/api/settings/route'
import { GET as listProjects, POST as postProjects } from '@/app/api/projects/route'
import { GET as listSources } from '@/app/api/sources/route'
import { DEFAULT_CAPTION_STYLE } from '@/core/captions/ass'
import type { Clip } from '@/core/edl'
import { DEFAULT_SELECTION_DIMENSIONS } from '@/core/transcript'
import { FRAMING_SETTINGS_DEFAULTS, HOOK_DEFAULTS } from '@/lib/api'
import type {
  CandidateClip,
  ClipDetail,
  PatchClipResult,
  ProjectListItem,
  ProjectStatus,
  ProjectSummary,
  SourcesListing,
} from '@/lib/api'
import { applySettings, closeDb, getClip, getDb, putClip, schedulePublications, upsertProject } from '@/server/db'
import { pendingHookBackfills } from '@/server/steps/hook-backfill'
import { statusFor } from '@/server/http'
import { clipFraming } from '@/server/clip-framing'
import { analysisPath } from '@/server/paths'
import { POINT, POINT_COUNT } from '@/core/shots'
import type { PersonBox } from '@/core/shots'
import {
  renderedFraming,
  pathsRender,
  renderFingerprint,
  renderedShape,
} from '@/server/steps/render'
import { launch, lireStatus, progression } from '@/server/run'
import { GeminiBlockedError } from '@/server/steps/candidates'
import { vignettePath } from '@/server/thumbs'

/**
 * Les routes, appelées comme Next les appelle.
 *
 * Ce qui se vérifie ici est **ce qui ne doit pas traverser la frontière** :
 * les chemins absolus du serveur, un statut `exported` posé par le client, un
 * champ d'identité modifié en douce, et une liste de segments qui se chevauche.
 * Quatre défauts silencieux, chacun visible seulement le jour où il coûte
 * quelque chose.
 */

const PROJECT = '2026-01-11-méchante'
const CLIP = `${PROJECT}_000060000-000090000`

let root: string

/** Le contexte que Next passe : des paramètres déjà décodés, dans une promesse. */
function context(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

/** Idem, pour la route qui sert un fichier de rendu nommé. */
function contextRender(id: string, file: string): { params: Promise<{ id: string; file: string }> } {
  return { params: Promise.resolve({ id, file }) }
}

/** Rend une liste de clips vide : `runCandidates` en rend une, l'étape témoin aussi. */
function resolveEmpty(resolve: (clips: Clip[]) => void): void {
  resolve([])
}

/** Un `status.json` posé à la main, comme une exécution terminée l'aurait écrit. */
function poserStatus(fields: Record<string, unknown>): void {
  const folder = path.join(root, 'projects', PROJECT)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(
    path.join(folder, 'status.json'),
    JSON.stringify({
      pid: 1,
      updatedAt: 0,
      targets: ['candidates'],
      plan: ['candidates'],
      running: null,
      error: null,
      finishedAt: 1,
      stopped: false,
      selectionReport: null,
      ...fields,
    }),
  )
}

/**
 * Laisse l'exécution de fond se terminer avant de rendre la main.
 *
 * `POST /run` répond 202 et laisse une promesse derrière lui. Sans cette
 * attente, elle se règlerait pendant le test suivant — dont le `beforeEach` a
 * déjà effacé le dossier sous ses pieds.
 */
async function leaveFinish(): Promise<void> {
  for (let i = 0; i < 400 && progression(PROJECT) !== null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Cent octets reconnaissables, pour distinguer une tranche du fichier entier. */
const OCTETS = Buffer.from(Array.from({ length: 100 }, (_, i) => 48 + (i % 10)))

/** Pose des fichiers dans `projects/<projet>/renders/`, comme le ferait un export. */
function poserRenders(...names: string[]): void {
  const folder = path.join(root, 'projects', PROJECT, 'renders')
  fs.mkdirSync(folder, { recursive: true })
  for (const name of names) fs.writeFileSync(path.join(folder, name), OCTETS)
}

/**
 * L'empreinte qu'un export aurait laissée à côté des rendus (#48).
 *
 * Des fichiers posés à la main ne décrivent aucun clip : sans elle, `outputs`
 * n'en publie rien — ce qui est le correctif lui-même, et pas ce que les tests
 * qui l'appellent cherchent à éprouver.
 */
function poserFingerprint(clip: Clip, markers: string[] = []): void {
  // **Le cadrage résolu**, comme `renderClip` l'écrit et comme `clipOutputs`
  // le relit : ces tests ne posent pas d'`analysis.json`, donc c'est le repli sur
  // le réglage manuel du clip. Le recalculer plutôt que de l'écrire à la main est
  // ce qui fait que l'empreinte posée ici décrit bien le clip qu'on lui donne.
  const framing = clipFraming(clip)
  const filePath = pathsRender(clip.projectId, clip.id, framing.ratio).fingerprint
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      renderFingerprint(
        renderedShape(clip, renderedFraming(framing)),
        markers.map((name) => ({
          path: name,
          nativeW: 1000,
          nativeH: 996,
          widthRatio: 0.22,
          heightCap: 0.06,
          edge: 'left' as const,
          content: `contenu-de-${name}`,
        })),
        {
          burnedIn: clip.captions,
          look: { style: DEFAULT_CAPTION_STYLE, fonts: 'peu importe : ces tests-ci ne rendent pas' },
          text: null,
        },
        // `null` : ces clips n'ont pas de hook (`hookText: ''`), voir `baseClip`.
        null,
      ),
    ),
  )
}

/** L'URL que `GET /api/clips/:id` doit publier pour un fichier de rendu. */
function urlExpected(name: string): string {
  return `/api/clips/${encodeURIComponent(CLIP)}/renders/${encodeURIComponent(name)}`
}

function baseClip(): Clip {
  return {
    id: CLIP,
    projectId: PROJECT,
    segments: [{ start: 60, end: 90 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'Le canapé',
    description: "C'était pas moi.",
    status: 'candidate',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
  }
}

/** Un transcript minuscule, à la forme de WhisperX. */
function poserTranscript(): void {
  const folder = path.join(root, 'projects', PROJECT, `${PROJECT}.avolo`)
  fs.mkdirSync(folder, { recursive: true })
  const segments = Array.from({ length: 40 }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 8,
    text: `phrase ${i}`,
    words: [
      { word: 'phrase', start: i * 10, end: i * 10 + 4 },
      { word: String(i), start: i * 10 + 4, end: i * 10 + 8 },
    ],
  }))
  fs.writeFileSync(
    path.join(folder, 'transcript.json'),
    JSON.stringify({ language: 'fr', segments }),
  )
}

/** Le journal de correction déjà là, à côté du transcript — même repli. */
function poserCorrection(): void {
  const folder = path.join(root, 'projects', PROJECT, `${PROJECT}.avolo`)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'correction.json'), JSON.stringify({ entries: [] }))
}

/**
 * Une analyse à deux personnes bien séparées, sur tout `[60, 90]` — la fenêtre
 * de `baseClip()`. Assez pour que `splitScreen` change ce que `computeFraming`
 * rend, condition nécessaire pour démontrer qu'un réglage non défaut publié
 * par `PATCH` est bien le même que celui que `GET` publie (`CLAUDE.md`, la
 * même règle que `renderIsStale`).
 */
function writeTwoPersonAnalysis(): void {
  const put = (k: number[], point: keyof typeof POINT, x: number, y: number, score: number): void => {
    k[POINT[point] * 3] = x
    k[POINT[point] * 3 + 1] = y
    k[POINT[point] * 3 + 2] = score
  }
  const keypoints = (centerX: number, eyeY: number, shoulderY: number, halfWidth: number): number[] => {
    const k = Array.from({ length: POINT_COUNT * 3 }, () => 0)
    put(k, 'NOSE', centerX, eyeY, 0.9)
    put(k, 'LEFT_EYE', centerX - 0.01, eyeY, 0.9)
    put(k, 'RIGHT_EYE', centerX + 0.01, eyeY, 0.9)
    put(k, 'LEFT_EAR', centerX - halfWidth, eyeY, 0.9)
    put(k, 'RIGHT_EAR', centerX + halfWidth, eyeY, 0.9)
    put(k, 'LEFT_SHOULDER', centerX - halfWidth, shoulderY, 0.9)
    put(k, 'RIGHT_SHOULDER', centerX + halfWidth, shoulderY, 0.9)
    return k
  }
  const box = (t: number, centerX: number, eyeY: number, shoulderY: number, halfWidth: number): PersonBox => ({
    t,
    x0: centerX - halfWidth * 2,
    x1: centerX + halfWidth * 2,
    y0: eyeY - 0.1,
    y1: shoulderY + 0.5,
    score: 0.9,
    k: keypoints(centerX, eyeY, shoulderY, halfWidth),
  })

  const boxes: PersonBox[] = []
  for (let t = 60; t < 90; t += 0.5) {
    boxes.push(box(t, 0.25, 0.3, 0.4, 0.05))
    boxes.push(box(t, 0.64, 0.35, 0.45, 0.04))
  }
  fs.mkdirSync(path.join(root, 'projects', PROJECT), { recursive: true })
  fs.writeFileSync(
    analysisPath(PROJECT),
    JSON.stringify({
      version: 2,
      keypoints: 'coco17',
      fps: 2,
      source: { w: 1920, h: 1080 },
      proxy: { w: 960, h: 540 },
      shots: [{ start: 0, end: 400 }],
      boxes,
    }),
  )
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-api-'))
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

describe('GET /api/projects', () => {
  it('ne publie ni sourcePath ni stagedPath', async () => {
    const response = await listProjects()
    expect(response.status).toBe(200)
    const projects = (await response.json()) as ProjectListItem[]

    expect(projects).toHaveLength(1)
    expect(Object.keys(projects[0]).sort()).toEqual([
      'createdAt',
      'durationSec',
      'error',
      'everRan',
      'id',
      'running',
      'stopped',
      'title',
      'warning',
    ])
    // Le corps entier, pas seulement les clés : un chemin qui se glisserait dans
    // une valeur ne se verrait pas autrement.
    expect(JSON.stringify(projects)).not.toContain(root)
  })

  /**
   * **La bibliothèque n'a pas `steps`, donc elle ne peut pas déduire l'arrêt.**
   * Une analyse arrêtée après l'ingestion ne tourne pas, n'a pas d'erreur et a
   * une durée : sans ce champ, elle est indiscernable d'une analyse finie, et
   * l'écran l'annonce « Analysée ».
   */
  it('publie l’arrêt de la dernière exécution', async () => {
    poserStatus({ stopped: true })
    const projects = (await (await listProjects()).json()) as ProjectListItem[]
    expect(projects[0].stopped).toBe(true)
  })

  /** Comme `error` : ce qu'on afficherait serait l'arrêt d'avant. */
  it('tait l’arrêt pendant qu’une exécution tourne', async () => {
    poserStatus({ stopped: true })
    poserTranscript()
    let release: (() => void) | undefined
    const blocked = new Promise<Clip[]>((resolve) => {
      release = () => resolve([])
    })
    await launch(PROJECT, ['candidates'], { steps: { runCandidates: () => blocked } })
    try {
      const projects = (await (await listProjects()).json()) as ProjectListItem[]
      expect(projects[0].running).not.toBeNull()
      expect(projects[0].stopped).toBe(false)
    } finally {
      release?.()
      await leaveFinish()
    }
  })

  /** Un `status.json` d'avant cette PR ne porte pas le champ : « pas arrêtée ». */
  it('lit un statut sans le champ comme une exécution non arrêtée', async () => {
    poserStatus({})
    const projects = (await (await listProjects()).json()) as ProjectListItem[]
    expect(projects[0].stopped).toBe(false)
  })

  it('dérive le titre du nom de fichier', async () => {
    const projects = (await (await listProjects()).json()) as ProjectSummary[]
    expect(projects[0].title).toBe('méchante — 11 janvier 2026')
  })

  /**
   * « Trois analyses en cours, une en échec » : la bibliothèque ne peut pas le
   * dire d'un `ProjectSummary`, et la seule autre forme — une requête par projet
   * — est à écarter. Elle multiplierait par vingt et un un appel qui exécute
   * `readingPresence`, lequel sonde le montage 9p avec un délai de garde : quatre
   * fils du vivier de libuv suffisent à figer le serveur entier (spec §3.1).
   */
  it('dit ce qui tourne, sans sonder le moindre artefact', async () => {
    // Le transcript et la correction déjà là : le plan se réduit au repérage,
    // seule étape qu'on remplace ici par un témoin qu'on tient en main.
    poserTranscript()
    poserCorrection()
    let release = (): void => {}
    const inCurrent = new Promise<Clip[]>((resolve) => {
      release = () => resolveEmpty(resolve)
    })
    await launch(PROJECT, ['candidates'], { steps: { runCandidates: () => inCurrent } })

    const probe = vi.spyOn(fs, 'existsSync')
    try {
      const projects = (await (await listProjects()).json()) as ProjectListItem[]
      expect(projects[0].running).toEqual({ step: 'candidates', progress: 0 })
      // **Le contrôle qui porte la décision.** `readingPresence` est fait de
      // `existsSync` : s'il revenait dans cette route, ce compteur le dirait.
      expect(probe).not.toHaveBeenCalled()
    } finally {
      probe.mockRestore()
      release()
      await leaveFinish()
    }
  })

  it('rend null quand rien ne tourne et que rien n’a échoué', async () => {
    const projects = (await (await listProjects()).json()) as ProjectListItem[]
    expect(projects[0].running).toBeNull()
    expect(projects[0].error).toBeNull()
  })

  /**
   * L'échec d'une tâche de fond n'a aucune réponse HTTP où loger : `status.json`
   * en est le seul dépositaire, et c'est un petit fichier local — ni Drive, ni
   * délai de garde.
   */
  it('remonte l’échec de la dernière exécution terminée', async () => {
    poserStatus({ error: 'Gemini a refusé le contenu de cette vidéo.' })

    const projects = (await (await listProjects()).json()) as ProjectListItem[]
    expect(projects[0].error).toContain('Gemini')
  })

  /**
   * Le même partage que `GET /api/projects/:id` : pendant qu'une exécution
   * tourne, l'échec affiché serait celui d'avant. Les deux routes doivent en
   * dire la même chose, sans quoi la bibliothèque et l'écran de projet se
   * contrediraient sur le même projet.
   */
  it('n’affiche pas l’échec d’avant pendant qu’une exécution tourne', async () => {
    poserStatus({ error: 'un échec d’avant' })
    poserTranscript()
    let release = (): void => {}
    const inCurrent = new Promise<Clip[]>((resolve) => {
      release = () => resolveEmpty(resolve)
    })
    await launch(PROJECT, ['candidates'], { steps: { runCandidates: () => inCurrent } })

    try {
      const projects = (await (await listProjects()).json()) as ProjectListItem[]
      expect(projects[0].error).toBeNull()
    } finally {
      release()
      await leaveFinish()
    }
  })
})

describe('GET /api/sources', () => {
  it('rend les replays et la ligne de montage', async () => {
    const response = await listSources()
    expect(response.status).toBe(200)
    const listing = (await response.json()) as SourcesListing

    expect(listing.sources.map((s) => s.name)).toEqual([`${PROJECT}.mp4`])
    // La source a déjà son projet : la carte y mène au lieu d'en recréer un.
    expect(listing.sources[0].projectId).toBe(PROJECT)
    expect(listing.editing.available).toBe(true)
    expect(JSON.stringify(listing.sources)).not.toContain(root)
  })

  /**
   * `REPLAY_DIR` absent de l'environnement n'est pas un montage indisponible :
   * c'est le serveur qui n'est pas monté, et personne n'y peut rien depuis
   * l'écran. Le déguiser en `disponible: false` enverrait rouvrir un lecteur
   * Windows là où il manque une ligne de `.env`.
   */
  it('rend 500 quand REPLAY_DIR n’est pas configurée', async () => {
    delete process.env.REPLAY_DIR
    const response = await listSources()
    expect(response.status).toBe(500)
    expect(((await response.json()) as { error: string }).error).toContain('REPLAY_DIR')
  })
})

describe('GET /api/projects/:id', () => {
  it('rend les étapes présentes et ce qui tourne', async () => {
    fs.mkdirSync(path.join(root, 'projects', PROJECT), { recursive: true })
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'proxy.mp4'), '')
    poserTranscript()

    const response = await getProject(new Request('http://x'), context(PROJECT))
    expect(response.status).toBe(200)
    const state = (await response.json()) as ProjectStatus
    expect(state.steps).toEqual({
      proxy: true,
      audio: false,
      transcript: true,
      correction: false,
      analysis: false,
      candidates: false,
      renders: false,
    })
    expect(state.running).toBeNull()
  })

  /**
   * Le seul chemin de retour d'un échec de tâche de fond : `lancer` a répondu 202
   * quarante minutes plus tôt, et son rejet part dans une promesse que personne
   * n'attend. (relevé par Copilot)
   */
  it('rend l’échec de la dernière exécution terminée', async () => {
    fs.mkdirSync(path.join(root, 'projects', PROJECT), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'projects', PROJECT, 'status.json'),
      JSON.stringify({
        pid: 1,
        updatedAt: 0,
        targets: ['candidates'],
        plan: ['candidates'],
        running: null,
        error: 'Gemini a bloqué le contenu de cette vidéo (PROHIBITED_CONTENT).',
        finishedAt: 1,
      }),
    )

    const state = (await (
      await getProject(new Request('http://x'), context(PROJECT))
    ).json()) as ProjectStatus
    expect(state.error).toContain('PROHIBITED_CONTENT')
  })

  /**
   * **Ce que le repérage n'a pas jugé** (spec §7.2). Quatre lots sur onze
   * reviennent `PROHIBITED_CONTENT` sur `2025-06-15-cqlp` : un tiers du
   * matériau écarté sans être jugé, et rien à l'écran ne le disait. Sans ce
   * champ, on trie vingt-cinq cartes en croyant regarder ce que l'émission a de
   * mieux, alors qu'on regarde ce qu'elle a de mieux dans les deux tiers notés.
   *
   * **Le `status.json` est posé à la main, sans qu'aucun bilan ne vive en
   * mémoire** : c'est aussi ce qui fige la persistance. Le décompte survit au
   * processus qui l'a produit, comme les propositions qu'il qualifie.
   */
  it('publie ce que le repérage n’a pas jugé', async () => {
    poserStatus({
      selectionReport: {
        windows: 83,
        scored: 51,
        rejectedBatches: 4,
        answeredBatches: 7,
        coverage: 0.6412,
        partial: false,
      },
    })

    const state = (await (
      await getProject(new Request('http://x'), context(PROJECT))
    ).json()) as ProjectStatus
    expect(state.selectionReport).toEqual({
      windows: 83,
      scored: 51,
      rejectedBatches: 4,
      answeredBatches: 7,
      coverage: 0.6412,
      partial: false,
    })
  })

  /**
   * `null` et non un objet à zéro : « aucune notation n'est décrite » n'est pas
   * « aucune fenêtre n'a été notée ». Un zéro affiché ferait annoncer une perte
   * totale sur un projet dont le repérage n'a simplement jamais tourné dans ce
   * processus.
   */
  it('rend null quand aucune notation n’est décrite', async () => {
    poserStatus({})

    const state = (await (
      await getProject(new Request('http://x'), context(PROJECT))
    ).json()) as ProjectStatus
    expect(state.selectionReport).toBeNull()
  })

  it('ne rend pas d’échec quand rien n’a jamais tourné', async () => {
    const state = (await (
      await getProject(new Request('http://x'), context(PROJECT))
    ).json()) as ProjectStatus
    expect(state.error).toBeNull()
  })

  /**
   * Les deux champs que l'écran d'analyse ne peut pas déduire : l'arrêt, qui ne
   * laisse ni `running` ni `error` ni artefact, et la taille de la source, dont
   * `stepDurationRange` a besoin pour annoncer une durée **avant** que ffprobe
   * n'ait relevé la vraie.
   */
  it('publie l’arrêt et la taille de la source', async () => {
    poserStatus({ stopped: true })
    const response = await getProject(new Request('http://x'), context(PROJECT))
    const state = (await response.json()) as ProjectStatus
    expect(state.stopped).toBe(true)
    expect(state.sizeBytes).toBe(12)
  })

  it('rend 404 sur un projet inconnu', async () => {
    const response = await getProject(new Request('http://x'), context('jamais-vu'))
    expect(response.status).toBe(404)
  })
})

describe('GET /api/projects/:id/candidates', () => {
  it('prépare l’aperçu côté serveur et laisse la vignette nulle sans proxy', async () => {
    poserTranscript()
    putClip(getDb(), baseClip())

    const response = await getCandidates(new Request('http://x'), context(PROJECT))
    const candidates = (await response.json()) as CandidateClip[]
    expect(candidates).toHaveLength(1)
    expect(candidates[0].preview).toBe('phrase 6 phrase 7 phrase 8')
    // Pas de proxy encore encodé : `null`, jamais une URL morte.
    expect(candidates[0].thumbnailUrl).toBeNull()
  })

  /**
   * Un clip est une liste : raccourcir par le milieu laisse un trou, et une carte
   * qui montrerait le texte de ce trou annoncerait ce qu'on vient d'enlever.
   * (relevé par Copilot)
   */
  it('n’aperçoit pas le texte retiré par une coupe au milieu', async () => {
    poserTranscript()
    // Deux morceaux, et vingt secondes retirées entre eux : les phrases 6 et 7
    // sont dans le clip, les phrases 8 et 9 dans le trou.
    putClip(getDb(), {
      ...baseClip(),
      segments: [
        { start: 60, end: 75 },
        { start: 100, end: 115 },
      ],
    })

    const candidates = (await (
      await getCandidates(new Request('http://x'), context(PROJECT))
    ).json()) as CandidateClip[]
    expect(candidates[0].preview).toBe('phrase 6 phrase 7 phrase 10')
    expect(candidates[0].preview).not.toContain('phrase 8')
  })

  it('propose la vignette dès que le proxy existe', async () => {
    poserTranscript()
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'proxy.mp4'), '')
    putClip(getDb(), baseClip())

    const candidates = (await (
      await getCandidates(new Request('http://x'), context(PROJECT))
    ).json()) as CandidateClip[]
    // L'identifiant porte un accent : sans encodage, l'URL serait cassée.
    expect(candidates[0].thumbnailUrl).toBe(
      `/api/clips/${encodeURIComponent(CLIP)}/thumb`,
    )
  })
})

describe('GET /api/clips/:id', () => {
  it('fenêtre le transcript sur l’étendue **d’origine**, pas sur les segments courants', async () => {
    poserTranscript()
    // L'artefact du repérage garde les bornes proposées ; l'édition n'y touche pas.
    fs.writeFileSync(
      path.join(root, 'projects', PROJECT, 'candidates.json'),
      JSON.stringify([{ ...baseClip(), segments: [{ start: 60, end: 90 }] }]),
    )
    // Le clip en base a été vidé de tous ses mots : c'est un état que l'écran de
    // clip produit, et celui où l'on a le plus besoin de relire le transcript.
    putClip(getDb(), { ...baseClip(), segments: [] })

    const response = await getClipRoute(new Request('http://x'), context(CLIP))
    expect(response.status).toBe(200)
    const detail = (await response.json()) as ClipDetail
    expect(detail.clip.segments).toEqual([])
    expect(detail.lines.length).toBeGreaterThan(0)
    // Deux minutes de contexte de part et d'autre de [60, 90].
    expect(detail.lines[0].start).toBe(0)
    expect(detail.lines[detail.lines.length - 1].end).toBeLessThanOrEqual(218)
    expect(detail.proxyUrl).toBeNull()
  })

  it('rend 404 sur un clip inconnu', async () => {
    const response = await getClipRoute(new Request('http://x'), context('jamais-vu'))
    expect(response.status).toBe(404)
  })

  /**
   * **Le cadrage résolu voyage avec le clip**, et c'est ce qui met le calcul en
   * service côté écran. `computeFraming` a besoin des plans, des boîtes de
   * personnes et des dimensions de la source ; `analysis.json` pèse deux à trois
   * méga-octets par projet, et le navigateur n'a aucune raison de le charger
   * pour dessiner un rectangle. Six appels y résolvaient « auto » eux-mêmes,
   * en rendant 9:16 en dur.
   */
  it('publie le cadrage résolu à côté du clip', async () => {
    putClip(getDb(), baseClip())

    const detail = (await (
      await getClipRoute(new Request('http://x'), context(CLIP))
    ).json()) as ClipDetail

    // Aucune analyse sur ce projet : le repli, et il se nomme.
    expect(detail.framing.origin).toBe('no-analysis')
    expect(detail.framing.ratio).toBe('9:16')
    expect(detail.framing.shots).toHaveLength(1)
    expect(detail.framing.shots[0]).toMatchObject({ ratio: '9:16', cropX: 0.5 })
    expect(detail.framing.rejectedOverrides).toEqual([])
  })

  /**
   * Les sorties. Un clip qui affiche « exporté » et dont le fichier reste
   * inatteignable, c'est la chaîne coupée à son dernier mètre : l'écran de clip
   * n'a aucun moyen de savoir ce qui a été produit ni où le lire.
   */
  it('ne promet aucune sortie tant que rien n’a été exporté', async () => {
    putClip(getDb(), baseClip())

    const detail = (await (
      await getClipRoute(new Request('http://x'), context(CLIP))
    ).json()) as ClipDetail
    expect(detail.outputs.mp4Url).toBeNull()
    expect(detail.outputs.textsUrl).toBeNull()
    expect(detail.outputs.variant9x16Url).toBeNull()
  })

  it('publie les sorties en URL, jamais en chemin du serveur', async () => {
    putClip(getDb(), { ...baseClip(), status: 'exported' })
    poserRenders(`${CLIP}.mp4`, `${CLIP}.txt`)
    poserFingerprint({ ...baseClip(), status: 'exported' })

    const response = await getClipRoute(new Request('http://x'), context(CLIP))
    const detail = (await response.json()) as ClipDetail
    expect(detail.outputs.mp4Url).toBe(urlExpected(`${CLIP}.mp4`))
    expect(detail.outputs.textsUrl).toBe(urlExpected(`${CLIP}.txt`))
    // Le corps entier : un chemin absolu qui se glisserait dans une valeur ne se
    // verrait pas autrement, et c'est l'arborescence de la machine qu'il publie.
    expect(JSON.stringify(detail)).not.toContain(root)
  })

  /**
   * Le cas que le contrat doit nommer : `variant9x16Url` vaut `null` pour deux
   * raisons opposées, et une interface qui les confond affiche « rendu
   * manquant » sur un clip parfaitement livré. `variant9x16Due` les sépare.
   */
  it('n’attend pas de variante 9:16 quand le ratio résolu l’est déjà', async () => {
    // `auto` se rabat sur 9:16 en itération 0 : la variante serait le même cadre
    // réencodé une seconde fois.
    putClip(getDb(), baseClip())
    poserRenders(`${CLIP}.mp4`, `${CLIP}.txt`, `${CLIP}-9x16.mp4`)

    const detail = (await (
      await getClipRoute(new Request('http://x'), context(CLIP))
    ).json()) as ClipDetail
    expect(detail.outputs.variant9x16Due).toBe(false)
    // Le fichier est là — abandonné par un ratio précédent — et n'est pourtant
    // pas une livraison de ce clip : le publier le ferait passer pour à jour.
    expect(detail.outputs.variant9x16Url).toBeNull()
  })

  /**
   * `status` ne devient `exported` que dans `renderClip`, une fois les fichiers
   * écrits. Des fichiers présents sous un clip qui ne le porte pas décrivent
   * donc autre chose que sa livraison. (relevé par Copilot)
   */
  it('ne publie rien tant que le clip n’est pas exporté', async () => {
    putClip(getDb(), { ...baseClip(), status: 'kept' })
    poserRenders(`${CLIP}.mp4`, `${CLIP}.txt`)

    const detail = (await (
      await getClipRoute(new Request('http://x'), context(CLIP))
    ).json()) as ClipDetail
    expect(detail.outputs.mp4Url).toBeNull()
    expect(detail.outputs.textsUrl).toBeNull()
  })

  /**
   * Les deux côtés du contrat doivent dire la même chose : `serveFile`
   * contrôle `isFile()` avant de pousser des octets, donc publier une entrée qui
   * n'est pas un fichier ordinaire annoncerait une sortie que la route des
   * rendus refuse aussitôt. (relevé par Copilot)
   */
  it('ne publie pas un dossier qui porte le nom d’un rendu', async () => {
    // **Exporté**, sans quoi le test passerait pour la mauvaise raison : la garde
    // de statut couperait avant le contrôle `isFile()`, et retirer ce dernier ne
    // ferait échouer personne. (relevé par Copilot)
    putClip(getDb(), { ...baseClip(), status: 'exported' })
    poserFingerprint({ ...baseClip(), status: 'exported' })
    fs.mkdirSync(path.join(root, 'projects', PROJECT, 'renders', `${CLIP}.mp4`), {
      recursive: true,
    })

    const detail = (await (
      await getClipRoute(new Request('http://x'), context(CLIP))
    ).json()) as ClipDetail
    expect(detail.outputs.mp4Url).toBeNull()
    // Et la route des rendus dit la même chose.
    expect(
      (await serveRender(new Request('http://x'), contextRender(CLIP, `${CLIP}.mp4`))).status,
    ).toBe(404)
  })

  it('attend la variante 9:16 dès que le ratio résolu ne l’est pas', async () => {
    putClip(getDb(), { ...baseClip(), ratio: '1:1', status: 'exported' })
    poserFingerprint({ ...baseClip(), ratio: '1:1', status: 'exported' })

    const before = (await (
      await getClipRoute(new Request('http://x'), context(CLIP))
    ).json()) as ClipDetail
    expect(before.outputs.variant9x16Due).toBe(true)
    // Due mais pas encore produite : là, `null` est bien une sortie manquante.
    expect(before.outputs.variant9x16Url).toBeNull()

    poserRenders(`${CLIP}-9x16.mp4`)
    const after = (await (
      await getClipRoute(new Request('http://x'), context(CLIP))
    ).json()) as ClipDetail
    expect(after.outputs.variant9x16Url).toBe(urlExpected(`${CLIP}-9x16.mp4`))
  })
})

describe('GET /api/clips/:id/renders/:file', () => {
  const request = (name: string, range?: string, id = CLIP): Promise<Response> =>
    serveRender(
      new Request('http://x', { headers: range === undefined ? undefined : { range } }),
      contextRender(id, name),
    )

  // **Ratio 9:16 par défaut**, pour que le natif reste dû quel que soit
  // `RENDER_NATIVE` — la plupart de ces tests portent sur le mécanisme de
  // service (octets, plages, 404), pas sur le choix natif/variante. Le seul
  // test qui a besoin d'une variante (`sert la variante 9:16...`) repose le
  // clip sous un autre ratio, localement.
  beforeEach(() => {
    putClip(getDb(), { ...baseClip(), ratio: '9:16', status: 'exported' })
    // Sans elle, la route refuse : un rendu que rien ne certifie n'est pas une
    // livraison à jour, et la porte des octets dit la même chose que celle des
    // URL. Ce que ces tests-ci éprouvent est ce qui vient après.
    poserFingerprint({ ...baseClip(), ratio: '9:16', status: 'exported' })
  })

  it('ne sert rien pour un clip que l’édition a fait sortir d’`exported`', async () => {
    poserRenders(`${CLIP}.mp4`)
    putClip(getDb(), { ...baseClip(), ratio: '1:1', status: 'kept' })
    // Le fichier est là, et c'est justement le cas qui compte : ne plus publier
    // l'URL ne suffit pas si celui qui l'a gardée peut encore la suivre.
    expect((await request(`${CLIP}.mp4`)).status).toBe(404)
  })

  it('sert le rendu natif en entier', async () => {
    poserRenders(`${CLIP}.mp4`)
    const response = await request(`${CLIP}.mp4`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-length')).toBe('100')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await response.arrayBuffer()).equals(OCTETS)).toBe(true)
  })

  it('répond aux requêtes partielles, comme le proxy', async () => {
    poserRenders(`${CLIP}.mp4`)
    const response = await request(`${CLIP}.mp4`, 'bytes=20-29')

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 20-29/100')
    expect(response.headers.get('content-length')).toBe('10')
    expect(Buffer.from(await response.arrayBuffer()).equals(OCTETS.subarray(20, 30))).toBe(true)
  })

  it('rend 416 avec la taille réelle, en gardant le `Cache-Control` de la route', async () => {
    poserRenders(`${CLIP}.mp4`)
    const response = await request(`${CLIP}.mp4`, 'bytes=500-600')

    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */100')
    // Un 416 est cacheable par heuristique : sans cet en-tête, un refus calculé
    // sur l'ancienne taille survit à un ré-export et bloque une demande devenue
    // légitime. (relevé par Copilot)
    expect(response.headers.get('cache-control')).toBe('no-cache')
  })

  it('sert la variante 9:16 et le texte de publication', async () => {
    // Un ratio natif qui n'est PAS déjà 9:16, pour que la variante soit due.
    putClip(getDb(), { ...baseClip(), ratio: '1:1', status: 'exported' })
    poserFingerprint({ ...baseClip(), ratio: '1:1', status: 'exported' })
    poserRenders(`${CLIP}-9x16.mp4`, `${CLIP}.txt`)
    expect((await request(`${CLIP}-9x16.mp4`)).status).toBe(200)

    const text = await request(`${CLIP}.txt`)
    expect(text.status).toBe(200)
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  })

  /**
   * Le nom demandé est **comparé** à ce que le clip produit, jamais joint au
   * dossier de rendus. Un nom qui ne figure pas dans cette liste ne peut donc
   * désigner aucun fichier, quelle que soit sa forme.
   */
  it('refuse un nom que ce clip ne produit pas', async () => {
    poserRenders(`${CLIP}.mp4`)
    expect((await request('autre.mp4')).status).toBe(404)
    expect((await request('../../../etc/passwd')).status).toBe(404)
    expect((await request(`../renders/${CLIP}.mp4`)).status).toBe(404)
    expect((await request('')).status).toBe(404)
  })

  it('ne sert pas le `.ass`, qui est un intermédiaire et non une sortie', async () => {
    poserRenders(`${CLIP}.ass`)
    expect((await request(`${CLIP}.ass`)).status).toBe(404)
  })

  it('refuse le rendu d’un autre clip, même bien nommé', async () => {
    const other = `${PROJECT}_000200000-000230000`
    // Exporté et certifié lui aussi : ce test porte sur le cloisonnement entre
    // clips, pas sur les règles de livraison éprouvées juste au-dessus.
    putClip(getDb(), { ...baseClip(), id: other, status: 'exported' })
    poserFingerprint({ ...baseClip(), id: other, status: 'exported' })
    poserRenders(`${other}.mp4`)
    expect((await request(`${other}.mp4`)).status).toBe(404)
    expect((await request(`${other}.mp4`, undefined, other)).status).toBe(200)
  })

  it('rend 404 tant que l’export n’a rien produit', async () => {
    expect((await request(`${CLIP}.mp4`)).status).toBe(404)
  })

  it('rend 404 sur un clip inconnu', async () => {
    expect((await request(`${CLIP}.mp4`, undefined, 'jamais-vu')).status).toBe(404)
  })

  it('n’écrit aucun chemin du serveur dans son message d’erreur', async () => {
    const response = await request(`${CLIP}.mp4`)
    expect(JSON.stringify(await response.json())).not.toContain(root)
  })
})

describe('PATCH /api/clips/:id', () => {
  /**
   * **Le point que rater coûterait le plus cher.** Le ratio et les crops se
   * recalculent sur les segments courants et ne sont pas stockés : retirer un
   * passage peut changer le cadre sous les doigts de celui qui monte. Si seul le
   * `GET` publiait le cadrage, l'écran garderait un ratio périmé jusqu'à la
   * prochaine navigation, et le montage mentirait sur ce que l'export produira.
   */
  it('renvoie le cadrage recalculé sur les segments écrits', async () => {
    putClip(getDb(), { ...baseClip(), ratio: '1:1', cropX: 0.5 })

    const response = await patchClipRoute(
      new Request('http://x', {
        method: 'PATCH',
        body: JSON.stringify({ segments: [{ start: 70, end: 80 }], cropX: 0.25 }),
      }),
      context(CLIP),
    )
    const result = (await response.json()) as PatchClipResult

    // Le cadrage suit l'écriture, pas l'état d'avant : les bornes du plan de
    // repli sont celles des segments qu'on vient d'écrire, et la position celle
    // qu'on vient de poser.
    expect(result.framing.shots[0].shot).toEqual({ start: 70, end: 80 })
    expect(result.framing.shots[0].cropX).toBe(0.25)
    expect(result.framing.ratio).toBe('1:1')
  })

  it('renvoie le cadrage même quand l’écriture a été écartée', async () => {
    putClip(getDb(), baseClip())
    const common = { method: 'PATCH' as const }

    await patchClipRoute(
      new Request('http://x', { ...common, body: JSON.stringify({ cropX: 0.8, seq: 20 }) }),
      context(CLIP),
    )
    const response = await patchClipRoute(
      new Request('http://x', { ...common, body: JSON.stringify({ cropX: 0.1, seq: 10 }) }),
      context(CLIP),
    )
    const result = (await response.json()) as PatchClipResult

    expect(result.applied).toBe(false)
    // Le cadrage décrit la base, pas l'intention refusée : c'est le seul qui
    // permette à l'écran de se remettre d'accord.
    expect(result.framing.shots[0].cropX).toBe(0.8)
  })

  const patch = (body: unknown, id = CLIP): Promise<Response> =>
    patchClipRoute(
      new Request('http://x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      context(id),
    )

  beforeEach(() => {
    putClip(getDb(), baseClip())
  })

  it('refuse `status: exported` venant du client', async () => {
    const response = await patch({ status: 'exported' })
    // Un clip devient exporté parce qu'un MP4 a été produit, jamais parce que
    // quelqu'un l'a écrit — et `mergeCandidates` le ferait survivre à toutes les
    // passes suivantes.
    expect(response.status).toBe(400)
  })

  it('refuse les champs d’identité', async () => {
    for (const body of [{ id: 'autre' }, { projectId: 'autre' }, { pass: 9 }]) {
      expect((await patch(body)).status).toBe(400)
    }
  })

  it('refuse un cropX hors de l’image', async () => {
    expect((await patch({ cropX: 1.5 })).status).toBe(400)
  })

  /**
   * Le hook sur un clip (retour d'usage §7). `hookStyle` est un
   * `z.strictObject` : une clé inconnue est un 400, comme le reste de cette
   * route (`segments`, par exemple).
   */
  it('accepte un hookText et l’enregistre', async () => {
    const response = await patch({ hookText: 'Une accroche' })
    expect(response.status).toBe(200)
    expect(((await response.json()) as PatchClipResult).clip.hookText).toBe('Une accroche')
  })

  it('accepte un hookBadge et l’enregistre', async () => {
    const response = await patch({ hookBadge: 'DÉFI 10' })
    expect(response.status).toBe(200)
    expect(((await response.json()) as PatchClipResult).clip.hookBadge).toBe('DÉFI 10')
  })

  // **120, pas 280** : le rasteriseur n'enroule pas la pastille, donc une
  // saisie longue produirait une boîte large comme le canevas.
  it('refuse un hookBadge trop long, à un plafond plus serré que le hook', async () => {
    expect((await patch({ hookBadge: 'x'.repeat(121) })).status).toBe(400)
    expect((await patch({ hookBadge: 'x'.repeat(120) })).status).toBe(200)
  })

  /**
   * **Le rattrapage part à la transition, et il ne bloque pas la réponse.**
   *
   * La sonde est l'avertissement, pas `fetch` : aucun fournisseur n'est
   * configuré dans ce fichier, donc `generateHook` échoue **avant tout appel
   * réseau** (c'est son contrat, `src/server/llm/registry.ts`) et un
   * `expect(fetch).toHaveBeenCalled()` passerait à côté du chemin qu'on teste.
   * Un avertissement de rattrapage prouve à la fois que le travail est parti
   * et que son échec est avalé — le tri ne casse pas.
   */
  const backfillWarnings = (warn: { mock: { calls: unknown[][] } }): string[] =>
    warn.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes('Rattrapage du hook'))

  /**
   * **`mockClear` à chaque prise, et ce n'est pas de la superstition.** Ce
   * fichier n'a pas de `restoreAllMocks` en `afterEach` ; un second
   * `vi.spyOn` sur une méthode déjà espionnée rend le MÊME espion, avec les
   * appels du test précédent dedans. Sans ce nettoyage, un test qui vérifie
   * qu'aucun rattrapage n'est parti lisait celui du test d'avant.
   */
  const silenceWarnings = () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warn.mockClear()
    return warn
  }

  it('garder un candidat au hook vide déclenche le rattrapage sans bloquer la réponse', async () => {
    putClip(getDb(), { ...baseClip(), status: 'candidate', hookText: '', hookBadge: '' })
    const warn = silenceWarnings()

    const response = await patch({ status: 'kept' })
    expect(response.status).toBe(200)

    // Le travail de fond a démarré : on l'attend ICI, jamais depuis la route.
    // Un délai arbitraire laisserait le rattrapage déborder sur le test
    // suivant, où son avertissement passerait pour celui d'un autre cas.
    await pendingHookBackfills()
    expect(backfillWarnings(warn)).toHaveLength(1)
    // Et le clip est gardé quoi qu'il arrive : l'échec n'a rien coûté au tri.
    expect(((await response.json()) as PatchClipResult).clip.status).toBe('kept')
  })

  it('garder un candidat qui a déjà son hook ne déclenche aucun rattrapage', async () => {
    putClip(getDb(), { ...baseClip(), status: 'candidate', hookText: 'Venu du repérage' })
    const warn = silenceWarnings()

    expect((await patch({ status: 'kept' })).status).toBe(200)
    await pendingHookBackfills()
    expect(backfillWarnings(warn)).toHaveLength(0)
  })

  it('re-garder un clip déjà gardé ne relance rien : c’est la transition qui compte', async () => {
    putClip(getDb(), { ...baseClip(), status: 'kept', hookText: '' })
    const warn = silenceWarnings()

    expect((await patch({ status: 'kept' })).status).toBe(200)
    await pendingHookBackfills()
    expect(backfillWarnings(warn)).toHaveLength(0)
  })

  it('refuse un hookText trop long', async () => {
    expect((await patch({ hookText: 'x'.repeat(281) })).status).toBe(400)
  })

  it('accepte un hookStyle et l’enregistre', async () => {
    const response = await patch({ hookStyle: { sizePermille: 150, position: 'bottom' } })
    expect(response.status).toBe(200)
    const { clip } = (await response.json()) as PatchClipResult
    expect(clip.hookStyle).toEqual({ sizePermille: 150, position: 'bottom' })
  })

  it('refuse un hookStyle avec une valeur hors bornes', async () => {
    expect((await patch({ hookStyle: { sizePermille: 5 } })).status).toBe(400)
  })

  it('refuse un hookStyle avec une clé inconnue', async () => {
    expect((await patch({ hookStyle: { unknownField: true } })).status).toBe(400)
  })

  it('refuse un hookStyle avec une couleur mal formée', async () => {
    expect((await patch({ hookStyle: { textColor: '#GG0000' } })).status).toBe(400)
  })

  it('normalise une couleur de hookStyle en majuscules, comme le registre', async () => {
    // Même contrat que la famille `hook` (`COLOR_PATTERN`, `src/server/db.ts`,
    // lignes 585-589) : `HOOK_STYLE_SHAPE` est partagé entre cette route et
    // `readHookStyle`, donc une seule normalisation doit couvrir les deux
    // chemins d'écriture — le registre global et la surcharge par clip.
    // (relevé par Copilot)
    const response = await patch({ hookStyle: { textColor: '#a1b2c3' } })
    expect(response.status).toBe(200)
    const { clip } = (await response.json()) as PatchClipResult
    expect(clip.hookStyle).toEqual({ textColor: '#A1B2C3' })
  })

  it('accepte un framingStyle et l’enregistre', async () => {
    const response = await patch({ framingStyle: { splitScreen: false, sizeFloorPermille: 250 } })
    expect(response.status).toBe(200)
    const { clip } = (await response.json()) as PatchClipResult
    expect(clip.framingStyle).toEqual({ splitScreen: false, sizeFloorPermille: 250 })
  })

  it('refuse un framingStyle avec une valeur hors bornes', async () => {
    expect((await patch({ framingStyle: { sizeFloorPermille: 9999 } })).status).toBe(400)
  })

  it('refuse un framingStyle avec une clé inconnue', async () => {
    expect((await patch({ framingStyle: { unknownField: true } })).status).toBe(400)
  })

  it('normalise les segments avant écriture', async () => {
    const response = await patch({
      segments: [
        { start: 80, end: 95 },
        { start: 60, end: 82 },
        { start: 120, end: 120 },
      ],
    })
    expect(response.status).toBe(200)
    const { clip } = (await response.json()) as PatchClipResult
    // Triés, fusionnés puisqu'ils se chevauchent, et le segment vide écarté.
    expect(clip.segments).toEqual([{ start: 60, end: 95 }])
  })

  /**
   * Un clip vidé de tous ses mots est un état légitime — c'est ce que produit
   * l'écran de clip quand on retire tout —, et deux choses s'y jouent :
   * `normalizeSegments([])` doit rendre `[]`, et la comparaison des premiers
   * segments doit tenir quand les deux valent `undefined`, sans quoi l'éviction
   * de la vignette partirait sur un clip qui n'en a jamais eu.
   * (relevé par Aristarque)
   */
  it('accepte une liste de segments vide', async () => {
    const response = await patch({ segments: [] })
    expect(response.status).toBe(200)
    expect(((await response.json()) as PatchClipResult).clip.segments).toEqual([])

    // Et une seconde fois : les deux côtés sont vides, rien ne doit lever.
    expect((await patch({ segments: [] })).status).toBe(200)
  })

  it('accepte les trois statuts humains et les enregistre', async () => {
    const response = await patch({ status: 'kept' })
    expect(response.status).toBe(200)
    expect(((await response.json()) as PatchClipResult).clip.status).toBe('kept')
    const reread = (await (
      await getClipRoute(new Request('http://x'), context(CLIP))
    ).json()) as ClipDetail
    expect(reread.clip.status).toBe('kept')
  })

  it('rejette un corps illisible', async () => {
    const response = await patchClipRoute(
      new Request('http://x', { method: 'PATCH', body: 'pas du json' }),
      context(CLIP),
    )
    expect(response.status).toBe(400)
  })

  /**
   * **Critère 5 de l'issue #205, le second piège du contrat.** À ratio égal,
   * `variantAfter` (calculé sur le clip édité) est le **même chemin** que
   * celui que `discardRenderStale` vient d'épargner : la route ne doit
   * l'effacer que sur `'discarded'`, jamais sur `'keptForSchedule'`, sous
   * peine de tout épargner d'une main pour le reprendre de l'autre.
   */
  describe('#205 : la variante survit à ratio égal, sur un clip programmé', () => {
    it('épargne la variante 9:16 déjà produite', async () => {
      putClip(getDb(), { ...baseClip(), ratio: '1:1', status: 'exported' })
      poserFingerprint({ ...baseClip(), ratio: '1:1', status: 'exported' })
      poserRenders(`${CLIP}-9x16.mp4`, `${CLIP}.txt`)
      schedulePublications(getDb(), [CLIP], Date.now() + 86_400_000, Date.now())
      const variant = path.join(root, 'projects', PROJECT, 'renders', `${CLIP}-9x16.mp4`)
      expect(fs.existsSync(variant)).toBe(true)

      // Les segments bougent, le ratio reste `1:1` : c'est exactement le cas où
      // `variantAfter` et le fichier épargné se confondent.
      const response = await patch({ segments: [{ start: 65, end: 88 }] })
      expect(response.status).toBe(200)
      expect(getClip(getDb(), CLIP)?.status).toBe('kept')
      expect(fs.existsSync(variant)).toBe(true)
    })

    /**
     * **Critère 3.** Le même geste, sans échéance : la réserve ne joue pas, et
     * la route efface `variantAfter` comme avant #205.
     */
    it("l'efface quand le clip n'a aucune échéance", async () => {
      putClip(getDb(), { ...baseClip(), ratio: '1:1', status: 'exported' })
      poserFingerprint({ ...baseClip(), ratio: '1:1', status: 'exported' })
      poserRenders(`${CLIP}-9x16.mp4`, `${CLIP}.txt`)
      const variant = path.join(root, 'projects', PROJECT, 'renders', `${CLIP}-9x16.mp4`)

      const response = await patch({ segments: [{ start: 65, end: 88 }] })
      expect(response.status).toBe(200)
      expect(getClip(getDb(), CLIP)?.status).toBe('kept')
      expect(fs.existsSync(variant)).toBe(false)
    })
  })

  /**
   * L'ordre du **geste**, pas celui de l'arrivée (issue #21).
   *
   * `usePatchClip` envoie délibérément des écritures qui se chevauchent, et rien
   * ne garantit que la première partie arrive la première. Sans jeton, la base
   * finit sur la valeur la plus ancienne — et ça ne se voit qu'au rechargement,
   * l'écran affichant, lui, la bonne.
   */
  describe('le jeton d’ordre', () => {
    const body = async (response: Response): Promise<PatchClipResult> =>
      (await response.json()) as PatchClipResult

    const titleInBase = async (): Promise<string> =>
      (
        (await (await getClipRoute(new Request('http://x'), context(CLIP))).json()) as ClipDetail
      ).clip.title

    it('applique une écriture plus récente que la dernière', async () => {
      expect((await body(await patch({ title: 'un', seq: 10 }))).applied).toBe(true)
      const result = await body(await patch({ title: 'deux', seq: 11 }))
      expect(result.applied).toBe(true)
      expect(result.clip.title).toBe('deux')
      expect(await titleInBase()).toBe('deux')
    })

    /**
     * **200, et pas 409.** Une écriture dépassée n'est pas un échec
     * d'enregistrement : c'en est une autre qui a gagné. Un code d'erreur ferait
     * afficher « la sauvegarde a échoué » sur le clip le mieux enregistré de la
     * session.
     */
    it('refuse une écriture périmée sans en faire un échec', async () => {
      await patch({ title: 'récent', seq: 20 })
      const response = await patch({ title: 'périmé', seq: 10 })

      expect(response.status).toBe(200)
      const result = await body(response)
      expect(result.applied).toBe(false)
      // Le clip **gagnant**, pas celui qu'on vient de refuser : c'est ce qui
      // permet à l'appelant de se remettre d'accord avec la base sans relire.
      expect(result.clip.title).toBe('récent')
      expect(await titleInBase()).toBe('récent')
    })

    /**
     * Le défaut inverse de #21, et il coûte plus cher : une écriture perdue
     * plutôt qu'une écriture désordonnée.
     *
     * Les patches sont partiels — l'écran de clip n'envoie que ce qui a changé,
     * l'écran de tri n'envoie que `status`. Deux gestes qui se croisent sur des
     * champs différents ne se contredisent sur rien, et un jeton par ligne
     * ferait écarter le second en entier. (relevé par Codex)
     */
    it('garde une écriture ancienne qui touche un autre champ', async () => {
      await patch({ status: 'kept', seq: 11 })
      const result = await body(await patch({ title: 'un titre plus ancien', seq: 10 }))

      expect(result.applied).toBe(true)
      expect(result.clip.title).toBe('un titre plus ancien')
      // Et le statut, plus récent, n'a pas été défait au passage.
      expect(result.clip.status).toBe('kept')
      expect(await titleInBase()).toBe('un titre plus ancien')
    })

    it('n’écarte que les champs contestés, et écrit les autres', async () => {
      await patch({ title: 'gagnant', seq: 20 })
      const result = await body(
        await patch({ title: 'perdant', status: 'discarded', seq: 15 }),
      )

      // Un champ écarté suffit à faire tomber `applied`…
      expect(result.applied).toBe(false)
      expect(result.clip.title).toBe('gagnant')
      // …mais l'autre est bien écrit : rien de ce geste n'est perdu sans raison.
      expect(result.clip.status).toBe('discarded')
    })

    it('date le jeton d’un champ réécrit à l’identique', async () => {
      // Une valeur identique reste une prise de position sur ce champ : sans
      // cela, un second geste plus ancien passerait derrière sans être vu.
      await patch({ title: 'même', seq: 30 })
      await patch({ title: 'même', seq: 40 })
      expect((await body(await patch({ title: 'ancien', seq: 35 }))).applied).toBe(false)
      expect(await titleInBase()).toBe('même')
    })

    it('rend le plancher d’ordre, de quoi se recaler après un retour d’horloge', async () => {
      await patch({ title: 'venu du futur', seq: 4_000_000_000_000 })
      // Le client dont l'horloge vient d'être corrigée envoie plus petit.
      const rejected = await body(await patch({ title: 'après correction', seq: 100 }))
      expect(rejected.applied).toBe(false)
      // La réponse porte le plancher : une seule requête suffit à l'apprendre.
      expect(rejected.seq).toBe(4_000_000_000_000)

      const resumed = await body(await patch({ title: 'recalé', seq: 4_000_000_000_001 }))
      expect(resumed.applied).toBe(true)
      expect(await titleInBase()).toBe('recalé')
    })

    it('accepte un jeton égal au dernier appliqué', async () => {
      await patch({ title: 'un', seq: 7 })
      const result = await body(await patch({ title: 'deux', seq: 7 }))
      // Deux gestes dans la même milliseconde : l'ordre est indécidable, et
      // seul le jeton **inférieur** se refuse.
      expect(result.applied).toBe(true)
      expect(await titleInBase()).toBe('deux')
    })

    it('annonce le plancher retenu même sans jeton', async () => {
      await patch({ title: 'ordonné', seq: 300 })
      const withoutToken = await body(await patch({ title: 'depuis curl' }))
      // La base garde 300 : annoncer 0 recalerait l'appelant vers le bas, donc
      // vers des jetons que le serveur refuserait aussitôt.
      expect(withoutToken.seq).toBe(300)
    })

    it('écrit sans jeton, comme le fait un appel en `curl`', async () => {
      await patch({ title: 'depuis l’interface', seq: 300 })
      const result = await body(await patch({ title: 'depuis curl' }))
      // Un appelant qui n'ordonne pas ses écritures n'a rien à faire dans cette
      // course : il écrit, et les jetons en base ne bougent pas.
      expect(result.applied).toBe(true)
      expect(await titleInBase()).toBe('depuis curl')
      expect((await body(await patch({ title: 'encore périmé', seq: 200 }))).applied).toBe(
        false,
      )
    })

    it('refuse un jeton qui n’est pas un entier', async () => {
      expect((await patch({ title: 'x', seq: 'récent' })).status).toBe(400)
      expect((await patch({ title: 'x', seq: 1.5 })).status).toBe(400)
      expect((await patch({ title: 'x', seq: -1 })).status).toBe(400)
    })

    /**
     * Un clip exporté puis remonté garde ses fichiers : le modèle de
     * l'itération 0 fait foi sur leur présence, donc `outputs` publierait une
     * vidéo qui montre le montage d'avant, et un export sans `force` la
     * sauterait. (relevé par Copilot)
     */
    it('écarte un rendu que l’édition vient de périmer', async () => {
      poserRenders(`${CLIP}.mp4`, `${CLIP}.txt`)
      putClip(getDb(), { ...baseClip(), status: 'exported' })

      const result = await body(await patch({ segments: [{ start: 61, end: 91 }], seq: 50 }))

      expect(result.applied).toBe(true)
      // Les fichiers décrivaient un montage que personne ne veut plus.
      expect(result.outputs.mp4Url).toBeNull()
      expect(fs.existsSync(path.join(root, 'projects', PROJECT, 'renders', `${CLIP}.mp4`))).toBe(
        false,
      )
      // Et le clip redevient ce qu'il est : gardé, pas exporté.
      expect(result.clip.status).toBe('kept')
    })

    /**
     * Un clip en 9:16 n'a pas de variante due, donc `pathsRender` du ratio de
     * départ ne la nomme pas et un `-9x16.mp4` abandonné y survivait. Le ratio
     * d'arrivée, lui, la rend due : `clipOutputs` la publiait aussitôt comme
     * la livraison du jour. (relevé par Copilot)
     */
    it('efface la variante abandonnée quand le ratio change de 9:16 vers 1:1', async () => {
      poserRenders(`${CLIP}.mp4`, `${CLIP}.txt`, `${CLIP}-9x16.mp4`)
      putClip(getDb(), { ...baseClip(), ratio: '9:16', status: 'exported' })

      const result = await body(await patch({ ratio: '1:1', seq: 70 }))

      expect(result.applied).toBe(true)
      // Due par le nouveau ratio, et pourtant absente : le fichier qui traînait
      // ne décrivait pas ce clip.
      expect(result.outputs.variant9x16Due).toBe(true)
      expect(result.outputs.variant9x16Url).toBeNull()
      expect(
        fs.existsSync(path.join(root, 'projects', PROJECT, 'renders', `${CLIP}-9x16.mp4`)),
      ).toBe(false)
    })

    it('laisse le rendu en place quand l’édition ne le périme pas', async () => {
      poserRenders(`${CLIP}.mp4`, `${CLIP}.txt`)
      putClip(getDb(), { ...baseClip(), status: 'exported' })
      poserFingerprint({ ...baseClip(), status: 'exported' })

      // Le titre et la description ne vont que dans le `.txt`, que l'export
      // réécrit sans réencoder : le MP4 les ignore.
      const result = await body(await patch({ title: 'Un autre titre', seq: 50 }))

      expect(result.outputs.mp4Url).toBe(urlExpected(`${CLIP}.mp4`))
      expect(result.clip.status).toBe('exported')
    })

    /**
     * Le `.txt` est une sortie publiée, et le titre y va. Le laisser tel quel
     * ferait servir un texte de publication qui n'est plus celui du clip, sans
     * qu'aucun statut ne le signale. (relevé par Copilot)
     */
    it('rafraîchit le texte de publication quand le titre change', async () => {
      poserRenders(`${CLIP}.mp4`, `${CLIP}.txt`)
      putClip(getDb(), { ...baseClip(), status: 'exported' })
      poserFingerprint({ ...baseClip(), status: 'exported' })

      const result = await body(await patch({ title: 'Un titre corrigé', seq: 60 }))

      const text = fs.readFileSync(
        path.join(root, 'projects', PROJECT, 'renders', `${CLIP}.txt`),
        'utf8',
      )
      expect(text).toContain('Un titre corrigé')
      // Les MP4 ne bougent pas : un titre ne change aucune image, et les
      // réencoder coûterait quarante secondes pour une faute de frappe.
      expect(result.outputs.mp4Url).toBe(urlExpected(`${CLIP}.mp4`))
      expect(result.clip.status).toBe('exported')
    })

    it('ne fabrique pas de texte pour un clip que rien n’a rendu', async () => {
      const result = await body(await patch({ title: 'Un titre', seq: 60 }))
      // Sinon `textsUrl` annoncerait une sortie qui n'en est pas une.
      expect(result.outputs.textsUrl).toBeNull()
      expect(
        fs.existsSync(path.join(root, 'projects', PROJECT, 'renders', `${CLIP}.txt`)),
      ).toBe(false)
    })

    /**
     * L'écriture en base est validée avant que le disque ne soit touché : une
     * erreur de système de fichiers ne doit pas rendre 500 sur un montage
     * pourtant enregistré. (relevé par Copilot)
     */
    it('n’échoue pas quand le dossier des rendus est illisible', async () => {
      poserRenders(`${CLIP}.mp4`, `${CLIP}.txt`)
      putClip(getDb(), { ...baseClip(), status: 'exported' })
      const folder = path.join(root, 'projects', PROJECT, 'renders')
      fs.chmodSync(folder, 0o500)

      try {
        const response = await patch({ segments: [{ start: 61, end: 91 }], seq: 60 })
        expect(response.status).toBe(200)
        const result = (await response.json()) as PatchClipResult
        // Le montage est enregistré, et c'est ce que la réponse porte.
        expect(result.applied).toBe(true)
        expect(result.clip.segments).toEqual([{ start: 61, end: 91 }])
        // Le fichier est toujours là : l'effacement a bien échoué, donc le test
        // éprouve le rattrapage et non un chemin où il n'y avait rien à faire.
        expect(
          fs.existsSync(path.join(root, 'projects', PROJECT, 'renders', `${CLIP}.mp4`)),
        ).toBe(true)
        // **Et il n'est plus publié.** Le statut est sorti d'`exported` malgré
        // l'échec, donc ce qui survit sur le disque n'est plus offert comme la
        // livraison du jour : c'est la seule chose qui empêche de publier la
        // vidéo d'avant sans le savoir.
        expect(result.clip.status).toBe('kept')
        expect(result.outputs.mp4Url).toBeNull()
      } finally {
        fs.chmodSync(folder, 0o700)
      }
    })

    it('rend les sorties d’un clip que rien n’a exporté', async () => {
      const result = await body(await patch({ title: 'Peu importe', seq: 50 }))
      // Le champ est là même quand il n'y a rien à publier : l'appelant tient
      // son cache dessus, et une absence de champ le laisserait sur l'ancien.
      expect(result.outputs).toEqual({
        mp4Url: null,
        mp4Due: true,
        variant9x16Url: null,
        variant9x16Due: false,
        textsUrl: null,
      })
    })

    /**
     * La vignette suit le premier segment, et `PATCH` l'efface quand il bouge.
     * Une écriture refusée n'a rien déplacé : l'effacer là ferait payer une
     * régénération à une écriture qui n'a pas eu lieu.
     */
    it('n’efface pas la vignette sur une écriture refusée', async () => {
      const vignette = vignettePath(PROJECT, CLIP)
      fs.mkdirSync(path.dirname(vignette), { recursive: true })
      fs.writeFileSync(vignette, 'jpeg')

      await patch({ segments: [{ start: 60, end: 90 }], seq: 40 })
      expect(fs.existsSync(vignette)).toBe(true)

      await patch({ segments: [{ start: 10, end: 20 }], seq: 5 })
      expect(fs.existsSync(vignette)).toBe(true)

      await patch({ segments: [{ start: 10, end: 20 }], seq: 41 })
      expect(fs.existsSync(vignette)).toBe(false)
    })
  })
})

/**
 * Le seam entre les deux routes : chacune résout le cadrage à sa façon
 * (`GET` sur le clip tel qu'il est en base, `PATCH` sur celui qu'il vient
 * d'écrire), et rien n'obligeait les deux résolutions à lire les mêmes
 * réglages globaux. `PATCH` appelle `framingWith` en direct, quatre fois,
 * pour ne pas relire `analysis.json` autour de l'écriture — un point où un
 * réglage non défaut peut se perdre en silence sans qu'aucun test ne le
 * remarque, puisque chaque route continue de rendre 200 avec un cadrage
 * plausible.
 */
describe('GET et PATCH /api/clips/:id — le même cadrage', () => {
  it('publient le même cadrage pour le même clip sous un réglage non défaut', async () => {
    writeTwoPersonAnalysis()
    putClip(getDb(), { ...baseClip(), ratio: '1:1' })

    // Le défaut (`splitScreen: true`) poserait un split sur ce plan à deux
    // personnes : le contrôle négatif qui dit que ce test mesure bien quelque
    // chose plutôt que de comparer deux absences.
    const before = (await (
      await getClipRoute(new Request('http://x'), context(CLIP))
    ).json()) as ClipDetail
    expect(before.framing.shots[0].split).toBeDefined()

    applySettings(getDb(), { framing: { splitScreen: false } })

    const afterGet = (await (
      await getClipRoute(new Request('http://x'), context(CLIP))
    ).json()) as ClipDetail
    expect(afterGet.framing.shots[0].split).toBeUndefined()

    // Une édition qui ne touche à rien du cadrage — seul le titre bouge —
    // pour isoler ce que `PATCH` calcule de ce qu'il écrit.
    const afterPatch = (await (
      await patchClipRoute(
        new Request('http://x', { method: 'PATCH', body: JSON.stringify({ title: 'Un autre titre' }) }),
        context(CLIP),
      )
    ).json()) as PatchClipResult

    expect(afterPatch.framing).toEqual(afterGet.framing)
  })
})

describe('POST /api/projects', () => {
  const createRoute = (body: unknown): Promise<Response> =>
    postProjects(
      new Request('http://x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )

  /**
   * Sans `launch`, la création est terminée avant la réponse : rien ne
   * continue en arrière-plan. Répondre 202 (« accepté pour traitement »)
   * serait trompeur — voir la docstring de la route. (relevé par Copilot)
   */
  it('rend 201, pas 202, quand launch est absent', async () => {
    fs.writeFileSync(path.join(process.env.REPLAY_DIR as string, `${PROJECT}-b.mp4`), '')
    const response = await createRoute({ source: `${PROJECT}-b.mp4` })
    expect(response.status).toBe(201)
    expect((await response.json()) as { plan: unknown[] }).toEqual(
      expect.objectContaining({ plan: [] }),
    )
  })

  it('rend 202 quand launch lance un travail', async () => {
    fs.writeFileSync(path.join(process.env.REPLAY_DIR as string, `${PROJECT}-c.mp4`), '')
    const response = await createRoute({ source: `${PROJECT}-c.mp4`, launch: true })
    expect(response.status).toBe(202)
    // Pas `leaveFinish()` : elle sonde `PROJECT`, pas l'identifiant que cette
    // création vient de créer sous son propre nom.
    const { projectId } = (await response.json()) as { projectId: string }
    for (let i = 0; i < 400 && progression(projectId) !== null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  })
})

describe('POST /api/projects/:id/run', () => {
  const launchRoute = (body: unknown, id = PROJECT): Promise<Response> =>
    postRun(
      new Request('http://x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      context(id),
    )

  it('rend le plan, et un plan vide quand tout est là', async () => {
    poserTranscript()
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'candidates.json'), '[]')

    const response = await launchRoute({ target: 'candidates' })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ projectId: PROJECT, plan: [] })
  })

  it('refuse `renders` : un rendu se demande par clip', async () => {
    expect((await launchRoute({ target: 'renders' })).status).toBe(400)
    expect((await launchRoute({ target: 'nimporte' })).status).toBe(400)
    expect((await launchRoute({ target: 'candidates', inconnu: 1 })).status).toBe(400)
  })

  /**
   * **Le bouton de reprise vise deux résultats, pas une étape.** Viser
   * `candidates` seul ne construit jamais le proxy — rien n'en dépend dans le
   * graphe —, et le projet resterait dans l'impasse dont on voulait le sortir.
   *
   * L'état posé ici le montre : le repérage est déjà fait, le proxy non. Une
   * cible seule rendrait un plan vide (le cas au-dessus), la liste rend
   * `['proxy']`.
   *
   * Le replay est retiré du dossier pour que l'exécution de fond échoue tout de
   * suite sur son `lstat`, au lieu de lancer un vrai encodage : ce qui se teste
   * ici est le plan, pas ffmpeg.
   */
  it('accepte une liste de cibles et les planifie toutes', async () => {
    poserTranscript()
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'candidates.json'), '[]')
    fs.rmSync(path.join(root, 'replays', `${PROJECT}.mp4`), { force: true })

    const response = await launchRoute({ target: ['candidates', 'proxy'] })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ projectId: PROJECT, plan: ['proxy'] })
    await leaveFinish()
  })

  /**
   * **Une liste vide est une demande mal formée, pas un plan vide.** Le plan
   * vide a déjà un sens — « tout était là, il n'y avait rien à faire » — et
   * l'écran l'affiche comme un succès. Accepter `[]` ferait donc répondre
   * « c'est fait » à une demande qui ne visait rien.
   */
  it('refuse une liste de cibles vide', async () => {
    expect((await launchRoute({ target: [] })).status).toBe(400)
  })

  /**
   * **Une cible répétée n'est pas refusée, elle est réduite.** Le plan, lui, ne
   * changeait pas — `planForTargets` ne planifie jamais deux fois la même étape
   * — mais `lancer` garde la liste reçue dans `cibles`, et `status.json` la
   * réécrit à chaque mise à jour, jusqu'à une fois par seconde pendant les six
   * minutes d'un proxy. Une liste qui répète mille fois `candidates` rendait donc
   * chaque écriture arbitrairement volumineuse, pour un plan identique.
   * (relevé par Copilot)
   */
  it('réduit une cible répétée au lieu de la recopier dans le statut', async () => {
    poserTranscript()
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'candidates.json'), '[]')

    const response = await launchRoute({ target: ['candidates', 'candidates', 'candidates'] })
    expect(response.status).toBe(202)
    expect(lireStatus(PROJECT)?.targets).toEqual(['candidates'])
  })

  it('refuse une cible interdite au milieu d’une liste', async () => {
    expect((await launchRoute({ target: ['candidates', 'renders'] })).status).toBe(400)
    expect((await launchRoute({ target: ['candidates', 'nimporte'] })).status).toBe(400)
  })

  it('rend 404 sur un projet inconnu', async () => {
    expect((await launchRoute({ target: 'candidates' }, 'jamais-vu')).status).toBe(404)
  })
})

describe('POST /api/projects/:id/stop', () => {
  const stop = (id = PROJECT): Promise<Response> =>
    postStop(new Request('http://x', { method: 'POST' }), context(id))

  /**
   * **`arrêtée: false` n'est pas un échec.** Rien ne tournait : l'analyse venait
   * de finir, ou un redémarrage du serveur a emporté l'exécution — la table des
   * exécutions est celle du processus. Un 409 ferait afficher une erreur à
   * quelqu'un dont le souhait est déjà réalisé, et le bouton ne pourrait pas se
   * cliquer deux fois.
   */
  it('rend 200 et `arrêtée: false` quand rien ne tourne', async () => {
    const response = await stop()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ stopped: false })
  })

  it('rend 200 et `arrêtée: true` quand une exécution tourne', async () => {
    poserTranscript()
    // Une étape qui ne finit pas d'elle-même : c'est l'arrêt qui doit la clore.
    let release: (() => void) | undefined
    const blocked = new Promise<Clip[]>((resolve) => {
      release = () => resolve([])
    })
    await launch(PROJECT, ['candidates'], { steps: { runCandidates: () => blocked } })
    for (let i = 0; i < 200 && progression(PROJECT) === null; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
    }

    const response = await stop()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ stopped: true })

    // Idempotente : tant que l'exécution descend, la réponse reste la même.
    expect(await (await stop()).json()).toEqual({ stopped: true })

    release?.()
    await leaveFinish()
    // Et le statut ne ressemble pas à une panne.
    expect(lireStatus(PROJECT)?.error).toBeNull()
    expect(lireStatus(PROJECT)?.stopped).toBe(true)
  })

  /**
   * 404 et `arrêtée: false` disent deux choses différentes : « ce projet
   * n'existe pas » et « rien à arrêter ». Les confondre ferait passer une faute
   * de frappe dans l'identifiant pour un arrêt réussi.
   */
  it('rend 404 sur un projet inconnu', async () => {
    expect((await stop('jamais-vu')).status).toBe(404)
  })
})

describe('/api/settings', () => {
  /** Les défauts de la famille `ai`, recopiés de `db.ts` (`AI_FIELDS`). */
  const AI_DEFAULTS = {
    selectionProvider: 'gemini',
    selectionModel: 'gemini-3.1-flash-lite',
    correctionProvider: 'gemini',
    correctionModel: 'gemini-3.1-flash-lite',
    hookProvider: 'gemini',
    hookModel: 'gemini-3.1-flash-lite',
    ollamaBaseUrl: '',
  }

  /** Le défaut de la famille `ingestion`, recopié de `db.ts`. */
  const INGESTION_DEFAULTS = { copySourceLocally: true }

  /** Les onze défauts de la famille `hook` (retour d'usage §6.3). */
  const HOOK_SETTINGS_DEFAULTS = { ...HOOK_DEFAULTS }

  /** Le défaut `auto` des quatre champs de la famille `publication`. */
  const PUBLICATION_DEFAULTS = {
    instagram: 'auto',
    facebook: 'auto',
    tiktok: 'auto',
    youtube: 'auto',
    scheduleHours: '19:00',
    autoPublish: true,
  }

  const write = (body: unknown): Promise<Response> =>
    putSettingsRoute(
      new Request('http://x', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )

  it('rend les réglages effectifs, défauts compris', async () => {
    const response = await getSettingsRoute()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      selection: DEFAULT_SELECTION_DIMENSIONS,
      ai: AI_DEFAULTS,
      ingestion: INGESTION_DEFAULTS,
      hook: HOOK_SETTINGS_DEFAULTS,
      framing: FRAMING_SETTINGS_DEFAULTS,
      publication: PUBLICATION_DEFAULTS,
    })
  })

  it('applique un patch partiel et rend les réglages résultants', async () => {
    const response = await write({ selection: { minutesPerClip: 4 } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      selection: { ...DEFAULT_SELECTION_DIMENSIONS, minutesPerClip: 4 },
      ai: AI_DEFAULTS,
      ingestion: INGESTION_DEFAULTS,
      hook: HOOK_SETTINGS_DEFAULTS,
      framing: FRAMING_SETTINGS_DEFAULTS,
      publication: PUBLICATION_DEFAULTS,
    })
    // Et ça persiste : la lecture suivante le voit.
    expect(await (await getSettingsRoute()).json()).toEqual({
      selection: { ...DEFAULT_SELECTION_DIMENSIONS, minutesPerClip: 4 },
      ai: AI_DEFAULTS,
      ingestion: INGESTION_DEFAULTS,
      hook: HOOK_SETTINGS_DEFAULTS,
      framing: FRAMING_SETTINGS_DEFAULTS,
      publication: PUBLICATION_DEFAULTS,
    })
  })

  /**
   * **Une clé mal orthographiée est un 400, pas un enregistrement silencieux.**
   * Elle ne serait jamais relue, et l'écran de réglages afficherait le défaut en
   * jurant avoir enregistré.
   */
  it('refuse une clé inconnue et une valeur hors bornes', async () => {
    expect((await write({ selection: { minutesParClipe: 4 } })).status).toBe(400)
    // `hook` est une vraie famille depuis cette PR : le témoin d'une famille
    // inconnue porte un nom que le registre n'a jamais eu, en anglais comme
    // tout code neuf (`CLAUDE.md`).
    expect((await write({ unknownFamily: { unknownField: 2 } })).status).toBe(400)
    // Y compris vide : sans champ, aucune boucle ne s'exécutait et le `PUT`
    // répondait 200 sur une famille qui n'existe pas. (relevé par Codex)
    expect((await write({ unknownFamily: {} })).status).toBe(400)
    expect((await write({ selection: { minutesPerClip: 0 } })).status).toBe(400)
    expect((await write({ selection: { minimumClips: 2.5 } })).status).toBe(400)
    expect((await write({ selection: { minutesPerClip: '4' } })).status).toBe(400)
    // Et rien n'a été écrit : la lecture rend toujours les défauts.
    expect(await (await getSettingsRoute()).json()).toEqual({
      selection: DEFAULT_SELECTION_DIMENSIONS,
      ai: AI_DEFAULTS,
      ingestion: INGESTION_DEFAULTS,
      hook: HOOK_SETTINGS_DEFAULTS,
      framing: FRAMING_SETTINGS_DEFAULTS,
      publication: PUBLICATION_DEFAULTS,
    })
  })

  /**
   * Les critères d'acceptation de la PR : une valeur hors bornes ou mal
   * formée sur la famille `hook` est un 400, comme pour `selection` — la
   * validation vit dans le registre (`applySettings`), pas ici, donc le même
   * chemin couvre les deux familles.
   */
  it('refuse une valeur de hook hors bornes ou mal formée', async () => {
    expect((await write({ hook: { sizePermille: 5 } })).status).toBe(400) // sous le plancher (20)
    expect((await write({ hook: { backgroundOpacity: 101 } })).status).toBe(400) // au-dessus du plafond (100)
    expect((await write({ hook: { textColor: '#GG0000' } })).status).toBe(400) // couleur mal formée
    // Rien de tout ça n'a été écrit.
    expect(await (await getSettingsRoute()).json()).toEqual({
      selection: DEFAULT_SELECTION_DIMENSIONS,
      ai: AI_DEFAULTS,
      ingestion: INGESTION_DEFAULTS,
      hook: HOOK_SETTINGS_DEFAULTS,
      framing: FRAMING_SETTINGS_DEFAULTS,
      publication: PUBLICATION_DEFAULTS,
    })
  })

  it('accepte et relit une valeur de hook valide, couleur normalisée en majuscules', async () => {
    const response = await write({ hook: { sizePermille: 150, textColor: '#a1b2c3' } })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { hook: { sizePermille: number; textColor: string } }
    expect(body.hook.sizePermille).toBe(150)
    expect(body.hook.textColor).toBe('#A1B2C3')
  })

  /**
   * Le round-trip HTTP de la famille `publication`, jusqu'ici couvert
   * seulement par `applySettings` en direct (`publication-index.test.ts`).
   * (relevé par Aristarque)
   */
  it('accepte et relit une préférence de publication non-défaut, sans toucher aux autres plateformes', async () => {
    const response = await write({ publication: { instagram: 'meta' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      selection: DEFAULT_SELECTION_DIMENSIONS,
      ai: AI_DEFAULTS,
      ingestion: INGESTION_DEFAULTS,
      hook: HOOK_SETTINGS_DEFAULTS,
      framing: FRAMING_SETTINGS_DEFAULTS,
      publication: { ...PUBLICATION_DEFAULTS, instagram: 'meta' },
    })
    // Et ça persiste.
    expect(await (await getSettingsRoute()).json()).toEqual({
      selection: DEFAULT_SELECTION_DIMENSIONS,
      ai: AI_DEFAULTS,
      ingestion: INGESTION_DEFAULTS,
      hook: HOOK_SETTINGS_DEFAULTS,
      framing: FRAMING_SETTINGS_DEFAULTS,
      publication: { ...PUBLICATION_DEFAULTS, instagram: 'meta' },
    })
  })

  it('refuse une préférence de publication hors de l’énumération de sa plateforme', async () => {
    // `youtube` n'a pas Meta dans son énumération (`PUBLICATION_ADAPTER_CHOICES`)
    // — seuls `auto` et `upload-post` le sont — contrairement à Instagram et
    // Facebook, où `meta` est valide.
    expect((await write({ publication: { youtube: 'meta' } })).status).toBe(400)
    expect((await write({ publication: { instagram: 'unknown-connector' } })).status).toBe(400)
    // Rien de tout ça n'a été écrit.
    expect(await (await getSettingsRoute()).json()).toEqual({
      selection: DEFAULT_SELECTION_DIMENSIONS,
      ai: AI_DEFAULTS,
      ingestion: INGESTION_DEFAULTS,
      hook: HOOK_SETTINGS_DEFAULTS,
      framing: FRAMING_SETTINGS_DEFAULTS,
      publication: PUBLICATION_DEFAULTS,
    })
  })

  it('refuse un corps illisible, et accepte un corps vide sans rien changer', async () => {
    const unreadable = await putSettingsRoute(
      new Request('http://x', { method: 'PUT', body: '{pas du json' }),
    )
    expect(unreadable.status).toBe(400)
    const empty = await putSettingsRoute(new Request('http://x', { method: 'PUT' }))
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({
      selection: DEFAULT_SELECTION_DIMENSIONS,
      ai: AI_DEFAULTS,
      ingestion: INGESTION_DEFAULTS,
      hook: HOOK_SETTINGS_DEFAULTS,
      framing: FRAMING_SETTINGS_DEFAULTS,
      publication: PUBLICATION_DEFAULTS,
    })
  })

  /**
   * **Changer un réglage ne recalcule rien** (retour d'usage §6.1 et §11) : les
   * émissions déjà analysées gardent leurs propositions, un recalcul reste une
   * action explicite. La route ne doit donc toucher ni aux clips, ni à un
   * artefact, ni lancer quoi que ce soit.
   */
  it('ne recalcule aucune émission', async () => {
    putClip(getDb(), baseClip())
    fs.mkdirSync(path.join(root, 'projects', PROJECT), { recursive: true })
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'candidates.json'), '[]')

    await write({ selection: { minutesPerClip: 4 } })

    expect(progression(PROJECT)).toBeNull()
    expect(fs.existsSync(path.join(root, 'projects', PROJECT, 'candidates.json'))).toBe(true)
    const clip = await getClipRoute(new Request('http://x'), context(CLIP))
    expect(((await clip.json()) as ClipDetail).clip.status).toBe('candidate')
  })
})

describe('les codes d’erreur', () => {
  it('distinguent les trois natures d’échec de la tâche 9', () => {
    // Ni la faute de l'appelant, ni un défaut du serveur : rien à réessayer.
    expect(statusFor(new GeminiBlockedError('refusé'))).toBe(422)
    // Une panne de service ou de réseau : tout à réessayer.
    expect(statusFor(new Error('503 Service Unavailable'))).toBe(503)
    expect(statusFor(new Error('fetch failed'))).toBe(503)
    // Le reste est un défaut de ce programme.
    expect(statusFor(new Error('Transcript illisible dans le sidecar'))).toBe(500)
  })
})
