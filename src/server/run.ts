import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type Database from 'better-sqlite3'

import { planSteps, type StepName } from '@/core/graph'
import type { SelectionReport } from '@/lib/api'
import { progressWorker } from '@/core/pipeline'
import { copiesSourceLocally, getDb, getProject, upsertProject, type Project } from '@/server/db'
import { messageSafe } from '@/server/errors'
import {
  analysisPath,
  audioPath,
  candidatesPath,
  projectDir,
  projectIdFromSource,
  proxyPath,
  rendersDir,
  resolveSource,
  sidecarDir,
  stagedPath,
} from '@/server/paths'
import { runAnalysis } from '@/server/steps/analysis'
import { extractAudio } from '@/server/steps/audio'
import {
  lastSummary,
  forgetSummary,
  runCandidates,
  type SummaryNotation,
} from '@/server/steps/candidates'
import {
  waitOrAbandon,
  cleanStage,
  DELAY_STAT_MS,
  editingResponds,
  ingest,
  workingInput,
} from '@/server/steps/ingest'
import { buildProxy } from '@/server/steps/proxy'
import { applyTranscriptCorrections } from '@/server/steps/transcript-correction'
import { transcribe } from '@/server/steps/transcript'

/**
 * Le lanceur : ce qui fait tourner l'analyse **en dehors d'une requête HTTP**.
 *
 * Une analyse complète dure 30 à 45 minutes. Aucun gestionnaire de route ne peut
 * la porter : le client aurait renoncé depuis longtemps, et un rechargement de
 * page en lancerait une seconde. D'où les trois règles de ce fichier.
 *
 * 1. **Un projet a au plus une exécution en cours.** La réservation est prise
 *    *avant* le premier `await`, donc deux requêtes simultanées ne peuvent pas
 *    la prendre toutes les deux — c'est le seul endroit où le fil unique de Node
 *    tient lieu de verrou, et il ne le tient que si rien ne s'intercale.
 * 2. **Le graphe décide, ce fichier exécute.** `planSteps` est pur et testé ; le
 *    relevé de présence des artefacts lui est passé tout fait. Rien ici ne
 *    réinvente « faut-il refaire cette étape ».
 * 3. **La vérité se relit sur le disque.** `status.json` est écrit à chaque
 *    changement d'étape, mais il n'est pas cru au démarrage : Next redémarre à
 *    chaque édition en développement, et un fichier laissé par un processus mort
 *    annoncerait une transcription qui ne tourne plus. Ce qui survit à un
 *    redémarrage, ce sont les artefacts — donc `steps`. Seul le suivi
 *    d'avancement en cours est perdu, et il ne se rattrape pas.
 * 4. **Une exécution s'arrête pour de vrai.** La table `inCurrent` tient un
 *    `AbortController` par projet, et son signal descend jusque dans les
 *    processus : `SIGTERM` puis `SIGKILL` sur ffmpeg et sur les deux workers
 *    Python, fermeture des flux pour la copie d'ingestion, `abortSignal` pour
 *    l'appel Gemini. Ce qui rend l'arrêt **sûr** est ailleurs, et c'est la
 *    règle 2 de `produceArtifact` : chaque étape écrit sous un nom temporaire
 *    et ne renomme qu'au succès, donc une étape tuée ne laisse rien que le
 *    relevé de présence prendrait pour un artefact fait.
 */

/** Ce que l'interface lit dans `ProjectStatus.running`. */
export type Progression = { step: StepName; progress: number }

/** Une exécution vivante, dans **ce** processus. */
type Execution = {
  projectId: string
  targets: StepName[]
  plan: StepName[]
  current: Progression
  /** Où en est l'étape `candidates` **dans cette exécution**. Voir `detectionSummary`. */
  detection: StateDetection
  /** Pour ne pas réécrire `status.json` à chaque marque de temps de ffmpeg. */
  lastWrite: number
  finished: Promise<void>
  /**
   * De quoi arrêter le travail en cours, **jusque dans les processus**.
   *
   * `inCurrent` tenait déjà une exécution par projet ; c'est ici que se pose le
   * contrôleur, parce que c'est la seule table qui sache ce qui tourne. Le
   * signal descend ensuite dans chaque étape : ffmpeg et les deux workers
   * Python reçoivent un `SIGTERM` puis un `SIGKILL`, la copie d'ingestion ferme
   * ses flux, et l'appel Gemini part avec un `abortSignal`.
   *
   * **Une pause qui tuerait seulement l'affichage n'est pas une pause** (retour
   * d'usage §11). Un proxy qu'on laisserait tourner tiendrait douze cœurs
   * pendant six minutes après qu'on a demandé l'arrêt, et une transcription
   * garderait le GPU.
   */
  controller: AbortController
}

const inCurrent = new Map<string, Execution>()

/** Levée quand une exécution tourne déjà sur ce projet. La route en fait un 409. */
export class ExecutionInCurrentError extends Error {
  constructor(readonly projectId: string) {
    super(`Une exécution est déjà en cours sur ${projectId}.`)
    this.name = 'ExecutionInCurrentError'
  }
}

/** Levée quand le projet demandé n'est pas en base. La route en fait un 404. */
export class UnknownProjectError extends Error {
  constructor(readonly projectId: string) {
    super(`Projet inconnu : ${projectId}`)
    this.name = 'UnknownProjectError'
  }
}

/**
 * Deux sources différentes pour un même identifiant. La route en fait un 409.
 *
 * `projectIdFromSource` retire l'extension : `show.mp4` et `show.mov` donnent
 * tous deux `show`. Sans ce refus, la seconde ingestion réécrivait `sourcePath`
 * et gardait la copie de travail, la durée et les artefacts de la première — le
 * plan ressortait vide et l'outil continuait de servir l'autre vidéo, sans un
 * mot. On refuse plutôt que de réinitialiser : effacer le travail d'un projet
 * parce qu'un fichier porte un nom voisin serait pire que de le dire.
 * (relevé par Copilot)
 */
export class ProjectErrorCollision extends Error {
  constructor(
    readonly projectId: string,
    readonly expected: string,
    readonly received: string,
  ) {
    super(
      `L'identifiant ${projectId} désigne déjà ${JSON.stringify(path.basename(expected))}. ` +
        `${JSON.stringify(path.basename(received))} lui donnerait le même projet : renommer l'un des deux fichiers.`,
    )
    this.name = 'ProjectErrorCollision'
  }
}

/** L'avancement en cours, ou `null` si rien ne tourne. */
export function progression(projectId: string): Progression | null {
  const execution = inCurrent.get(projectId)
  return execution === undefined ? null : { ...execution.current }
}

/**
 * Arrête l'exécution en cours d'un projet. **Idempotent.**
 *
 * Rend `false` quand rien ne tournait, et ce n'est pas un échec : l'analyse
 * venait de finir, ou un redémarrage de Next a emporté l'exécution avec lui —
 * `inCurrent` est une table de *ce* processus. Le bouton peut donc se cliquer deux
 * fois sans que l'appelant ait à décider lequel des deux clics comptait.
 *
 * **Elle ne bloque pas.** `forwardAbort` laisse dix secondes à un `SIGTERM`
 * avant le `SIGKILL`, et une route qui attendrait la mort effective du processus
 * ferait patienter le navigateur d'autant. Ce qui dit que l'arrêt a eu lieu est
 * `running` qui retombe à `null`, sur le même sondage qui suivait l'avancement.
 *
 * **Ce qui est fait reste fait.** Aucun artefact n'est effacé : les étapes
 * écrivent sous un nom temporaire et ne renomment qu'au succès (voir
 * `produceArtifact`), donc l'étape coupée n'a rien laissé qui la ferait passer
 * pour faite, et les précédentes gardent les leurs. La reprise repart à la
 * première étape manquante — c'est le graphe, rien de plus.
 */
