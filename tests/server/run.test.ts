import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StepName } from '@/core/graph'
import { CAPACITIES } from '@/core/resources'
import type { SummaryNotation } from '@/server/steps/candidates'
import {
  applySettings,
  getProject,
  listProjects,
  openDb,
  upsertProject,
  type Project,
} from '@/server/db'
import {
  cleanWorkCache,
  stopRun,
  wait,
  detectionSummary,
  pathTranscript,
  ProjectErrorCollision,
  createProject as createProjectRun,
  ExecutionInCurrentError,
  launch as launchRun,
  lireStatus,
  planForTargets,
  forgetSidecar,
  UnknownProjectError,
  progression,
  readingPresence,
  type OptionsLaunch,
  type Steps,
} from '@/server/run'
import { StopRequestedError } from '@/server/ffmpeg'
import { createScheduler, type Scheduler } from '@/server/scheduler'
import { CorrectionProposalError } from '@/server/steps/transcript-correction'

/**
 * Le lanceur, sans GPU, sans ffmpeg et sans vidéo : les étapes sont injectées.
 *
 * Ce qui se vérifie ici n'est pas qu'un proxy s'encode — c'est déjà testé
 * ailleurs — mais **ce que le lanceur décide de faire tourner**, et ce qu'il
 * refuse. Le cas qui compte tient en une phrase : sur un projet dont le
 * transcript **et** la correction existent déjà, demander les candidats ne
 * doit relancer que le repérage. Si ce test tombe, le produit est
 * inutilisable au quotidien — on retranscrit deux heures cinquante d'audio,
 * ou on rappelle le modèle de correction pour rien, pour reformuler des
 * propositions.
 *
 * **`correction` s'intercale entre `transcript` et `candidates`** depuis le
 * 23 août 2026 (spec §5, §9) : un transcript présent sans `correction.json`
 * ne suffit plus à limiter le plan au seul repérage, et `poserCorrection`
 * pose l'artefact qui manque pour retrouver ce cas.
 */

const PROJECT = '2025-06-15-cqlp'

let root: string
let db: Database.Database
let calls: StepName[]
/** La vidéo que le lanceur donne à l'analyse pour en relever les dimensions. */
let sourcesAnalysis: string[]
/** Le fichier que chaque étape ffmpeg a reçu, dans l'ordre. */
let inputsSteps: string[]

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
      inputsSteps.push(o.input)
      await note('proxy', path.join(root, 'projects', o.projectId, 'proxy.mp4'))
      return { path: 'proxy.mp4', skipped: false }
    },
    extractAudio: async (o) => {
      inputsSteps.push(o.input)
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
    applyTranscriptCorrections: async (project) => {
      const file = path.join(root, 'projects', project.id, `${PROJECT}.avolo`, 'correction.json')
      await note('correction', file)
      return { entries: [], applied: 0, failed: 0, rejected: {} }
    },
    runCandidates: async (id) => {
      await note('candidates', path.join(root, 'projects', id, 'candidates.json'))
      return []
    },
  }
}

function poserProject(
  o: {
    durationSec?: number | null
    copy?: boolean
    /**
     * La taille de la copie, quand elle doit **différer** de celle de
     * l'original. Sert le seul cas où `workingInput` doit écarter un fichier
     * pourtant présent : un replay réimporté sous le même nom avec une autre
     * taille. Par défaut les deux font zéro octet, donc la copie décrit bien
     * la source.
     */
    copyBytes?: number
  } = {},
): void {
  const source = path.join(root, 'replays', `${PROJECT}.mp4`)
  const copy = path.join(root, 'stage', `${PROJECT}.mp4`)
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, '')
  if (o.copy !== false) {
    fs.mkdirSync(path.dirname(copy), { recursive: true })
    fs.writeFileSync(copy, Buffer.alloc(o.copyBytes ?? 0, 1))
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

/** Le journal de correction déjà là, à côté du transcript — même repli. */
function poserCorrection(): void {
  const folder = path.join(root, 'projects', PROJECT, `${PROJECT}.avolo`)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'correction.json'), '{"entries":[]}')
}

