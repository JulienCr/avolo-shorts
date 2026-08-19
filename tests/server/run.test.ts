import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { StepName } from '@/core/graph'
import type { SummaryNotation } from '@/server/steps/candidates'
import { getProject, openDb, upsertProject, type Project } from '@/server/db'
import {
  cleanWorkCache,
  stopRun,
  wait,
  detectionSummary,
  pathTranscript,
  ProjectErrorCollision,
  createProject,
  ExecutionInCurrentError,
  launch,
  lireStatus,
  planForTargets,
  forgetSidecar,
  ProjectInconnuError,
  progression,
  readingPresence,
  type Steps,
} from '@/server/run'
import { StopRequestedError } from '@/server/ffmpeg'

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

const PROJECT = '2025-06-15-cqlp'

let root: string
let db: Database.Database
let calls: StepName[]
/** La vidéo que le lanceur donne à l'analyse pour en relever les dimensions. */
let sourcesAnalysis: string[]

/** Les étapes, remplacées par des témoins qui ne font qu'écrire leur artefact. */
function stepsFake(fail?: StepName): Partial<Steps> {
  const note = async (step: StepName, artifact?: string): Promise<void> => {
    calls.push(step)
    if (fail === step) {
      throw new Error(`ffmpeg a échoué — Commande : /usr/bin/ffmpeg -i ${root}/stage/x.mp4`)
    }
    if (artifact !== undefined) {
      fs.mkdirSync(path.dirname(artifact), { recursive: true })
      fs.writeFileSync(artifact, '')
    }
  }

  return {
    ingest: async () => {
      calls.push('proxy' as StepName)
      throw new Error("l'ingestion ne devait pas être appelée")
    },
    buildProxy: async (o) => {
      await note('proxy', path.join(root, 'projects', o.projectId, 'proxy.mp4'))
      return { path: 'proxy.mp4', skipped: false }
    },
    extractAudio: async (o) => {
      await note('audio', path.join(root, 'projects', o.projectId, 'audio.wav'))
      return { path: 'audio.wav', skipped: false }
    },
    transcribe: async (o) => {
      const file = path.join(root, 'projects', o.projectId, `${PROJECT}.avolo`, 'transcript.json')
      await note('transcript', file)
      return { path: file, skipped: false, fallback: true }
    },
    runAnalysis: async (o) => {
      const file = path.join(root, 'projects', o.projectId, 'analysis.json')
      await note('analysis', file)
      sourcesAnalysis.push(o.source)
      return { path: file, skipped: false }
    },
    runCandidates: async (id) => {
      await note('candidates', path.join(root, 'projects', id, 'candidates.json'))
      return []
    },
  }
}

function poserProject(o: { durationSec?: number | null; copy?: boolean } = {}): void {
  const source = path.join(root, 'replays', `${PROJECT}.mp4`)
  const copy = path.join(root, 'stage', `${PROJECT}.mp4`)
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, '')
  if (o.copy !== false) {
    fs.mkdirSync(path.dirname(copy), { recursive: true })
    fs.writeFileSync(copy, '')
  }
  upsertProject(db, {
    id: PROJECT,
    sourcePath: source,
    stagedPath: copy,
    durationSec: o.durationSec === undefined ? 5936 : o.durationSec,
    sizeBytes: 0,
    mtimeMs: 0,
    createdAt: 1_787_019_419_976,
  })
}

/** Le proxy déjà là : l'analyse en dépend, et le poser évite de le refaire. */
function poserProxy(): void {
  const folder = path.join(root, 'projects', PROJECT)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'proxy.mp4'), '')
}

/** Le transcript déjà là, dans le repli du projet — le cas de la vérification. */
function poserTranscript(): void {
  const folder = path.join(root, 'projects', PROJECT, `${PROJECT}.avolo`)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'transcript.json'), '{"segments":[]}')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-run-'))
  process.env.REPLAY_DIR = path.join(root, 'replays')
  process.env.STAGE_DIR = path.join(root, 'stage')
  process.env.PROJECTS_DIR = path.join(root, 'projects')
  fs.mkdirSync(process.env.REPLAY_DIR, { recursive: true })
  db = openDb(':memory:')
  calls = []
  sourcesAnalysis = []
})