export function stopRun(projectId: string): boolean {
  const execution = inCurrent.get(projectId)
  if (execution === undefined) return false
  // Un second appel pendant que le premier finit de descendre : l'exécution est
  // toujours là, la demande est toujours vraie, et `abort()` deux fois n'a pas
  // d'effet supplémentaire.
  if (!execution.controller.signal.aborted) execution.controller.abort()
  return true
}

/** Attend la fin de l'exécution d'un projet. Pour les scripts et les tests. */
export async function wait(projectId: string): Promise<void> {
  await inCurrent.get(projectId)?.finished
}

// ---------------------------------------------------------------------------
// Le relevé de présence
// ---------------------------------------------------------------------------

/**
 * Le dernier emplacement connu du sidecar, par projet, avec sa date de
 * péremption.
 *
 * **Ce cache n'est pas une optimisation, c'est une protection.** L'écran de tri
 * interroge `GET /api/projects/:id` toutes les deux secondes tant qu'une analyse
 * tourne, et ce relevé finit sur le Drive quand le transcript n'est pas dans le
 * projet. Or `editingResponds` s'appuie sur `fsp.stat`, qui **consomme un fil du
 * vivier de libuv** quand le montage ne répond pas — le vivier en compte quatre
 * par défaut. Sans cache, huit secondes de sondage suffisaient à les prendre
 * tous les quatre et à figer *tout* ce qui touche au disque dans le serveur, y
 * compris l'analyse en cours. Le mode de panne visé par la garde était devenu
 * une façon de la déclencher.
 *
 * La sonde en vol est partagée, donc deux requêtes simultanées n'en lancent
 * jamais deux — et `editingAlive`, juste en dessous, ferme le cas où la sonde
 * ne revient pas du tout.
 */
/**
 * Le couple que le sidecar peut porter : le transcript, et si `correction.json`
 * est à côté de lui.
 */
type SidecarState = { transcript: string | null; correction: boolean }
type EntrySidecar = SidecarState & { expire: number; inFlight?: Promise<SidecarState> }
const sidecars = new Map<string, EntrySidecar>()

/** Assez court pour qu'un transcript qui vient d'être écrit apparaisse presque tout de suite. */
const TTL_SIDECAR_MS = 4_000

/**
 * Les sondes de montage **encore en vol**, par chemin sondé.
 *
 * **Renoncer n'est pas annuler.** `waitOrAbandon` rend la main au bout du
 * délai, mais le `fsp.stat` qu'il attendait continue d'occuper un fil du vivier
 * de libuv — le vivier en compte quatre, et sur un montage 9p au transport mort
 * cet appel ne revient jamais. Une temporisation, si longue soit-elle, ne fait
 * donc que ralentir l'épuisement : quatre expirations et tout ce qui touche au
 * disque s'arrête, analyse en cours comprise. (relevé par Copilot)
 *
 * D'où cette table : tant que la sonde précédente n'est pas revenue, on n'en
 * lance pas une seconde et on répond « muet » sans attendre. Un montage mort
 * coûte **un** fil, une fois, et les interrogations suivantes ne coûtent rien.
 * L'entrée disparaît quand la sonde se règle enfin — le montage remonte, ou le
 * noyau rend la main —, et la sonde suivante repart normalement.
 */
const probes = new Map<string, Promise<boolean>>()

/**
 * Le montage répond-il ? Comme `editingResponds`, mais sans jamais laisser deux
 * sondes en vol sur le même chemin.
 */
async function editingAlive(path: string): Promise<boolean> {
  // Une sonde est déjà partie et n'est pas revenue : elle occupe déjà un fil, et
  // en lancer une seconde en occuperait un de plus sans rien apprendre de neuf.
  if (probes.has(path)) return false

  const probe = fsp.stat(path).then(
    () => true,
    // Une erreur *est* une réponse : un `ENOENT` immédiat prouve que le système
    // de fichiers est vivant. Ce qu'on mesure ici est le silence, pas l'absence.
    () => true,
  )
  probes.set(path, probe)
  void probe.finally(() => probes.delete(path))

  try {
    return await waitOrAbandon(probe, DELAY_STAT_MS, 'muet')
  } catch {
    return false
  }
}

/**
 * Le `transcript.json` du sidecar, **sans rien créer**.
 *
 * `placeSidecar` est l'autorité sur l'emplacement, mais elle *écrit* pour
 * décider — elle crée le dossier et y pose une sonde. Un relevé de présence,
 * lui, n'a rien à créer sur un Drive partagé.
 *
 * Les deux emplacements sont regardés dans l'ordre inverse de `placeSidecar`, et
 * la raison est le coût : le repli est local et répond en microsecondes, le
 * Drive est monté en 9p. L'ordre ne change rien au résultat — un transcript ne
 * peut pas être aux deux endroits sans être le même travail —, il change ce
 * qu'on paie quand il est dans le projet.
 *
 * Rend `null` quand il n'y a pas de transcript, ou quand le Drive ne répond pas
 * et qu'il n'y en a pas de copie locale.
 */
export async function pathTranscript(project: Project): Promise<string | null> {
  return (await sidecarState(project)).transcript
}

async function sidecarState(project: Project): Promise<SidecarState> {
  const key = keySidecar(project)
  const entry = sidecars.get(key)
  if (entry !== undefined) {
    if (entry.inFlight !== undefined) return entry.inFlight
    if (entry.expire > Date.now()) return { transcript: entry.transcript, correction: entry.correction }
  }

  const work = findSidecar(project, key)
  sidecars.set(key, { transcript: null, correction: false, expire: 0, inFlight: work })
  return work
}

/**
 * La clé retient **les deux dossiers dont dépend la réponse**, pas seulement
 * l'identifiant du projet : le sidecar peut être dans `PROJECTS_DIR` ou à côté
 * de l'original, et une entrée qui ne nommerait que le projet resterait valable
 * après un changement de l'un ou de l'autre. Le calcul est de la manipulation de
 * chemins, il ne touche pas au disque.
 */
function keySidecar(project: Project): string {
  return `${projectDir(project.id)}\0${project.sourcePath}`
}

async function findSidecar(project: Project, key: string): Promise<SidecarState> {
  const keep = (state: SidecarState, ttl: number): SidecarState => {
    sidecars.set(key, { ...state, expire: Date.now() + ttl })
    return state
  }

  const nameSidecar = path.basename(sidecarDir(project.sourcePath))
  const fallbackDir = path.join(projectDir(project.id), nameSidecar)
  const fallback = path.join(fallbackDir, 'transcript.json')
  if (fs.existsSync(fallback)) {
    // Local : un `existsSync` de plus ne coûte rien, contrairement à celui du
    // Drive un peu plus bas.
    return keep(
      { transcript: fallback, correction: fs.existsSync(path.join(fallbackDir, 'correction.json')) },
      TTL_SIDECAR_MS,
    )
  }

  // **Sonder avant de toucher au Drive.** Monté avec son transport mort dessous,
  // il ne répond pas, et un `existsSync` synchrone gèle la boucle d'événements —
  // donc le serveur entier, pas seulement cette requête.
  if (!(await editingAlive(project.sourcePath))) {
    return keep({ transcript: null, correction: false }, TTL_SIDECAR_MS)
  }
  const desiredDir = sidecarDir(project.sourcePath)
  const desired = path.join(desiredDir, 'transcript.json')
  const found = fs.existsSync(desired)
  // Le Drive répond déjà à ce point : un second `existsSync` sur le même
  // dossier, pour `correction.json`, ne fait pas une seconde sonde de vivacité
  // — seulement l'appel synchrone déjà payé pour `transcript.json`, une fois de
  // plus.
  return keep(
    { transcript: found ? desired : null, correction: found && fs.existsSync(path.join(desiredDir, 'correction.json')) },
    TTL_SIDECAR_MS,
  )
}