/**
 * This file's scheduler, in memory only.
 *
 * Without it, every call would fall back on the `@/server/scheduler`
 * singleton, which captures `PROJECTS_DIR` at its first construction in this
 * test worker and keeps it past the next `mkdtempSync` — a lock file sought
 * under a directory already wiped. A fresh instance per test also isolates
 * the `gpu`/`cpu`/`net` tokens from one test to the next.
 */
let testScheduler: Scheduler

/** `launch`, with the test scheduler in place by default. */
function launch(
  projectId: string,
  targets: readonly StepName[],
  options: OptionsLaunch = {},
): ReturnType<typeof launchRun> {
  return launchRun(projectId, targets, { scheduler: testScheduler, ...options })
}

/** `createProject`, with the same default as `launch` above. */
function createProject(
  source: string,
  options: OptionsLaunch & { launchNow?: boolean } = {},
): ReturnType<typeof createProjectRun> {
  return createProjectRun(source, { scheduler: testScheduler, ...options })
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
  inputsSteps = []
  testScheduler = createScheduler({ capacities: CAPACITIES, lockDir: null })
})

afterEach(async () => {
  // **Rien ne doit tourner d'un test à l'autre.** `inCurrent` est une table de
  // module : une exécution qu'une assertion ratée aurait laissée derrière elle
  // ferait échouer le test suivant sur `ExecutionInCurrentError`, à un endroit qui
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
describe('detectionSummary', () => {
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
    expect(detectionSummary(null, 'done')).toBeNull()
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
    expect(detectionSummary(summary, 'done')).toEqual({
      windows: 83,
      scored: 51,
      rejectedBatches: 4,
      answeredBatches: 7,
      coverage: 0.6412,
      partial: false,
    })
  })

  it('marque partiel un repérage qui a échoué', () => {
    expect(detectionSummary(summary, 'failed')?.partial).toBe(true)
  })

  /**
   * Une notation en cours n'a pas fini : ce qu'elle annonce est un décompte
   * provisoire, et le dire est précisément le rôle de ce drapeau.
   */
  it('marque partiel un repérage en cours', () => {
    expect(detectionSummary(summary, 'running')?.partial).toBe(true)
  })

  /**
   * Le cas que les deux relecteurs ont nommé : le repérage est fini et bon,
   * l'exécution ne l'est pas encore.
   */
  it('ne marque pas partiel un repérage fini sous une exécution qui continue', () => {
    expect(detectionSummary(summary, 'done')?.partial).toBe(false)
  })
})

describe('planForTargets', () => {
  const nothing: Record<StepName, boolean> = {
    proxy: false,
    audio: false,
    transcript: false,
    correction: false,
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
      'correction',
      'candidates',
      'proxy',
    ])
  })

  it('ne planifie rien quand tout est là', () => {
    const all = {
      ...nothing,
      proxy: true,
      audio: true,
      transcript: true,
      correction: true,
      candidates: true,
    }
    expect(planForTargets(['candidates', 'proxy'], all, [])).toEqual([])
  })
})

