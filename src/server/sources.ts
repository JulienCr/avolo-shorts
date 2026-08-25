import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type Database from 'better-sqlite3'

import type { CauseUnavailable, Source, SourcesListing } from '@/lib/api'
import { getDb, listProjects } from '@/server/db'
import { isAAbsence } from '@/server/bytes'
import { replayDir, resolveSource } from '@/server/paths'
import { waitOrAbandon, DELAY_STAT_MS } from '@/server/steps/ingest'
import { urlVignetteSource } from '@/server/source-thumbnails'

/**
 * Le catalogue des replays : **l'entrée du parcours** (spec §13, tâche 15).
 *
 * Tout ce fichier tourne autour du même fait que l'ingestion : `REPLAY_DIR` est
 * un Google Drive monté en 9p, et il décroche de **deux façons que
 * `/proc/mounts` ne distingue pas** — absent au démarrage de la machine, ou
 * monté avec son transport mort dessous. Dans le second cas, le dossier se liste
 * encore et le moindre accès au contenu suspend l'appelant sans limite de temps.
 *
 * Trois conséquences, et aucune n'est une précaution de style.
 *
 * 1. **`available` s'éprouve par un accès réel**, jamais par les bits de
 *    permission — le montage annonce `drwxrwxrwx` sans que cela prouve rien — ni
 *    par la présence d'une ligne dans `/proc/mounts`, qui reste là quand le
 *    transport est mort.
 * 2. **L'accès porte un délai de garde.** Un `readdir` qui pend indéfiniment est
 *    le mode d'échec à fermer : il ne rend jamais la main, et la page de
 *    bibliothèque tourne pour toujours.
 * 3. **Une seule sonde en vol à la fois, et des `lstat` en série.** Renoncer
 *    n'est pas annuler : l'appel système continue d'occuper un fil du vivier de
 *    libuv, qui en compte quatre. Vingt et un `lstat` lancés ensemble sur un
 *    montage mort les prennent tous les quatre et figent *tout* ce qui touche au
 *    disque dans le serveur, analyse en cours comprise. Un montage mort coûte
 *    ici **un** fil, une fois.
 * 4. **L'échec porte sa cause, et l'écran la nomme au lieu de l'énumérer.**
 *    C'était le reste de la vague d'interface (issue #56, point 5) : ces quatre
 *    causes rendaient un seul `disponible: false`, si bien que la ligne de
 *    montage devait citer les trois gestes possibles. Deux cas mesurés le
 *    rendaient franchement trompeur — un `REPLAY_DIR` mal orthographié **sous un
 *    partage 9p sain** annonçait `fstype: '9p'` avec la lecture en échec, et un
 *    seul fichier aux droits refusés faisait basculer tout le dossier. Ils sont
 *    désormais nommés, `missing` et `denied`, et le geste utile suit du nom.
 */

/**
 * Les extensions qu'on propose comme replays.
 *
 * **L'ingestion, elle, n'en a pas.** `ingest` accepte n'importe quel fichier
 * ordinaire posé dans `REPLAY_DIR` : c'est ffprobe qui tranche, plus tard, et
 * c'est le bon endroit pour trancher. Cette liste ne restreint donc pas ce que
 * l'outil sait ingérer — elle décide seulement ce qu'on **propose** dans une
 * grille de cartes, pour ne pas y faire figurer un `notes.txt` ou un
 * `desktop.ini` comme s'ils étaient des émissions. Un fichier qui n'y figure pas
 * reste ingérable en le nommant à `POST /api/projects`.
 *
 * Les conteneurs d'un enregistrement de diffusion, plus ceux qu'un montage
 * intermédiaire produit. Comparée en minuscules : le Drive rend des `.MP4`.
 */
const EXTENSIONS_VIDEO = new Set([
  '.mp4',
  '.mkv',
  '.mov',
  '.m4v',
  '.ts',
  '.webm',
  '.flv',
  '.avi',
])

/** Ce qu'un accès réel au dossier des replays rapporte. */
export type ReadingFolder = {
  /** Toutes les entrées, vidéos ou non. Un dossier plein d'autre chose n'est pas vide. */
  entries: number
  /** Les vidéos, avec ce qu'un `lstat` en dit. */
  videos: { name: string; sizeBytes: number; mtimeMs: number }[]
}