/**
 * Oublie l'emplacement retenu. Appelé après la transcription : l'étape vient
 * précisément de créer le fichier dont on avait constaté l'absence.
 */
export function forgetSidecar(project: Project): void {
  sidecars.delete(keySidecar(project))
}

/**
 * Y a-t-il au moins un rendu ? Un dossier vide n'est pas une étape faite.
 *
 * **Les fichiers temporaires ne comptent pas.** `cheminTemporaire` garde
 * l'extension d'origine — ffmpeg choisit son muxeur dessus —, si bien qu'un
 * encodage en cours ou interrompu laisse un `clip.partiel-1234-1.mp4` dans le
 * dossier. Un `endsWith('.mp4')` nu annonçait donc `renders: true` pendant que
 * ffmpeg tournait encore, et après un processus tué. (relevé par Copilot)
 */
const TEMPORARY = '.partiel-'

function rendersPresent(projectId: string): boolean {
  try {
    return fs
      .readdirSync(rendersDir(projectId))
      .some((name) => name.endsWith('.mp4') && !name.includes(TEMPORARY))
  } catch {
    return false
  }
}

/**
 * Ce qui est déjà là, artefact par artefact.
 *
 * **La présence du fichier, pas une clé de validité** (spec §4) : les versions
 * d'outil, les paramètres et l'empreinte des entrées sont l'itération 4.
 */
export async function readingPresence(project: Project): Promise<Record<StepName, boolean>> {
  // **Une seule sonde du sidecar pour les deux étapes** : `sidecarState` porte
  // déjà le couple transcript/correction depuis un seul passage par le Drive.
  const sidecar = await sidecarState(project)
  return {
    proxy: fs.existsSync(proxyPath(project.id)),
    audio: fs.existsSync(audioPath(project.id)),
    transcript: sidecar.transcript !== null,
    correction: sidecar.correction,
    analysis: fs.existsSync(analysisPath(project.id)),
    candidates: fs.existsSync(candidatesPath(project.id)),
    renders: rendersPresent(project.id),
  }
}

// ---------------------------------------------------------------------------
// `status.json`
// ---------------------------------------------------------------------------

/**
 * Ce que porte `projects/<id>/status.json`.
 *
 * **Ni `steps` ni `running` ne sortent d'ici.** `steps` se relève sur les
 * artefacts et `running` sort de la table en mémoire, seule à savoir ce qui
 * tourne *dans ce processus* : c'est ce qui rend un redémarrage de Next
 * inoffensif, alors que croire ce fichier ferait annoncer une transcription
 * morte avec le dernier redémarrage.
 *
 * `error` fait exception, et c'est la raison d'être du fichier : une exécution
 * de tâche de fond n'a aucune réponse HTTP où loger son échec, donc
 * `GET /api/projects/:id` va le chercher là — mais seulement au repos.
 *
 * Le `pid` est là pour la personne qui l'ouvre : il dit quel processus a écrit
 * ces lignes, donc si le `running` qu'elles portent a encore un sens. `error` est
 * la seule chose que ce fichier soit seul à savoir, une fois l'exécution finie.
 */
export type Status = {
  pid: number
  updatedAt: number
  targets: StepName[]
  plan: StepName[]
  running: Progression | null
  /** Le message d'échec, **déjà épuré** : ce fichier se recopie dans un rapport. */
  error: string | null
  finishedAt: number | null
  /**
   * Vrai quand l'exécution s'est arrêtée parce qu'on le lui a demandé.
   *
   * **Un arrêt demandé n'est pas un échec**, et c'est tout ce que ce champ sert
   * à dire à qui ouvre le fichier : il porte `error: null` et un `finishedAt`,
   * exactement comme une exécution qui a fini son plan, alors qu'il manque des
   * artefacts. Sans lui, les deux cas sont indiscernables sur le disque.
   *
   * **Un `status.json` écrit avant cette PR ne le porte pas**, et `lireStatut`
   * ne valide rien : il y vaut `undefined`, pas `false`. Ses deux lecteurs
   * — `élémentDeListe` et `GET /api/projects/:id` — écrivent donc `?? false`, et
   * personne ne doit tester `=== false`, qui prendrait un vieux fichier pour une
   * exécution menée à son terme. (relevé par Aristarque)
   *
   * **Il traverse la frontière HTTP, et il a fallu qu'il la traverse.** Ce
   * commentaire a d'abord dit l'inverse, en s'appuyant sur `phaseProjet`
   * (`src/core/phase.ts`) qui déduit l'état juste — plus rien ne tourne,
   * aucune erreur, une étape manque, donc `interrompu`. L'argument vaut pour
   * l'écran de projet et **pas pour la bibliothèque, qui n'a pas `steps`** : la
   * liste ne porte que deux lectures gratuites, par une décision de coût qui ne
   * bouge pas (spec §3.1). Sans ce champ, une analyse arrêtée après l'ingestion
   * y est indiscernable d'une analyse finie. (relevé par Copilot)
   */
  stopped: boolean
  /**
   * Ce que le repérage de **cette** exécution n'a pas jugé, ou `null`.
   *
   * Le bilan lui-même vit en mémoire dans le processus qui l'a produit
   * (`dernierBilan`) ; c'est ici qu'il devient lisible depuis une requête HTTP —
   * **et qu'il survit au processus**. Rien ne réécrit ce fichier tant qu'une
   * nouvelle exécution ne tourne pas, donc après un redémarrage de Next il
   * décrit encore la dernière passe de repérage du projet. C'est voulu, et c'est
   * l'inverse de `running`, que le redémarrage doit précisément faire oublier :
   * un décompte de perte qualifie des propositions qui sont, elles aussi,
   * toujours là. (relevé par Copilot)
   *
   * Déduit par `bilanDeRepérage`, jamais recopié tel quel — voir pourquoi là-bas.
   */
  selectionReport: SelectionReport | null
}

/**
 * Où en est l'étape `candidates` d'une exécution donnée.
 *
 * **C'est le sort de l'étape qui qualifie le bilan, pas celui de l'exécution**,
 * et la nuance porte le champ `partiel`. Une création vise
 * `['candidates', 'proxy', 'analysis']` : le repérage y finit en trente
 * secondes, le proxy tourne six minutes derrière lui, et l'analyse peut échouer
 * ensuite. Déduire l'état du bilan de l'`error` et du `finishedAt` de
 * l'exécution marquait donc partiel un décompte complet pendant tout le proxy —
 * et **définitivement** si une étape ultérieure tombait, puisque l'échec reste
 * écrit. (relevé par Codex et Copilot)
 */
export type StateDetection = 'absent' | 'en cours' | 'fait' | 'échoué'

/**
 * Ce qu'on publie d'une notation, à partir du bilan que le repérage a laissé
 * en mémoire et de l'état de son étape.
 *
 * **Trois raisons de ne pas recopier le bilan tel quel.**
 *
 * 1. *Il décrit une notation tentée, pas une notation réussie.* Il est posé
 *    avant le premier appel et se remplit au fil de l'eau : une passe qui tombe
 *    à la quarantième fenêtre en laisse un qui dit « 40 sur 83 ». Publié seul,
 *    ce chiffre passerait pour un résultat. D'où `partial`, que seul l'état de
 *    l'étape peut dire — le bilan, lui, ne sait pas s'il est fini.
 * 2. *Il survit à l'exécution qui l'a produit.* La table est celle du processus,
 *    pas celle d'une passe : une relance qui ne vise que le proxy y recopierait
 *    le décompte d'un repérage qu'elle n'a pas fait. D'où `'absent'` — et, à
 *    l'autre bout, l'oubli posé par `lancer` avant que l'exécution ne commence,
 *    sans quoi une passe qui met une demi-heure à atteindre le repérage
 *    publierait celui d'avant pendant tout ce temps.
 * 3. *Il nomme les fenêtres.* `jamaisNotées` et `refusées` portent jusqu'à 83
 *    identifiants ; l'écran compte, il ne localise pas. Les identifiants restent
 *    au journal, qui est l'endroit d'où l'on va relire le transcript.
 */
