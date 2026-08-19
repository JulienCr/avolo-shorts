import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Database } from 'better-sqlite3'
import { getDb, getProject, upsertProject } from '@/server/db'
import { cheminTemporaire, StopRequestedError } from '@/server/ffmpeg'
import { probeDuration } from '@/server/ffprobe'
import { projectIdFromSource, resolveSource, stageDir, stagedPath } from '@/server/paths'

/**
 * L'ingestion : amener un replay du Drive partagé jusqu'à une copie locale
 * exploitable, et relever l'empreinte de la source (spec §12).
 *
 * **Tout ce fichier tourne autour d'une contrainte : `REPLAY_DIR` est un Google
 * Drive monté en 9p.** Il est lent — 40 Mo/s mesurés —, et il décroche de deux
 * façons que `/proc/mounts` ne distingue pas : absent au démarrage de la
 * machine, ou monté avec son transport mort dessous. Dans le second cas, le
 * dossier se liste encore et le moindre accès au contenu suspend l'appelant sans
 * limite de temps. D'où le délai de garde sur le `stat`, qui est la première
 * chose que fait cette étape.
 */

/**
 * L'empreinte d'une source : **taille, date de modification et durée ffprobe.
 * Pas de hash** (spec §5).
 *
 * Digérer 12 Go à chaque lancement coûterait plus cher que l'étape qu'on
 * cherche à éviter — et sur un montage à 40 Mo/s, il faudrait cinq minutes rien
 * que pour lire le fichier.
 *
 * En itération 0 elle est seulement **relevée** : le saut d'étape se décide sur
 * la présence du fichier (spec §4), et la comparaison des clés de validité vient
 * en itération 4. `durationSec` sert déjà, lui — `buildWindows` en a besoin.
 */
export type Empreinte = {
  sizeBytes: number
  /** Millisecondes depuis l'époque, comme `fs.Stats.mtimeMs` — voir `db.ts`. */
  mtimeMs: number
  durationSec: number | null
}

/**
 * Construit l'empreinte. Pure, et testée : c'est la forme qui compte, pas
 * l'appel système qui la remplit.
 *
 * `Math.trunc` sur `mtimeMs` : la colonne est un `INTEGER` SQLite, et une
 * fraction de milliseconde relue en réel ne serait plus égale à celle qu'on a
 * écrite. Les systèmes de fichiers ne s'accordent déjà pas sur la granularité —
 * 9p rend souvent la seconde entière —, on ne va pas y ajouter du flottant.
 */
export function empreinteSource(
  stat: Pick<fs.Stats, 'size' | 'mtimeMs'>,
  durationSec: number | null,
): Empreinte {
  return {
    sizeBytes: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
    durationSec,
  }
}

/** Ce qu'on décide devant une copie déjà présente. */
export type DécisionCopie = 'copier' | 'garder'

/**
 * Faut-il recopier la source ?
 *
 * **La taille seule tranche, et c'est délibéré.** Le saut d'étape s'applique
 * aussi ici (spec §4) : on parle de recopier jusqu'à 12 Go depuis un montage à
 * 40 Mo/s, soit cinq minutes qu'on ne paie pas deux fois. Comparer les dates
 * ferait recopier à chaque fois que le Drive resynchronise un fichier qu'il n'a
 * pas modifié ; comparer le contenu coûterait plus cher que la copie.
 *
 * Une copie interrompue ne trompe pas ce contrôle : la copie s'écrit sous un nom
 * temporaire et n'est renommée qu'une fois complète, donc une taille égale veut
 * bien dire une copie entière.
 */
export function décisionCopie(o: {
  source: { sizeBytes: number }
  copie: { sizeBytes: number } | null
  force?: boolean
}): DécisionCopie {
  if (o.force === true) return 'copier'
  if (o.copie === null) return 'copier'
  return o.copie.sizeBytes === o.source.sizeBytes ? 'garder' : 'copier'
}