afterEach(async () => {
  // **Rien ne doit tourner d'un test à l'autre.** `enCours` est une table de
  // module : une exécution qu'une assertion ratée aurait laissée derrière elle
  // ferait échouer le test suivant sur `ExécutionEnCoursError`, à un endroit qui
  // ne dit rien du vrai défaut. Et la base se referme après, pas avant : une
  // exécution encore vivante s'en servirait.
  stopRun(PROJECT)
  await waitFin()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

/**
 * Le bilan du repérage, tel que `status.json` le porte.
 *
 * **Un bilan décrit une notation tentée, pas une notation réussie.** Il est posé
 * avant le premier appel et se remplit au fil de l'eau : une passe qui échoue à
 * la quarantième fenêtre en laisse un qui dit « 40 sur 83 ». Le lire seul ferait
 * afficher ce chiffre comme un résultat.
 *
 * **Ce qui le qualifie est le sort de l'étape `candidates`, pas celui de
 * l'exécution.** Une création vise `['candidates', 'proxy', 'analysis']` : le
 * repérage y finit en trente secondes, le proxy tourne six minutes derrière lui,
 * et l'analyse peut échouer ensuite. Déduire `partiel` de l'`error` et du
 * `finishedAt` de l'exécution marquait donc partiel un bilan complet pendant tout
 * le proxy, et **définitivement** si une étape ultérieure tombait.
 * (relevé par Codex et Copilot)
 */
describe('bilanDeRepérage', () => {
  const summary: SummaryNotation = {
    windows: 83,
    noted: 51,
    neverNoted: Array.from({ length: 32 }, (_, i) => `window_${i}`),
    rejected: [],
    calls: 14,
    batchesRejected: 4,
    batchesResponded: 7,
    coverage: 0.6412,
  }

  it('rend null quand aucune notation n’est décrite', () => {
    expect(detectionSummary(null, 'fait')).toBeNull()
  })

  /**
   * Le bilan vit dans ce processus et survit à l'exécution qui l'a produit. Une
   * relance qui ne vise que le proxy y recopierait sinon le décompte d'un
   * repérage qu'elle n'a pas fait.
   */
  it('rend null quand le repérage n’a pas tourné dans cette exécution', () => {
    expect(detectionSummary(summary, 'absent')).toBeNull()
  })

  it('publie les décomptes, jamais la liste des identifiants', () => {
    expect(detectionSummary(summary, 'fait')).toEqual({
      windows: 83,
      scored: 51,
      rejectedBatches: 4,
      answeredBatches: 7,
      coverage: 0.6412,
      partial: false,
    })
  })

  it('marque partiel un repérage qui a échoué', () => {
    expect(detectionSummary(summary, 'échoué')?.partial).toBe(true)
  })

  /**
   * Une notation en cours n'a pas fini : ce qu'elle annonce est un décompte
   * provisoire, et le dire est précisément le rôle de ce drapeau.
   */
  it('marque partiel un repérage en cours', () => {
    expect(detectionSummary(summary, 'en cours')?.partial).toBe(true)
  })

  /**
   * Le cas que les deux relecteurs ont nommé : le repérage est fini et bon,
   * l'exécution ne l'est pas encore.
   */
  it('ne marque pas partiel un repérage fini sous une exécution qui continue', () => {
    expect(detectionSummary(summary, 'fait')?.partial).toBe(false)
  })
})

describe('planPourCibles', () => {
  const nothing: Record<StepName, boolean> = {
    proxy: false,
    audio: false,
    transcript: false,
    analysis: false,
    candidates: false,
    renders: false,
  }

  it('enchaîne deux cibles sans répéter ce qui est déjà planifié', () => {
    // C'est ce que fait `POST /api/projects` : rien ne dépend du proxy dans le
    // graphe, donc viser les candidats ne le construirait jamais.
    expect(planForTargets(['candidates', 'proxy'], nothing, [])).toEqual([
      'audio',
      'transcript',
      'candidates',
      'proxy',
    ])
  })

  it('ne planifie rien quand tout est là', () => {
    const all = { ...nothing, proxy: true, audio: true, transcript: true, candidates: true }
    expect(planForTargets(['candidates', 'proxy'], all, [])).toEqual([])
  })
})

describe('relevéPrésence', () => {
  it('lit les artefacts sur le disque, y compris le sidecar rabattu dans le projet', async () => {
    poserProject()
    poserTranscript()
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'proxy.mp4'), '')

    const project = { id: PROJECT, sourcePath: path.join(root, 'replays', `${PROJECT}.mp4`) }
    const presence = await readingPresence({
      ...project,
      stagedPath: null,
      durationSec: null,
      sizeBytes: null,
      mtimeMs: null,
      createdAt: 0,
    })
    expect(presence).toEqual({
      proxy: true,
      audio: false,
      transcript: true,
      analysis: false,
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
    poserProject()
    const renders = path.join(root, 'projects', PROJECT, 'renders')
    fs.mkdirSync(renders, { recursive: true })
    fs.writeFileSync(path.join(renders, 'clip.partiel-1234-1.mp4'), '')

    const project: Project = {
      id: PROJECT,
      sourcePath: path.join(root, 'replays', `${PROJECT}.mp4`),
      stagedPath: null,
      durationSec: null,
      sizeBytes: null,
      mtimeMs: null,
      createdAt: 0,
    }
    expect((await readingPresence(project)).renders).toBe(false)

    fs.writeFileSync(path.join(renders, 'clip.mp4'), '')
    forgetSidecar(project)
    expect((await readingPresence(project)).renders).toBe(true)
  })
})

/**
 * L'analyse d'image, dans le lanceur. Ce que ces cas figent n'est pas la
 * détection — elle est injectée — mais **ce que le lanceur accepte de lui
 * donner**, et à quel prix.
 */
describe('analysis', () => {
  it('ne construit que le proxy pour atteindre l’analyse', async () => {
    poserProject()
    const { plan } = await launch(PROJECT, ['analysis'], { db, steps: stepsFake() })
    expect(plan).toEqual(['proxy', 'analysis'])
    await wait(PROJECT)
    expect(calls).toEqual(['proxy', 'analysis'])
  })

  /**
   * **Le repli sur l'original quand la copie de travail a disparu.** L'analyse
   * ne lit de la source que ses dimensions, recopiées dans `analysis.json` pour
   * dire à quoi ses fractions se rapportent — un en-tête, pas de la vidéo.
   * Exiger la copie ferait payer cinq minutes de recopie depuis un montage 9p
   * lent pour relancer une analyse dont le proxy est déjà sur le disque.
   */
  it('se rabat sur l’original quand la copie de travail n’est plus là', async () => {
    poserProject({ copy: false })
    poserProxy()

    await launch(PROJECT, ['analysis'], { db, steps: stepsFake() })
    await wait(PROJECT)
    expect(sourcesAnalysis).toEqual([path.join(root, 'replays', `${PROJECT}.mp4`)])
  })

  it('préfère la copie de travail quand elle est là', async () => {
    poserProject()
    poserProxy()

    await launch(PROJECT, ['analysis'], { db, steps: stepsFake() })
    await wait(PROJECT)
    expect(sourcesAnalysis).toEqual([path.join(root, 'stage', `${PROJECT}.mp4`)])
  })

  it('ne relance pas la transcription pour une analyse', async () => {
    poserProject()
    await launch(PROJECT, ['analysis'], { db, steps: stepsFake() })
    await wait(PROJECT)
    expect(calls).not.toContain('transcript')
    expect(calls).not.toContain('audio')
  })
})

describe('créerProjet', () => {
  /**
   * **Ce que `POST /api/projects` vise, et le seul endroit qui le dise.**
   * `CIBLES_INITIALES` porte `analysis` parce que personne ne clique « détecte
   * les corps » : on veut un projet dont le cadrage sait déjà se calculer. Les
   * cas plus haut visent `analysis` explicitement, donc aucun ne verrait cette
   * cible disparaître de la liste — la suite resterait verte et un projet neuf
   * n'aurait plus jamais d'analyse. (relevé par Copilot)
   */
  it('vise l’analyse à la création, après le proxy dont elle dépend', async () => {
    poserProject()
    const { plan } = await createProject(`${PROJECT}.mp4`, { db, steps: stepsFake() })
    expect(plan).toContain('analysis')
    expect(plan.indexOf('proxy')).toBeLessThan(plan.indexOf('analysis'))

    await wait(PROJECT)
    expect(calls).toContain('analysis')
    expect(calls.indexOf('proxy')).toBeLessThan(calls.indexOf('analysis'))
  })

  /**
   * `projectIdFromSource` retire l'extension : `show.mp4` et `show.mov` donnent
   * tous deux `show`. Sans refus, la seconde ingestion gardait la copie de
   * travail, la durée et les artefacts de la première, et l'outil continuait de
   * servir l'autre vidéo sans un mot. (relevé par Copilot)
   */
  it('refuse deux sources qui se partageraient un identifiant', async () => {
    poserProject()
    fs.writeFileSync(path.join(root, 'replays', `${PROJECT}.mov`), '')

    await expect(
      createProject(`${PROJECT}.mov`, { db, steps: stepsFake() }),
    ).rejects.toBeInstanceOf(ProjectErrorCollision)

    // Et le projet d'origine n'a pas bougé.
    expect(getProject(db, PROJECT)?.sourcePath).toBe(path.join(root, 'replays', `${PROJECT}.mp4`))
  })
})

describe('cheminTranscript', () => {
  const project = (): Project => ({
    id: PROJECT,
    sourcePath: path.join(root, 'replays', `${PROJECT}.mp4`),
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
  /**
   * Renoncer n'est pas annuler : le `fsp.stat` abandonné occupe un fil du vivier
   * de libuv jusqu'à ce que le noyau rende la main, ce qu'un montage 9p au
   * transport mort ne fait jamais. Une seconde sonde en occuperait un de plus
   * sans rien apprendre, et quatre suffiraient à figer tout ce qui touche au
   * disque. (relevé par Copilot)
   */
  it('ne lance qu’une sonde à la fois sur un montage muet', async () => {
    poserProject()
    // Un chemin qui ne répondra pas : on remplace le `stat` par un appel qui ne
    // se règle jamais, comme le fait un transport 9p mort.
    const trueStat = fsp.stat
    let probes = 0
    // @ts-expect-error — remplacement de sonde, restauré juste après.
    fsp.stat = () => {
      probes += 1
      return new Promise(() => {})
    }

    const mute: Project = {
      id: PROJECT,
      sourcePath: path.join(root, 'replays', 'absent.mp4'),
      stagedPath: null,
      durationSec: null,
      sizeBytes: null,
      mtimeMs: null,
      createdAt: 0,
    }

    try {
      // Trois interrogations rapprochées, comme l'écran de tri en fait une
      // toutes les deux secondes. Une seule sonde doit partir.
      const first = Promise.all([pathTranscript(mute), pathTranscript(mute)])
      await new Promise((r) => setTimeout(r, 10))
      expect(probes).toBe(1)
      forgetSidecar(mute)
      // Même après oubli de l'emplacement, la sonde précédente est toujours en
      // vol : on ne doit pas en lancer une seconde.
      expect(await pathTranscript(mute)).toBeNull()
      expect(probes).toBe(1)
      void first
    } finally {
      fsp.stat = trueStat
    }
  }, 30_000)

  it('retient une absence, et l’oublie quand on le lui demande', async () => {
    poserProject()
    expect(await pathTranscript(project())).toBeNull()

    poserTranscript()
    expect(await pathTranscript(project())).toBeNull()

    forgetSidecar(project())
    expect(await pathTranscript(project())).toContain('transcript.json')
  })
})

describe('lancer', () => {
  it('sur un projet transcrit, viser les candidats ne relance que le repérage', async () => {
    poserProject()
    poserTranscript()

    const { plan } = await launch(PROJECT, ['candidates'], { db, steps: stepsFake() })
    expect(plan).toEqual(['candidates'])

    await waitFin()
    // Ni transcription, ni audio, ni ingestion : c'est tout l'objet du graphe.
    expect(calls).toEqual(['candidates'])
  })

  it('sur un projet neuf, remonte les dépendances jusqu’à la source', async () => {
    poserProject()

    const { plan } = await launch(PROJECT, ['candidates'], { db, steps: stepsFake() })
    expect(plan).toEqual(['audio', 'transcript', 'candidates'])
    await waitFin()
    expect(calls).toEqual(['audio', 'transcript', 'candidates'])
  })

  it('force entraîne l’aval avec lui', async () => {
    poserProject()
    poserTranscript()
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'audio.wav'), '')
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'candidates.json'), '[]')

    const { plan } = await launch(PROJECT, ['candidates'], {
      db,
      force: ['transcript'],
      steps: stepsFake(),
    })
    // Refaire le transcript sans reprendre le repérage laisserait des candidats
    // calculés sur un texte qui n'existe plus.
    expect(plan).toEqual(['transcript', 'candidates'])
    await waitFin()
  })

  it('`force: true` vise la cible', async () => {
    poserProject()
    poserTranscript()
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'candidates.json'), '[]')

    const { plan } = await launch(PROJECT, ['candidates'], {
      db,
      force: true,
      steps: stepsFake(),
    })
    expect(plan).toEqual(['candidates'])
    await waitFin()
  })

  it('refuse une seconde exécution sur le même projet', async () => {
    poserProject()
    poserTranscript()

    let unblock = (): void => {}
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve
    })
    await launch(PROJECT, ['candidates'], {
      db,
      steps: {
        ...stepsFake(),
        runCandidates: async () => {
          await blocked
          return []
        },
      },
    })

    await expect(launch(PROJECT, ['candidates'], { db })).rejects.toBeInstanceOf(
      ExecutionInCurrentError,
    )
    expect(progression(PROJECT)).toEqual({ step: 'candidates', progress: 0 })

    unblock()
    await waitFin()
    expect(progression(PROJECT)).toBeNull()
  })

  it('refuse un projet inconnu', async () => {
    await expect(launch('jamais-vu', ['candidates'], { db })).rejects.toBeInstanceOf(
      ProjectInconnuError,
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
    poserProject({ durationSec: null })
    poserTranscript()
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'candidates.json'), '[]')

    let ingested = false
    const { plan } = await launch(PROJECT, ['candidates'], {
      db,
      steps: {
        ...stepsFake(),
        ingest: async (source) => {
          ingested = true
          return {
            projectId: PROJECT,
            sourcePath: String(source),
            stagedPath: path.join(root, 'stage', `${PROJECT}.mp4`),
            copied: false,
            sizeBytes: 0,
            mtimeMs: 0,
            durationSec: 5936,
          }
        },
      },
    })
    expect(plan).toEqual([])
    await waitFin()
    expect(ingested).toBe(true)
  })

  it('un plan vide ne prend pas le verrou', async () => {
    poserProject()
    poserTranscript()
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'candidates.json'), '[]')

    const { plan } = await launch(PROJECT, ['candidates'], { db, steps: stepsFake() })
    expect(plan).toEqual([])
    expect(progression(PROJECT)).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('status.json', () => {
  it('rend la main sur `running: null` quand tout est fini', async () => {
    poserProject()
    poserTranscript()

    await launch(PROJECT, ['candidates'], { db, steps: stepsFake() })
    await waitFin()

    const status = lireStatus(PROJECT)
    expect(status?.running).toBeNull()
    expect(status?.error).toBeNull()
    expect(status?.plan).toEqual(['candidates'])
    expect(status?.finishedAt).toBeTypeOf('number')
  })

  it('écrit un échec **épuré de ses chemins absolus**', async () => {
    poserProject()
    poserTranscript()

    await launch(PROJECT, ['candidates'], { db, steps: stepsFake('candidates') })
    await waitFin()

    const status = lireStatus(PROJECT)
    expect(status?.error).toContain('ffmpeg a échoué')
    // Ce fichier se recopie dans un rapport : l'arborescence de la machine n'a
    // rien à y faire, même quand elle vient d'un message de ffmpeg.
    expect(status?.error).not.toContain(root)
    expect(status?.error).toContain('…/x.mp4')
  })

  /**
   * **La lecture tolérante des anciens noms** (issue #73). `status.json` n'a
   * pas de migration de fichiers — voir `statusFromJSON` dans
   * `src/server/run.ts`, qui explique pourquoi une lecture tolérante suffit
   * ici là où la table `settings` en a une pour de bon. Un fichier écrit par
   * une version d'avant cette PR porte encore `cibles` et `repérage`, avec les
   * six champs du bilan sous leurs noms français : `lireStatut` doit les
   * retrouver sous `targets` et `selectionReport`, sans qu'un redémarrage du
   * serveur ne les efface silencieusement de l'écran de projet.
   */
  it('relit un `status.json` écrit avant la traduction des clés, bilan compris', () => {
    poserProject()
    const dir = path.join(root, 'projects', PROJECT)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'status.json'),
      JSON.stringify({
        pid: 1,
        updatedAt: 0,
        cibles: ['candidates', 'proxy'],
        plan: ['candidates', 'proxy'],
        running: null,
        error: null,
        finishedAt: 1,
        stopped: false,
        repérage: {
          fenêtres: 83,
          notées: 51,
          lotsRefusés: 4,
          lotsRépondus: 7,
          couverture: 0.6412,
          partiel: false,
        },
      }),
    )

    const status = lireStatus(PROJECT)
    expect(status?.targets).toEqual(['candidates', 'proxy'])
    expect(status?.selectionReport).toEqual({
      windows: 83,
      scored: 51,
      rejectedBatches: 4,
      answeredBatches: 7,
      coverage: 0.6412,
      partial: false,
    })
  })

  it('relit un `status.json` écrit avant la traduction quand le repérage n’a rien à dire', () => {
    poserProject()
    const dir = path.join(root, 'projects', PROJECT)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'status.json'),
      JSON.stringify({
        pid: 1,
        updatedAt: 0,
        cibles: ['candidates'],
        plan: ['candidates'],
        running: null,
        error: null,
        finishedAt: 1,
        stopped: false,
        repérage: null,
      }),
    )

    const status = lireStatus(PROJECT)
    expect(status?.targets).toEqual(['candidates'])
    expect(status?.selectionReport).toBeNull()
  })
})