export type OptionsSources = {
  db?: Database.Database
  /** Le délai de garde de l'accès au dossier. */
  timeoutMs?: number
  /**
   * L'accès réel au dossier. Injecté par les tests, qui n'ont pas de montage 9p
   * au transport mort sous la main — et c'est le seul mode d'échec qui compte
   * vraiment ici.
   */
  capture?: (dir: string) => Promise<ReadingFolder>
}

/**
 * Les sondes **encore en vol**, par dossier.
 *
 * Même raison que la table `probes` du lanceur : sur un montage mort, l'appel
 * système ne revient jamais et garde son fil. Tant que la précédente n'est pas
 * revenue, on lui raccroche les appelants suivants au lieu d'en lancer une
 * seconde — chacun repartira sur son propre délai de garde, sans avoir rien
 * coûté de plus. L'entrée disparaît quand la sonde se règle enfin.
 */
const inFlight = new Map<string, Promise<ReadingFolder>>()

/**
 * Le dossier des replays, listé et mesuré.
 *
 * Les `lstat` sont **en série**, et c'est délibéré : voir le point 3 en tête de
 * fichier. Vingt et un appels sur un montage vivant se comptent en
 * millisecondes ; sur un montage mort, le premier ne revient pas et les vingt
 * autres ne partent jamais.
 *
 * `lstat` et non `stat` : un lien symbolique n'est pas un replay, et
 * l'ingestion le refuse déjà pour la même raison — il désignerait un fichier
 * hors de `REPLAY_DIR`.
 */
async function captureFolder(dir: string): Promise<ReadingFolder> {
  const entries = await fsp.readdir(dir)
  const videos: ReadingFolder['videos'] = []
  for (const name of entries) {
    if (isAStub(name)) continue
    if (!EXTENSIONS_VIDEO.has(path.extname(name).toLowerCase())) continue
    let info: fs.Stats
    try {
      info = await fsp.lstat(path.join(dir, name))
    } catch (cause) {
      // Un fichier disparu entre la liste et la mesure est une course banale, pas
      // une panne : on l'omet. Tout le reste — droits refusés, montage qui meurt
      // en cours de route — remonte et fait dire « indisponible » plutôt que de
      // présenter un catalogue amputé comme s'il était complet.
      //
      // **Un seul fichier suffit donc à faire basculer le dossier**, et c'est
      // voulu : l'alternative est un catalogue silencieusement incomplet, où la
      // source qu'on cherche est celle qui manque. Ce que l'issue #56 reprochait
      // à ce chemin n'est pas la bascule, c'est qu'elle était muette — un droit
      // refusé sur un fichier ressemblait trait pour trait à un partage tombé.
      // La cause remonte maintenant avec l'échec : `rejected` envoie regarder les
      // droits, pas remonter le partage.
      if (isAAbsence(cause)) continue
      throw cause
    }
    if (!info.isFile()) continue
    videos.push({ name: name, sizeBytes: info.size, mtimeMs: info.mtimeMs })
  }
  return { entries: entries.length, videos }
}

/**
 * Les entrées cachées et celles qui commencent par `$`.
 *
 * **Un dossier adossé à un Drive porte des téléchargements partiels**, et ils
 * portent l'extension de leur destination : `.com.google.Chrome.….mp4` a tout
 * d'une vidéo pour un filtre d'extension, et rien d'une vidéo pour ffprobe. Les
 * proposer ferait des cartes qui échouent à l'ingestion, ce qui ressemble à un
 * défaut de l'outil. La spec les écarte nommément (§ « Lister les sources »).
 *
 * **Elles restent comptées dans `entries`.** Un dossier plein de moignons n'est
 * pas un dossier vide, et c'est cette distinction-là qui porte le diagnostic.
 */
function isAStub(name: string): boolean {
  return name.startsWith('.') || name.startsWith('$')
}

/**
 * Le message que le délai de garde donne à son rejet.
 *
 * Il ne s'affiche nulle part : il sert à **reconnaître** le renoncement parmi
 * les rejets possibles. `waitOrAbandon` construit lui-même son `Error`, et
 * c'est la seule chose qui distingue « personne n'a répondu » d'un code d'erreur
 * du système de fichiers. Producteur et consommateur sont à vingt lignes l'un de
 * l'autre, et un test le vérifie de bout en bout.
 */
const GIVE_UP = 'sources:délai-dépassé'

