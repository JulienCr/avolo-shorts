import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET as servirRendu } from '@/app/api/clips/[id]/renders/[file]/route'
import { GET as getClipRoute, PATCH as patchClipRoute } from '@/app/api/clips/[id]/route'
import { GET as getCandidats } from '@/app/api/projects/[id]/candidates/route'
import { GET as getProjet } from '@/app/api/projects/[id]/route'
import { POST as postRun } from '@/app/api/projects/[id]/run/route'
import { GET as listerProjets } from '@/app/api/projects/route'
import { GET as listerSources } from '@/app/api/sources/route'
import type { Clip } from '@/core/edl'
import type {
  CandidateClip,
  ClipDetail,
  PatchClipResult,
  ProjectListItem,
  ProjectStatus,
  ProjectSummary,
  SourcesListing,
} from '@/lib/api'
import { closeDb, getDb, putClip, upsertProject } from '@/server/db'
import { statutPour } from '@/server/http'
import { lancer, progression } from '@/server/run'
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

const PROJET = '2026-01-11-méchante'
const CLIP = `${PROJET}_000060000-000090000`

let racine: string

/** Le contexte que Next passe : des paramètres déjà décodés, dans une promesse. */
function contexte(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

/** Idem, pour la route qui sert un fichier de rendu nommé. */
function contexteRendu(id: string, file: string): { params: Promise<{ id: string; file: string }> } {
  return { params: Promise.resolve({ id, file }) }
}

/** Rend une liste de clips vide : `runCandidates` en rend une, l'étape témoin aussi. */
function resolveVide(résoudre: (clips: Clip[]) => void): void {
  résoudre([])
}

/** Un `status.json` posé à la main, comme une exécution terminée l'aurait écrit. */
function poserStatut(champs: Record<string, unknown>): void {
  const dossier = path.join(racine, 'projects', PROJET)
  fs.mkdirSync(dossier, { recursive: true })
  fs.writeFileSync(
    path.join(dossier, 'status.json'),
    JSON.stringify({
      pid: 1,
      updatedAt: 0,
      cibles: ['candidates'],
      plan: ['candidates'],
      running: null,
      error: null,
      finishedAt: 1,
      repérage: null,
      ...champs,
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
async function laisserFinir(): Promise<void> {
  for (let i = 0; i < 400 && progression(PROJET) !== null; i += 1) {
    await new Promise((résoudre) => setTimeout(résoudre, 5))
  }
}

/** Cent octets reconnaissables, pour distinguer une tranche du fichier entier. */
const OCTETS = Buffer.from(Array.from({ length: 100 }, (_, i) => 48 + (i % 10)))

/** Pose des fichiers dans `projects/<projet>/renders/`, comme le ferait un export. */
function poserRendus(...noms: string[]): void {
  const dossier = path.join(racine, 'projects', PROJET, 'renders')
  fs.mkdirSync(dossier, { recursive: true })
  for (const nom of noms) fs.writeFileSync(path.join(dossier, nom), OCTETS)
}

/** L'URL que `GET /api/clips/:id` doit publier pour un fichier de rendu. */
function urlAttendue(nom: string): string {
  return `/api/clips/${encodeURIComponent(CLIP)}/renders/${encodeURIComponent(nom)}`
}

function clipDeBase(): Clip {
  return {
    id: CLIP,
    projectId: PROJET,
    segments: [{ start: 60, end: 90 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'Le canapé',
    description: "C'était pas moi.",
    status: 'candidate',
    pass: 1,
  }
}

/** Un transcript minuscule, à la forme de WhisperX. */
function poserTranscript(): void {
  const dossier = path.join(racine, 'projects', PROJET, `${PROJET}.avolo`)
  fs.mkdirSync(dossier, { recursive: true })
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
    path.join(dossier, 'transcript.json'),
    JSON.stringify({ language: 'fr', segments }),
  )
}

beforeEach(() => {
  racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-api-'))
  process.env.REPLAY_DIR = path.join(racine, 'replays')
  process.env.STAGE_DIR = path.join(racine, 'stage')
  process.env.PROJECTS_DIR = path.join(racine, 'projects')
  fs.mkdirSync(process.env.REPLAY_DIR, { recursive: true })
  fs.writeFileSync(path.join(process.env.REPLAY_DIR, `${PROJET}.mp4`), '')

  upsertProject(getDb(), {
    id: PROJET,
    sourcePath: path.join(racine, 'replays', `${PROJET}.mp4`),
    stagedPath: path.join(racine, 'stage', `${PROJET}.mp4`),
    durationSec: 400,
    sizeBytes: 12,
    mtimeMs: 0,
    createdAt: 1_787_019_419_976,
  })
})

afterEach(() => {
  closeDb()
  fs.rmSync(racine, { recursive: true, force: true })
})

describe('GET /api/projects', () => {
  it('ne publie ni sourcePath ni stagedPath', async () => {
    const réponse = await listerProjets()
    expect(réponse.status).toBe(200)
    const projets = (await réponse.json()) as ProjectListItem[]

    expect(projets).toHaveLength(1)
    expect(Object.keys(projets[0]).sort()).toEqual([
      'createdAt',
      'durationSec',
      'error',
      'id',
      'running',
      'title',
    ])
    // Le corps entier, pas seulement les clés : un chemin qui se glisserait dans
    // une valeur ne se verrait pas autrement.
    expect(JSON.stringify(projets)).not.toContain(racine)
  })

  it('dérive le titre du nom de fichier', async () => {
    const projets = (await (await listerProjets()).json()) as ProjectSummary[]
    expect(projets[0].title).toBe('méchante — 11 janvier 2026')
  })

  /**
   * « Trois analyses en cours, une en échec » : la bibliothèque ne peut pas le
   * dire d'un `ProjectSummary`, et la seule autre forme — une requête par projet
   * — est à écarter. Elle multiplierait par vingt et un un appel qui exécute
   * `relevéPrésence`, lequel sonde le montage 9p avec un délai de garde : quatre
   * fils du vivier de libuv suffisent à figer le serveur entier (spec §3.1).
   */
  it('dit ce qui tourne, sans sonder le moindre artefact', async () => {
    // Le transcript déjà là : le plan se réduit au repérage, seule étape qu'on
    // remplace ici par un témoin qu'on tient en main.
    poserTranscript()
    let relâcher = (): void => {}
    const enCours = new Promise<Clip[]>((résoudre) => {
      relâcher = () => resolveVide(résoudre)
    })
    await lancer(PROJET, ['candidates'], { étapes: { runCandidates: () => enCours } })

    const sonde = vi.spyOn(fs, 'existsSync')
    try {
      const projets = (await (await listerProjets()).json()) as ProjectListItem[]
      expect(projets[0].running).toEqual({ step: 'candidates', progress: 0 })
      // **Le contrôle qui porte la décision.** `relevéPrésence` est fait de
      // `existsSync` : s'il revenait dans cette route, ce compteur le dirait.
      expect(sonde).not.toHaveBeenCalled()
    } finally {
      sonde.mockRestore()
      relâcher()
      await laisserFinir()
    }
  })

  it('rend null quand rien ne tourne et que rien n’a échoué', async () => {
    const projets = (await (await listerProjets()).json()) as ProjectListItem[]
    expect(projets[0].running).toBeNull()
    expect(projets[0].error).toBeNull()
  })

  /**
   * L'échec d'une tâche de fond n'a aucune réponse HTTP où loger : `status.json`
   * en est le seul dépositaire, et c'est un petit fichier local — ni Drive, ni
   * délai de garde.
   */
  it('remonte l’échec de la dernière exécution terminée', async () => {
    poserStatut({ error: 'Gemini a refusé le contenu de cette vidéo.' })

    const projets = (await (await listerProjets()).json()) as ProjectListItem[]
    expect(projets[0].error).toContain('Gemini')
  })

  /**
   * Le même partage que `GET /api/projects/:id` : pendant qu'une exécution
   * tourne, l'échec affiché serait celui d'avant. Les deux routes doivent en
   * dire la même chose, sans quoi la bibliothèque et l'écran de projet se
   * contrediraient sur le même projet.
   */
  it('n’affiche pas l’échec d’avant pendant qu’une exécution tourne', async () => {
    poserStatut({ error: 'un échec d’avant' })
    poserTranscript()
    let relâcher = (): void => {}
    const enCours = new Promise<Clip[]>((résoudre) => {
      relâcher = () => resolveVide(résoudre)
    })
    await lancer(PROJET, ['candidates'], { étapes: { runCandidates: () => enCours } })

    try {
      const projets = (await (await listerProjets()).json()) as ProjectListItem[]
      expect(projets[0].error).toBeNull()
    } finally {
      relâcher()
      await laisserFinir()
    }
  })
})

describe('GET /api/sources', () => {
  it('rend les replays et la ligne de montage', async () => {
    const réponse = await listerSources()
    expect(réponse.status).toBe(200)
    const listing = (await réponse.json()) as SourcesListing

    expect(listing.sources.map((s) => s.name)).toEqual([`${PROJET}.mp4`])
    // La source a déjà son projet : la carte y mène au lieu d'en recréer un.
    expect(listing.sources[0].projectId).toBe(PROJET)
    expect(listing.montage.disponible).toBe(true)
    expect(JSON.stringify(listing.sources)).not.toContain(racine)
  })

  /**
   * `REPLAY_DIR` absent de l'environnement n'est pas un montage indisponible :
   * c'est le serveur qui n'est pas monté, et personne n'y peut rien depuis
   * l'écran. Le déguiser en `disponible: false` enverrait rouvrir un lecteur
   * Windows là où il manque une ligne de `.env`.
   */
  it('rend 500 quand REPLAY_DIR n’est pas configurée', async () => {
    delete process.env.REPLAY_DIR
    const réponse = await listerSources()
    expect(réponse.status).toBe(500)
    expect(((await réponse.json()) as { error: string }).error).toContain('REPLAY_DIR')
  })
})

describe('GET /api/projects/:id', () => {
  it('rend les étapes présentes et ce qui tourne', async () => {
    fs.mkdirSync(path.join(racine, 'projects', PROJET), { recursive: true })
    fs.writeFileSync(path.join(racine, 'projects', PROJET, 'proxy.mp4'), '')
    poserTranscript()

    const réponse = await getProjet(new Request('http://x'), contexte(PROJET))
    expect(réponse.status).toBe(200)
    const état = (await réponse.json()) as ProjectStatus
    expect(état.steps).toEqual({
      proxy: true,
      audio: false,
      transcript: true,
      analysis: false,
      candidates: false,
      renders: false,
    })
    expect(état.running).toBeNull()
  })

  /**
   * Le seul chemin de retour d'un échec de tâche de fond : `lancer` a répondu 202
   * quarante minutes plus tôt, et son rejet part dans une promesse que personne
   * n'attend. (relevé par Copilot)
   */
  it('rend l’échec de la dernière exécution terminée', async () => {
    fs.mkdirSync(path.join(racine, 'projects', PROJET), { recursive: true })
    fs.writeFileSync(
      path.join(racine, 'projects', PROJET, 'status.json'),
      JSON.stringify({
        pid: 1,
        updatedAt: 0,
        cibles: ['candidates'],
        plan: ['candidates'],
        running: null,
        error: 'Gemini a bloqué le contenu de cette vidéo (PROHIBITED_CONTENT).',
        finishedAt: 1,
      }),
    )

    const état = (await (
      await getProjet(new Request('http://x'), contexte(PROJET))
    ).json()) as ProjectStatus
    expect(état.error).toContain('PROHIBITED_CONTENT')
  })

  /**
   * **Ce que le repérage n'a pas jugé** (spec §7.2). Quatre lots sur onze
   * reviennent `PROHIBITED_CONTENT` sur `2025-06-15-cqlp` : un tiers du
   * matériau écarté sans être jugé, et rien à l'écran ne le disait. Sans ce
   * champ, on trie vingt-cinq cartes en croyant regarder ce que l'émission a de
   * mieux, alors qu'on regarde ce qu'elle a de mieux dans les deux tiers notés.
   */
  it('publie ce que le repérage n’a pas jugé', async () => {
    poserStatut({
      repérage: {
        fenêtres: 83,
        notées: 51,
        lotsRefusés: 4,
        lotsRépondus: 7,
        couverture: 0.6412,
        partiel: false,
      },
    })

    const état = (await (
      await getProjet(new Request('http://x'), contexte(PROJET))
    ).json()) as ProjectStatus
    expect(état.repérage).toEqual({
      fenêtres: 83,
      notées: 51,
      lotsRefusés: 4,
      lotsRépondus: 7,
      couverture: 0.6412,
      partiel: false,
    })
  })

  /**
   * `null` et non un objet à zéro : « aucune notation n'est décrite » n'est pas
   * « aucune fenêtre n'a été notée ». Un zéro affiché ferait annoncer une perte
   * totale sur un projet dont le repérage n'a simplement jamais tourné dans ce
   * processus.
   */
  it('rend null quand aucune notation n’est décrite', async () => {
    poserStatut({})

    const état = (await (
      await getProjet(new Request('http://x'), contexte(PROJET))
    ).json()) as ProjectStatus
    expect(état.repérage).toBeNull()
  })

  it('ne rend pas d’échec quand rien n’a jamais tourné', async () => {
    const état = (await (
      await getProjet(new Request('http://x'), contexte(PROJET))
    ).json()) as ProjectStatus
    expect(état.error).toBeNull()
  })

  it('rend 404 sur un projet inconnu', async () => {
    const réponse = await getProjet(new Request('http://x'), contexte('jamais-vu'))
    expect(réponse.status).toBe(404)
  })
})

describe('GET /api/projects/:id/candidates', () => {
  it('prépare l’aperçu côté serveur et laisse la vignette nulle sans proxy', async () => {
    poserTranscript()
    putClip(getDb(), clipDeBase())

    const réponse = await getCandidats(new Request('http://x'), contexte(PROJET))
    const candidats = (await réponse.json()) as CandidateClip[]
    expect(candidats).toHaveLength(1)
    expect(candidats[0].preview).toBe('phrase 6 phrase 7 phrase 8')
    // Pas de proxy encore encodé : `null`, jamais une URL morte.
    expect(candidats[0].thumbnailUrl).toBeNull()
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
      ...clipDeBase(),
      segments: [
        { start: 60, end: 75 },
        { start: 100, end: 115 },
      ],
    })

    const candidats = (await (
      await getCandidats(new Request('http://x'), contexte(PROJET))
    ).json()) as CandidateClip[]
    expect(candidats[0].preview).toBe('phrase 6 phrase 7 phrase 10')
    expect(candidats[0].preview).not.toContain('phrase 8')
  })

  it('propose la vignette dès que le proxy existe', async () => {
    poserTranscript()
    fs.writeFileSync(path.join(racine, 'projects', PROJET, 'proxy.mp4'), '')
    putClip(getDb(), clipDeBase())

    const candidats = (await (
      await getCandidats(new Request('http://x'), contexte(PROJET))
    ).json()) as CandidateClip[]
    // L'identifiant porte un accent : sans encodage, l'URL serait cassée.
    expect(candidats[0].thumbnailUrl).toBe(
      `/api/clips/${encodeURIComponent(CLIP)}/thumb`,
    )
  })
})

describe('GET /api/clips/:id', () => {
  it('fenêtre le transcript sur l’étendue **d’origine**, pas sur les segments courants', async () => {
    poserTranscript()
    // L'artefact du repérage garde les bornes proposées ; l'édition n'y touche pas.
    fs.writeFileSync(
      path.join(racine, 'projects', PROJET, 'candidates.json'),
      JSON.stringify([{ ...clipDeBase(), segments: [{ start: 60, end: 90 }] }]),
    )
    // Le clip en base a été vidé de tous ses mots : c'est un état que l'écran de
    // clip produit, et celui où l'on a le plus besoin de relire le transcript.
    putClip(getDb(), { ...clipDeBase(), segments: [] })

    const réponse = await getClipRoute(new Request('http://x'), contexte(CLIP))
    expect(réponse.status).toBe(200)
    const détail = (await réponse.json()) as ClipDetail
    expect(détail.clip.segments).toEqual([])
    expect(détail.lines.length).toBeGreaterThan(0)
    // Deux minutes de contexte de part et d'autre de [60, 90].
    expect(détail.lines[0].start).toBe(0)
    expect(détail.lines[détail.lines.length - 1].end).toBeLessThanOrEqual(218)
    expect(détail.proxyUrl).toBeNull()
  })

  it('rend 404 sur un clip inconnu', async () => {
    const réponse = await getClipRoute(new Request('http://x'), contexte('jamais-vu'))
    expect(réponse.status).toBe(404)
  })

  /**
   * Les sorties. Un clip qui affiche « exporté » et dont le fichier reste
   * inatteignable, c'est la chaîne coupée à son dernier mètre : l'écran de clip
   * n'a aucun moyen de savoir ce qui a été produit ni où le lire.
   */
  it('ne promet aucune sortie tant que rien n’a été exporté', async () => {
    putClip(getDb(), clipDeBase())

    const détail = (await (
      await getClipRoute(new Request('http://x'), contexte(CLIP))
    ).json()) as ClipDetail
    expect(détail.outputs.mp4Url).toBeNull()
    expect(détail.outputs.textsUrl).toBeNull()
    expect(détail.outputs.variant9x16Url).toBeNull()
  })

  it('publie les sorties en URL, jamais en chemin du serveur', async () => {
    putClip(getDb(), { ...clipDeBase(), status: 'exported' })
    poserRendus(`${CLIP}.mp4`, `${CLIP}.txt`)

    const réponse = await getClipRoute(new Request('http://x'), contexte(CLIP))
    const détail = (await réponse.json()) as ClipDetail
    expect(détail.outputs.mp4Url).toBe(urlAttendue(`${CLIP}.mp4`))
    expect(détail.outputs.textsUrl).toBe(urlAttendue(`${CLIP}.txt`))
    // Le corps entier : un chemin absolu qui se glisserait dans une valeur ne se
    // verrait pas autrement, et c'est l'arborescence de la machine qu'il publie.
    expect(JSON.stringify(détail)).not.toContain(racine)
  })

  /**
   * Le cas que le contrat doit nommer : `variant9x16Url` vaut `null` pour deux
   * raisons opposées, et une interface qui les confond affiche « rendu
   * manquant » sur un clip parfaitement livré. `variant9x16Due` les sépare.
   */
  it('n’attend pas de variante 9:16 quand le ratio résolu l’est déjà', async () => {
    // `auto` se rabat sur 9:16 en itération 0 : la variante serait le même cadre
    // réencodé une seconde fois.
    putClip(getDb(), clipDeBase())
    poserRendus(`${CLIP}.mp4`, `${CLIP}.txt`, `${CLIP}-9x16.mp4`)

    const détail = (await (
      await getClipRoute(new Request('http://x'), contexte(CLIP))
    ).json()) as ClipDetail
    expect(détail.outputs.variant9x16Due).toBe(false)
    // Le fichier est là — abandonné par un ratio précédent — et n'est pourtant
    // pas une livraison de ce clip : le publier le ferait passer pour à jour.
    expect(détail.outputs.variant9x16Url).toBeNull()
  })

  /**
   * `status` ne devient `exported` que dans `renderClip`, une fois les fichiers
   * écrits. Des fichiers présents sous un clip qui ne le porte pas décrivent
   * donc autre chose que sa livraison. (relevé par Copilot)
   */
  it('ne publie rien tant que le clip n’est pas exporté', async () => {
    putClip(getDb(), { ...clipDeBase(), status: 'kept' })
    poserRendus(`${CLIP}.mp4`, `${CLIP}.txt`)

    const détail = (await (
      await getClipRoute(new Request('http://x'), contexte(CLIP))
    ).json()) as ClipDetail
    expect(détail.outputs.mp4Url).toBeNull()
    expect(détail.outputs.textsUrl).toBeNull()
  })

  /**
   * Les deux côtés du contrat doivent dire la même chose : `servirFichier`
   * contrôle `isFile()` avant de pousser des octets, donc publier une entrée qui
   * n'est pas un fichier ordinaire annoncerait une sortie que la route des
   * rendus refuse aussitôt. (relevé par Copilot)
   */
  it('ne publie pas un dossier qui porte le nom d’un rendu', async () => {
    // **Exporté**, sans quoi le test passerait pour la mauvaise raison : la garde
    // de statut couperait avant le contrôle `isFile()`, et retirer ce dernier ne
    // ferait échouer personne. (relevé par Copilot)
    putClip(getDb(), { ...clipDeBase(), status: 'exported' })
    fs.mkdirSync(path.join(racine, 'projects', PROJET, 'renders', `${CLIP}.mp4`), {
      recursive: true,
    })

    const détail = (await (
      await getClipRoute(new Request('http://x'), contexte(CLIP))
    ).json()) as ClipDetail
    expect(détail.outputs.mp4Url).toBeNull()
    // Et la route des rendus dit la même chose.
    expect(
      (await servirRendu(new Request('http://x'), contexteRendu(CLIP, `${CLIP}.mp4`))).status,
    ).toBe(404)
  })

  it('attend la variante 9:16 dès que le ratio résolu ne l’est pas', async () => {
    putClip(getDb(), { ...clipDeBase(), ratio: '1:1', status: 'exported' })

    const avant = (await (
      await getClipRoute(new Request('http://x'), contexte(CLIP))
    ).json()) as ClipDetail
    expect(avant.outputs.variant9x16Due).toBe(true)
    // Due mais pas encore produite : là, `null` est bien une sortie manquante.
    expect(avant.outputs.variant9x16Url).toBeNull()

    poserRendus(`${CLIP}-9x16.mp4`)
    const après = (await (
      await getClipRoute(new Request('http://x'), contexte(CLIP))
    ).json()) as ClipDetail
    expect(après.outputs.variant9x16Url).toBe(urlAttendue(`${CLIP}-9x16.mp4`))
  })
})

describe('GET /api/clips/:id/renders/:file', () => {
  const demander = (nom: string, range?: string, id = CLIP): Promise<Response> =>
    servirRendu(
      new Request('http://x', { headers: range === undefined ? undefined : { range } }),
      contexteRendu(id, nom),
    )

  beforeEach(() => {
    putClip(getDb(), { ...clipDeBase(), ratio: '1:1', status: 'exported' })
  })

  it('ne sert rien pour un clip que l’édition a fait sortir d’`exported`', async () => {
    poserRendus(`${CLIP}.mp4`)
    putClip(getDb(), { ...clipDeBase(), ratio: '1:1', status: 'kept' })
    // Le fichier est là, et c'est justement le cas qui compte : ne plus publier
    // l'URL ne suffit pas si celui qui l'a gardée peut encore la suivre.
    expect((await demander(`${CLIP}.mp4`)).status).toBe(404)
  })

  it('sert le rendu natif en entier', async () => {
    poserRendus(`${CLIP}.mp4`)
    const réponse = await demander(`${CLIP}.mp4`)

    expect(réponse.status).toBe(200)
    expect(réponse.headers.get('content-type')).toBe('video/mp4')
    expect(réponse.headers.get('content-length')).toBe('100')
    expect(réponse.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await réponse.arrayBuffer()).equals(OCTETS)).toBe(true)
  })

  it('répond aux requêtes partielles, comme le proxy', async () => {
    poserRendus(`${CLIP}.mp4`)
    const réponse = await demander(`${CLIP}.mp4`, 'bytes=20-29')

    expect(réponse.status).toBe(206)
    expect(réponse.headers.get('content-range')).toBe('bytes 20-29/100')
    expect(réponse.headers.get('content-length')).toBe('10')
    expect(Buffer.from(await réponse.arrayBuffer()).equals(OCTETS.subarray(20, 30))).toBe(true)
  })

  it('rend 416 avec la taille réelle, en gardant le `Cache-Control` de la route', async () => {
    poserRendus(`${CLIP}.mp4`)
    const réponse = await demander(`${CLIP}.mp4`, 'bytes=500-600')

    expect(réponse.status).toBe(416)
    expect(réponse.headers.get('content-range')).toBe('bytes */100')
    // Un 416 est cacheable par heuristique : sans cet en-tête, un refus calculé
    // sur l'ancienne taille survit à un ré-export et bloque une demande devenue
    // légitime. (relevé par Copilot)
    expect(réponse.headers.get('cache-control')).toBe('no-cache')
  })

  it('sert la variante 9:16 et le texte de publication', async () => {
    poserRendus(`${CLIP}-9x16.mp4`, `${CLIP}.txt`)
    expect((await demander(`${CLIP}-9x16.mp4`)).status).toBe(200)

    const texte = await demander(`${CLIP}.txt`)
    expect(texte.status).toBe(200)
    expect(texte.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  })

  /**
   * Le nom demandé est **comparé** à ce que le clip produit, jamais joint au
   * dossier de rendus. Un nom qui ne figure pas dans cette liste ne peut donc
   * désigner aucun fichier, quelle que soit sa forme.
   */
  it('refuse un nom que ce clip ne produit pas', async () => {
    poserRendus(`${CLIP}.mp4`)
    expect((await demander('autre.mp4')).status).toBe(404)
    expect((await demander('../../../etc/passwd')).status).toBe(404)
    expect((await demander(`../renders/${CLIP}.mp4`)).status).toBe(404)
    expect((await demander('')).status).toBe(404)
  })

  it('ne sert pas le `.ass`, qui est un intermédiaire et non une sortie', async () => {
    poserRendus(`${CLIP}.ass`)
    expect((await demander(`${CLIP}.ass`)).status).toBe(404)
  })

  it('refuse le rendu d’un autre clip, même bien nommé', async () => {
    const autre = `${PROJET}_000200000-000230000`
    // Exporté lui aussi : ce test porte sur le cloisonnement entre clips, pas
    // sur la règle de statut éprouvée juste au-dessus.
    putClip(getDb(), { ...clipDeBase(), id: autre, status: 'exported' })
    poserRendus(`${autre}.mp4`)
    expect((await demander(`${autre}.mp4`)).status).toBe(404)
    expect((await demander(`${autre}.mp4`, undefined, autre)).status).toBe(200)
  })

  it('rend 404 tant que l’export n’a rien produit', async () => {
    expect((await demander(`${CLIP}.mp4`)).status).toBe(404)
  })

  it('rend 404 sur un clip inconnu', async () => {
    expect((await demander(`${CLIP}.mp4`, undefined, 'jamais-vu')).status).toBe(404)
  })

  it('n’écrit aucun chemin du serveur dans son message d’erreur', async () => {
    const réponse = await demander(`${CLIP}.mp4`)
    expect(JSON.stringify(await réponse.json())).not.toContain(racine)
  })
})

describe('PATCH /api/clips/:id', () => {
  const patcher = (corps: unknown, id = CLIP): Promise<Response> =>
    patchClipRoute(
      new Request('http://x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corps),
      }),
      contexte(id),
    )

  beforeEach(() => {
    putClip(getDb(), clipDeBase())
  })

  it('refuse `status: exported` venant du client', async () => {
    const réponse = await patcher({ status: 'exported' })
    // Un clip devient exporté parce qu'un MP4 a été produit, jamais parce que
    // quelqu'un l'a écrit — et `mergeCandidates` le ferait survivre à toutes les
    // passes suivantes.
    expect(réponse.status).toBe(400)
  })

  it('refuse les champs d’identité', async () => {
    for (const corps of [{ id: 'autre' }, { projectId: 'autre' }, { pass: 9 }]) {
      expect((await patcher(corps)).status).toBe(400)
    }
  })

  it('refuse un cropX hors de l’image', async () => {
    expect((await patcher({ cropX: 1.5 })).status).toBe(400)
  })

  it('normalise les segments avant écriture', async () => {
    const réponse = await patcher({
      segments: [
        { start: 80, end: 95 },
        { start: 60, end: 82 },
        { start: 120, end: 120 },
      ],
    })
    expect(réponse.status).toBe(200)
    const { clip } = (await réponse.json()) as PatchClipResult
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
    const réponse = await patcher({ segments: [] })
    expect(réponse.status).toBe(200)
    expect(((await réponse.json()) as PatchClipResult).clip.segments).toEqual([])

    // Et une seconde fois : les deux côtés sont vides, rien ne doit lever.
    expect((await patcher({ segments: [] })).status).toBe(200)
  })

  it('accepte les trois statuts humains et les enregistre', async () => {
    const réponse = await patcher({ status: 'kept' })
    expect(réponse.status).toBe(200)
    expect(((await réponse.json()) as PatchClipResult).clip.status).toBe('kept')
    const relu = (await (
      await getClipRoute(new Request('http://x'), contexte(CLIP))
    ).json()) as ClipDetail
    expect(relu.clip.status).toBe('kept')
  })

  it('rejette un corps illisible', async () => {
    const réponse = await patchClipRoute(
      new Request('http://x', { method: 'PATCH', body: 'pas du json' }),
      contexte(CLIP),
    )
    expect(réponse.status).toBe(400)
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
    const corpsDe = async (réponse: Response): Promise<PatchClipResult> =>
      (await réponse.json()) as PatchClipResult

    const titreEnBase = async (): Promise<string> =>
      (
        (await (await getClipRoute(new Request('http://x'), contexte(CLIP))).json()) as ClipDetail
      ).clip.title

    it('applique une écriture plus récente que la dernière', async () => {
      expect((await corpsDe(await patcher({ title: 'un', seq: 10 }))).applied).toBe(true)
      const résultat = await corpsDe(await patcher({ title: 'deux', seq: 11 }))
      expect(résultat.applied).toBe(true)
      expect(résultat.clip.title).toBe('deux')
      expect(await titreEnBase()).toBe('deux')
    })

    /**
     * **200, et pas 409.** Une écriture dépassée n'est pas un échec
     * d'enregistrement : c'en est une autre qui a gagné. Un code d'erreur ferait
     * afficher « la sauvegarde a échoué » sur le clip le mieux enregistré de la
     * session.
     */
    it('refuse une écriture périmée sans en faire un échec', async () => {
      await patcher({ title: 'récent', seq: 20 })
      const réponse = await patcher({ title: 'périmé', seq: 10 })

      expect(réponse.status).toBe(200)
      const résultat = await corpsDe(réponse)
      expect(résultat.applied).toBe(false)
      // Le clip **gagnant**, pas celui qu'on vient de refuser : c'est ce qui
      // permet à l'appelant de se remettre d'accord avec la base sans relire.
      expect(résultat.clip.title).toBe('récent')
      expect(await titreEnBase()).toBe('récent')
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
      await patcher({ status: 'kept', seq: 11 })
      const résultat = await corpsDe(await patcher({ title: 'un titre plus ancien', seq: 10 }))

      expect(résultat.applied).toBe(true)
      expect(résultat.clip.title).toBe('un titre plus ancien')
      // Et le statut, plus récent, n'a pas été défait au passage.
      expect(résultat.clip.status).toBe('kept')
      expect(await titreEnBase()).toBe('un titre plus ancien')
    })

    it('n’écarte que les champs contestés, et écrit les autres', async () => {
      await patcher({ title: 'gagnant', seq: 20 })
      const résultat = await corpsDe(
        await patcher({ title: 'perdant', status: 'discarded', seq: 15 }),
      )

      // Un champ écarté suffit à faire tomber `applied`…
      expect(résultat.applied).toBe(false)
      expect(résultat.clip.title).toBe('gagnant')
      // …mais l'autre est bien écrit : rien de ce geste n'est perdu sans raison.
      expect(résultat.clip.status).toBe('discarded')
    })

    it('date le jeton d’un champ réécrit à l’identique', async () => {
      // Une valeur identique reste une prise de position sur ce champ : sans
      // cela, un second geste plus ancien passerait derrière sans être vu.
      await patcher({ title: 'même', seq: 30 })
      await patcher({ title: 'même', seq: 40 })
      expect((await corpsDe(await patcher({ title: 'ancien', seq: 35 }))).applied).toBe(false)
      expect(await titreEnBase()).toBe('même')
    })

    it('rend le plancher d’ordre, de quoi se recaler après un retour d’horloge', async () => {
      await patcher({ title: 'venu du futur', seq: 4_000_000_000_000 })
      // Le client dont l'horloge vient d'être corrigée envoie plus petit.
      const refusé = await corpsDe(await patcher({ title: 'après correction', seq: 100 }))
      expect(refusé.applied).toBe(false)
      // La réponse porte le plancher : une seule requête suffit à l'apprendre.
      expect(refusé.seq).toBe(4_000_000_000_000)

      const repris = await corpsDe(await patcher({ title: 'recalé', seq: 4_000_000_000_001 }))
      expect(repris.applied).toBe(true)
      expect(await titreEnBase()).toBe('recalé')
    })

    it('accepte un jeton égal au dernier appliqué', async () => {
      await patcher({ title: 'un', seq: 7 })
      const résultat = await corpsDe(await patcher({ title: 'deux', seq: 7 }))
      // Deux gestes dans la même milliseconde : l'ordre est indécidable, et
      // seul le jeton **inférieur** se refuse.
      expect(résultat.applied).toBe(true)
      expect(await titreEnBase()).toBe('deux')
    })

    it('annonce le plancher retenu même sans jeton', async () => {
      await patcher({ title: 'ordonné', seq: 300 })
      const sansJeton = await corpsDe(await patcher({ title: 'depuis curl' }))
      // La base garde 300 : annoncer 0 recalerait l'appelant vers le bas, donc
      // vers des jetons que le serveur refuserait aussitôt.
      expect(sansJeton.seq).toBe(300)
    })

    it('écrit sans jeton, comme le fait un appel en `curl`', async () => {
      await patcher({ title: 'depuis l’interface', seq: 300 })
      const résultat = await corpsDe(await patcher({ title: 'depuis curl' }))
      // Un appelant qui n'ordonne pas ses écritures n'a rien à faire dans cette
      // course : il écrit, et les jetons en base ne bougent pas.
      expect(résultat.applied).toBe(true)
      expect(await titreEnBase()).toBe('depuis curl')
      expect((await corpsDe(await patcher({ title: 'encore périmé', seq: 200 }))).applied).toBe(
        false,
      )
    })

    it('refuse un jeton qui n’est pas un entier', async () => {
      expect((await patcher({ title: 'x', seq: 'récent' })).status).toBe(400)
      expect((await patcher({ title: 'x', seq: 1.5 })).status).toBe(400)
      expect((await patcher({ title: 'x', seq: -1 })).status).toBe(400)
    })

    /**
     * Un clip exporté puis remonté garde ses fichiers : le modèle de
     * l'itération 0 fait foi sur leur présence, donc `outputs` publierait une
     * vidéo qui montre le montage d'avant, et un export sans `force` la
     * sauterait. (relevé par Copilot)
     */
    it('écarte un rendu que l’édition vient de périmer', async () => {
      poserRendus(`${CLIP}.mp4`, `${CLIP}.txt`)
      putClip(getDb(), { ...clipDeBase(), status: 'exported' })

      const résultat = await corpsDe(await patcher({ segments: [{ start: 61, end: 91 }], seq: 50 }))

      expect(résultat.applied).toBe(true)
      // Les fichiers décrivaient un montage que personne ne veut plus.
      expect(résultat.outputs.mp4Url).toBeNull()
      expect(fs.existsSync(path.join(racine, 'projects', PROJET, 'renders', `${CLIP}.mp4`))).toBe(
        false,
      )
      // Et le clip redevient ce qu'il est : gardé, pas exporté.
      expect(résultat.clip.status).toBe('kept')
    })

    /**
     * Un clip en 9:16 n'a pas de variante due, donc `cheminsRendu` du ratio de
     * départ ne la nomme pas et un `-9x16.mp4` abandonné y survivait. Le ratio
     * d'arrivée, lui, la rend due : `sortiesDuClip` la publiait aussitôt comme
     * la livraison du jour. (relevé par Copilot)
     */
    it('efface la variante abandonnée quand le ratio change de 9:16 vers 1:1', async () => {
      poserRendus(`${CLIP}.mp4`, `${CLIP}.txt`, `${CLIP}-9x16.mp4`)
      putClip(getDb(), { ...clipDeBase(), ratio: '9:16', status: 'exported' })

      const résultat = await corpsDe(await patcher({ ratio: '1:1', seq: 70 }))

      expect(résultat.applied).toBe(true)
      // Due par le nouveau ratio, et pourtant absente : le fichier qui traînait
      // ne décrivait pas ce clip.
      expect(résultat.outputs.variant9x16Due).toBe(true)
      expect(résultat.outputs.variant9x16Url).toBeNull()
      expect(
        fs.existsSync(path.join(racine, 'projects', PROJET, 'renders', `${CLIP}-9x16.mp4`)),
      ).toBe(false)
    })

    it('laisse le rendu en place quand l’édition ne le périme pas', async () => {
      poserRendus(`${CLIP}.mp4`, `${CLIP}.txt`)
      putClip(getDb(), { ...clipDeBase(), status: 'exported' })

      // Le titre et la description ne vont que dans le `.txt`, que l'export
      // réécrit sans réencoder : le MP4 les ignore.
      const résultat = await corpsDe(await patcher({ title: 'Un autre titre', seq: 50 }))

      expect(résultat.outputs.mp4Url).toBe(urlAttendue(`${CLIP}.mp4`))
      expect(résultat.clip.status).toBe('exported')
    })

    /**
     * Le `.txt` est une sortie publiée, et le titre y va. Le laisser tel quel
     * ferait servir un texte de publication qui n'est plus celui du clip, sans
     * qu'aucun statut ne le signale. (relevé par Copilot)
     */
    it('rafraîchit le texte de publication quand le titre change', async () => {
      poserRendus(`${CLIP}.mp4`, `${CLIP}.txt`)
      putClip(getDb(), { ...clipDeBase(), status: 'exported' })

      const résultat = await corpsDe(await patcher({ title: 'Un titre corrigé', seq: 60 }))

      const texte = fs.readFileSync(
        path.join(racine, 'projects', PROJET, 'renders', `${CLIP}.txt`),
        'utf8',
      )
      expect(texte).toContain('Un titre corrigé')
      // Les MP4 ne bougent pas : un titre ne change aucune image, et les
      // réencoder coûterait quarante secondes pour une faute de frappe.
      expect(résultat.outputs.mp4Url).toBe(urlAttendue(`${CLIP}.mp4`))
      expect(résultat.clip.status).toBe('exported')
    })

    it('ne fabrique pas de texte pour un clip que rien n’a rendu', async () => {
      const résultat = await corpsDe(await patcher({ title: 'Un titre', seq: 60 }))
      // Sinon `textsUrl` annoncerait une sortie qui n'en est pas une.
      expect(résultat.outputs.textsUrl).toBeNull()
      expect(
        fs.existsSync(path.join(racine, 'projects', PROJET, 'renders', `${CLIP}.txt`)),
      ).toBe(false)
    })

    /**
     * L'écriture en base est validée avant que le disque ne soit touché : une
     * erreur de système de fichiers ne doit pas rendre 500 sur un montage
     * pourtant enregistré. (relevé par Copilot)
     */
    it('n’échoue pas quand le dossier des rendus est illisible', async () => {
      poserRendus(`${CLIP}.mp4`, `${CLIP}.txt`)
      putClip(getDb(), { ...clipDeBase(), status: 'exported' })
      const dossier = path.join(racine, 'projects', PROJET, 'renders')
      fs.chmodSync(dossier, 0o500)

      try {
        const réponse = await patcher({ segments: [{ start: 61, end: 91 }], seq: 60 })
        expect(réponse.status).toBe(200)
        const résultat = (await réponse.json()) as PatchClipResult
        // Le montage est enregistré, et c'est ce que la réponse porte.
        expect(résultat.applied).toBe(true)
        expect(résultat.clip.segments).toEqual([{ start: 61, end: 91 }])
        // Le fichier est toujours là : l'effacement a bien échoué, donc le test
        // éprouve le rattrapage et non un chemin où il n'y avait rien à faire.
        expect(
          fs.existsSync(path.join(racine, 'projects', PROJET, 'renders', `${CLIP}.mp4`)),
        ).toBe(true)
        // **Et il n'est plus publié.** Le statut est sorti d'`exported` malgré
        // l'échec, donc ce qui survit sur le disque n'est plus offert comme la
        // livraison du jour : c'est la seule chose qui empêche de publier la
        // vidéo d'avant sans le savoir.
        expect(résultat.clip.status).toBe('kept')
        expect(résultat.outputs.mp4Url).toBeNull()
      } finally {
        fs.chmodSync(dossier, 0o700)
      }
    })

    it('rend les sorties d’un clip que rien n’a exporté', async () => {
      const résultat = await corpsDe(await patcher({ title: 'Peu importe', seq: 50 }))
      // Le champ est là même quand il n'y a rien à publier : l'appelant tient
      // son cache dessus, et une absence de champ le laisserait sur l'ancien.
      expect(résultat.outputs).toEqual({
        mp4Url: null,
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
      const vignette = vignettePath(PROJET, CLIP)
      fs.mkdirSync(path.dirname(vignette), { recursive: true })
      fs.writeFileSync(vignette, 'jpeg')

      await patcher({ segments: [{ start: 60, end: 90 }], seq: 40 })
      expect(fs.existsSync(vignette)).toBe(true)

      await patcher({ segments: [{ start: 10, end: 20 }], seq: 5 })
      expect(fs.existsSync(vignette)).toBe(true)

      await patcher({ segments: [{ start: 10, end: 20 }], seq: 41 })
      expect(fs.existsSync(vignette)).toBe(false)
    })
  })
})

describe('POST /api/projects/:id/run', () => {
  const lancerRoute = (corps: unknown, id = PROJET): Promise<Response> =>
    postRun(
      new Request('http://x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corps),
      }),
      contexte(id),
    )

  it('rend le plan, et un plan vide quand tout est là', async () => {
    poserTranscript()
    fs.writeFileSync(path.join(racine, 'projects', PROJET, 'candidates.json'), '[]')

    const réponse = await lancerRoute({ target: 'candidates' })
    expect(réponse.status).toBe(202)
    expect(await réponse.json()).toEqual({ projectId: PROJET, plan: [] })
  })

  it('refuse `renders` : un rendu se demande par clip', async () => {
    expect((await lancerRoute({ target: 'renders' })).status).toBe(400)
    expect((await lancerRoute({ target: 'nimporte' })).status).toBe(400)
    expect((await lancerRoute({ target: 'candidates', inconnu: 1 })).status).toBe(400)
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
    fs.writeFileSync(path.join(racine, 'projects', PROJET, 'candidates.json'), '[]')
    fs.rmSync(path.join(racine, 'replays', `${PROJET}.mp4`), { force: true })

    const réponse = await lancerRoute({ target: ['candidates', 'proxy'] })
    expect(réponse.status).toBe(202)
    expect(await réponse.json()).toEqual({ projectId: PROJET, plan: ['proxy'] })
    await laisserFinir()
  })

  /**
   * **Une liste vide est une demande mal formée, pas un plan vide.** Le plan
   * vide a déjà un sens — « tout était là, il n'y avait rien à faire » — et
   * l'écran l'affiche comme un succès. Accepter `[]` ferait donc répondre
   * « c'est fait » à une demande qui ne visait rien.
   */
  it('refuse une liste de cibles vide', async () => {
    expect((await lancerRoute({ target: [] })).status).toBe(400)
  })

  it('refuse une cible interdite au milieu d’une liste', async () => {
    expect((await lancerRoute({ target: ['candidates', 'renders'] })).status).toBe(400)
    expect((await lancerRoute({ target: ['candidates', 'nimporte'] })).status).toBe(400)
  })

  it('rend 404 sur un projet inconnu', async () => {
    expect((await lancerRoute({ target: 'candidates' }, 'jamais-vu')).status).toBe(404)
  })
})

describe('les codes d’erreur', () => {
  it('distinguent les trois natures d’échec de la tâche 9', () => {
    // Ni la faute de l'appelant, ni un défaut du serveur : rien à réessayer.
    expect(statutPour(new GeminiBlockedError('refusé'))).toBe(422)
    // Une panne de service ou de réseau : tout à réessayer.
    expect(statutPour(new Error('503 Service Unavailable'))).toBe(503)
    expect(statutPour(new Error('fetch failed'))).toBe(503)
    // Le reste est un défaut de ce programme.
    expect(statutPour(new Error('Transcript illisible dans le sidecar'))).toBe(500)
  })
})
