import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type Database from 'better-sqlite3'

import type { Source, SourcesListing } from '@/lib/api'
import { getDb, listProjects } from '@/server/db'
import { estUneAbsence } from '@/server/octets'
import { replayDir, resolveSource } from '@/server/paths'
import { attendreOuRenoncer, DÉLAI_STAT_MS } from '@/server/steps/ingest'

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
 * 1. **`disponible` s'éprouve par un accès réel**, jamais par les bits de
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
const EXTENSIONS_VIDÉO = new Set([
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
export type RelevéDossier = {
  /** Toutes les entrées, vidéos ou non. Un dossier plein d'autre chose n'est pas vide. */
  entrées: number
  /** Les vidéos, avec ce qu'un `lstat` en dit. */
  vidéos: { name: string; sizeBytes: number; mtimeMs: number }[]
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
  relever?: (dir: string) => Promise<RelevéDossier>
}

/**
 * Les sondes **encore en vol**, par dossier.
 *
 * Même raison que la table `sondes` du lanceur : sur un montage mort, l'appel
 * système ne revient jamais et garde son fil. Tant que la précédente n'est pas
 * revenue, on lui raccroche les appelants suivants au lieu d'en lancer une
 * seconde — chacun repartira sur son propre délai de garde, sans avoir rien
 * coûté de plus. L'entrée disparaît quand la sonde se règle enfin.
 */
const enVol = new Map<string, Promise<RelevéDossier>>()

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
async function releverLeDossier(dir: string): Promise<RelevéDossier> {
  const entrées = await fsp.readdir(dir)
  const vidéos: RelevéDossier['vidéos'] = []
  for (const nom of entrées) {
    if (estUnMoignon(nom)) continue
    if (!EXTENSIONS_VIDÉO.has(path.extname(nom).toLowerCase())) continue
    let info: fs.Stats
    try {
      info = await fsp.lstat(path.join(dir, nom))
    } catch (cause) {
      // Un fichier disparu entre la liste et la mesure est une course banale, pas
      // une panne : on l'omet. Tout le reste — droits refusés, montage qui meurt
      // en cours de route — remonte et fait dire « indisponible » plutôt que de
      // présenter un catalogue amputé comme s'il était complet.
      if (estUneAbsence(cause)) continue
      throw cause
    }
    if (!info.isFile()) continue
    vidéos.push({ name: nom, sizeBytes: info.size, mtimeMs: info.mtimeMs })
  }
  return { entrées: entrées.length, vidéos }
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
 * **Elles restent comptées dans `entrées`.** Un dossier plein de moignons n'est
 * pas un dossier vide, et c'est cette distinction-là qui porte le diagnostic.
 */
function estUnMoignon(nom: string): boolean {
  return nom.startsWith('.') || nom.startsWith('$')
}

/** Le relevé, ou `null` quand le montage n'a pas répondu à temps. */
async function releverAvecGarde(
  dir: string,
  timeoutMs: number,
  relever: (dir: string) => Promise<RelevéDossier>,
): Promise<RelevéDossier | null> {
  let sonde = enVol.get(dir)
  if (sonde === undefined) {
    sonde = relever(dir)
    enVol.set(dir, sonde)
    // **Le `catch` est sur la chaîne, pas à côté d'elle.** `finally` propage le
    // rejet : un `sonde.catch()` posé en parallèle laisse la promesse dérivée du
    // `finally` sans gestionnaire, et un montage absent — le cas le plus banal —
    // remonte en rejet non traité, ce qui coupe le processus. Le rejet réel, lui,
    // est déjà traité : `releverAvecGarde` le rattrape et rend `null`.
    void sonde.finally(() => enVol.delete(dir)).catch(() => {})
  }

  try {
    return await attendreOuRenoncer(sonde, timeoutMs, 'muet')
  } catch {
    // Absence, droits, transport mort, délai dépassé : du point de vue de
    // l'écran, c'est le même fait — on ne peut pas dire ce qu'il y a dedans.
    return null
  }
}

/**
 * Le type de système de fichiers qui porte `chemin`, d'après le contenu de
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
export function fstypeDeMontage(montages: string, chemin: string): string | null {
  let meilleur: { point: string; fstype: string } | null = null
  for (const ligne of montages.split('\n')) {
    const champs = ligne.split(' ')
    if (champs.length < 3) continue
    const point = déséchapper(champs[1])
    if (point === '' || !contient(point, chemin)) continue
    // `>=` et non `>` : à profondeur égale, c'est la **dernière** ligne qui
    // décrit ce qu'on atteint. Le noyau empile les montages, et un point
    // remonté par-dessus un autre apparaît après lui dans `/proc/mounts` — le
    // cas se produit sous WSL, où `/mnt/wsl` est recouvert.
    if (meilleur === null || point.length >= meilleur.point.length) {
      meilleur = { point, fstype: champs[2] }
    }
  }
  return meilleur?.fstype ?? null
}

/** `\040` et compagnie : `/proc/mounts` échappe en octal. */
function déséchapper(champ: string): string {
  return champ.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  )
}

/** Le point de montage porte-t-il ce chemin ? Frontière de segment exigée. */
function contient(point: string, chemin: string): boolean {
  if (chemin === point) return true
  const préfixe = point.endsWith('/') ? point : `${point}/`
  return chemin.startsWith(préfixe)
}

function fstypeDe(chemin: string): string | null {
  try {
    return fstypeDeMontage(fs.readFileSync('/proc/mounts', 'utf8'), chemin)
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
 * Les replays sont rendus **du plus récent au plus ancien** : une émission
 * arrive par semaine et c'est la dernière qu'on vient traiter.
 */
export async function listerSources(options: OptionsSources = {}): Promise<SourcesListing> {
  const dir = replayDir()
  const db = options.db ?? getDb()
  const relevé = await releverAvecGarde(
    dir,
    options.timeoutMs ?? DÉLAI_STAT_MS,
    options.relever ?? releverLeDossier,
  )

  const montage = {
    disponible: relevé !== null,
    fstype: fstypeDe(dir),
    entrées: relevé?.entrées ?? 0,
  }
  if (relevé === null) return { sources: [], montage }

  // **Indexés par leur source, pas par leur identifiant.** Voir `projetDe`.
  const projets = new Map(listProjects(db).map((p) => [p.sourcePath, p.id]))
  const sources: Source[] = relevé.vidéos
    .slice()
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
    .map((vidéo) => ({
      name: vidéo.name,
      sizeBytes: vidéo.sizeBytes,
      modifiedAt: new Date(vidéo.mtimeMs).toISOString(),
      projectId: projetDe(vidéo.name, projets),
    }))

  return { sources, montage }
}

/**
 * Le projet né de **cette source**, ou `null`.
 *
 * **Le rattachement se fait sur le chemin, jamais sur l'identifiant dérivé.**
 * `projectIdFromSource` retire l'extension : `show.mp4` et `show.mov` donnent
 * tous deux `show`. Chercher l'identifiant dans la table ferait mener la carte
 * du MOV au projet du MP4 — une autre vidéo, sous un titre qui ne la décrit pas
 * — alors que `créerProjet` refuse précisément cette paire par un
 * `CollisionDeProjetError`. Le MOV reste donc « à créer », et la création
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
function projetDe(nom: string, projets: ReadonlyMap<string, string>): string | null {
  try {
    return projets.get(resolveSource(nom)) ?? null
  } catch {
    return null
  }
}