/** Ce que le relevé a donné : les entrées, ou la raison de ne pas les avoir. */
type Reading = { reading: ReadingFolder; cause: null } | { reading: null; cause: CauseUnavailable }

/**
 * Le code d'échec réel, tel que l'écran pourra le nommer.
 *
 * **Un code énuméré, jamais un `errno` ni un message du système.** Ce dépôt est
 * public et la réponse part sur le réseau : `EACCES` et « permission denied sur
 * /mnt/j/Drive partagés/… » disent la même chose à qui diagnostique, et une
 * chose de plus à qui n'a rien à faire là. Le code, lui, ne porte ni chemin ni
 * texte d'origine — l'écran le traduit.
 *
 * Les quatre couvrent l'espace : ce qui n'existe pas, ce qui est refusé, ce qui
 * ne répond pas, et ce qu'on ne sait pas nommer. Le dernier n'est pas un fourre-
 * tout paresseux — `EIO`, `ESTALE` et `ENOTCONN` existent, et les ranger de
 * force dans l'une des trois autres cases ferait dire à l'écran quelque chose de
 * faux plutôt que quelque chose de vague.
 */
function cause(error: unknown): CauseUnavailable {
  if (error instanceof Error && error.message === GIVE_UP) return 'silent'
  if (isAAbsence(error)) return 'absent'
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EACCES' || code === 'EPERM') return 'denied'
  return 'unreadable'
}

/** Le relevé, ou la cause pour laquelle il n'a pas eu lieu. */
async function captureWithGuard(
  dir: string,
  timeoutMs: number,
  capture: (dir: string) => Promise<ReadingFolder>,
): Promise<Reading> {
  let probe = inFlight.get(dir)
  if (probe === undefined) {
    probe = capture(dir)
    inFlight.set(dir, probe)
    // **Le `catch` est sur la chaîne, pas à côté d'elle.** `finally` propage le
    // rejet : un `sonde.catch()` posé en parallèle laisse la promesse dérivée du
    // `finally` sans gestionnaire, et un montage absent — le cas le plus banal —
    // remonte en rejet non traité, ce qui coupe le processus. Le rejet réel, lui,
    // est déjà traité : `captureWithGuard` le rattrape et le nomme.
    void probe.finally(() => inFlight.delete(dir)).catch(() => {})
  }

  try {
    return { reading: await waitOrAbandon(probe, timeoutMs, GIVE_UP), cause: null }
  } catch (error) {
    // Absence, droits, transport mort, délai dépassé : quatre faits, et l'écran
    // ne peut en nommer un que si on le lui dit. Les confondre était le reste
    // documenté de la vague d'interface (issue #56, point 5).
    return { reading: null, cause: cause(error) }
  }
}

/**
 * Le type de système de fichiers qui porte `path`, d'après le contenu de
 * `/proc/mounts`.
 *
 * **Il se relève même quand l'accès échoue, et c'est là qu'il sert le plus** :
 * un `ext4` là où on attend un `9p` dit « ce montage n'a pas eu lieu », ce qui
 * est exactement la phrase que l'écran doit pouvoir écrire. Le montage retenu
 * est le **plus profond** qui contienne le chemin — sinon `/` répondrait pour
 * tout le monde — et la comparaison exige une frontière de segment, faute de
 * quoi `/mnt/jazz` passerait pour du `/mnt/j`.
 *
 * `/proc/mounts` échappe les espaces et quelques autres caractères en octal.
 *
 * Pure, et séparée pour être testée sans dépendre du montage de la machine qui
 * exécute la suite.
 */
export function editingFstype(edits: string, path: string): string | null {
  let best: { point: string; fstype: string } | null = null
  for (const line of edits.split('\n')) {
    const fields = line.split(' ')
    if (fields.length < 3) continue
    const point = unescape(fields[1])
    if (point === '' || !contains(point, path)) continue
    // `>=` et non `>` : à profondeur égale, c'est la **dernière** ligne qui
    // décrit ce qu'on atteint. Le noyau empile les montages, et un point
    // remonté par-dessus un autre apparaît après lui dans `/proc/mounts` — le
    // cas se produit sous WSL, où `/mnt/wsl` est recouvert.
    if (best === null || point.length >= best.point.length) {
      best = { point, fstype: fields[2] }
    }
  }
  return best?.fstype ?? null
}

/** `\040` et compagnie : `/proc/mounts` échappe en octal. */
function unescape(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  )
}

