import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type Database from 'better-sqlite3'

import { planSteps, type StepName } from '@/core/graph'
import { avancementWorker } from '@/core/pipeline'
import { getDb, getProject, upsertProject, type Project } from '@/server/db'
import { messageSûr } from '@/server/erreurs'
import {
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
import { extractAudio } from '@/server/steps/audio'
import { runCandidates } from '@/server/steps/candidates'
import { attendreOuRenoncer, DÉLAI_STAT_MS, ingest } from '@/server/steps/ingest'
import { buildProxy } from '@/server/steps/proxy'
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
 */

/** Ce que l'interface lit dans `ProjectStatus.running`. */
export type Progression = { step: StepName; progress: number }

/** Une exécution vivante, dans **ce** processus. */
type Exécution = {
  projectId: string
  cibles: StepName[]
  plan: StepName[]
  courante: Progression
  /** Pour ne pas réécrire `status.json` à chaque marque de temps de ffmpeg. */
  dernièreÉcriture: number
  terminée: Promise<void>
}

const enCours = new Map<string, Exécution>()

/** Levée quand une exécution tourne déjà sur ce projet. La route en fait un 409. */
export class ExécutionEnCoursError extends Error {
  constructor(readonly projectId: string) {
    super(`Une exécution est déjà en cours sur ${projectId}.`)
    this.name = 'ExécutionEnCoursError'
  }
}

/** Levée quand le projet demandé n'est pas en base. La route en fait un 404. */
export class ProjetInconnuError extends Error {
  constructor(readonly projectId: string) {
    super(`Projet inconnu : ${projectId}`)
    this.name = 'ProjetInconnuError'
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
export class CollisionDeProjetError extends Error {
  constructor(
    readonly projectId: string,
    readonly attendu: string,
    readonly reçu: string,
  ) {
    super(
      `L'identifiant ${projectId} désigne déjà ${JSON.stringify(path.basename(attendu))}. ` +
        `${JSON.stringify(path.basename(reçu))} lui donnerait le même projet : renommer l'un des deux fichiers.`,
    )
    this.name = 'CollisionDeProjetError'
  }
}

/** L'avancement en cours, ou `null` si rien ne tourne. */
export function progression(projectId: string): Progression | null {
  const exécution = enCours.get(projectId)
  return exécution === undefined ? null : { ...exécution.courante }
}

/** Attend la fin de l'exécution d'un projet. Pour les scripts et les tests. */
export async function attendre(projectId: string): Promise<void> {
  await enCours.get(projectId)?.terminée
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
 * projet. Or `montageRépond` s'appuie sur `fsp.stat`, qui **consomme un fil du
 * vivier de libuv** quand le montage ne répond pas — le vivier en compte quatre
 * par défaut. Sans cache, huit secondes de sondage suffisaient à les prendre
 * tous les quatre et à figer *tout* ce qui touche au disque dans le serveur, y
 * compris l'analyse en cours. Le mode de panne visé par la garde était devenu
 * une façon de la déclencher.
 *
 * La sonde en vol est partagée, donc deux requêtes simultanées n'en lancent
 * jamais deux — et `montageVivant`, juste en dessous, ferme le cas où la sonde
 * ne revient pas du tout.
 */
type EntréeSidecar = { valeur: string | null; expire: number; enVol?: Promise<string | null> }
const sidecars = new Map<string, EntréeSidecar>()

/** Assez court pour qu'un transcript qui vient d'être écrit apparaisse presque tout de suite. */
const TTL_SIDECAR_MS = 4_000

/**
 * Les sondes de montage **encore en vol**, par chemin sondé.
 *
 * **Renoncer n'est pas annuler.** `attendreOuRenoncer` rend la main au bout du
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
const sondes = new Map<string, Promise<boolean>>()

/**
 * Le montage répond-il ? Comme `montageRépond`, mais sans jamais laisser deux
 * sondes en vol sur le même chemin.
 */
async function montageVivant(chemin: string): Promise<boolean> {
  // Une sonde est déjà partie et n'est pas revenue : elle occupe déjà un fil, et
  // en lancer une seconde en occuperait un de plus sans rien apprendre de neuf.
  if (sondes.has(chemin)) return false

  const sonde = fsp.stat(chemin).then(
    () => true,
    // Une erreur *est* une réponse : un `ENOENT` immédiat prouve que le système
    // de fichiers est vivant. Ce qu'on mesure ici est le silence, pas l'absence.
    () => true,
  )
  sondes.set(chemin, sonde)
  void sonde.finally(() => sondes.delete(chemin))

  try {
    return await attendreOuRenoncer(sonde, DÉLAI_STAT_MS, 'muet')
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
export async function cheminTranscript(projet: Project): Promise<string | null> {
  const clé = cléSidecar(projet)
  const entrée = sidecars.get(clé)
  if (entrée !== undefined) {
    if (entrée.enVol !== undefined) return entrée.enVol
    if (entrée.expire > Date.now()) return entrée.valeur
  }

  const travail = chercherSidecar(projet, clé)
  sidecars.set(clé, { valeur: null, expire: 0, enVol: travail })
  return travail
}

/**
 * La clé retient **les deux dossiers dont dépend la réponse**, pas seulement
 * l'identifiant du projet : le sidecar peut être dans `PROJECTS_DIR` ou à côté
 * de l'original, et une entrée qui ne nommerait que le projet resterait valable
 * après un changement de l'un ou de l'autre. Le calcul est de la manipulation de
 * chemins, il ne touche pas au disque.
 */
function cléSidecar(projet: Project): string {
  return `${projectDir(projet.id)}\0${projet.sourcePath}`
}

async function chercherSidecar(projet: Project, clé: string): Promise<string | null> {
  const retenir = (valeur: string | null, ttl: number): string | null => {
    sidecars.set(clé, { valeur, expire: Date.now() + ttl })
    return valeur
  }

  const nomSidecar = path.basename(sidecarDir(projet.sourcePath))
  const repli = path.join(projectDir(projet.id), nomSidecar, 'transcript.json')
  if (fs.existsSync(repli)) return retenir(repli, TTL_SIDECAR_MS)

  // **Sonder avant de toucher au Drive.** Monté avec son transport mort dessous,
  // il ne répond pas, et un `existsSync` synchrone gèle la boucle d'événements —
  // donc le serveur entier, pas seulement cette requête.
  if (!(await montageVivant(projet.sourcePath))) return retenir(null, TTL_SIDECAR_MS)
  const voulu = path.join(sidecarDir(projet.sourcePath), 'transcript.json')
  return retenir(fs.existsSync(voulu) ? voulu : null, TTL_SIDECAR_MS)
}

/**
 * Oublie l'emplacement retenu. Appelé après la transcription : l'étape vient
 * précisément de créer le fichier dont on avait constaté l'absence.
 */
export function oublierSidecar(projet: Project): void {
  sidecars.delete(cléSidecar(projet))
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
const TEMPORAIRE = '.partiel-'

function rendusPrésents(projectId: string): boolean {
  try {
    return fs
      .readdirSync(rendersDir(projectId))
      .some((nom) => nom.endsWith('.mp4') && !nom.includes(TEMPORAIRE))
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
export async function relevéPrésence(projet: Project): Promise<Record<StepName, boolean>> {
  return {
    proxy: fs.existsSync(proxyPath(projet.id)),
    audio: fs.existsSync(audioPath(projet.id)),
    transcript: (await cheminTranscript(projet)) !== null,
    candidates: fs.existsSync(candidatesPath(projet.id)),
    renders: rendusPrésents(projet.id),
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
export type Statut = {
  pid: number
  updatedAt: number
  cibles: StepName[]
  plan: StepName[]
  running: Progression | null
  /** Le message d'échec, **déjà épuré** : ce fichier se recopie dans un rapport. */
  error: string | null
  finishedAt: number | null
}

function cheminStatut(projectId: string): string {
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
function écrireStatut(projectId: string, statut: Statut): void {
  try {
    const fichier = cheminStatut(projectId)
    fs.mkdirSync(path.dirname(fichier), { recursive: true })
    const provisoire = `${fichier}.${process.pid}.tmp`
    fs.writeFileSync(provisoire, `${JSON.stringify(statut, null, 2)}\n`, 'utf8')
    fs.renameSync(provisoire, fichier)
  } catch (cause) {
    console.warn(`status.json non écrit pour ${projectId} : ${messageSûr(cause)}`)
  }
}

/**
 * Le dernier statut connu, ou `null`.
 *
 * Lu par `GET /api/projects/:id` pour le seul champ `error` — voir `Statut`.
 */
export function lireStatut(projectId: string): Statut | null {
  try {
    return JSON.parse(fs.readFileSync(cheminStatut(projectId), 'utf8')) as Statut
  } catch {
    return null
  }
}

/** À chaque marque de temps de ffmpeg, mais pas plus d'une fois par seconde. */
const PÉRIODE_ÉCRITURE_MS = 1_000

function publier(exécution: Exécution, changementDÉtape: boolean): void {
  const maintenant = Date.now()
  if (!changementDÉtape && maintenant - exécution.dernièreÉcriture < PÉRIODE_ÉCRITURE_MS) return
  exécution.dernièreÉcriture = maintenant
  écrireStatut(exécution.projectId, {
    pid: process.pid,
    updatedAt: maintenant,
    cibles: exécution.cibles,
    plan: exécution.plan,
    running: { ...exécution.courante },
    error: null,
    finishedAt: null,
  })
}

// ---------------------------------------------------------------------------
// L'exécution
// ---------------------------------------------------------------------------

/** Les étapes, injectables : c'est par là que les tests entrent. */
export type Étapes = {
  ingest: typeof ingest
  buildProxy: typeof buildProxy
  extractAudio: typeof extractAudio
  transcribe: typeof transcribe
  runCandidates: typeof runCandidates
}

const ÉTAPES: Étapes = { ingest, buildProxy, extractAudio, transcribe, runCandidates }

export type OptionsLancement = {
  /** Les étapes à refaire même si leur artefact est là. `true` vaut « la cible ». */
  force?: readonly StepName[] | boolean
  db?: Database.Database
  étapes?: Partial<Étapes>
}

/**
 * `renders` est une cible du graphe, mais **pas une cible de ce lanceur** : un
 * rendu se demande par clip (`POST /api/clips/:id/export`), parce que c'est par
 * clip qu'on choisit le ratio, le cadrage et les sous-titres. Le graphe garde
 * l'étape parce qu'elle décrit une dépendance réelle ; le lanceur ne sait pas la
 * fabriquer, et prétendre le contraire ferait une exécution qui s'arrête sans
 * rien produire.
 */
export const CIBLES_LANÇABLES = ['proxy', 'audio', 'transcript', 'candidates'] as const
export type CibleLançable = (typeof CIBLES_LANÇABLES)[number]

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
export function planPourCibles(
  cibles: readonly StepName[],
  présence: Record<StepName, boolean>,
  force: readonly StepName[],
): StepName[] {
  const plan: StepName[] = []
  for (const cible of cibles) {
    for (const étape of planSteps(cible, présence, force)) {
      if (!plan.includes(étape)) plan.push(étape)
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
export async function lancer(
  projectId: string,
  cibles: readonly StepName[],
  options: OptionsLancement = {},
): Promise<{ projectId: string; plan: StepName[] }> {
  // **Rien d'asynchrone au-dessus de cette ligne.** La réservation ferme la
  // course entre deux requêtes simultanées, et elle ne la ferme que si aucun
  // point d'attente ne s'intercale entre le contrôle et la pose.
  if (enCours.has(projectId)) throw new ExécutionEnCoursError(projectId)
  const exécution: Exécution = {
    projectId,
    cibles: [...cibles],
    plan: [],
    courante: { step: cibles[0] ?? 'candidates', progress: 0 },
    dernièreÉcriture: 0,
    terminée: Promise.resolve(),
  }
  enCours.set(projectId, exécution)

  try {
    const db = options.db ?? getDb()
    const projet = getProject(db, projectId)
    if (projet === undefined) throw new ProjetInconnuError(projectId)

    const force =
      options.force === true
        ? [...cibles]
        : options.force === false || options.force === undefined
          ? []
          : [...options.force]

    const présence = await relevéPrésence(projet)
    exécution.plan = planPourCibles(cibles, présence, force)
    exécution.courante = { step: exécution.plan[0] ?? cibles[0] ?? 'candidates', progress: 0 }

    // **L'ingestion se décide avant, pas dans l'exécution.** Un projet dont les
    // artefacts sont déjà sur le disque mais dont la ligne en base est neuve —
    // une base effacée, un projet réinscrit — a un plan vide *et* une durée
    // inconnue. Sortir tout de suite le laissait à `0:00` pour toujours, et le
    // premier `run --force` échouait bien plus tard sur « le projet n'a pas de
    // durée ». Un `lstat` et un `ffprobe` sur la copie locale suffisent à le
    // réparer, et l'ingestion saute la copie si elle est déjà à la bonne taille.
    const doitIngérer = ingestionNécessaire(projet, exécution.plan)

    // Un plan vide n'est pas une exécution : tout est déjà là, il n'y a rien à
    // suivre et rien à verrouiller.
    if (exécution.plan.length === 0 && !doitIngérer) {
      enCours.delete(projectId)
      écrireStatut(projectId, {
        pid: process.pid,
        updatedAt: Date.now(),
        cibles: [...cibles],
        plan: [],
        running: null,
        error: null,
        finishedAt: Date.now(),
      })
      return { projectId, plan: [] }
    }

    publier(exécution, true)
    exécution.terminée = exécuter(exécution, projet, db, options, doitIngérer).finally(() => {
      enCours.delete(projectId)
    })
    // Le rejet est traité dans `exécuter` ; ce `catch` n'existe que pour qu'une
    // promesse dont personne n'attend le résultat ne coupe pas le processus.
    exécution.terminée.catch(() => {})

    return { projectId, plan: [...exécution.plan] }
  } catch (cause) {
    enCours.delete(projectId)
    throw cause
  }
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
function ingestionNécessaire(projet: Project, plan: readonly StepName[]): boolean {
  const besoinDeLaCopie = plan.includes('proxy') || plan.includes('audio')
  const copieLà = projet.stagedPath !== null && fs.existsSync(projet.stagedPath)
  return (besoinDeLaCopie && !copieLà) || projet.durationSec === null
}

async function exécuter(
  exécution: Exécution,
  projetInitial: Project,
  db: Database.Database,
  options: OptionsLancement,
  doitIngérer: boolean,
): Promise<void> {
  const étapes = { ...ÉTAPES, ...options.étapes }
  const { projectId } = exécution
  let projet = projetInitial

  const avancer = (fraction: number | null): void => {
    if (fraction === null) return
    exécution.courante.progress = Math.min(1, Math.max(0, fraction))
    publier(exécution, false)
  }

  try {
    if (doitIngérer) {
      // L'ingestion n'est pas une étape du graphe — la source est là ou le
      // projet n'existe pas —, elle n'a donc pas de nom à afficher. On garde
      // celui de la première étape à faire, dont la progression est bien à zéro
      // tant que la copie n'est pas finie.
      const ingestion = await étapes.ingest(projet.sourcePath, {
        db,
        onProgress: (a) => avancer(a.fraction),
      })
      const relu = getProject(db, projectId)
      if (relu !== undefined) projet = relu
      else projet = { ...projet, stagedPath: ingestion.stagedPath, durationSec: ingestion.durationSec }
    }

    for (const étape of exécution.plan) {
      exécution.courante = { step: étape, progress: 0 }
      publier(exécution, true)
      console.log(`[${projectId}] ${étape}…`)
      await exécuterÉtape(étape, projet, db, étapes, avancer)
    }

    écrireStatut(projectId, {
      pid: process.pid,
      updatedAt: Date.now(),
      cibles: exécution.cibles,
      plan: exécution.plan,
      running: null,
      error: null,
      finishedAt: Date.now(),
    })
    console.log(`[${projectId}] terminé : ${exécution.plan.join(' → ')}`)
  } catch (cause) {
    // **Le message complet au journal, sa version épurée dans le fichier.** Les
    // erreurs de `runFfmpeg`, `statAvecDélai` et `lancerWorker` portent la
    // commande entière, chemins absolus compris : c'est ce qu'il faut sous les
    // yeux pour diagnostiquer, et c'est ce qui n'a rien à faire dans un fichier
    // qu'on recopie dans un rapport ou qu'une route finirait par servir.
    console.error(`[${projectId}] échec sur ${exécution.courante.step} :`, cause)
    écrireStatut(projectId, {
      pid: process.pid,
      updatedAt: Date.now(),
      cibles: exécution.cibles,
      plan: exécution.plan,
      running: null,
      error: messageSûr(cause),
      finishedAt: Date.now(),
    })
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
async function exécuterÉtape(
  étape: StepName,
  projet: Project,
  db: Database.Database,
  étapes: Étapes,
  avancer: (fraction: number | null) => void,
): Promise<void> {
  switch (étape) {
    case 'proxy':
    case 'audio': {
      if (projet.stagedPath === null) {
        throw new Error(
          `Le projet ${projet.id} n'a pas de copie de travail : l'ingestion doit passer avant ${étape}.`,
        )
      }
      const commun = {
        projectId: projet.id,
        input: projet.stagedPath,
        durationSec: projet.durationSec,
        force: true,
        onProgress: (a: { fraction: number | null }) => avancer(a.fraction),
      }
      await (étape === 'proxy' ? étapes.buildProxy(commun) : étapes.extractAudio(commun))
      return
    }

    case 'transcript': {
      await étapes.transcribe({
        source: projet.sourcePath,
        projectId: projet.id,
        audio: audioPath(projet.id),
        force: true,
        onLog: (ligne) => {
          console.log(`[${projet.id}] worker | ${ligne}`)
          avancer(avancementWorker(ligne))
        },
      })
      // L'emplacement retenu disait « pas de transcript », et c'était vrai il y
      // a quarante minutes. Sans cet oubli, l'étape suivante consulterait une
      // absence que l'étape qui vient de finir a précisément levée.
      oublierSidecar(projet)
      return
    }

    case 'candidates': {
      await étapes.runCandidates(projet.id, { db })
      return
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

/** Ce que `POST /api/projects` vise : les candidats, **et** le proxy. */
export const CIBLES_INITIALES: StepName[] = ['candidates', 'proxy']

/**
 * Inscrit un projet et lance son analyse.
 *
 * **La ligne est écrite avant que la copie ne commence**, et c'est ce qui rend
 * la réponse 202 utile : sans elle, `GET /api/projects/:id` répondrait 404
 * pendant les cinq minutes de copie depuis le Drive, et l'interface n'aurait
 * rien à interroger. Les champs que l'ingestion relève — durée, taille, date —
 * arrivent ensuite ; `upsertProject` les met à jour sans toucher à `createdAt`.
 */
export async function créerProjet(
  source: string,
  options: OptionsLancement = {},
): Promise<{ projectId: string; plan: StepName[] }> {
  const sourcePath = resolveSource(source)
  const projectId = projectIdFromSource(source)
  const db = options.db ?? getDb()

  const existant = getProject(db, projectId)
  // Un identifiant, une source. Voir `CollisionDeProjetError`.
  if (existant !== undefined && existant.sourcePath !== sourcePath) {
    throw new CollisionDeProjetError(projectId, existant.sourcePath, sourcePath)
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

  return lancer(projectId, CIBLES_INITIALES, options)
}