export function detectionSummary(
  summary: SummaryNotation | null,
  state: StateDetection,
): SelectionReport | null {
  if (summary === null || state === 'absent') return null
  return {
    windows: summary.windows,
    scored: summary.noted,
    rejectedBatches: summary.batchesRejected,
    answeredBatches: summary.batchesResponded,
    coverage: summary.coverage,
    partial: state !== 'fait',
  }
}

function pathStatus(projectId: string): string {
  return path.join(projectDir(projectId), 'status.json')
}

/**
 * Écrit `status.json`, à côté puis renommé.
 *
 * Un `writeFileSync` interrompu laisse un JSON tronqué, que la lecture suivante
 * signalerait comme une panne alors que seule l'écriture avait été coupée.
 * L'écriture ne fait jamais échouer une étape : perdre le suivi d'avancement est
 * ennuyeux, perdre une transcription de quarante minutes ne l'est pas.
 */
function writeStatus(
  projectId: string,
  status: Omit<Status, 'selectionReport'>,
  detection: StateDetection,
): void {
  try {
    // **Le bilan se déduit ici, pas au point d'appel.** Il y a cinq endroits qui
    // écrivent ce fichier — début d'étape, marque de temps, plan vide, succès,
    // échec — et un raccord posé dans quatre d'entre eux manquerait au cinquième
    // sans que rien ne le signale.
    const complete: Status = {
      ...status,
      selectionReport: detectionSummary(lastSummary(projectId), detection),
    }
    const file = pathStatus(projectId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const provisional = `${file}.${process.pid}.tmp`
    fs.writeFileSync(provisional, `${JSON.stringify(complete, null, 2)}\n`, 'utf8')
    fs.renameSync(provisional, file)
  } catch (cause) {
    console.warn(`status.json non écrit pour ${projectId} : ${messageSafe(cause)}`)
  }
}

/**
 * Les six champs du bilan de repérage, de leur ancien nom français vers le
 * nouveau nom anglais — la même traduction que celle des cinq clés de
 * `selection` dans `src/server/db.ts` (`LEGACY_SELECTION_KEYS`), pour la
 * famille de champs que porte `SelectionReport`.
 */
const LEGACY_SELECTION_REPORT_FIELDS: Readonly<Record<string, keyof SelectionReport>> = {
  fenêtres: 'windows',
  notées: 'scored',
  lotsRefusés: 'rejectedBatches',
  lotsRépondus: 'answeredBatches',
  couverture: 'coverage',
  partiel: 'partial',
}

/** Le bilan de repérage lu d'un JSON, sous son ancien nom ou le nouveau. */
function selectionReportFromJSON(raw: unknown): SelectionReport | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  // Le nouveau format se reconnaît à un seul de ses champs : les six
  // arrivent toujours ensemble, voir `bilanDeRepérage`.
  if ('windows' in obj) return obj as unknown as SelectionReport
  const translated: Record<string, unknown> = {}
  for (const [oldName, newName] of Object.entries(LEGACY_SELECTION_REPORT_FIELDS)) {
    if (oldName in obj) translated[newName] = obj[oldName]
  }
  return translated as unknown as SelectionReport
}

/**
 * Un `status.json` écrit avant la traduction des clés persistées (issue #73),
 * ramené à la forme d'aujourd'hui.
 *
 * **Une lecture tolérante, pas une migration de fichiers.** Contrairement à la
 * table `settings` — une ligne par réglage, réécrite une fois pour toutes par
 * `migrateSelectionSettingKeys` —, `status.json` est un fichier par projet,
 * jamais collecté au démarrage, et il se réécrit de toute façon au prochain
 * lancement d'une analyse. Migrer les fichiers coûterait de parcourir
 * `PROJECTS_DIR` pour un gain identique à celui-ci, qui ne coûte qu'à la
 * lecture. `cibles` devient `targets`, `repérage` devient `selectionReport`,
 * et ses six champs suivent `LEGACY_SELECTION_REPORT_FIELDS`. **Ce chemin
 * pourra partir** le jour où plus aucun `status.json` d'avant cette PR ne
 * traîne sur le disque — pas avant.
 */
function statusFromJSON(raw: unknown): Status {
  const obj = { ...(raw as Record<string, unknown>) }
  const targets = ('targets' in obj ? obj.targets : obj.cibles) as StepName[]
  const rawSelectionReport = 'selectionReport' in obj ? obj.selectionReport : obj.repérage
  delete obj.cibles
  delete obj.repérage
  return {
    ...(obj as unknown as Status),
    targets,
    selectionReport: selectionReportFromJSON(rawSelectionReport),
  }
}

/**
 * Le dernier statut connu, ou `null`.
 *
 * Lu par `GET /api/projects/:id` pour le seul champ `error` — voir `Statut`.
 */
export function lireStatus(projectId: string): Status | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(pathStatus(projectId), 'utf8'))
    return statusFromJSON(raw)
  } catch {
    return null
  }
}

/** À chaque marque de temps de ffmpeg, mais pas plus d'une fois par seconde. */
const PERIOD_WRITE_MS = 1_000

function publish(execution: Execution, changeDStep: boolean): void {
  const now = Date.now()
  if (!changeDStep && now - execution.lastWrite < PERIOD_WRITE_MS) return
  execution.lastWrite = now
  writeStatus(
    execution.projectId,
    {
      pid: process.pid,
      updatedAt: now,
      targets: execution.targets,
      plan: execution.plan,
      running: { ...execution.current },
      error: null,
      finishedAt: null,
      stopped: false,
    },
    execution.detection,
  )
}

// ---------------------------------------------------------------------------
// L'exécution
// ---------------------------------------------------------------------------

/** Les étapes, injectables : c'est par là que les tests entrent. */
export type Steps = {
  ingest: typeof ingest
  buildProxy: typeof buildProxy
  extractAudio: typeof extractAudio
  transcribe: typeof transcribe
  applyTranscriptCorrections: typeof applyTranscriptCorrections
  runAnalysis: typeof runAnalysis
  runCandidates: typeof runCandidates
}

const STEPS: Steps = {
  ingest,
  buildProxy,
  extractAudio,
  transcribe,
  applyTranscriptCorrections,
  runAnalysis,
  runCandidates,
}

export type OptionsLaunch = {
  /** Les étapes à refaire même si leur artefact est là. `true` vaut « la cible ». */
  force?: readonly StepName[] | boolean
  db?: Database.Database
  steps?: Partial<Steps>
}

/**
 * `renders` est une cible du graphe, mais **pas une cible de ce lanceur** : un
 * rendu se demande par clip (`POST /api/clips/:id/export`), parce que c'est par
 * clip qu'on choisit le ratio, le cadrage et les sous-titres. Le graphe garde
 * l'étape parce qu'elle décrit une dépendance réelle ; le lanceur ne sait pas la
 * fabriquer, et prétendre le contraire ferait une exécution qui s'arrête sans
 * rien produire.
 */
// `correction` y entre pour que `force: ['correction']` valide côté route
// (`POST /api/projects/:id/run` borne `force` à cette même liste) — c'est le
// chemin du bouton « Relancer la correction ».
export const TARGETS_LAUNCHABLE = [
  'proxy',
  'audio',
  'transcript',
  'correction',
  'analysis',
  'candidates',
] as const
export type TargetLaunchable = (typeof TARGETS_LAUNCHABLE)[number]