/**
 * `stat`, mais qui renonce.
 *
 * `fs.stat` n'est pas annulable : sur un montage 9p dont le transport est mort,
 * l'appel part dans le vivier de fils de libuv et n'en revient jamais. On ne peut
 * donc pas *interrompre* le sondage — seulement cesser de l'attendre, ce qui
 * suffit à transformer un blocage indéfini en une erreur qui se lit.
 *
 * La contrepartie, assumée : le fil reste consommé. Le vivier en compte quatre
 * par défaut, donc quatre montages morts sondés coup sur coup gèleraient tout ce
 * qui touche au disque. En itération 0 il y a un `stat` par ingestion, et le
 * message dit quoi faire ; le jour où un veilleur balaiera le dossier de replays
 * (itération 4), il faudra un sondage qui ne consomme pas de fil. La requête
 * abandonnée maintient par ailleurs la boucle d'événements en vie : les scripts
 * de `scripts/` sortent donc par `quitter()`, qui ne s'en remet pas au seul
 * `process.exitCode`. (relevé par Copilot)
 *
 * **Le message porte le chemin complet.** Comme ceux de `runFfmpeg`, il est
 * destiné à un journal de serveur : une route qui le renverrait tel quel
 * exposerait l'arborescence de la machine. (relevé par Aristarque)
 */
export async function statAvecDélai(chemin: string, timeoutMs: number): Promise<fs.Stats> {
  return attendreOuRenoncer(
    // `lstat` et non `stat`, et c'est ce qui ferme la porte des liens
    // symboliques. `resolveSource` valide la **forme** du chemin avec
    // `path.resolve`, qui ne suit pas les liens : un `REPLAY_DIR/emission.mp4`
    // pointant sur `/etc/shadow` passerait son contrôle de dossier parent, et
    // `stat` — qui suit les liens — le déclarerait fichier. Le contenu de la
    // cible partirait alors dans `stage/`, puis dans un proxy consultable.
    // `lstat` décrit le lien lui-même, donc `isFile()` est faux et l'ingestion
    // s'arrête. Le montage 9p du Drive ne porte de toute façon pas de liens.
    // (relevé par Aristarque)
    fsp.lstat(chemin),
    timeoutMs,
    `Le dossier des replays ne répond pas (${timeoutMs} ms sur ${JSON.stringify(chemin)}). ` +
      'REPLAY_DIR est monté en 9p : il peut être absent, ou monté avec son transport mort ' +
      "dessous — /proc/mounts ne les distingue pas. Rouvrir l'explorateur Windows sur le " +
      'lecteur, ou remonter le partage.',
  )
}

/** Délai par défaut des gardes sur le Drive. Généreux : il est lent, pas mort. */
export const DÉLAI_STAT_MS = 20_000

/**
 * Le montage **répond-il** ? Pas « le fichier existe-t-il » : `false` veut dire
 * qu'aucune réponse n'est venue dans le temps imparti, et rien d'autre. Une
 * erreur en est une, de réponse — un `ENOENT` immédiat prouve que le système de
 * fichiers est vivant.
 *
 * C'est la distinction qui compte pour un montage 9p : **absent**, il répond
 * `ENOENT` en une microseconde et tout ce qui suit se déroule normalement ;
 * **monté avec son transport mort**, il ne répond rien du tout et gèle
 * l'appelant. `/proc/mounts` ne les distingue pas, cette fonction si.
 *
 * Elle existe pour être appelée **avant du synchrone**. `fs.existsSync` sur un
 * montage mort ne bloque pas un fil du vivier comme le fait `fsp.stat` : il
 * gèle la boucle d'événements entière, donc tout le serveur. `placeSidecar` en
 * fait plusieurs, et c'est ce qui rend ce sondage nécessaire côté transcription.
 * (relevé par Copilot et Aristarque)
 */
export async function montageRépond(chemin: string, timeoutMs = DÉLAI_STAT_MS): Promise<boolean> {
  try {
    await attendreOuRenoncer(
      fsp.stat(chemin).then(
        () => true,
        () => true,
      ),
      timeoutMs,
      'muet',
    )
    return true
  } catch {
    return false
  }
}

/**
 * Attend une promesse, ou renonce et explique.
 *
 * Extrait de `statAvecDélai` pour une raison de test : un `stat` sur un fichier
 * local revient trop vite pour qu'on puisse en observer le délai de garde de
 * façon reproductible, alors qu'une promesse qui ne se règle jamais reproduit
 * exactement le montage mort.
 *
 * **Renoncer n'est pas annuler.** Le travail continue derrière — c'est le prix
 * d'un appel système non interruptible —, mais l'appelant, lui, repart.
 */
