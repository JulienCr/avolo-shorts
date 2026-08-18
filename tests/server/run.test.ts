import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { StepName } from '@/core/graph'
import { openDb, upsertProject, type Project } from '@/server/db'
import {
  cheminTranscript,
  ExécutionEnCoursError,
  lancer,
  lireStatut,
  planPourCibles,
  oublierSidecar,
  ProjetInconnuError,
  progression,
  relevéPrésence,
  type Étapes,
} from '@/server/run'

/**
 * Le lanceur, sans GPU, sans ffmpeg et sans vidéo : les étapes sont injectées.
 *
 * Ce qui se vérifie ici n'est pas qu'un proxy s'encode — c'est déjà testé
 * ailleurs — mais **ce que le lanceur décide de faire tourner**, et ce qu'il
 * refuse. Le cas qui compte tient en une phrase : sur un projet dont le
 * transcript existe, demander les candidats ne doit relancer que le repérage. Si
 * ce test tombe, le produit est inutilisable au quotidien — on retranscrit deux
 * heures cinquante d'audio pour reformuler des propositions.
 */

const PROJET = '2025-06-15-cqlp'

let racine: string
let db: Database.Database
let appels: StepName[]

/** Les étapes, remplacées par des témoins qui ne font qu'écrire leur artefact. */
function étapesFactices(échouer?: StepName): Partial<Étapes> {
  const noter = async (étape: StepName, artefact?: string): Promise<void> => {
    appels.push(étape)
    if (échouer === étape) {
      throw new Error(`ffmpeg a échoué — Commande : /usr/bin/ffmpeg -i ${racine}/stage/x.mp4`)
    }
    if (artefact !== undefined) {
      fs.mkdirSync(path.dirname(artefact), { recursive: true })
      fs.writeFileSync(artefact, '')
    }
  }

  return {
    ingest: async () => {
      appels.push('proxy' as StepName)
      throw new Error("l'ingestion ne devait pas être appelée")
    },
    buildProxy: async (o) => {
      await noter('proxy', path.join(racine, 'projects', o.projectId, 'proxy.mp4'))
      return { path: 'proxy.mp4', skipped: false }
    },
    extractAudio: async (o) => {
      await noter('audio', path.join(racine, 'projects', o.projectId, 'audio.wav'))
      return { path: 'audio.wav', skipped: false }
    },
    transcribe: async (o) => {
      const fichier = path.join(racine, 'projects', o.projectId, `${PROJET}.avolo`, 'transcript.json')
      await noter('transcript', fichier)
      return { path: fichier, skipped: false, fallback: true }
    },
    runCandidates: async (id) => {
      await noter('candidates', path.join(racine, 'projects', id, 'candidates.json'))
      return []
    },
  }
}

function poserProjet(o: { durationSec?: number | null; copie?: boolean } = {}): void {
  const source = path.join(racine, 'replays', `${PROJET}.mp4`)
  const copie = path.join(racine, 'stage', `${PROJET}.mp4`)
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, '')
  if (o.copie !== false) {
    fs.mkdirSync(path.dirname(copie), { recursive: true })
    fs.writeFileSync(copie, '')
  }
  upsertProject(db, {
    id: PROJET,
    sourcePath: source,
    stagedPath: copie,
    durationSec: o.durationSec === undefined ? 5936 : o.durationSec,
    sizeBytes: 0,
    mtimeMs: 0,
    createdAt: 1_787_019_419_976,
  })
}

/** Le transcript déjà là, dans le repli du projet — le cas de la vérification. */
function poserTranscript(): void {
  const dossier = path.join(racine, 'projects', PROJET, `${PROJET}.avolo`)
  fs.mkdirSync(dossier, { recursive: true })
  fs.writeFileSync(path.join(dossier, 'transcript.json'), '{"segments":[]}')
}

beforeEach(() => {
  racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-run-'))
  process.env.REPLAY_DIR = path.join(racine, 'replays')
  process.env.STAGE_DIR = path.join(racine, 'stage')
  process.env.PROJECTS_DIR = path.join(racine, 'projects')
  fs.mkdirSync(process.env.REPLAY_DIR, { recursive: true })
  db = openDb(':memory:')
  appels = []
})

afterEach(() => {
  db.close()
  fs.rmSync(racine, { recursive: true, force: true })
})

describe('planPourCibles', () => {
  const rien: Record<StepName, boolean> = {
    proxy: false,
    audio: false,
    transcript: false,
    candidates: false,
    renders: false,
  }

  it('enchaîne deux cibles sans répéter ce qui est déjà planifié', () => {
    // C'est ce que fait `POST /api/projects` : rien ne dépend du proxy dans le
    // graphe, donc viser les candidats ne le construirait jamais.
    expect(planPourCibles(['candidates', 'proxy'], rien, [])).toEqual([
      'audio',
      'transcript',
      'candidates',
      'proxy',
    ])
  })

  it('ne planifie rien quand tout est là', () => {
    const tout = { ...rien, proxy: true, audio: true, transcript: true, candidates: true }
    expect(planPourCibles(['candidates', 'proxy'], tout, [])).toEqual([])
  })
})