describe('readingPresence', () => {
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
      correction: false,
      analysis: false,
      candidates: false,
      renders: false,
    })
  })

  /**
   * `pathTemporary` garde l'extension d'origine — ffmpeg choisit son muxeur
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

  /**
   * **L'avertissement du repli ne tombe que s'il décrit un accident.**
   *
   * Coché, une copie absente au moment de l'analyse est une anomalie : le §5 du
   * retour d'usage décrit ce basculement silencieux sur le 9p comme « extrêmement
   * lent », et une lenteur inexpliquée se cherche une demi-heure avant qu'on
   * pense au montage. Décoché, c'est le réglage qui s'applique — le signaler à
   * chaque passe apprendrait à ne plus lire les avertissements, et le premier
   * vrai passerait avec les autres.
   */
  it('n’avertit du repli sur l’original que si la copie était attendue', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      poserProject({ copy: false })
      poserProxy()

      await launch(PROJECT, ['analysis'], { db, steps: stepsFake() })
      await wait(PROJECT)
      expect(warn.mock.calls.flat().join('\n')).toMatch(/pas de copie de travail dans stage\//)

      warn.mockClear()
      applySettings(db, { ingestion: { copySourceLocally: false } })
      await launch(PROJECT, ['analysis'], { db, steps: stepsFake(), force: ['analysis'] })
      await wait(PROJECT)
      expect(warn.mock.calls.flat().join('\n')).not.toMatch(/pas de copie de travail/)
      // Et la source retenue est bien l'original, dans les deux cas.
      expect(sourcesAnalysis).toEqual([
        path.join(root, 'replays', `${PROJECT}.mp4`),
        path.join(root, 'replays', `${PROJECT}.mp4`),
      ])
    } finally {
      warn.mockRestore()
    }
  })

  it('ne relance pas la transcription pour une analyse', async () => {
    poserProject()
    await launch(PROJECT, ['analysis'], { db, steps: stepsFake() })
    await wait(PROJECT)
    expect(calls).not.toContain('transcript')
    expect(calls).not.toContain('audio')
  })
})