/**
 * L'arrêt d'une analyse, de bout en bout.
 *
 * **Ce qui se vérifie ici n'est pas qu'un processus meurt** — c'est éprouvé dans
 * `tests/server/ffmpeg.test.ts`, sur de vrais processus — mais ce que le lanceur
 * en fait : le signal descend jusqu'aux étapes, la suivante ne part pas, ce qui
 * était fait reste fait, `status.json` ne ressemble pas à une panne, et la
 * reprise repart à la première étape manquante (retour d'usage §4.1).
 */
describe("l'arrêt d'une exécution", () => {
  /**
   * Des étapes qui n'en finissent pas, jusqu'à ce qu'on les arrête.
   *
   * `bloquante` est celle qui pend ; les autres écrivent leur artefact
   * normalement. C'est ce qui permet de tuer l'exécution au milieu de son plan
   * et de vérifier que ce qui la précédait a bien survécu.
   */
  function stepsWhichPending(blocking: StepName): Partial<Steps> {
    const fake = stepsFake()
    const pend = (signal: AbortSignal | undefined): Promise<never> =>
      new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new StopRequestedError(blocking)), {
          once: true,
        })
      })

    return {
      ...fake,
      buildProxy: async (o) => {
        calls.push('proxy')
        if (blocking === 'proxy') return pend(o.signal)
        return fake.buildProxy!(o)
      },
      extractAudio: async (o) => {
        if (blocking === 'audio') {
          calls.push('audio')
          return pend(o.signal)
        }
        return fake.extractAudio!(o)
      },
      runCandidates: async (id, o) => {
        if (blocking === 'candidates') {
          calls.push('candidates')
          return pend(o?.signal)
        }
        return fake.runCandidates!(id, o)
      },
    }
  }

  it('rend faux quand rien ne tourne — deux clics ne sont pas une erreur', () => {
    expect(stopRun(PROJECT)).toBe(false)
    expect(stopRun('projet-qui-n-existe-pas')).toBe(false)
  })

  it('coupe le travail en cours et rend vrai, deux fois de suite', async () => {
    poserProject()
    poserTranscript()
    await launch(PROJECT, ['proxy'], { db, steps: stepsWhichPending('proxy') })
    // L'étape a bien démarré : sans cela, l'arrêt éprouverait le refus d'entrée
    // et non la coupure d'un travail en cours.
    await waitStep('proxy')

    expect(stopRun(PROJECT)).toBe(true)
    // Idempotent : un second appel pendant que l'exécution finit de descendre
    // dit toujours vrai, et n'a pas d'effet supplémentaire.
    expect(stopRun(PROJECT)).toBe(true)

    await waitFin()
    expect(progression(PROJECT)).toBeNull()
  })

  /**
   * **Un arrêt demandé n'est pas une panne.** Écrire le message du processus tué
   * — « ffmpeg a échoué (tué par SIGTERM) » — ferait afficher un bandeau d'échec
   * à quelqu'un qui vient de cliquer « Arrêter », et `phaseProjet` classerait le
   * projet en `echec` au lieu d'`interrompu`.
   */
  it('écrit un statut d’arrêt, sans erreur et sans running', async () => {
    poserProject()
    poserTranscript()
    await launch(PROJECT, ['proxy'], { db, steps: stepsWhichPending('proxy') })
    await waitStep('proxy')
    stopRun(PROJECT)
    await waitFin()

    const status = lireStatus(PROJECT)
    expect(status?.stopped).toBe(true)
    expect(status?.error).toBeNull()
    expect(status?.running).toBeNull()
    expect(status?.finishedAt).not.toBeNull()
  })

  /**
   * L'étape suivante ne doit pas partir. Sans le contrôle à l'entrée de chaque
   * étape, arrêter pendant la transcription laisserait démarrer les six minutes
   * de proxy qui la suivent — le processus tué serait bien mort, et le travail
   * continuerait quand même.
   */
  it('n’enchaîne pas sur l’étape suivante', async () => {
    poserProject()
    await launch(PROJECT, ['candidates'], { db, steps: stepsWhichPending('audio') })
    await waitStep('audio')
    stopRun(PROJECT)
    await waitFin()

    expect(calls).toEqual(['audio'])
    expect(fs.existsSync(path.join(root, 'projects', PROJECT, `${PROJECT}.avolo`))).toBe(false)
  })

  /**
   * **Ce qui est fait reste fait, et la reprise repart à la première étape
   * manquante.** C'est le critère du §4.1 du retour d'usage, et il ne demande
   * aucun code de reprise : le graphe le fait déjà, à condition qu'une étape
   * tuée n'ait rien laissé qui la ferait passer pour faite.
   */
  it('laisse les artefacts déjà terminés, et la reprise finit le travail', async () => {
    poserProject()
    await launch(PROJECT, ['candidates'], { db, steps: stepsWhichPending('candidates') })
    await waitStep('candidates')
    stopRun(PROJECT)
    await waitFin()

    // L'audio et le transcript sont passés avant l'arrêt : ils restent.
    const presence = await readingPresence(getProject(db, PROJECT) as Project)
    expect(presence.audio).toBe(true)
    expect(presence.transcript).toBe(true)
    expect(presence.candidates).toBe(false)

    calls = []
    const { plan } = await launch(PROJECT, ['candidates'], { db, steps: stepsFake() })
    // La reprise ne refait ni l'audio ni le transcript.
    expect(plan).toEqual(['candidates'])
    await waitFin()
    expect(calls).toEqual(['candidates'])
    expect(lireStatus(PROJECT)?.stopped).toBe(false)
    expect(lireStatus(PROJECT)?.error).toBeNull()
  })

  /** Une exécution arrêtée s'est terminée comme on le voulait : rien ne rejette. */
  it('ne fait pas rejeter l’attente de l’exécution', async () => {
    poserProject()
    poserTranscript()
    await launch(PROJECT, ['proxy'], { db, steps: stepsWhichPending('proxy') })
    await waitStep('proxy')
    stopRun(PROJECT)
    await expect(wait(PROJECT)).resolves.toBeUndefined()
  })

  /**
   * **Le nettoyage du cache épargne ce qu'une exécution lit.** Le balayage de
   * démarrage continue après le retour de `register()` : le serveur accepte une
   * analyse pendant qu'il tourne, cette analyse constate sa copie présente —
   * elle n'a rien à recopier, donc rien ne l'inscrit dans les copies en vol — et
   * un `cleanStage` nu la lui retirait. (relevé par Copilot)
   */
  it('n’efface pas la copie de travail d’une exécution en cours', async () => {
    poserProject()
    poserTranscript()
    const copy = path.join(root, 'stage', `${PROJECT}.mp4`)
    // Vieille de deux TTL : sans la garde, elle part.
    const old = new Date(Date.now() - 9 * 60 * 60 * 1000)
    fs.utimesSync(copy, old, old)

    await launch(PROJECT, ['proxy'], { db, steps: stepsWhichPending('proxy') })
    await waitStep('proxy')
    expect(await cleanWorkCache(db)).toEqual([])
    expect(fs.existsSync(copy)).toBe(true)

    stopRun(PROJECT)
    await waitFin()
    // Une fois l'exécution finie, plus rien ne l'épargne et le TTL s'applique.
    // On ne compare pas la liste rendue : le nettoyage qui suit chaque exécution
    // a pu passer avant celui-ci, auquel cas il ne reste rien à retirer. Ce qui
    // se vérifie est l'effet, pas lequel des deux l'a produit.
    await cleanWorkCache(db)
    expect(fs.existsSync(copy)).toBe(false)
  })

  /** Un échec ordinaire garde son message : l'arrêt ne l'avale pas. */
  it('n’écrase pas un vrai échec quand personne n’a rien demandé', async () => {
    poserProject()
    poserTranscript()
    await launch(PROJECT, ['candidates'], { db, steps: stepsFake('candidates') })
    await waitFin()
    expect(lireStatus(PROJECT)?.stopped).toBe(false)
    expect(lireStatus(PROJECT)?.error).toContain('ffmpeg a échoué')
  })
})

/**
 * Attend que le lanceur ait fini.
 *
 * `attendre()` du module rendrait la main tout de suite une fois l'exécution
 * retirée de la table ; on boucle donc sur l'absence de progression, ce qui est
 * l'observation que fait l'interface.
 */
async function waitFin(): Promise<void> {
  for (let i = 0; i < 200 && progression(PROJECT) !== null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * Attend que le lanceur en soit à une étape donnée.
 *
 * `lancer` rend la main **avant** que l'exécution ne commence — c'est ce qui
 * permet à `POST /run` de répondre 202 en disant ce qu'il va faire. Arrêter dans
 * la foulée éprouverait donc le refus d'entrée d'une étape, pas la coupure d'un
 * travail en cours, et le test passerait sans rien démontrer.
 */
async function waitStep(step: StepName): Promise<void> {
  for (let i = 0; i < 200 && progression(PROJECT)?.step !== step; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(progression(PROJECT)?.step).toBe(step)
}