describe('relevéPrésence', () => {
  it('lit les artefacts sur le disque, y compris le sidecar rabattu dans le projet', async () => {
    poserProjet()
    poserTranscript()
    fs.writeFileSync(path.join(racine, 'projects', PROJET, 'proxy.mp4'), '')

    const projet = { id: PROJET, sourcePath: path.join(racine, 'replays', `${PROJET}.mp4`) }
    const présence = await relevéPrésence({
      ...projet,
      stagedPath: null,
      durationSec: null,
      sizeBytes: null,
      mtimeMs: null,
      createdAt: 0,
    })
    expect(présence).toEqual({
      proxy: true,
      audio: false,
      transcript: true,
      candidates: false,
      renders: false,
    })
  })

  /**
   * `cheminTemporaire` garde l'extension d'origine — ffmpeg choisit son muxeur
   * dessus —, donc un encodage en cours ou tué laisse un `.partiel-….mp4` dans
   * le dossier des rendus. (relevé par Copilot)
   */
  it('ne compte pas un rendu encore en cours d’écriture', async () => {
    poserProjet()
    const rendus = path.join(racine, 'projects', PROJET, 'renders')
    fs.mkdirSync(rendus, { recursive: true })
    fs.writeFileSync(path.join(rendus, 'clip.partiel-1234-1.mp4'), '')

    const projet: Project = {
      id: PROJET,
      sourcePath: path.join(racine, 'replays', `${PROJET}.mp4`),
      stagedPath: null,
      durationSec: null,
      sizeBytes: null,
      mtimeMs: null,
      createdAt: 0,
    }
    expect((await relevéPrésence(projet)).renders).toBe(false)

    fs.writeFileSync(path.join(rendus, 'clip.mp4'), '')
    oublierSidecar(projet)
    expect((await relevéPrésence(projet)).renders).toBe(true)
  })
})

describe('cheminTranscript', () => {
  const projet = (): Project => ({
    id: PROJET,
    sourcePath: path.join(racine, 'replays', `${PROJET}.mp4`),
    stagedPath: null,
    durationSec: null,
    sizeBytes: null,
    mtimeMs: null,
    createdAt: 0,
  })

  /**
   * Le prix du cache, énoncé : une absence se retient. C'est ce qui empêche
   * l'écran de tri, qui interroge toutes les deux secondes, de sonder un Drive
   * muet à chaque fois — et le sondage y consomme un fil du vivier de libuv, qui
   * n'en compte que quatre.
   */
  it('retient une absence, et l’oublie quand on le lui demande', async () => {
    poserProjet()
    expect(await cheminTranscript(projet())).toBeNull()

    poserTranscript()
    expect(await cheminTranscript(projet())).toBeNull()

    oublierSidecar(projet())
    expect(await cheminTranscript(projet())).toContain('transcript.json')
  })
})

