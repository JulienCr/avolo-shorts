import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Database } from 'better-sqlite3'
import { getDb, getProject, upsertProject } from '@/server/db'
import { cheminTemporaire } from '@/server/ffmpeg'
import { probeDuration } from '@/server/ffprobe'
import { projectIdFromSource, resolveSource, stagedPath } from '@/server/paths'

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
 * (itération 4), il faudra un sondage qui ne consomme pas de fil.
 */
export async function statAvecDélai(chemin: string, timeoutMs: number): Promise<fs.Stats> {
  return attendreOuRenoncer(
    fsp.stat(chemin),
    timeoutMs,
    `Le dossier des replays ne répond pas (${timeoutMs} ms sur ${JSON.stringify(chemin)}). ` +
      'REPLAY_DIR est monté en 9p : il peut être absent, ou monté avec son transport mort ' +
      "dessous — /proc/mounts ne les distingue pas. Rouvrir l'explorateur Windows sur le " +
      'lecteur, ou remonter le partage.',
  )
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
    await pipeline(fs.createReadStream(src), compteur, fs.createWriteStream(temporaire))
    await fsp.rename(temporaire, dst)
  } catch (cause) {
    // Ne pas laisser un moignon derrière soi : il ne serait ramassé par
    // personne, et `stage/` porte des fichiers de plusieurs gigaoctets.
    await fsp.rm(temporaire, { force: true }).catch(() => {})
    throw cause
  }
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
}

/** Ce que l'ingestion rend, et ce que les étapes suivantes consomment. */
export type Ingestion = {
  projectId: string
  /** L'original sur `REPLAY_DIR`. Jamais modifié. */
  sourcePath: string
  /** La copie de travail. C'est **elle** que ffmpeg lit ensuite. */
  stagedPath: string
  /** Vrai si la copie vient d'être faite, faux si elle était déjà là. */
  copied: boolean
} & Empreinte

/** Délai par défaut du `stat` de garde. Généreux : le Drive est lent, pas mort. */
const DÉLAI_STAT_MS = 20_000

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
  if (!stat.isFile()) {
    throw new Error(
      `${JSON.stringify(source)} n'est pas un fichier. Un replay est un fichier posé dans REPLAY_DIR.`,
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

  if (décision === 'copier') {
    await copier(sourcePath, destination, stat.size, options.onProgress)
  }

  // Sonder la **copie locale**, pas l'original : c'est le même contenu, et
  // ffprobe lit quelques mégaoctets d'en-tête que le 9p ferait payer.
  const empreinte = empreinteSource(stat, await probeDuration(destination))

  const ingestion: Ingestion = {
    projectId,
    sourcePath,
    stagedPath: destination,
    copied: décision === 'copier',
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