export async function attendreOuRenoncer<T>(
  travail: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let minuterie: NodeJS.Timeout | undefined
  const garde = new Promise<never>((_, reject) => {
    minuterie = setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  // Le perdant de la course garde une promesse en vol : sans ce `catch`, un
  // `stat` qui échoue *après* le délai remonterait en rejet non traité et
  // couperait le processus.
  travail.catch(() => {})

  try {
    return await Promise.race([travail, garde])
  } finally {
    clearTimeout(minuterie)
  }
}

/**
 * Copie en flux, avec avancement, vers un nom temporaire renommé à la fin.
 *
 * Le temporaire n'est pas une précaution de style : une copie interrompue à
 * 11 Go sur 12 laisserait, sous le nom définitif, un fichier que `décisionCopie`
 * comparerait par sa taille — et qui, au premier octet près, pourrait passer.
 * Le renommage est atomique à l'intérieur d'un même système de fichiers, et
 * `stage/` en est un.
 */
async function copier(
  src: string,
  dst: string,
  total: number,
  onProgress?: (a: AvancementCopie) => void,
  signal?: AbortSignal,
): Promise<void> {
  await fsp.mkdir(path.dirname(dst), { recursive: true })
  const temporaire = cheminTemporaire(dst)

  let fait = 0
  const compteur = new Transform({
    transform(morceau: Buffer, _codage, suite) {
      fait += morceau.length
      onProgress?.({ done: fait, total, fraction: total > 0 ? Math.min(1, fait / total) : null })
      suite(null, morceau)
    },
  })

  try {
    // **Le seul endroit du dépôt où renoncer *est* annuler.** Ailleurs on cesse
    // d'attendre un appel système qui continue derrière ; ici `pipeline` ferme
    // les deux flux et rend la main pour de bon. C'est ce qui permet d'arrêter
    // une analyse pendant les cinq minutes de copie depuis le Drive.
    await pipeline(fs.createReadStream(src), compteur, fs.createWriteStream(temporaire), { signal })
    vérifierTailleCopiée(fait, total, src)
    await fsp.rename(temporaire, dst)
  } catch (cause) {
    // Ne pas laisser un moignon derrière soi : il ne serait ramassé par
    // personne, et `stage/` porte des fichiers de plusieurs gigaoctets.
    await fsp.rm(temporaire, { force: true }).catch(() => {})
    // Un arrêt demandé n'est pas un échec de la copie : `pipeline` rejette avec
    // une `AbortError` dont le message ne dit rien à personne.
    if (signal?.aborted === true) throw new StopRequestedError(`copie de ${path.basename(src)}`)
    throw cause
  }
}

/**
 * Les copies en cours, par destination. **Dans ce processus, et pas au-delà.**
 *
 * Deux traitements du même processus qui demandent la même source ne la copient
 * pas deux fois. Le cas n'est pas théorique : `enCours` (`src/server/run.ts`)
 * interdit deux exécutions du même projet, mais rien n'interdit deux **exports**
 * simultanés sur des clips de la même émission, et chacun réclame la copie par
 * `ensureLocalCopy`. Sur une source de 12 Go, c'est la différence entre attendre
 * une copie et en lancer deux.
 *
 * L'exemple que ce commentaire donnait — `show.mp4` et `show.mov` visant la même
 * destination — était faux : `stagedPath` conserve l'extension, donc les deux
 * destinations diffèrent, et `créerProjet` refuse de toute façon de leur donner
 * le même identifiant. (relevé par Copilot)
 *
 * **La portée est celle d'une `Map` de module, et il faut la lire comme telle.**
 * Un `dev-ingest` lancé à côté du serveur a la sienne : les deux copies
 * repartent, et elles se disputent la bande passante d'un montage à 97 Mo/s.
 * Ce qui les empêche de se corrompre l'une l'autre n'est pas ce verrou mais
 * `cheminTemporaire`, dont le jeton porte le `pid` : chaque processus écrit son
 * propre fichier, et le renommage final est atomique — le dernier arrivé gagne,
 * les deux candidats sont entiers. Un verrou inter-processus achèterait la bande
 * passante et coûterait la gestion d'un verrou périmé qu'un processus tué laisse
 * derrière lui ; sur un cache qui peut disparaître sans conséquence, l'échange
 * n'est pas bon. (relevé par Codex)
 *
 * La clé est la **destination**, pas la source : c'est elle qui est écrite, et
 * elle dérive de toute façon du nom du fichier d'origine.
 */
const copiesInFlight = new Map<string, Promise<void>>()

/**
 * Copie, ou attend celle qui est déjà partie vers la même destination. Rend
 * `true` quand c'est **cet appel** qui a écrit.
 *
 * **Le second appelant ne recopie pas derrière le premier** quand celui-ci
 * réussit : les deux visent le même contenu — la destination dérive du nom de la
 * source —, donc attendre suffit.
 *
 * **Mais l'échec du premier n'est pas l'échec du second, et surtout pas son
 * arrêt.** Une version antérieure laissait remonter tel quel le rejet de la
 * copie voisine : quand celle-ci était coupée par l'arrêt d'un *autre* projet,
 * le second recevait `StopRequestedError` alors que son propre signal n'avait
 * rien reçu, et `exécuter` — qui décide sur son signal à lui, à raison —
 * l'écrivait dans `status.json` comme une panne. L'écran affichait donc « Arrêt
 * demandé — copie de … » en bandeau d'échec à quelqu'un qui n'avait rien
 * demandé. On tente donc la sienne. (relevé par Aristarque)
 */
async function copyOnce(
  src: string,
  dst: string,
  total: number,
  onProgress?: (a: AvancementCopie) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  // **Deux tours au plus.** Le premier attend la copie déjà partie ; le second
  // couvre le cas où une troisième est repartie pendant cette attente. Sans
  // borne, deux appelants qui échouent l'un après l'autre boucleraient.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const inFlight = copiesInFlight.get(dst)
    if (inFlight === undefined) break
    // **L'attente court contre notre propre signal.** Sans cela, un projet
    // arrêté pendant qu'un autre copie la même source restait dans `enCours`
    // jusqu'à la fin de cette copie — plusieurs minutes sur 12 Go — avant de
    // seulement constater son arrêt. C'est le même défaut que l'attente entre
    // deux tentatives de Gemini, sur un autre chemin. (relevé par Copilot)
    //
    // Le sort de la copie voisine, jamais son erreur : ce qui nous intéresse est
    // « y a-t-il une copie exploitable au bout », pas pourquoi la sienne a raté.
    const done = await raceAgainstAbort(
      inFlight.then(
        () => true,
        () => false,
      ),
      signal,
    )
    if (done === true) return false
    // Notre arrêt à nous, en revanche, se dit tel quel.
    if (signal?.aborted === true) throw new StopRequestedError(`copie de ${path.basename(src)}`)
  }

  const work = copier(src, dst, total, onProgress, signal)
  copiesInFlight.set(dst, work)
  try {
    await work
    return true
  } finally {
    copiesInFlight.delete(dst)
  }
}

/**
 * La copie de travail du projet, **reconstituée si elle manque**.
 *
 * **C'est la propriété que le cache doit tenir et que le code ne tenait pas** :
 * « le cache n'est jamais une source de vérité et peut être supprimé sans
 * conséquence fonctionnelle » (retour d'usage §5). Le rendu constatait l'absence
 * et levait, en prescrivant une réingestion que rien dans l'application ne
 * savait déclencher — `CIBLES_LANÇABLES` n'expose pas l'ingestion, et
 * `ingestionNécessaire` ne recopie que si le proxy ou l'audio sont au plan, donc
 * un projet dont tous les artefacts existent planifie `[]` et ne recopie rien.
 * Le seul remède était `scripts/dev-ingest.ts` dans un terminal, ce qui
 * contredit le critère de réussite de la conception : *sans avoir tapé un chemin
 * ni ouvert un terminal*. (issue #76)
 *
 * **Et le TTL de huit heures transformait cet accident en impasse
 * systématique** : passé ce délai, toute émission y tombait, par construction.
 * Un TTL sans réparation est exactement la panne qui n'échoue pas au bon
 * endroit.
 *
 * Trois choses qu'elle ne fait pas, et chacune ferme un mode d'échec :
 *
 * - **elle ne promet rien avant d'avoir sondé le montage.** `REPLAY_DIR` est en
 *   9p et décroche de deux façons que `/proc/mounts` ne distingue pas ; sans ce
 *   sondage sous délai de garde, l'appelant attendrait indéfiniment au lieu de
 *   recevoir un message qui dit quoi faire ;
 * - **elle ne recopie pas deux fois.** Elle passe par `ingest`, donc par
 *   `copyOnce` : deux exports lancés coup sur coup sur des clips de la même
 *   émission attendent la même copie de 12 Go au lieu d'en lancer deux ;
 * - **elle ne se tait pas.** Une recopie va de 45 secondes à plus de deux
 *   minutes selon la taille, et `POST /api/clips/:id/export` est synchrone :
 *   l'écran est muet pendant tout ce temps. On n'invente pas de canal de
 *   progression — ce serait une autre livraison — mais le journal du serveur dit
 *   ce qui se passe et à quelle vitesse.
 */
export async function ensureLocalCopy(
  project: { id: string; sourcePath: string; stagedPath: string | null },
  options: { db?: Database | null; signal?: AbortSignal } = {},
): Promise<string> {
  const destination = project.stagedPath ?? stagedPath(project.sourcePath)
  // Le cas courant, et il ne coûte qu'un appel local : `stage/` est sur le
  // disque de la machine, jamais sur le montage.
  if (fs.existsSync(destination)) return destination

  if (!(await montageRépond(project.sourcePath))) {
    throw new Error(
      `La copie de travail de ${project.id} est absente et le dossier des replays ne répond pas : ` +
        'impossible de la reconstituer. REPLAY_DIR est monté en 9p et peut être monté avec son ' +
        "transport mort dessous — /proc/mounts ne le distingue pas. Rouvrir le lecteur côté " +
        'Windows, ou remonter le partage.',
    )
  }

  console.log(`[${project.id}] copie de travail absente, reconstitution depuis le Drive…`)
  const start = Date.now()
  let milestone = 0
  let lastLog = start
  const ingestion = await ingérerOuExpliquer(project, {
    db: options.db,
    signal: options.signal,
    onProgress: (a: AvancementCopie) => {
      if (a.fraction === null) return
      // **Deux conditions, et il faut les deux.** Un palier tous les dix pour
      // cent suffirait sur une copie de deux minutes ; sur un fichier local
      // recopié en une seconde — ce que font les tests et un `stage/` déjà
      // chaud — il produit dix lignes qui n'apprennent rien. La seconde borne
      // les espace d'au moins deux secondes, donc le journal ne parle que
      // quand l'attente est réelle.
      const reached = Math.floor(a.fraction * 10)
      const now = Date.now()
      if (reached <= milestone || now - lastLog < 2_000) return
      milestone = reached
      lastLog = now
      console.log(
        `[${project.id}] copie ${reached * 10} % (${enOctets(a.done)} sur ${enOctets(a.total)})`,
      )
    },
  })
  const seconds = (Date.now() - start) / 1000
  console.log(
    `[${project.id}] copie de travail reconstituée en ${seconds.toFixed(0)} s ` +
      `(${(ingestion.sizeBytes / 1e6 / Math.max(seconds, 0.001)).toFixed(0)} Mo/s).`,
  )
  return ingestion.stagedPath
}

/**
 * Une taille lisible : des gigaoctets au-delà du gigaoctet, des mégaoctets en
 * dessous. Un replay pèse 4 à 13 Go et un fichier de test quelques mégaoctets ;
 * une seule unité rendait l'un des deux illisible — « 0.0 Go sur 0.0 ».
 */
function enOctets(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} Go` : `${Math.round(bytes / 1e6)} Mo`
}

/**
 * `ingest`, avec un message qui dit quoi faire quand elle échoue.
 *
 * **Le dernier recours reste**, et c'est tout ce qu'il devait être. Les messages
 * de l'ingestion nomment le fichier qui manque et non ce qu'on essayait de
 * faire : à ce point du rendu, ce qu'on veut lire est « la copie n'a pas pu être
 * reconstituée », pas un `ENOENT` nu. L'erreur d'origine reste attachée en
 * `cause` pour le journal du serveur, et seul le nom de base traverse — le
 * chemin complet porte l'arborescence du Drive.
 */
async function ingérerOuExpliquer(
  project: { id: string; sourcePath: string },
  options: OptionsIngestion,
): Promise<Ingestion> {
  try {
    return await ingest(project.sourcePath, options)
  } catch (cause) {
    if (cause instanceof StopRequestedError) throw cause
    throw new Error(
      `La copie de travail de ${project.id} est absente et n'a pas pu être reconstituée depuis ` +
        `${JSON.stringify(path.basename(project.sourcePath))}. L'original est-il toujours dans le ` +
        'dossier des replays ?',
      { cause },
    )
  }
}