describe('lancer', () => {
  it('sur un projet transcrit, viser les candidats ne relance que le repérage', async () => {
    poserProjet()
    poserTranscript()

    const { plan } = await lancer(PROJET, ['candidates'], { db, étapes: étapesFactices() })
    expect(plan).toEqual(['candidates'])

    await attendreLaFin()
    // Ni transcription, ni audio, ni ingestion : c'est tout l'objet du graphe.
    expect(appels).toEqual(['candidates'])
  })

  it('sur un projet neuf, remonte les dépendances jusqu’à la source', async () => {
    poserProjet()

    const { plan } = await lancer(PROJET, ['candidates'], { db, étapes: étapesFactices() })
    expect(plan).toEqual(['audio', 'transcript', 'candidates'])
    await attendreLaFin()
    expect(appels).toEqual(['audio', 'transcript', 'candidates'])
  })

  it('force entraîne l’aval avec lui', async () => {
    poserProjet()
    poserTranscript()
    fs.writeFileSync(path.join(racine, 'projects', PROJET, 'audio.wav'), '')
    fs.writeFileSync(path.join(racine, 'projects', PROJET, 'candidates.json'), '[]')

    const { plan } = await lancer(PROJET, ['candidates'], {
      db,
      force: ['transcript'],
      étapes: étapesFactices(),
    })
    // Refaire le transcript sans reprendre le repérage laisserait des candidats
    // calculés sur un texte qui n'existe plus.
    expect(plan).toEqual(['transcript', 'candidates'])
    await attendreLaFin()
  })

  it('`force: true` vise la cible', async () => {
    poserProjet()
    poserTranscript()
    fs.writeFileSync(path.join(racine, 'projects', PROJET, 'candidates.json'), '[]')

    const { plan } = await lancer(PROJET, ['candidates'], {
      db,
      force: true,
      étapes: étapesFactices(),
    })
    expect(plan).toEqual(['candidates'])
    await attendreLaFin()
  })

  it('refuse une seconde exécution sur le même projet', async () => {
    poserProjet()
    poserTranscript()

    let débloquer = (): void => {}
    const bloquée = new Promise<void>((résoudre) => {
      débloquer = résoudre
    })
    await lancer(PROJET, ['candidates'], {
      db,
      étapes: {
        ...étapesFactices(),
        runCandidates: async () => {
          await bloquée
          return []
        },
      },
    })

    await expect(lancer(PROJET, ['candidates'], { db })).rejects.toBeInstanceOf(
      ExécutionEnCoursError,
    )
    expect(progression(PROJET)).toEqual({ step: 'candidates', progress: 0 })

    débloquer()
    await attendreLaFin()
    expect(progression(PROJET)).toBeNull()
  })

  it('refuse un projet inconnu', async () => {
    await expect(lancer('jamais-vu', ['candidates'], { db })).rejects.toBeInstanceOf(
      ProjetInconnuError,
    )
    // La réservation est relâchée : un projet inconnu ne doit pas rester verrouillé.
    expect(progression('jamais-vu')).toBeNull()
  })

  /**
   * Un projet dont les artefacts sont là mais dont la ligne en base est neuve —
   * base effacée, projet réinscrit — a un plan vide *et* une durée inconnue.
   * Sortir tout de suite le laissait à `0:00` pour toujours, et le premier
   * `run --force` échouait bien plus tard sur « le projet n'a pas de durée ».
   */
  it('ingère quand même si la durée manque, plan vide ou non', async () => {
    poserProjet({ durationSec: null })
    poserTranscript()
    fs.writeFileSync(path.join(racine, 'projects', PROJET, 'candidates.json'), '[]')

    let ingéré = false
    const { plan } = await lancer(PROJET, ['candidates'], {
      db,
      étapes: {
        ...étapesFactices(),
        ingest: async (source) => {
          ingéré = true
          return {
            projectId: PROJET,
            sourcePath: String(source),
            stagedPath: path.join(racine, 'stage', `${PROJET}.mp4`),
            copied: false,
            sizeBytes: 0,
            mtimeMs: 0,
            durationSec: 5936,
          }
        },
      },
    })
    expect(plan).toEqual([])
    await attendreLaFin()
    expect(ingéré).toBe(true)
  })

  it('un plan vide ne prend pas le verrou', async () => {
    poserProjet()
    poserTranscript()
    fs.writeFileSync(path.join(racine, 'projects', PROJET, 'candidates.json'), '[]')

    const { plan } = await lancer(PROJET, ['candidates'], { db, étapes: étapesFactices() })
    expect(plan).toEqual([])
    expect(progression(PROJET)).toBeNull()
    expect(appels).toEqual([])
  })
})

describe('status.json', () => {
  it('rend la main sur `running: null` quand tout est fini', async () => {
    poserProjet()
    poserTranscript()

    await lancer(PROJET, ['candidates'], { db, étapes: étapesFactices() })
    await attendreLaFin()

    const statut = lireStatut(PROJET)
    expect(statut?.running).toBeNull()
    expect(statut?.error).toBeNull()
    expect(statut?.plan).toEqual(['candidates'])
    expect(statut?.finishedAt).toBeTypeOf('number')
  })

  it('écrit un échec **épuré de ses chemins absolus**', async () => {
    poserProjet()
    poserTranscript()

    await lancer(PROJET, ['candidates'], { db, étapes: étapesFactices('candidates') })
    await attendreLaFin()

    const statut = lireStatut(PROJET)
    expect(statut?.error).toContain('ffmpeg a échoué')
    // Ce fichier se recopie dans un rapport : l'arborescence de la machine n'a
    // rien à y faire, même quand elle vient d'un message de ffmpeg.
    expect(statut?.error).not.toContain(racine)
    expect(statut?.error).toContain('…/x.mp4')
  })
})

/**
 * Attend que le lanceur ait fini.
 *
 * `attendre()` du module rendrait la main tout de suite une fois l'exécution
 * retirée de la table ; on boucle donc sur l'absence de progression, ce qui est
 * l'observation que fait l'interface.
 */
async function attendreLaFin(): Promise<void> {
  for (let i = 0; i < 200 && progression(PROJET) !== null; i += 1) {
    await new Promise((résoudre) => setTimeout(résoudre, 5))
  }
}