/**
 * Le plan de plusieurs cibles, dans l'ordre d'exécution et sans doublon.
 *
 * `POST /api/projects` en demande deux — les candidats *et* le proxy —, et il
 * n'y a pas d'autre façon de les obtenir : `renders` mis à part, **rien ne
 * dépend du proxy** dans le graphe (le transcript lit le WAV, pas la vidéo),
 * donc viser les candidats ne le construit jamais. Or l'écran de clip ne peut
 * pas lire une vidéo qui n'existe pas.
 *
 * Ce n'est pas une réécriture du graphe : chaque cible passe par `planSteps`, et
 * on ne fait que concaténer sans répéter ce qui est déjà planifié.
 */
export function planForTargets(
  targets: readonly StepName[],
  presence: Record<StepName, boolean>,
  force: readonly StepName[],
): StepName[] {
  const plan: StepName[] = []
  for (const target of targets) {
    for (const step of planSteps(target, presence, force)) {
      if (!plan.includes(step)) plan.push(step)
    }
  }
  return plan
}

/**
 * Lance une analyse en tâche de fond et rend le plan **avant** de la lancer.
 *
 * La fonction attend le relevé de présence et le calcul du plan — quelques
 * `existsSync` — puis rend la main. C'est ce qui permet à `POST /run` de
 * répondre 202 en disant *ce qu'il va faire*, et c'est cette réponse-là qui
 * démontre le graphe : demander `candidates` sur un projet transcrit doit rendre
 * `["candidates"]`, et rien de plus.
 */
export async function launch(
  projectId: string,
  targets: readonly StepName[],
  options: OptionsLaunch = {},
): Promise<{ projectId: string; plan: StepName[] }> {
  // **Rien d'asynchrone au-dessus de cette ligne.** La réservation ferme la
  // course entre deux requêtes simultanées, et elle ne la ferme que si aucun
  // point d'attente ne s'intercale entre le contrôle et la pose.
  if (inCurrent.has(projectId)) throw new ExecutionInCurrentError(projectId)
  const execution: Execution = {
    projectId,
    targets: [...targets],
    plan: [],
    current: { step: targets[0] ?? 'candidates', progress: 0 },
    detection: 'absent',
    lastWrite: 0,
    finished: Promise.resolve(),
    controller: new AbortController(),
  }
  inCurrent.set(projectId, execution)

  try {
    const db = options.db ?? getDb()
    const project = getProject(db, projectId)
    if (project === undefined) throw new UnknownProjectError(projectId)

    const force =
      options.force === true
        ? [...targets]
        : options.force === false || options.force === undefined
          ? []
          : [...options.force]

    const presence = await readingPresence(project)
    execution.plan = planForTargets(targets, presence, force)
    // **L'oubli est posé au lancement, pas à l'entrée du repérage.** Une
    // exécution qui vise `candidates` peut passer une demi-heure dans la
    // transcription avant d'y arriver, et `status.json` publierait pendant tout
    // ce temps le décompte de la passe précédente comme s'il décrivait celle-ci.
    // `runCandidates` refait ce nettoyage pour son propre compte — il s'appelle
    // aussi hors du lanceur —, ce qui ne le rend pas redondant ici.
    if (execution.plan.includes('candidates')) forgetSummary(projectId)
    execution.current = { step: execution.plan[0] ?? targets[0] ?? 'candidates', progress: 0 }

    // **L'ingestion se décide avant, pas dans l'exécution.** Un projet dont les
    // artefacts sont déjà sur le disque mais dont la ligne en base est neuve —
    // une base effacée, un projet réinscrit — a un plan vide *et* une durée
    // inconnue. Sortir tout de suite le laissait à `0:00` pour toujours, et le
    // premier `run --force` échouait bien plus tard sur « le projet n'a pas de
    // durée ». Un `lstat` et un `ffprobe` sur la copie locale suffisent à le
    // réparer, et l'ingestion saute la copie si elle est déjà à la bonne taille.
    //
    // **Une seule lecture du réglage pour toute l'exécution.** Une transcription
    // dure jusqu'à quarante minutes avant que `proxy` ne soit atteint ; relire
    // `copiesSourceLocally(db)` à l'entrée de chaque étape laissait le réglage
    // coché entre-temps contredire ce que la planification venait de décider —
    // aucune ingestion prévue, mais l'étape l'exigeant quand même, sur un projet
    // qu'aucune relance ne pouvait plus débloquer. La valeur lue ici vaut pour
    // tout le reste du lancement (relevé par la review de la PR #113).
    const copyLocally = copiesSourceLocally(db)
    const doitIngest = ingestionNecessary(project, execution.plan, copyLocally)

    // Un plan vide n'est pas une exécution : tout est déjà là, il n'y a rien à
    // suivre et rien à verrouiller.
    if (execution.plan.length === 0 && !doitIngest) {
      inCurrent.delete(projectId)
      writeStatus(
        projectId,
        {
          pid: process.pid,
          updatedAt: Date.now(),
          targets: [...targets],
          plan: [],
          running: null,
          error: null,
          finishedAt: Date.now(),
          stopped: false,
        },
        'absent',
      )
      return { projectId, plan: [] }
    }

    publish(execution, true)
    execution.finished = execute(execution, project, db, options, doitIngest, copyLocally).finally(() => {
      inCurrent.delete(projectId)
      // **Le nettoyage du cache de travail, après traitement** (retour d'usage
      // §5). Best effort et sans attente : il ne fait pas partie de
      // l'exécution, et son échec n'a rien à dire à personne. `enCours` vient
      // d'être vidé de ce projet, donc sa propre copie n'est plus épargnée —
      // c'est voulu, le TTL vaut pour elle comme pour les autres.
      void cleanWorkCache(db).catch(() => {})
    })
    // Le rejet est traité dans `exécuter` ; ce `catch` n'existe que pour qu'une
    // promesse dont personne n'attend le résultat ne coupe pas le processus.
    execution.finished.catch(() => {})

    return { projectId, plan: [...execution.plan] }
  } catch (cause) {
    inCurrent.delete(projectId)
    throw cause
  }
}

/**
 * Nettoie le cache de travail **en épargnant ce que les exécutions lisent**.
 *
 * **Le seul endroit qui sache faire les deux à la fois**, et c'est la raison
 * d'être de cette fonction : `cleanStage` connaît le TTL, `run.ts` connaît les
 * exécutions, et un appelant qui n'aurait que le premier efface la copie du
 * second. C'est ce qui est arrivé au nettoyage de démarrage
 * (`src/instrumentation.ts`), qui appelait `cleanStage` nu : le balayage
 * continue après le retour de `register()`, donc le serveur accepte une analyse
 * pendant qu'il tourne, cette analyse constate sa copie présente — elle n'a rien
 * à recopier, donc rien ne l'inscrit dans `copiesInFlight` — et la perd.
 * (relevé par Copilot)
 *
 * La liste est passée en **fonction** : le balayage dure, et une exécution
 * démarrée pendant ce temps doit être vue. Voir `cleanStage`.
 */
export function cleanWorkCache(db?: Database.Database): Promise<string[]> {
  return cleanStage({ keep: () => copiesInUse(db) })
}

/**
 * Les copies de travail qu'une exécution est en train de lire, ou `null` si on
 * n'a pas pu le savoir.
 *
 * Effacer sous un ffmpeg ne le casse pas — le descripteur ouvert survit à
 * l'`unlink` sous Linux — mais l'étape d'après repaierait la copie, et sur une
 * source de 12 Go cela veut dire cinq minutes de Drive. Deux projets peuvent
 * tourner en même temps : `enCours` est une table par projet, pas un verrou
 * global.
 *
 * **`null` veut dire « épargne tout », pas « n'épargne rien ».** Cette fonction
 * est rappelée à chaque fichier par `cleanStage`, et `closeDb` s'accroche à
 * l'arrêt du serveur : la base peut s'être refermée entre-temps. Rendre une
 * liste vide ferait alors effacer à l'aveugle exactement les copies qu'on
 * cherchait à épargner, et laisser lever ferait rejeter une exécution qui, elle,
 * s'est bien passée. Ne rien effacer coûte au pire un passage sauté.
 */