/** Le point de montage porte-t-il ce chemin ? Frontière de segment exigée. */
function contains(point: string, path: string): boolean {
  if (path === point) return true
  const prefix = point.endsWith('/') ? point : `${point}/`
  return path.startsWith(prefix)
}

function fstype(path: string): string | null {
  try {
    return editingFstype(fs.readFileSync('/proc/mounts', 'utf8'), path)
  } catch {
    // Pas de procfs, pas de relevé. Ce n'est pas une panne : c'est une machine
    // qui ne répond pas à cette question-là.
    return null
  }
}

/**
 * Les replays disponibles, et l'état du montage qui les porte.
 *
 * **Un montage muet n'est pas une erreur de cette fonction** : elle rend une
 * liste vide et une ligne de montage qui dit pourquoi. C'est ce qui permet à
 * l'écran d'écrire « le dossier des replays n'est pas monté » et le geste qui le
 * répare, au lieu d'une page d'erreur qui ne distingue rien — l'incident réel
 * d'OpenShorts, où « dossier vide » et « montage absent » rendaient la même page.
 *
 * `montage.cause` porte **laquelle** des quatre : c'est le point 4 en tête de
 * fichier, et c'est ce qui fait passer la ligne de montage d'une énumération de
 * gestes possibles à un seul, celui qui répare.
 *
 * Les replays sont rendus **du plus récent au plus ancien** : une émission
 * arrive par semaine et c'est la dernière qu'on vient traiter.
 */
export async function listSources(options: OptionsSources = {}): Promise<SourcesListing> {
  const dir = replayDir()
  const db = options.db ?? getDb()
  const { reading, cause } = await captureWithGuard(
    dir,
    options.timeoutMs ?? DELAY_STAT_MS,
    options.capture ?? captureFolder,
  )

  const editing = {
    available: reading !== null,
    cause,
    fstype: fstype(dir),
    entries: reading?.entries ?? 0,
  }
  if (reading === null) return { sources: [], editing }

  // **Indexés par leur source, pas par leur identifiant.** Voir `project`.
  const projects = new Map(listProjects(db).map((p) => [p.sourcePath, p.id]))
  const sources: Source[] = reading.videos
    .slice()
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
    .map((video) => ({
      name: video.name,
      sizeBytes: video.sizeBytes,
      modifiedAt: new Date(video.mtimeMs).toISOString(),
      projectId: project(video.name, projects),
      // **Une URL, pas une image.** Elle est toujours servie — contrairement à
      // celle d'un candidat, qui vaut `null` tant que le proxy n'est pas encodé
      // — parce que le fichier existe : on vient de le mesurer. Ce qui reste
      // incertain est l'extraction, et c'est la route qui répond de ça.
      thumbnailUrl: urlVignetteSource(video.name, video.sizeBytes, video.mtimeMs),
    }))

  return { sources, editing }
}

/**
 * Le projet né de **cette source**, ou `null`.
 *
 * **Le rattachement se fait sur le chemin, jamais sur l'identifiant dérivé.**
 * `projectIdFromSource` retire l'extension : `show.mp4` et `show.mov` donnent
 * tous deux `show`. Chercher l'identifiant dans la table ferait mener la carte
 * du MOV au projet du MP4 — une autre vidéo, sous un titre qui ne la décrit pas
 * — alors que `createProject` refuse précisément cette paire par un
 * `ProjectErrorCollision`. Le MOV reste donc « à créer », et la création
 * répondra 409 avec le message qui nomme les deux fichiers : un cul-de-sac qui
 * s'explique vaut mieux qu'un lien vers la mauvaise vidéo.
 * (relevé par Codex et Copilot)
 *
 * Le chemin passe par `resolveSource`, comme celui qu'`upsertProject` a écrit :
 * deux façons de normaliser le même chemin finiraient par ne plus s'accorder, et
 * la bibliothèque annoncerait des sources neuves qu'elle a déjà analysées.
 * `resolveSource` lève sur un nom qu'elle refuse ; un nom venu de `readdir` n'en
 * fait pas partie, mais le rattraper ici plutôt que de laisser tomber la liste
 * entière coûte une ligne.
 */
function project(name: string, projects: ReadonlyMap<string, string>): string | null {
  try {
    return projects.get(resolveSource(name)) ?? null
  } catch {
    return null
  }
}
