import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { StepName } from '@/core/graph'
import type { BilanNotation } from '@/server/steps/candidates'
import { getProject, openDb, upsertProject, type Project } from '@/server/db'
import {
  stopRun,
  attendre,
  bilanDeRepérage,
  cheminTranscript,
  CollisionDeProjetError,
  créerProjet,
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

const PROJET = '2025-06-15-cqlp'

let racine: string
let db: Database.Database
let appels: StepName[]
/** La vidéo que le lanceur donne à l'analyse pour en relever les dimensions. */
let sourcesAnalyse: string[]

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
    runAnalysis: async (o) => {
      const fichier = path.join(racine, 'projects', o.projectId, 'analysis.json')
      await noter('analysis', fichier)
      sourcesAnalyse.push(o.source)
      return { path: fichier, skipped: false }
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

/** Le proxy déjà là : l'analyse en dépend, et le poser évite de le refaire. */
function poserProxy(): void {
  const dossier = path.join(racine, 'projects', PROJET)
  fs.mkdirSync(dossier, { recursive: true })
  fs.writeFileSync(path.join(dossier, 'proxy.mp4'), '')
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
  sourcesAnalyse = []
})

afterEach(async () => {
  // **Rien ne doit tourner d'un test à l'autre.** `enCours` est une table de
  // module : une exécution qu'une assertion ratée aurait laissée derrière elle
  // ferait échouer le test suivant sur `ExécutionEnCoursError`, à un endroit qui
  // ne dit rien du vrai défaut. Et la base se referme après, pas avant : une
  // exécution encore vivante s'en servirait.
  stopRun(PROJET)
  await attendreLaFin()
  db.close()
  fs.rmSync(racine, { recursive: true, force: true })
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
  const bilan: BilanNotation = {
    fenêtres: 83,
    notées: 51,
    jamaisNotées: Array.from({ length: 32 }, (_, i) => `window_${i}`),
    refusées: [],
    appels: 14,
    lotsRefusés: 4,
    lotsRépondus: 7,
    couverture: 0.6412,
  }

  it('rend null quand aucune notation n’est décrite', () => {
    expect(bilanDeRepérage(null, 'fait')).toBeNull()
  })

  /**
   * Le bilan vit dans ce processus et survit à l'exécution qui l'a produit. Une
   * relance qui ne vise que le proxy y recopierait sinon le décompte d'un
   * repérage qu'elle n'a pas fait.
   */
  it('rend null quand le repérage n’a pas tourné dans cette exécution', () => {
    expect(bilanDeRepérage(bilan, 'absent')).toBeNull()
  })

  it('publie les décomptes, jamais la liste des identifiants', () => {
    expect(bilanDeRepérage(bilan, 'fait')).toEqual({
      fenêtres: 83,
      notées: 51,
      lotsRefusés: 4,
      lotsRépondus: 7,
      couverture: 0.6412,
      partiel: false,
    })
  })

  it('marque partiel un repérage qui a échoué', () => {
    expect(bilanDeRepérage(bilan, 'échoué')?.partiel).toBe(true)
  })

  /**
   * Une notation en cours n'a pas fini : ce qu'elle annonce est un décompte
   * provisoire, et le dire est précisément le rôle de ce drapeau.
   */
  it('marque partiel un repérage en cours', () => {
    expect(bilanDeRepérage(bilan, 'en cours')?.partiel).toBe(true)
  })

  /**
   * Le cas que les deux relecteurs ont nommé : le repérage est fini et bon,
   * l'exécution ne l'est pas encore.
   */
  it('ne marque pas partiel un repérage fini sous une exécution qui continue', () => {
    expect(bilanDeRepérage(bilan, 'fait')?.partiel).toBe(false)
  })
})

describe('planPourCibles', () => {
  const rien: Record<StepName, boolean> = {
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

/**
 * L'analyse d'image, dans le lanceur. Ce que ces cas figent n'est pas la
 * détection — elle est injectée — mais **ce que le lanceur accepte de lui
 * donner**, et à quel prix.
 */
describe('analysis', () => {
  it('ne construit que le proxy pour atteindre l’analyse', async () => {
    poserProjet()
    const { plan } = await lancer(PROJET, ['analysis'], { db, étapes: étapesFactices() })
    expect(plan).toEqual(['proxy', 'analysis'])
    await attendre(PROJET)
    expect(appels).toEqual(['proxy', 'analysis'])
  })

  /**
   * **Le repli sur l'original quand la copie de travail a disparu.** L'analyse
   * ne lit de la source que ses dimensions, recopiées dans `analysis.json` pour
   * dire à quoi ses fractions se rapportent — un en-tête, pas de la vidéo.
   * Exiger la copie ferait payer cinq minutes de recopie depuis un montage 9p
   * lent pour relancer une analyse dont le proxy est déjà sur le disque.
   */
  it('se rabat sur l’original quand la copie de travail n’est plus là', async () => {
    poserProjet({ copie: false })
    poserProxy()

    await lancer(PROJET, ['analysis'], { db, étapes: étapesFactices() })
    await attendre(PROJET)
    expect(sourcesAnalyse).toEqual([path.join(racine, 'replays', `${PROJET}.mp4`)])
  })

  it('préfère la copie de travail quand elle est là', async () => {
    poserProjet()
    poserProxy()

    await lancer(PROJET, ['analysis'], { db, étapes: étapesFactices() })
    await attendre(PROJET)
    expect(sourcesAnalyse).toEqual([path.join(racine, 'stage', `${PROJET}.mp4`)])
  })

  it('ne relance pas la transcription pour une analyse', async () => {
    poserProjet()
    await lancer(PROJET, ['analysis'], { db, étapes: étapesFactices() })
    await attendre(PROJET)
    expect(appels).not.toContain('transcript')
    expect(appels).not.toContain('audio')
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
    poserProjet()
    const { plan } = await créerProjet(`${PROJET}.mp4`, { db, étapes: étapesFactices() })
    expect(plan).toContain('analysis')
    expect(plan.indexOf('proxy')).toBeLessThan(plan.indexOf('analysis'))

    await attendre(PROJET)
    expect(appels).toContain('analysis')
    expect(appels.indexOf('proxy')).toBeLessThan(appels.indexOf('analysis'))
  })

  /**
   * `projectIdFromSource` retire l'extension : `show.mp4` et `show.mov` donnent
   * tous deux `show`. Sans refus, la seconde ingestion gardait la copie de
   * travail, la durée et les artefacts de la première, et l'outil continuait de
   * servir l'autre vidéo sans un mot. (relevé par Copilot)
   */
  it('refuse deux sources qui se partageraient un identifiant', async () => {
    poserProjet()
    fs.writeFileSync(path.join(racine, 'replays', `${PROJET}.mov`), '')

    await expect(
      créerProjet(`${PROJET}.mov`, { db, étapes: étapesFactices() }),
    ).rejects.toBeInstanceOf(CollisionDeProjetError)

    // Et le projet d'origine n'a pas bougé.
    expect(getProject(db, PROJET)?.sourcePath).toBe(path.join(racine, 'replays', `${PROJET}.mp4`))
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
  /**
   * Renoncer n'est pas annuler : le `fsp.stat` abandonné occupe un fil du vivier
   * de libuv jusqu'à ce que le noyau rende la main, ce qu'un montage 9p au
   * transport mort ne fait jamais. Une seconde sonde en occuperait un de plus
   * sans rien apprendre, et quatre suffiraient à figer tout ce qui touche au
   * disque. (relevé par Copilot)
   */
  it('ne lance qu’une sonde à la fois sur un montage muet', async () => {
    poserProjet()
    // Un chemin qui ne répondra pas : on remplace le `stat` par un appel qui ne
    // se règle jamais, comme le fait un transport 9p mort.
    const vraiStat = fsp.stat
    let sondes = 0
    // @ts-expect-error — remplacement de sonde, restauré juste après.
    fsp.stat = () => {
      sondes += 1
      return new Promise(() => {})
    }

    const muet: Project = {
      id: PROJET,
      sourcePath: path.join(racine, 'replays', 'absent.mp4'),
      stagedPath: null,
      durationSec: null,
      sizeBytes: null,
      mtimeMs: null,
      createdAt: 0,
    }

    try {
      // Trois interrogations rapprochées, comme l'écran de tri en fait une
      // toutes les deux secondes. Une seule sonde doit partir.
      const premières = Promise.all([cheminTranscript(muet), cheminTranscript(muet)])
      await new Promise((r) => setTimeout(r, 10))
      expect(sondes).toBe(1)
      oublierSidecar(muet)
      // Même après oubli de l'emplacement, la sonde précédente est toujours en
      // vol : on ne doit pas en lancer une seconde.
      expect(await cheminTranscript(muet)).toBeNull()
      expect(sondes).toBe(1)
      void premières
    } finally {
      fsp.stat = vraiStat
    }
  }, 30_000)

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
   * `blocking` est celle qui pend ; les autres écrivent leur artefact
   * normalement. C'est ce qui permet de tuer l'exécution au milieu de son plan
   * et de vérifier que ce qui la précédait a bien survécu.
   */
  function hangingSteps(blocking: StepName): Partial<Étapes> {
    const fakes = étapesFactices()
    const hang = (signal: AbortSignal | undefined): Promise<never> =>
      new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new StopRequestedError(blocking)), {
          once: true,
        })
      })

    return {
      ...fakes,
      buildProxy: async (o) => {
        appels.push('proxy')
        if (blocking === 'proxy') return hang(o.signal)
        return fakes.buildProxy!(o)
      },
      extractAudio: async (o) => {
        if (blocking === 'audio') {
          appels.push('audio')
          return hang(o.signal)
        }
        return fakes.extractAudio!(o)
      },
      runCandidates: async (id, o) => {
        if (blocking === 'candidates') {
          appels.push('candidates')
          return hang(o?.signal)
        }
        return fakes.runCandidates!(id, o)
      },
    }
  }

  it('rend faux quand rien ne tourne — deux clics ne sont pas une erreur', () => {
    expect(stopRun(PROJET)).toBe(false)
    expect(stopRun('projet-qui-n-existe-pas')).toBe(false)
  })

  it('coupe le travail en cours et rend vrai, deux fois de suite', async () => {
    poserProjet()
    poserTranscript()
    await lancer(PROJET, ['proxy'], { db, étapes: hangingSteps('proxy') })
    // L'étape a bien démarré : sans cela, l'arrêt éprouverait le refus d'entrée
    // et non la coupure d'un travail en cours.
    await waitForStep('proxy')

    expect(stopRun(PROJET)).toBe(true)
    // Idempotent : un second appel pendant que l'exécution finit de descendre
    // dit toujours vrai, et n'a pas d'effet supplémentaire.
    expect(stopRun(PROJET)).toBe(true)

    await attendreLaFin()
    expect(progression(PROJET)).toBeNull()
  })

  /**
   * **Un arrêt demandé n'est pas une panne.** Écrire le message du processus tué
   * — « ffmpeg a échoué (tué par SIGTERM) » — ferait afficher un bandeau d'échec
   * à quelqu'un qui vient de cliquer « Arrêter », et `phaseProjet` classerait le
   * projet en `echec` au lieu d'`interrompu`.
   */
  it('écrit un statut d’arrêt, sans erreur et sans running', async () => {
    poserProjet()
    poserTranscript()
    await lancer(PROJET, ['proxy'], { db, étapes: hangingSteps('proxy') })
    await waitForStep('proxy')
    stopRun(PROJET)
    await attendreLaFin()

    const statut = lireStatut(PROJET)
    expect(statut?.stopped).toBe(true)
    expect(statut?.error).toBeNull()
    expect(statut?.running).toBeNull()
    expect(statut?.finishedAt).not.toBeNull()
  })

  /**
   * L'étape suivante ne doit pas partir. Sans le contrôle à l'entrée de chaque
   * étape, stopRun pendant la transcription laisserait démarrer les six minutes
   * de proxy qui la suivent — le processus tué serait bien mort, et le travail
   * continuerait quand même.
   */
  it('n’enchaîne pas sur l’étape suivante', async () => {
    poserProjet()
    await lancer(PROJET, ['candidates'], { db, étapes: hangingSteps('audio') })
    await waitForStep('audio')
    stopRun(PROJET)
    await attendreLaFin()

    expect(appels).toEqual(['audio'])
    expect(fs.existsSync(path.join(racine, 'projects', PROJET, `${PROJET}.avolo`))).toBe(false)
  })

  /**
   * **Ce qui est fait reste fait, et la reprise repart à la première étape
   * manquante.** C'est le critère du §4.1 du retour d'usage, et il ne demande
   * aucun code de reprise : le graphe le fait déjà, à condition qu'une étape
   * tuée n'ait rien laissé qui la ferait passer pour faite.
   */
  it('laisse les artefacts déjà terminés, et la reprise finit le travail', async () => {
    poserProjet()
    await lancer(PROJET, ['candidates'], { db, étapes: hangingSteps('candidates') })
    await waitForStep('candidates')
    stopRun(PROJET)
    await attendreLaFin()

    // L'audio et le transcript sont passés avant l'arrêt : ils restent.
    const presence = await relevéPrésence(getProject(db, PROJET) as Project)
    expect(presence.audio).toBe(true)
    expect(presence.transcript).toBe(true)
    expect(presence.candidates).toBe(false)

    appels = []
    const { plan } = await lancer(PROJET, ['candidates'], { db, étapes: étapesFactices() })
    // La reprise ne refait ni l'audio ni le transcript.
    expect(plan).toEqual(['candidates'])
    await attendreLaFin()
    expect(appels).toEqual(['candidates'])
    expect(lireStatut(PROJET)?.stopped).toBe(false)
    expect(lireStatut(PROJET)?.error).toBeNull()
  })

  /** Une exécution arrêtée s'est terminée comme on le voulait : rien ne rejette. */
  it('ne fait pas reject l’attente de l’exécution', async () => {
    poserProjet()
    poserTranscript()
    await lancer(PROJET, ['proxy'], { db, étapes: hangingSteps('proxy') })
    await waitForStep('proxy')
    stopRun(PROJET)
    await expect(attendre(PROJET)).resolves.toBeUndefined()
  })

  /** Un échec ordinaire garde son message : l'arrêt ne l'avale pas. */
  it('n’écrase pas un vrai échec quand personne n’a rien demandé', async () => {
    poserProjet()
    poserTranscript()
    await lancer(PROJET, ['candidates'], { db, étapes: étapesFactices('candidates') })
    await attendreLaFin()
    expect(lireStatut(PROJET)?.stopped).toBe(false)
    expect(lireStatut(PROJET)?.error).toContain('ffmpeg a échoué')
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

/**
 * Attend que le lanceur en soit à une step donnée.
 *
 * `lancer` rend la main **avant** que l'exécution ne commence — c'est ce qui
 * permet à `POST /run` de répondre 202 en disant ce qu'il va faire. Arrêter dans
 * la foulée éprouverait donc le refus d'entrée d'une step, pas la coupure d'un
 * travail en cours, et le test passerait sans rien démontrer.
 */
async function waitForStep(step: StepName): Promise<void> {
  for (let i = 0; i < 200 && progression(PROJET)?.step !== step; i += 1) {
    await new Promise((résoudre) => setTimeout(résoudre, 5))
  }
  expect(progression(PROJET)?.step).toBe(step)
}