/**
 * Les copies de travail qu'un traitement **tient ouvertes**, et le nombre de
 * traitements qui les tiennent.
 *
 * `copiesInFlight` ne protège qu'une copie **en train de s'écrire**. Un export
 * qui vient de la faire reconstituer, lui, la lit pendant l'encodage — de dix
 * secondes à une minute — sans plus rien qui la signale : le balayage de
 * démarrage ou celui d'une autre exécution pouvait donc l'effacer entre le
 * retour d'`ensureLocalCopy` et l'ouverture du fichier par ffmpeg. `copiesInUse`
 * (`src/server/run.ts`) ne connaît que les analyses, pas les exports.
 *
 * Un compteur et non un ensemble : deux exports simultanés sur des clips de la
 * même émission tiennent la même copie, et le premier à finir ne doit pas la
 * libérer sous le second. (relevé par Copilot)
 */
const leases = new Map<string, number>()

/**
 * Tient une copie de travail le temps d'un traitement. Rend la fonction qui la
 * relâche, **à appeler dans un `finally`**.
 *
 * Le relâchement est idempotent : appelé deux fois, il ne décompte qu'une.
 */
export function holdStagedCopy(filePath: string): () => void {
  leases.set(filePath, (leases.get(filePath) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (leases.get(filePath) ?? 1) - 1
    if (remaining <= 0) leases.delete(filePath)
    else leases.set(filePath, remaining)
  }
}

/**
 * Attend un travail, ou l'abandon du signal — le premier des deux.
 *
 * Rend `undefined` quand c'est l'arrêt qui a gagné. **L'écouteur est retiré dans
 * tous les cas** : sans ce retrait, chaque appelant qui attend une copie voisine
 * laisse un écouteur de plus sur le signal de son exécution, qui vit aussi
 * longtemps qu'elle.
 */
async function raceAgainstAbort<T>(travail: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (signal === undefined) return travail
  if (signal.aborted) return undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      travail,
      new Promise<undefined>((resolve) => {
        onAbort = () => resolve(undefined)
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Combien de temps une copie de travail reste valable : **huit heures**.
 *
 * C'est le TTL demandé par le §5 du retour d'usage, et il faut le lire avec la
 * phrase qui le suit : *le cache n'est jamais une source de vérité et peut être
 * supprimé sans conséquence fonctionnelle*. Une copie effacée coûte une recopie
 * — 45 secondes pour 4,3 Go —, jamais un artefact ni une décision. `stage/` porte
 * plusieurs gigaoctets par émission ; sans borne, il grossit jusqu'au disque.
 */
export const STAGE_TTL_MS = 8 * 60 * 60 * 1000

/**
 * Retire de `stage/` les copies plus vieilles que le TTL. **Best effort.**
 *
 * Appelée au démarrage du serveur (`src/instrumentation.ts`) et après chaque
 * exécution. Elle n'échoue jamais : un dossier absent, un fichier verrouillé ou
 * une permission refusée valent zéro fichier retiré, pas une panne au démarrage.
 *
 * Trois protections, et chacune ferme un cas réel :
 *
 * - **les copies en vol sont épargnées** par `copiesInFlight`, et leur temporaire
 *   l'est par sa date de modification, qui avance à chaque bloc écrit ;
 * - **celles qu'un traitement tient ouvertes** le sont par `leases` : un export
 *   lit sa copie pendant tout l'encodage sans rien qui l'écrive ;
 * - **`keep` épargne ce qu'une exécution est en train de lire.** Effacer sous
 *   un ffmpeg ne le casse pas — le descripteur ouvert survit à l'`unlink` sous
 *   Linux — mais l'étape suivante repaierait la copie ;
 * - **rien hors de `stage/`.** Les noms viennent d'un `readdir` du dossier et
 *   sont rejoints dessus, les sous-dossiers et les liens sont ignorés.
 *
 * **`keep` est une fonction, et pas une liste, parce que le balayage dure.**
 * Prise en instantané au départ, elle ignorait une exécution démarrée pendant la
 * boucle : ce projet-là ne recopie rien — `ingestionNécessaire` vient de
 * constater que sa copie est là —, `copiesInFlight` ne le connaît donc pas, et le
 * balayage l'effaçait sous ses pieds. L'étape suivante échouait sur une entrée
 * manquante. Réévaluée à chaque fichier, la liste voit les exécutions arrivées
 * entre-temps. Elle rend `null` quand on n'a pas pu savoir : on épargne alors
 * plutôt que d'effacer à l'aveugle. (relevé par Codex)
 *
 * **Et le dernier contrôle est collé à l'effacement, sans point d'attente entre
 * les deux.** Relire `keep` avant le `lstat` ne suffisait pas : l'`await` qui
 * les sépare rend la main, et une exécution démarrée là constatait sa copie
 * présente puis la perdait avant d'ouvrir le fichier. Le contrôle final et le
 * `rmSync` sont synchrones et consécutifs — le fil unique de Node interdit alors
 * qu'un `lancer` s'intercale, exactement comme il tient la réservation
 * d'`enCours`. C'est aussi pourquoi l'effacement est synchrone : ce n'est qu'un
 * `unlink`, une opération de métadonnées, et rien n'y est copié.
 * (relevé par Copilot)
 */
export async function cleanStage(
  options: {
    ttlMs?: number
    now?: number
    keep?: () => Iterable<string> | null
  } = {},
): Promise<string[]> {
  const dir = stageDir()
  const cutoff = (options.now ?? Date.now()) - (options.ttlMs ?? STAGE_TTL_MS)

  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    // Pas encore de dossier de travail : il n'y a rien à nettoyer.
    return []
  }

  /**
   * Ce fichier est-il à épargner ? **Synchrone**, et c'est ce qui compte :
   * appelée juste avant le `rmSync`, elle ne laisse aucun point d'attente où un
   * `lancer` pourrait s'intercaler.
   *
   * `null` veut dire « on n'a pas pu savoir », donc « on épargne » : c'est le
   * cas d'une base refermée par l'arrêt du serveur pendant le balayage.
   */
  const isSpared = (candidate: string): boolean => {
    if (copiesInFlight.has(candidate) || leases.has(candidate)) return true
    const kept = options.keep?.()
    if (kept === null) return true
    return kept !== undefined && new Set(kept).has(candidate)
  }

  const removed: string[] = []
  for (const name of names) {
    const filePath = path.join(dir, name)
    // **`isSpared` est appelé dans le `try`**, et pas au-dessus : `keep` est du
    // code de l'appelant, et une exception qui en sortirait ferait rejeter un
    // nettoyage dont ce commentaire annonce plus haut qu'il n'échoue jamais.
    try {
      // Un premier contrôle avant le `lstat`, pour ne pas sonder inutilement.
      if (isSpared(filePath)) continue
      // `lstat` : un lien symbolique n'est pas une copie de travail, et le
      // suivre ferait effacer ce qu'il désigne.
      const stat = await fsp.lstat(filePath)
      if (!stat.isFile() || stat.mtimeMs > cutoff) continue
      // Le second, collé à l'effacement. Rien entre les deux : pas d'`await`,
      // pas d'appel qui pourrait en cacher un.
      if (isSpared(filePath)) continue
      fs.rmSync(filePath, { force: true })
      removed.push(name)
    } catch {
      // Un fichier disparu entre le `readdir` et le `lstat`, une permission
      // refusée : on passe au suivant. Le nettoyage est une hygiène, pas une
      // étape du pipeline.
    }
  }
  if (removed.length > 0) {
    console.log(`stage/ : ${removed.length} copie(s) périmée(s) retirée(s) — ${removed.join(', ')}`)
  }
  return removed
}

/**
 * La copie fait-elle bien la taille annoncée ?
 *
 * **Une fin de fichier propre n'est pas une preuve de complétude.** Si la source
 * rétrécit pendant la copie — le Drive resynchronise, quelqu'un remplace le
 * fichier —, `pipeline` s'achève sans erreur sur un fichier plus court, et le
 * renommage le rend définitif. `décisionCopie` ne s'en rendrait pas compte tout
 * de suite, mais tout ce qui suit — le proxy, l'audio, le transcript — serait
 * construit sur une émission tronquée, sans un mot. L'invariant que le
 * temporaire est censé garantir est « ce nom désigne une copie entière » : il
 * faut donc le vérifier, pas seulement l'espérer. (relevé par Copilot)
 *
 * Pure, et séparée pour être testée sans copier quatre gigaoctets.
 */
export function vérifierTailleCopiée(copié: number, attendu: number, source: string): void {
  if (copié === attendu) return
  throw new Error(
    `La copie de ${JSON.stringify(source)} fait ${copié} octets au lieu de ${attendu} : ` +
      'la source a changé de taille pendant la copie. Le fichier temporaire est effacé, ' +
      'rien de tronqué ne prend le nom définitif. Relancer.',
  )
}

/** L'avancement d'une copie, en octets. */
export type AvancementCopie = { done: number; total: number; fraction: number | null }

export type OptionsIngestion = {
  /** Recopier même si une copie de la bonne taille est déjà là. */
  force?: boolean
  /** Délai de garde du `stat` sur le Drive. */
  statTimeoutMs?: number
  onProgress?: (avancement: AvancementCopie) => void
  /** La base à renseigner. `null` pour n'en renseigner aucune (tests). */
  db?: Database | null
  /**
   * L'arrêt demandé (`POST /api/projects/:id/stop`).
   *
   * Il coupe la copie, qui est la seule chose longue de cette étape — et la
   * seule du dépôt qui s'annule vraiment, `pipeline` fermant les deux flux. Le
   * `stat` du Drive au-dessus, lui, n'est pas interruptible : il est borné par
   * son propre délai de garde de vingt secondes.
   */
  signal?: AbortSignal
}

/** Ce que l'ingestion rend, et ce que les étapes suivantes consomment. */
export type Ingestion = {
  projectId: string
  /** L'original sur `REPLAY_DIR`. Jamais modifié. */
  sourcePath: string
  /** La copie de travail. C'est **elle** que ffmpeg lit ensuite. */
  stagedPath: string
  /**
   * Vrai quand **cet appel** a écrit la copie.
   *
   * Faux dans deux cas, et ils veulent dire la même chose pour l'appelant — il
   * n'a rien payé : la copie était déjà là à la bonne taille, ou un autre appel
   * la faisait déjà et celui-ci l'a attendue (voir `copyOnce`).
   */
  copied: boolean
} & Empreinte

/**
 * Ingère un replay : contrôle le montage, copie en local, relève l'empreinte,
 * inscrit le projet.
 *
 * **La copie garde le nom du fichier d'origine** (spec §12). Le titre du projet
 * en dérive, et un nom haché renommerait toute la bibliothèque en charabia. La
 * validation de forme du chemin appartient à `resolveSource` — un fichier posé
 * directement dans `REPLAY_DIR`, ni au-dessus ni dans un sous-dossier —, mais
 * elle ne dit rien de l'existence ni du type : c'est ici que ça se vérifie.
 */
export async function ingest(source: string, options: OptionsIngestion = {}): Promise<Ingestion> {
  const sourcePath = resolveSource(source)
  const projectId = projectIdFromSource(source)
  const destination = stagedPath(source)

  const stat = await statAvecDélai(sourcePath, options.statTimeoutMs ?? DÉLAI_STAT_MS)
  // `statAvecDélai` fait un `lstat` : un lien symbolique n'est donc pas un
  // fichier, et il est refusé ici même s'il pointe sur une vraie vidéo. C'est
  // volontaire — voir le commentaire de `statAvecDélai`.
  if (!stat.isFile()) {
    throw new Error(
      `${JSON.stringify(source)} n'est pas un fichier ordinaire. Un replay est un fichier posé ` +
        'directement dans REPLAY_DIR — ni un dossier, ni un lien symbolique.',
    )
  }

  // La copie, si elle existe : son absence est le cas courant, pas une erreur.
  let copieStat: fs.Stats | null = null
  try {
    copieStat = await fsp.stat(destination)
  } catch {
    copieStat = null
  }

  const décision = décisionCopie({
    source: { sizeBytes: stat.size },
    copie: copieStat === null ? null : { sizeBytes: copieStat.size },
    force: options.force,
  })

  const copied =
    décision === 'copier' &&
    (await copyOnce(sourcePath, destination, stat.size, options.onProgress, options.signal))

  // Sonder la **copie locale**, pas l'original : c'est le même contenu, et
  // ffprobe lit quelques mégaoctets d'en-tête que le 9p ferait payer.
  const empreinte = empreinteSource(stat, await probeDuration(destination, undefined, options.signal))

  const ingestion: Ingestion = {
    projectId,
    sourcePath,
    stagedPath: destination,
    copied,
    ...empreinte,
  }

  const db = options.db === undefined ? getDb() : options.db
  if (db !== null) {
    upsertProject(db, {
      ...empreinte,
      id: projectId,
      sourcePath,
      stagedPath: destination,
      // `createdAt` ne bouge pas d'une réingestion à l'autre : c'est la date
      // d'entrée du projet dans la bibliothèque, et l'interface trie dessus.
      createdAt: getProject(db, projectId)?.createdAt ?? Date.now(),
    })
  }

  return ingestion
}