function copiesInUse(db?: Database.Database): string[] | null {
  // **Rien ne tourne, donc rien à épargner — et surtout rien à ouvrir.** C'est
  // le cas du nettoyage de démarrage, et il vaut mieux qu'une optimisation :
  // sans lui, `getDb()` ouvrirait SQLite pendant l'amorçage du serveur, pour
  // une liste dont on sait déjà qu'elle est vide.
  if (inCurrent.size === 0) return []
  const paths: string[] = []
  try {
    const base = db ?? getDb()
    for (const id of inCurrent.keys()) {
      const copy = getProject(base, id)?.stagedPath
      if (copy != null) paths.push(copy)
    }
  } catch {
    return null
  }
  return paths
}

/**
 * Faut-il (ré)ingérer avant d'exécuter le plan ?
 *
 * Deux cas, et un seul coûte cher. `stage/` est transitoire — il peut être
 * effacé à tout moment —, donc une étape qui lit la vidéo exige de vérifier que
 * la copie est là : sinon, cinq minutes de copie depuis le Drive. La durée
 * manquante, elle, ne coûte qu'un `lstat` et un `ffprobe` sur la copie locale,
 * mais elle est indispensable : `runCandidates` refuse de travailler sans elle.
 *
 * Le reste du temps — le cas courant d'une relance de repérage — **on ne touche
 * pas au Drive du tout**, ce qui est exactement ce qu'on veut d'un montage lent
 * qui décroche.
 */
function ingestionNecessary(
  project: Project,
  plan: readonly StepName[],
  copyLocally: boolean,
): boolean {
  // **Le besoin de copie disparaît avec le réglage, pas le besoin de durée.**
  // Décoché, déclencher une ingestion pour une copie qu'on refuse d'écrire
  // ferait payer le sondage du Drive pour rien. La durée, elle, reste
  // indispensable — `runCandidates` refuse de travailler sans —, et l'ingestion
  // sait la relever sur l'original quand elle ne copie pas.
  const copyNeed = copyLocally && (plan.includes('proxy') || plan.includes('audio'))
  // **`workingInput` et non un `existsSync` écrit ici**, parce que c'est la même
  // question que se pose l'entrée des étapes : *ce fichier décrit-il encore la
  // source ?* Un `existsSync` y répondait « oui » à un fichier périmé, et les
  // deux réponses divergeaient — la planification ne réingérait pas, l'étape
  // refusait l'entrée, et le projet restait coincé sur une erreur qu'aucune
  // relance ne pouvait lever : rien n'efface la copie, rien ne rafraîchit la
  // durée. Un défaut compris comme local revient au champ suivant (`CLAUDE.md`),
  // et c'est exactement ce qui s'est produit ici, une couche au-dessus du
  // correctif précédent.
  const copy = workingInput(project).local
  return (copyNeed && !copy) || project.durationSec === null
}

async function execute(
  execution: Execution,
  projectInitial: Project,
  db: Database.Database,
  options: OptionsLaunch,
  doitIngest: boolean,
  copyLocally: boolean,
): Promise<void> {
  const steps = { ...STEPS, ...options.steps }
  const { projectId } = execution
  let project = projectInitial
  // **Portée par l'exécution, jamais par un throw.** L'étape `correction`
  // avale une panne du modèle plutôt que d'arrêter toute l'analyse (voir son
  // `case` dans `executeStep`) ; ce que cette variable porte, c'est ce que
  // `status.json` doit dire malgré tout — sinon la panne n'échoue pas, elle
  // disparaît.
  let correctionWarning: string | null = null

  const advance = (fraction: number | null): void => {
    if (fraction === null) return
    execution.current.progress = Math.min(1, Math.max(0, fraction))
    publish(execution, false)
  }

  /**
   * Le bilan du repérage vient de changer : `status.json` doit le dire tout de
   * suite.
   *
   * **Hors de la temporisation d'écriture**, contrairement à `avancer`. Celle-ci
   * existe pour les marques de temps de ffmpeg, qui arrivent plusieurs fois par
   * seconde et ne portent qu'un pourcentage ; un lot noté est un changement
   * d'état, il y en a une trentaine sur une passe entière, et l'écran qui
   * interroge toutes les deux secondes doit pouvoir le voir monter.
   */
  const flagSummary = (): void => {
    publish(execution, true)
  }

  const signal = execution.controller.signal

  /**
   * Le `status.json` d'une exécution qu'on a arrêtée.
   *
   * **Ni `running`, ni `error`.** Un arrêt demandé n'est pas une panne : écrire
   * le message du ffmpeg tué — « ffmpeg a échoué (tué par SIGTERM) » — ferait
   * afficher un bandeau d'échec à quelqu'un qui vient de cliquer « Arrêter ».
   * L'état juste est celui que `phaseProjet` en déduit tout seul : plus rien ne
   * tourne, aucune erreur, une étape manque — donc `interrompu`, donc l'écran
   * propose de reprendre.
   */
  const writeStoppedStatus = (): void => {
    writeStatus(
      projectId,
      {
        pid: process.pid,
        updatedAt: Date.now(),
        targets: execution.targets,
        plan: execution.plan,
        running: null,
        error: null,
        finishedAt: Date.now(),
        stopped: true,
      },
      execution.detection,
    )
    console.log(`[${projectId}] arrêté sur ${execution.current.step}.`)
  }

  try {
    if (doitIngest) {
      // L'ingestion n'est pas une étape du graphe — la source est là ou le
      // projet n'existe pas —, elle n'a donc pas de nom à afficher. On garde
      // celui de la première étape à faire, dont la progression est bien à zéro
      // tant que la copie n'est pas finie.
      // **`copyLocally` explicite, pas la lecture propre d'`ingest`.** Sans ce
      // paramètre, `ingest` relit `copiesSourceLocally(db)` lui-même après le
      // sondage du montage — un sondage qui peut prendre jusqu'à vingt
      // secondes — et la valeur figée au lancement cesserait de gouverner
      // « toute l'exécution » si le réglage changeait pendant l'attente.
      // (relevé par la review de la PR #113)
      const ingestion = await steps.ingest(project.sourcePath, {
        db,
        signal,
        copyLocally,
        onProgress: (a) => advance(a.fraction),
      })
      const reread = getProject(db, projectId)
      if (reread !== undefined) project = reread
      else project = { ...project, stagedPath: ingestion.stagedPath, durationSec: ingestion.durationSec }
    }

    for (const step of execution.plan) {
      // **Le contrôle est à l'entrée de chaque étape, pas seulement dans les
      // processus.** Un arrêt demandé pendant la transcription doit couper le
      // worker *et* empêcher les six minutes de proxy qui la suivent de partir.
      if (signal.aborted) break
      execution.current = { step: step, progress: 0 }
      // **Le sort du repérage se suit à part, étape par étape.** C'est lui qui
      // qualifie le bilan, et non celui de l'exécution qui l'entoure : voir
      // `ÉtatRepérage`.
      if (step === 'candidates') execution.detection = 'en cours'
      publish(execution, true)
      console.log(`[${projectId}] ${step}…`)
      try {
        const warning = await executeStep(
          step,
          project,
          db,
          copyLocally,
          steps,
          advance,
          flagSummary,
          signal,
          // **Une retranscription dans ce même plan fait repartir le journal
          // de correction à vide.** `transcript.json` vient d'être remplacé
          // en entier : les positions d'un journal antérieur n'y correspondent
          // plus à rien (voir `applyTranscriptCorrections`).
          execution.plan.includes('transcript'),
        )
        if (warning !== null) correctionWarning = warning
      } catch (cause) {
        // Une passe coupée n'a pas échoué : elle n'a pas fini. Les deux donnent
        // `partiel: true` dans le bilan publié, mais l'un décrit un incident et
        // l'autre une décision, et le code se relit.
        if (step === 'candidates') execution.detection = signal.aborted ? 'en cours' : 'échoué'
        throw cause
      }
      if (step === 'candidates') execution.detection = 'fait'
    }

    // L'arrêt tombé entre deux étapes, ou pendant la dernière : la boucle est
    // sortie sans lever, et il ne faut surtout pas écrire un statut de succès.
    if (signal.aborted) {
      writeStoppedStatus()
      return
    }

    writeStatus(
      projectId,
      {
        pid: process.pid,
        updatedAt: Date.now(),
        targets: execution.targets,
        plan: execution.plan,
        running: null,
        error: correctionWarning,
        finishedAt: Date.now(),
        stopped: false,
      },
      execution.detection,
    )
    console.log(`[${projectId}] terminé : ${execution.plan.join(' → ')}`)
  } catch (cause) {
    // **L'arrêt se lit sur le signal, jamais sur l'erreur reçue.** Selon
    // l'étape, elle vaut `StopRequestedError`, une `AbortError` de `pipeline` ou
    // le refus d'un flux fermé sous les pieds d'une bibliothèque tierce ; le
    // seul fait commun est que quelqu'un a demandé l'arrêt. Et on ne relève pas
    // l'erreur : une exécution arrêtée s'est terminée comme on le voulait, donc
    // `attendre()` doit rendre la main sans rejeter.
    if (signal.aborted) {
      writeStoppedStatus()
      return
    }
    // **Le message complet au journal, sa version épurée dans le fichier.** Les
    // erreurs de `runFfmpeg`, `statAvecDélai` et `lancerWorker` portent la
    // commande entière, chemins absolus compris : c'est ce qu'il faut sous les
    // yeux pour diagnostiquer, et c'est ce qui n'a rien à faire dans un fichier
    // qu'on recopie dans un rapport ou qu'une route finirait par servir.
    console.error(`[${projectId}] échec sur ${execution.current.step} :`, cause)
    writeStatus(
      projectId,
      {
        pid: process.pid,
        updatedAt: Date.now(),
        targets: execution.targets,
        plan: execution.plan,
        running: null,
        error: messageSafe(cause),
        finishedAt: Date.now(),
        stopped: false,
      },
      execution.detection,
    )
    throw cause
  }
}