describe('createProject', () => {
  /**
   * **Ce que `POST /api/projects` vise, et le seul endroit qui le dise.**
   * `TARGETS_INITIAL` porte `analysis` parce que personne ne clique « détecte
   * les corps » : on veut un projet dont le cadrage sait déjà se calculer. Les
   * cas plus haut visent `analysis` explicitement, donc aucun ne verrait cette
   * cible disparaître de la liste — la suite resterait verte et un projet neuf
   * n'aurait plus jamais d'analyse. (relevé par Copilot)
   */
  it('vise l’analyse à la création, après le proxy dont elle dépend', async () => {
    poserProject()
    const { plan } = await createProject(`${PROJECT}.mp4`, {
      db,
      steps: stepsFake(),
      launchNow: true,
    })
    expect(plan).toContain('analysis')
    expect(plan.indexOf('proxy')).toBeLessThan(plan.indexOf('analysis'))

    await wait(PROJECT)
    expect(calls).toContain('analysis')
    expect(calls.indexOf('proxy')).toBeLessThan(calls.indexOf('analysis'))
  })

  // Point A.3 du retour d'usage (23 août 2026) : un clic sur la carte d'un
  // replay ne doit plus déclencher 30 à 45 minutes de traitement sans étape
  // intermédiaire. `launchNow` vaut donc `false` par défaut — ni `launch` ni
  // aucune étape n'est appelée, et le projet reste sans `status.json`.
  it('n’inscrit le projet et ne lance rien, par défaut', async () => {
    poserProject()
    const { plan } = await createProject(`${PROJECT}.mp4`, { db, steps: stepsFake() })
    expect(plan).toEqual([])
    expect(calls).toEqual([])
    expect(getProject(db, PROJECT)).toBeDefined()
    expect(fs.existsSync(path.join(root, 'projects', PROJECT, 'status.json'))).toBe(false)
  })

  it('lance quand `launchNow` vaut `true`, explicitement', async () => {
    poserProject()
    const { plan } = await createProject(`${PROJECT}.mp4`, {
      db,
      steps: stepsFake(),
      launchNow: true,
    })
    expect(plan).not.toEqual([])
    await wait(PROJECT)
    expect(calls.length).toBeGreaterThan(0)
  })

  /**
   * **Un projet créé avant le repli des accents garde son identifiant**, que sa
   * source ne donne plus. Sans la recherche par `sourcePath`, reposter le même
   * fichier dérivait `mechante`, ne trouvait rien sous ce nom et insérait une
   * seconde ligne — deux projets pour une vidéo, `sourcePath` n'étant pas
   * unique. (relevé par Copilot et Codex)
   */
  it('reconnaît par son chemin un projet à l’identifiant accentué', async () => {
    const source = '2026-01-11-méchante.mp4'
    const sourcePath = path.join(root, 'replays', source)
    fs.writeFileSync(sourcePath, '')
    upsertProject(db, {
      id: '2026-01-11-méchante',
      sourcePath,
      stagedPath: null,
      durationSec: null,
      sizeBytes: null,
      mtimeMs: null,
      createdAt: 42,
    })

    const { projectId } = await createProject(source, { db, steps: stepsFake() })

    expect(projectId).toBe('2026-01-11-méchante')
    expect(listProjects(db).filter((p) => p.sourcePath === sourcePath)).toHaveLength(1)
    // Et la ligne d'origine n'a pas été refondée sous un autre nom.
    expect(getProject(db, '2026-01-11-méchante')?.createdAt).toBe(42)
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

describe('pathTranscript', () => {
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
  it('sur un projet transcrit et corrigé, viser les candidats ne relance que le repérage', async () => {
    poserProject()
    poserTranscript()
    poserCorrection()

    const { plan } = await launch(PROJECT, ['candidates'], { db, steps: stepsFake() })
    expect(plan).toEqual(['candidates'])

    await waitFin()
    // Ni transcription, ni audio, ni correction, ni ingestion : c'est tout
    // l'objet du graphe.
    expect(calls).toEqual(['candidates'])
  })

  // La moitié manquante du cas ci-dessus, et c'est elle que cette PR ajoute :
  // un transcript présent sans `correction.json` ne suffit plus à limiter le
  // plan au seul repérage.
  it('sur un projet transcrit mais pas encore corrigé, refait la correction avant le repérage', async () => {
    poserProject()
    poserTranscript()

    const { plan } = await launch(PROJECT, ['candidates'], { db, steps: stepsFake() })
    expect(plan).toEqual(['correction', 'candidates'])

    await waitFin()
    expect(calls).toEqual(['correction', 'candidates'])
  })

  it('sur un projet neuf, remonte les dépendances jusqu’à la source', async () => {
    poserProject()

    const { plan } = await launch(PROJECT, ['candidates'], { db, steps: stepsFake() })
    expect(plan).toEqual(['audio', 'transcript', 'correction', 'candidates'])
    await waitFin()
    expect(calls).toEqual(['audio', 'transcript', 'correction', 'candidates'])
  })

  /**
   * `GET /api/projects/:id` awaits its own probe (`readingPresence`) before
   * reading `progression()`, precisely so it never misses a launch that
   * started during that same wait (see this file). That guard assumes
   * `progression()` is never `null` as soon as a project is in `inCurrent` —
   * even before `launch()` has finished computing its own plan.
   */
  it('progression() n’est jamais nul entre l’inscription et le plan calculé', async () => {
    poserProject()
    const promise = launch(PROJECT, ['proxy'], { db, steps: stepsFake() })
    // Nothing async has resolved yet: only the synchronous prefix of
    // `launch()` (before its first `await`) has run.
    expect(progression(PROJECT)).not.toBeNull()
    await promise
    await waitFin()
  })

  it('force entraîne l’aval avec lui', async () => {
    poserProject()
    poserTranscript()
    poserCorrection()
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'audio.wav'), '')
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'candidates.json'), '[]')

    const { plan } = await launch(PROJECT, ['candidates'], {
      db,
      force: ['transcript'],
      steps: stepsFake(),
    })
    // Refaire le transcript sans reprendre la correction ni le repérage
    // laisserait des candidats calculés sur un texte qui n'existe plus.
    expect(plan).toEqual(['transcript', 'correction', 'candidates'])
    await waitFin()
  })

  it('forcer la correction seule entraîne aussi le repérage', async () => {
    poserProject()
    poserTranscript()
    poserCorrection()
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'candidates.json'), '[]')

    const { plan } = await launch(PROJECT, ['candidates'], {
      db,
      force: ['correction'],
      steps: stepsFake(),
    })
    expect(plan).toEqual(['correction', 'candidates'])
    await waitFin()
  })

  it('`force: true` vise la cible', async () => {
    poserProject()
    poserTranscript()
    poserCorrection()
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'candidates.json'), '[]')

    const { plan } = await launch(PROJECT, ['candidates'], {
      db,
      force: true,
      steps: stepsFake(),
    })
    expect(plan).toEqual(['candidates'])
    await waitFin()
  })

  /**
   * **Une copie périmée se réingère, elle ne coince pas le projet.**
   *
   * Ce test-là porte sur le réglage **coché**, c'est-à-dire sur le défaut : il
   * n'a besoin de personne pour toucher aux paramètres. Un replay réimporté sous
   * le même nom avec une autre taille, sur un projet déjà analysé une fois,
   * suffit à l'atteindre — le cas que `decisionCopy` existe pour attraper.
   *
   * Il garde deux façons de se tromper, à un correctif d'écart. Avec un
   * `existsSync` des deux côtés, la planification et l'étape s'accordaient à
   * accepter le fichier périmé : le proxy encodait l'ancienne vidéo, en silence.
   * Avec le contrôle de taille du seul côté de l'étape, elles ne s'accordaient
   * plus : la planification ne réingérait pas, l'étape refusait l'entrée, et
   * aucune relance ne pouvait lever l'erreur — rien n'efface la copie, rien ne
   * rafraîchit la durée. Le second est pire que le premier, et il faut les deux
   * réponses pour n'avoir ni l'un ni l'autre.
   */
  it('réingère quand la copie ne décrit plus la source, plutôt que de coincer', async () => {
    poserProject({ copyBytes: 3 })

    await launch(PROJECT, ['proxy'], { db, steps: stepsFake() })
    await waitFin()
    // Le témoin d'ingestion lève : ce qui compte est qu'on l'ait appelé, là où
    // le défaut faisait échouer l'étape sur « n'a pas de copie de travail ».
    expect(lireStatus(PROJECT)?.error).toMatch(/ingestion ne devait pas être appelée/)
    expect(lireStatus(PROJECT)?.error).not.toMatch(/n’a pas de copie de travail/)
  })

  /**
   * Le réglage `ingestion.copySourceLocally` décoché.
   *
   * **Le fait qui compte est qu'aucune ingestion ne parte.** `stepsFake` fait
   * lever son `ingest` — « l'ingestion ne devait pas être appelée » —, donc un
   * plan qui la déclencherait ferait tomber ces tests sur ce message-là. Sans
   * cette bascule, viser le proxy sur un projet sans copie planifiait une
   * ingestion dont l'unique travail aurait été la copie qu'on refuse d'écrire :
   * on aurait payé le sondage du Drive pour rien.
   */
  describe('sans copie locale', () => {
    beforeEach(() => {
      applySettings(db, { ingestion: { copySourceLocally: false } })
    })

    it('donne l’original au proxy et à l’audio, sans ingérer', async () => {
      poserProject({ copy: false })

      const { plan } = await launch(PROJECT, ['proxy', 'audio'], { db, steps: stepsFake() })
      expect(plan).toEqual(['proxy', 'audio'])
      await wait(PROJECT)

      const original = path.join(root, 'replays', `${PROJECT}.mp4`)
      expect(inputsSteps).toEqual([original, original])
      // No edge between `proxy` and `audio`: both are ready at once, only one
      // local step is admitted, and `priorityFor` (audio: 10, proxy: 80) picks
      // audio — the ordering that keeps candidates ahead of the montage.
      expect(calls).toEqual(['audio', 'proxy'])
    })

    /**
     * **Le réglage gouverne ce qu'on fabrique, pas ce qu'on utilise.** Une copie
     * déjà là est strictement plus rapide à lire, et l'ignorer ferait repayer le
     * montage 9p pour rien.
     */
    it('préfère quand même une copie déjà présente', async () => {
      poserProject()

      await launch(PROJECT, ['proxy'], { db, steps: stepsFake() })
      await wait(PROJECT)
      expect(inputsSteps).toEqual([path.join(root, 'stage', `${PROJECT}.mp4`)])
    })

    /**
     * **Une copie qui ne décrit plus la source ne sert pas d'entrée.**
     *
     * C'est le cas qui amplifie le plus loin : la durée étant déjà connue,
     * `ingestionNecessary` rend `false` et `ingest` n'est **jamais rappelé** —
     * donc rien ne vient corriger l'écart, et le proxy encoderait l'ancienne
     * vidéo pendant que la base annonce la taille et la durée de la nouvelle. Il
     * n'y a même pas d'avertissement pour le dire : `input.local` serait vrai.
     */
    it('écarte une copie qui ne décrit plus la source', async () => {
      poserProject({ copyBytes: 3 })

      await launch(PROJECT, ['proxy'], { db, steps: stepsFake() })
      await wait(PROJECT)
      expect(inputsSteps).toEqual([path.join(root, 'replays', `${PROJECT}.mp4`)])
    })

    /**
     * **La durée reste indispensable, elle.** `runCandidates` refuse de
     * travailler sans, et l'ingestion est le seul endroit qui la relève : la
     * bascule ne doit pas la faire sauter avec la copie, sinon le réglage
     * échouerait une demi-heure plus tard dans une étape qui n'a rien à voir.
     */
    it('ingère quand même quand la durée manque', async () => {
      poserProject({ copy: false, durationSec: null })

      await launch(PROJECT, ['proxy'], { db, steps: stepsFake() })
      await waitFin()
      // Le témoin d'ingestion lève ; ce qui se vérifie est qu'il a été appelé.
      expect(calls[0]).toBe('proxy')
      expect(lireStatus(PROJECT)?.error).toMatch(/ingestion ne devait pas être appelée/)
    })
  })

  it('refuse une seconde exécution sur le même projet', async () => {
    poserProject()
    poserTranscript()
    poserCorrection()

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
    // Le journal est déjà là (`poserCorrection`) : la correction ne repasse
    // pas, et l'exécution bloque directement sur le repérage — l'assertion
    // qui suit peut donc viser une étape connue plutôt que de deviner laquelle
    // des deux, correction ou candidats, tourne encore.
    await waitStep('candidates')

    await expect(launch(PROJECT, ['candidates'], { db })).rejects.toBeInstanceOf(
      ExecutionInCurrentError,
    )
    expect(progression(PROJECT)).toEqual({ step: 'candidates', progress: 0, waiting: null })

    unblock()
    await waitFin()
    expect(progression(PROJECT)).toBeNull()
  })

  it('refuse un projet inconnu', async () => {
    await expect(launch('jamais-vu', ['candidates'], { db })).rejects.toBeInstanceOf(
      UnknownProjectError,
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

/**
 * L'étape `correction`, dans le lanceur : ce que `case 'correction'`
 * d'`executeStep` décide de faire d'une panne du modèle, et ce qu'il transmet
 * à `applyTranscriptCorrections` (`src/server/steps/transcript-correction.ts`).
 *
 * **Ne pas passer `isRunning` s'y vérifie ailleurs** — `applyTranscriptCorrections`
 * ne prend même pas cette option, donc rien ici ne pourrait la lui passer par
 * erreur. La preuve que l'étape ne se refuse pas elle-même se fait contre la
 * vraie fonction, dans `transcript-correction-apply.test.ts`.
 */
describe("l'étape correction", () => {
  it('une panne du modèle n’arrête pas le plan : candidates tourne quand même', async () => {
    poserProject()
    poserTranscript()

    const { plan } = await launch(PROJECT, ['candidates'], {
      db,
      steps: {
        ...stepsFake(),
        applyTranscriptCorrections: async () => {
          calls.push('correction')
          throw new CorrectionProposalError('le modèle ne répond pas')
        },
      },
    })
    expect(plan).toEqual(['correction', 'candidates'])
    await waitFin()

    // Le repérage a bien tourné derrière la panne — c'est tout l'objet du
    // choix : une panne réseau ne doit pas bloquer un lancement du soir
    // jusqu'au matin.
    expect(calls).toEqual(['correction', 'candidates'])

    const status = lireStatus(PROJECT)
    // Ni `stopped`, ni une erreur qui rejetterait `wait()` : le plan est allé
    // à son terme. Mais la panne n'a pas disparu — voir `status?.warning`, un
    // champ distinct d'`error` depuis les issues #137/#140.
    expect(status?.stopped).toBe(false)
    expect(status?.finishedAt).toBeTypeOf('number')
    expect(status?.error).toBeNull()
    expect(status?.warning).toContain('correction automatique du transcript a échoué')
    expect(status?.warning).toContain('le modèle ne répond pas')
    // Le rattrapage explicite est nommé dans le message lui-même — c'est ce
    // que l'écran affiche tel quel (`project-screen.tsx`).
    expect(status?.warning).toContain('relancer la correction')
  })

  it('un correction.json n’est pas écrit quand la panne est avalée', async () => {
    poserProject()
    poserTranscript()

    await launch(PROJECT, ['candidates'], {
      db,
      steps: {
        ...stepsFake(),
        applyTranscriptCorrections: async () => {
          throw new CorrectionProposalError('injoignable')
        },
      },
    })
    await waitFin()

    // La présence est le seul signal du graphe : sans artefact, un futur
    // lancement qui vise `candidates` redécouvre `correction` comme manquante
    // et la retente — c'est `toRedo`, pas un rattrapage écrit à la main ici.
    const presence = await readingPresence(getProject(db, PROJECT) as Project)
    expect(presence.correction).toBe(false)
  })

  it('une panne qui n’est pas `CorrectionProposalError` fait échouer tout le plan (#136)', async () => {
    // **Ce que ce groupe distingue.** Une `CorrectionProposalError` ne peut
    // venir que d'avant toute écriture — voir son type — donc elle seule se
    // tolère. Une erreur nue, ici, représente une panne survenue dans la
    // boucle d'écriture d'`applyTranscriptCorrections` : elle peut laisser le
    // transcript à moitié corrigé, et la confondre avec la précédente
    // avalait aussi les pannes de stockage.
    poserProject()
    poserTranscript()

    await launch(PROJECT, ['candidates'], {
      db,
      steps: {
        ...stepsFake(),
        applyTranscriptCorrections: async () => {
          calls.push('correction')
          throw new Error('ENOSPC: no space left on device')
        },
      },
    })
    await waitFin()

    // `candidates` ne tourne pas derrière : le plan s'est arrêté sur la
    // panne, comme n'importe quelle autre étape qui lève.
    expect(calls).toEqual(['correction'])
    const status = lireStatus(PROJECT)
    expect(status?.error).toContain('ENOSPC')
    expect(status?.warning).toBeNull()
  })

  /**
   * `error: null` is the pump's own success sentinel, and JavaScript allows
   * `throw null`. Without normalizing it, this failure would read as a
   * success: `candidates` would land in `done`, `error` would stay `null`.
   */
  it('lever littéralement `null` reste un échec, jamais un succès silencieux', async () => {
    poserProject()
    poserTranscript()
    poserCorrection()

    await launch(PROJECT, ['candidates'], {
      db,
      steps: {
        ...stepsFake(),
        runCandidates: async () => {
          calls.push('candidates')
          throw null
        },
      },
    })
    await waitFin()

    const status = lireStatus(PROJECT)
    expect(status?.error).not.toBeNull()
    expect(status?.stopped).toBe(false)
  })

  it('un échec de suppression de l’ancien candidates.json ne fait pas échouer la correction (#141)', async () => {
    // **Le scénario de l'issue.** `candidates.json` existant est écarté puis
    // supprimé une fois la correction réussie ; si la seule suppression finale
    // échoue (`EIO`/`EPERM`), l'écartement — le renommage hors de
    // `candidatesPath` — a déjà eu lieu : le graphe voit `candidates: false`
    // et une relance ordinaire retente l'étape, sans qu'un fichier orphelin
    // sous un nom que plus rien ne lit fasse échouer la correction elle-même.
    poserProject()
    poserTranscript()
    fs.writeFileSync(path.join(root, 'projects', PROJECT, 'candidates.json'), '[]')

    // Recouvre la forme d'avant cette PR (`rm(candidatesPath(...))` direct)
    // et celle d'après (`rm(pathTemporary(candidatesPath(...)))`, une fois
    // l'écartement fait) : les deux commencent par `candidates`.
    const originalRm = fsp.rm
    const spy = vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      if (path.basename(String(target)).startsWith('candidates')) throw new Error('EIO: i/o error')
      return originalRm(target, options)
    })
    try {
      await launch(PROJECT, ['correction'], {
        db,
        steps: {
          ...stepsFake(),
          applyTranscriptCorrections: async () => {
            calls.push('correction')
            return { entries: [], applied: 1, failed: 0, rejected: {} }
          },
        },
      })
      await waitFin()
    } finally {
      spy.mockRestore()
    }

    const status = lireStatus(PROJECT)
    expect(status?.error).toBeNull()
    const presence = await readingPresence(getProject(db, PROJECT) as Project)
    expect(presence.candidates).toBe(false)
  })

  it('un arrêt demandé pendant la correction n’est pas avalé comme une panne', async () => {
    poserProject()
    poserTranscript()

    let signalSeen: AbortSignal | undefined
    const { plan } = await launch(PROJECT, ['candidates'], {
      db,
      steps: {
        ...stepsFake(),
        applyTranscriptCorrections: async (_project, _db, options) => {
          calls.push('correction')
          signalSeen = options?.signal
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('coupé')))
          })
        },
      },
    })
    expect(plan).toEqual(['correction', 'candidates'])
    await waitStep('correction')
    stopRun(PROJECT)
    await waitFin()

    expect(signalSeen?.aborted).toBe(true)
    // L'arrêt se lit sur `stopped`, jamais sur `error` — un arrêt demandé
    // n'est pas une panne, avalée ou non.
    const status = lireStatus(PROJECT)
    expect(status?.stopped).toBe(true)
    expect(status?.error).toBeNull()
    // Le repérage n'a pas dû démarrer derrière un arrêt.
    expect(calls).toEqual(['correction'])
  })

  it('freshTranscript est vrai seulement quand transcript vient de tourner dans le même plan', async () => {
    poserProject()
    const freshSeen: (boolean | undefined)[] = []
    const fakeCorrection = async (_project: Project, _db: Database.Database, options?: { freshTranscript?: boolean }) => {
      freshSeen.push(options?.freshTranscript)
      return { entries: [], applied: 0, failed: 0, rejected: {} }
    }

    // Premier lancement, sur un projet neuf : `transcript` fait partie du plan.
    await launch(PROJECT, ['candidates'], {
      db,
      steps: { ...stepsFake(), applyTranscriptCorrections: fakeCorrection },
    })
    await waitFin()
    expect(freshSeen).toEqual([true])

    // Second lancement, avec un journal déjà là mais forcé : `transcript` ne
    // fait plus partie du plan, la correction s'accumule.
    poserCorrection()
    await launch(PROJECT, ['candidates'], {
      db,
      force: ['correction'],
      steps: { ...stepsFake(), applyTranscriptCorrections: fakeCorrection },
    })
    await waitFin()
    expect(freshSeen).toEqual([true, false])
  })
})

describe('status.json', () => {
  it('rend la main sur `running: null` quand tout est fini', async () => {
    poserProject()
    poserTranscript()
    poserCorrection()

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
   * six champs du bilan sous leurs noms français : `lireStatus` doit les
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
   * à quelqu'un qui vient de cliquer « Arrêter », et `phaseProject` classerait le
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

    // L'audio, le transcript et la correction sont passés avant l'arrêt :
    // ils restent.
    const presence = await readingPresence(getProject(db, PROJECT) as Project)
    expect(presence.audio).toBe(true)
    expect(presence.transcript).toBe(true)
    expect(presence.correction).toBe(true)
    expect(presence.candidates).toBe(false)

    calls = []
    const { plan } = await launch(PROJECT, ['candidates'], { db, steps: stepsFake() })
    // La reprise ne refait ni l'audio, ni le transcript, ni la correction.
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