/**
 * Une étape, avec `force: true` sans condition.
 *
 * Ce n'est pas une entorse au saut d'étape : `planSteps` ne nomme une étape que
 * s'il faut la refaire, et le relevé de présence qu'il a reçu est exactement
 * celui que ces fonctions consulteraient. Leur laisser décider une seconde fois
 * ferait deux autorités sur la même question, et la seule façon de les
 * départager serait de relire le disque entre les deux.
 */
async function executeStep(
  step: StepName,
  project: Project,
  db: Database.Database,
  copyLocally: boolean,
  steps: Steps,
  advance: (fraction: number | null) => void,
  flagSummary: () => void,
  signal: AbortSignal,
  freshTranscript: boolean,
): Promise<string | null> {
  switch (step) {
    case 'proxy':
    case 'audio': {
      const input = workingInput(project)
      // **L'exigence de copie suit le réglage, et rien d'autre.** Coché, une
      // copie absente ici est un défaut d'ordonnancement — `ingestionNecessary`
      // vient précisément de la garantir —, et lever le dit mieux qu'un ffmpeg
      // qui relit six gigaoctets sur un montage à 40 Mo/s sans que personne ne
      // sache pourquoi l'étape a triplé. Décoché, lire l'original **est** le
      // comportement demandé.
      //
      // **`copyLocally` vient du lancement, pas d'une relecture ici** — voir le
      // commentaire au point d'appel de `execute`, dans `launch`.
      if (copyLocally && !input.local) {
        throw new Error(
          `Le projet ${project.id} n'a pas de copie de travail : l'ingestion doit passer avant ${step}.`,
        )
      }
      // **Décoché, ou copie absente sans copie exigée, `ffmpeg` va ouvrir
      // l'original — sonder le montage avant, sous délai de garde.** Le cas
      // courant ne repasse pas par `ingest` ici (`ingestionNecessary` n'a rien
      // planifié quand la durée est déjà connue), donc rien d'autre n'a encore
      // touché le Drive sur ce lancement. Sans ce sondage, un 9p monté avec son
      // transport mort dessous laisserait `produceArtifact` — qui ne reçoit
      // aucun `timeoutMs` — pendre indéfiniment plutôt que d'échouer avec un
      // message qui dit quoi faire. (relevé par la review de la PR #113)
      if (!input.local) {
        if (!(await editingResponds(input.path))) {
          throw new Error(
            `${step} de ${project.id} : le dossier des replays ne répond pas. REPLAY_DIR est ` +
              'monté en 9p et peut être monté avec son transport mort dessous — /proc/mounts ne le ' +
              'distingue pas. Rouvrir le lecteur côté Windows, ou remonter le partage.',
          )
        }
        // **`editingResponds` dit que le montage répond, pas que le fichier y
        // est.** Un `ENOENT` immédiat *est* une réponse en ce sens — c'est ce
        // qui distingue un montage mort d'un montage vivant —, donc un
        // original supprimé passerait le sondage ci-dessus tel quel et
        // laisserait ffmpeg échouer sur un message qui n'explique rien.
        // `ensureLocalCopy` fait déjà cette distinction pour l'export ; les
        // mêmes deux questions se posent ici. (relevé par Copilot)
        if (!fs.existsSync(input.path)) {
          throw new Error(
            `${step} de ${project.id} : la copie de travail est désactivée ou absente, et ` +
              `l'original ${JSON.stringify(path.basename(input.path))} est introuvable dans le ` +
              'dossier des replays.',
          )
        }
      }
      const common = {
        projectId: project.id,
        input: input.path,
        durationSec: project.durationSec,
        force: true,
        signal,
        onProgress: (a: { fraction: number | null }) => advance(a.fraction),
      }
      await (step === 'proxy' ? steps.buildProxy(common) : steps.extractAudio(common))
      return null
    }

    case 'transcript': {
      await steps.transcribe({
        source: project.sourcePath,
        projectId: project.id,
        audio: audioPath(project.id),
        force: true,
        signal,
        onLog: (line) => {
          console.log(`[${project.id}] worker | ${line}`)
          advance(progressWorker(line))
        },
      })
      // L'emplacement retenu disait « pas de transcript », et c'était vrai il y
      // a quarante minutes. Sans cet oubli, l'étape suivante consulterait une
      // absence que l'étape qui vient de finir a précisément levée.
      forgetSidecar(project)
      return null
    }

    case 'correction': {
      // **Jamais `isRunning`.** `applyTranscriptCorrections` ne le prend même
      // pas en option — voir son commentaire — précisément pour qu'aucun
      // appelant ne puisse reproduire ici le piège documenté au contrat de
      // cette PR : l'exécution en cours est la nôtre.
      //
      // **Une panne du modèle n'arrête pas l'analyse, mais elle ne disparaît
      // pas non plus.** Un modèle injoignable est une panne d'environnement,
      // pas un transcript invalide ; bloquer tout le plan derrière une panne
      // réseau referait exactement ce que cette PR retire — un lancement du
      // soir qui attend jusqu'au matin. Mais l'avaler en silence serait
      // l'échec qui n'échoue pas (`CLAUDE.md`) : `candidates.json` existerait
      // ensuite, calculé sur du texte non corrigé, et plus rien ne le
      // dirait — le graphe ne redécouvre jamais une dépendance absente sous
      // un artefact présent (`toRedo`, `src/core/graph.ts`). Le message
      // remonté ici devient donc `status.json.error` (voir `correctionWarning`
      // dans `execute`), visible au repos sur l'écran de projet, et le
      // rattrapage explicite est le bouton « Relancer la correction » du
      // transcript de l'émission (`force: ['correction']`, qui entraîne
      // `candidates` avec lui).
      //
      // **`signal.aborted` n'est pas avalé.** Un arrêt demandé n'est pas une
      // panne du modèle : il doit remonter tel quel, pour que l'exécution se
      // termine comme `interrompu`, pas comme un succès avec un avertissement.
      let correctionOutcome: { applied: number } | undefined
      try {
        correctionOutcome = await steps.applyTranscriptCorrections(project, db, { signal, freshTranscript })
      } catch (cause) {
        if (signal.aborted) throw cause
        const message = `La correction automatique du transcript a échoué : ${messageSafe(cause)}. ` +
          'Le repérage a tourné sur le texte non corrigé — relancer la correction depuis le ' +
          'transcript de l’émission.'
        console.error(`[${project.id}] correction du transcript :`, cause)
        return message
      }
      // Même oubli qu'après `transcript`, ligne 1224 : `correction.json` vient
      // d'être écrit, et le cache retenait `correction: false` depuis le
      // relevé de présence au lancement — sans cet oubli, un arrêt ou une
      // relance immédiate dans la fenêtre du TTL (4 s) reprogrammerait la
      // correction pour rien. (relevé par Copilot et Aristarque)
      forgetSidecar(project)
      // **`candidates.json` invalidé ici, pas laissé à l'étape `candidates`.**
      // `DEPS.candidates = ['correction']` fait déjà entrer `candidates` dans
      // le plan de cette même exécution dès que `correction` s'y trouve — mais
      // un arrêt ou un crash entre les deux laisserait l'ancien
      // `candidates.json` intact, calculé sur le texte d'avant les
      // substitutions qui viennent d'être écrites. `readingPresence` le lirait
      // comme fait, et une relance ordinaire — qui ne vise pas `correction`,
      // déjà là — ne le redécouvrirait jamais absent. On ne le supprime que si
      // au moins une substitution a réellement changé le texte : sans ça,
      // rien n'a bougé sous lui. (relevé par Codex)
      if (correctionOutcome.applied > 0) await fsp.rm(candidatesPath(project.id), { force: true })
      return null
    }

    case 'analysis': {
      // La copie de travail si elle est là, l'original sinon. Ce n'est pas de
      // la vidéo qu'on lit ici, seulement ses dimensions : `analysis.json` les
      // recopie pour dire à quoi ses fractions se rapportent, et un en-tête se
      // lit même sur le Drive. **Sans repli sur la copie, on la rendrait
      // obligatoire** — donc on paierait cinq minutes de recopie depuis un
      // montage lent pour relancer une analyse dont le proxy est déjà là.
      // **Mais un repli silencieux n'en est pas un.** C'est le cas que le §5 du
      // retour d'usage décrit comme « extrêmement lent » : le travail bascule
      // sur le montage 9p sans que rien ne le dise, et une lenteur inexpliquée
      // se cherche pendant une demi-heure avant qu'on pense au montage. Ici
      // elle reste bornée — on lit un en-tête, pas la vidéo —, ce qui justifie
      // de ne pas repayer cinq minutes de recopie ; ce qui ne se justifie pas,
      // c'est de le taire.
      //
      // **Et l'avertissement ne tombe que si la copie était attendue.** Décoché,
      // lire l'original est le réglage qui s'applique, pas un accident : le
      // signaler à chaque analyse apprendrait à ne plus lire les avertissements,
      // et le premier vrai — celui qui décrit une copie perdue — passerait avec
      // les autres.
      const input = workingInput(project)
      if (!input.local && copyLocally) {
        console.warn(
          `[${project.id}] analyse : pas de copie de travail dans stage/, les dimensions sont ` +
            'relevées sur l’original — c’est-à-dire sur le montage 9p. Un ffprobe d’en-tête le ' +
            'supporte ; une étape qui lirait la vidéo entière, non. Viser proxy ou audio ' +
            'reconstitue la copie.',
        )
      }
      await steps.runAnalysis({
        projectId: project.id,
        source: input.path,
        force: true,
        signal,
        onLog: (line) => {
          console.log(`[${project.id}] detect | ${line}`)
          advance(progressWorker(line))
        },
      })
      return null
    }

    case 'candidates': {
      // `onBilan` est ce qui rend le décompte lisible **pendant** la notation.
      // Sans lui, `status.json` ne le porte qu'une fois l'étape finie, et l'écran
      // affiche « rien à signaler » pendant les trente secondes où la perte se
      // constitue. (relevé par Codex et Copilot)
      await steps.runCandidates(project.id, { db, signal, onSummary: flagSummary })
      return null
    }

    case 'renders': {
      // Inatteignable par les routes : `CIBLES_LANÇABLES` ne le propose pas, et
      // aucune autre étape n'en dépend. Le dire plutôt que de l'ignorer, sinon
      // une cible ajoutée demain ne ferait rien du tout, en silence.
      throw new Error(
        'Le rendu ne se lance pas par le graphe : un clip se rend par POST /api/clips/:id/export.',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// La création d'un projet
// ---------------------------------------------------------------------------

/**
 * Ce que `POST /api/projects` vise : les candidats, le proxy, **et** l'analyse.
 *
 * L'analyse est là parce qu'elle ne se demande jamais toute seule : personne ne
 * clique « détecte les corps », on veut un projet dont le cadrage sait déjà se
 * calculer. Elle coûte trois minutes sur une chaîne qui en dure quarante, et son
 * unique dépendance — le proxy — est déjà visée.
 */
export const TARGETS_INITIAL: StepName[] = ['candidates', 'proxy', 'analysis']

/**
 * Inscrit un projet, et lance son analyse si on le demande.
 *
 * **La ligne est écrite avant que la copie ne commence**, et c'est ce qui rend
 * la réponse 202 utile : sans elle, `GET /api/projects/:id` répondrait 404
 * pendant les cinq minutes de copie depuis le Drive, et l'interface n'aurait
 * rien à interroger. Les champs que l'ingestion relève — durée, taille, date —
 * arrivent ensuite ; `upsertProject` les met à jour sans toucher à `createdAt`.
 *
 * `launchNow` vaut `false` par défaut depuis le 23 août 2026 — voir spec §12.
 */
export async function createProject(
  source: string,
  options: OptionsLaunch & { launchNow?: boolean } = {},
): Promise<{ projectId: string; plan: StepName[] }> {
  const sourcePath = resolveSource(source)
  const projectId = projectIdFromSource(source)
  const db = options.db ?? getDb()

  const existant = getProject(db, projectId)
  // Un identifiant, une source. Voir `CollisionDeProjetError`.
  if (existant !== undefined && existant.sourcePath !== sourcePath) {
    throw new ProjectErrorCollision(projectId, existant.sourcePath, sourcePath)
  }
  upsertProject(db, {
    id: projectId,
    sourcePath,
    stagedPath: existant?.stagedPath ?? stagedPath(source),
    durationSec: existant?.durationSec ?? null,
    sizeBytes: existant?.sizeBytes ?? null,
    mtimeMs: existant?.mtimeMs ?? null,
    createdAt: existant?.createdAt ?? Date.now(),
  })

  if (options.launchNow !== true) return { projectId, plan: [] }
  return launch(projectId, TARGETS_INITIAL, options)
}
