/**
 * La bibliothèque : **un replay, une carte, et son état de traitement dessus**.
 *
 * L'écran d'entrée montrait deux sections — « Projets » puis « Replays » — et une
 * émission déjà analysée y apparaissait **deux fois**, une fois par section. La
 * conception §3.1 avait tranché pour les deux sections, et le retour d'usage a
 * tranché dans l'autre sens : un projet n'est que l'état de traitement d'un
 * replay, donc les deux listes décrivent le même objet à deux moments de sa vie.
 * Ce qui reste vrai de l'arbitrage d'origine, c'est **la moitié qui parle au
 * serveur**, et elle ne bouge pas d'un octet.
 *
 * **La jointure se fait ici, côté client, sur deux requêtes qui existent déjà.**
 * `GET /api/sources` porte `projectId`, `GET /api/projects` porte l'état de
 * chacun : les apparier ne coûte rien de plus. La forme qui vient d'abord — un
 * `GET /api/projects/:id` par entrée, pour connaître les artefacts présents —
 * reste écartée pour la raison qui l'avait fait écarter : elle exécute
 * `relevéPrésence`, qui sonde le montage 9p sous délai de garde, et quatre fils
 * du vivier de libuv suffisent à figer tout ce qui touche au disque dans le
 * serveur, analyse en cours comprise.
 *
 * **Donc pur, et sans `@/lib/api`.** La frontière de pureté interdit à
 * `src/core/` d'importer `src/lib/` ; les types d'entrée sont décrits
 * structurellement et paramétrés, ce qui rend ce module testable sans DOM, sans
 * réseau, et rend au passage aux composants les objets complets qu'ils affichent.
 */

import type { StepName } from '@/core/graph'
import { titreProjet } from '@/core/pipeline'

/**
 * L'état d'une émission dans la bibliothèque.
 *
 * Cinq valeurs, et **quatre se lisent sur ce que la liste des projets porte
 * déjà**. La cinquième, `interrupted`, mérite son paragraphe (voir `showState`).
 */
export type ShowState =
  /** Aucun projet : le replay est là, personne ne l'a analysé. */
  | 'new'
  /** Une exécution tourne. */
  | 'analyzing'
  /** Une exécution a été perdue ou arrêtée sans laisser d'échec. */
  | 'interrupted'
  /** La dernière exécution terminée a échoué. */
  | 'failed'
  /** Le projet est au repos et son ingestion a abouti. */
  | 'analyzed'

/** Ce que la bibliothèque lit d'un replay. */
export type LibrarySource = {
  name: string
  /** Le projet déjà créé sur cette source, ou `null`. */
  projectId: string | null
}

/** Ce que la bibliothèque lit d'un projet — les deux lectures gratuites, et le résumé. */
export type LibraryProject = {
  id: string
  title: string
  /** La durée sondée à l'ingestion. Zéro tant qu'elle ne l'a pas été. */
  durationSec: number
  running: { step: StepName; progress: number } | null
  error: string | null
  /**
   * La dernière exécution terminée a-t-elle été **arrêtée** ?
   *
   * Faux pendant qu'une exécution tourne, exactement comme `error`, et pour la
   * même raison : ce qu'on afficherait serait l'arrêt d'avant.
   */
  stopped: boolean
}

/**
 * Une carte de la bibliothèque.
 *
 * `source` et `project` sont rendus tels quels, pas résumés : la carte affiche la
 * vignette, la taille et la date du replay, l'avancement et le message d'échec
 * du projet. Les recopier ici ferait un troisième modèle à tenir d'accord avec
 * deux contrats d'API.
 */
export type LibraryEntry<S extends LibrarySource, P extends LibraryProject> = {
  /**
   * La clé de liste, **stable d'un relevé à l'autre**.
   *
   * Le nom du replay pour une entrée qui en a un, l'identifiant du projet sinon.
   * Les deux espaces ne se chevauchent pas — un nom de fichier porte son
   * extension, un identifiant de projet non — et de toute façon une entrée
   * orpheline n'existe que parce qu'aucune source ne la réclame.
   */
  key: string
  /**
   * Le titre affiché, **dérivé du nom de fichier par `titreProjet`**.
   *
   * Dans une bibliothèque d'émissions, `2025-06-15-cqlp.mp4` n'est pas un titre :
   * c'est un nom de fichier. La date en tête sert à trier un dossier, elle ne se
   * lit pas — `titreProjet` la remet en français et la passe derrière, ce qui
   * laisse en tête ce qui distingue une émission d'une autre.
   *
   * **Et il ne bouge pas au moment de l'analyse.** `titreProjet` est une fonction
   * pure de l'identifiant, et l'identifiant est le nom de fichier sans son
   * extension (`projectIdFromSource`) : la même chaîne entre, la même sort, avant
   * comme après. Ce module dérive d'ailleurs toujours depuis `source.name`, même
   * quand le projet est là et porte l'identifiant tout fait — lire `project.id`
   * ferait dépendre l'affichage de l'accord entre deux dérivations, et le jour où
   * elles divergeraient le titre changerait sous les yeux au pire moment.
   */
  title: string
  /**
   * Le nom du fichier sur le Drive, ou `null` pour une entrée orpheline.
   *
   * Il reste affiché en métadonnée, à côté de la taille et de la date, parce que
   * c'est ce qui fait le lien avec ce qu'on voit dans un explorateur — et la
   * recherche mord dessus autant que sur le titre, pour la même raison.
   */
  fileName: string | null
  /** Le replay, ou `null` s'il a disparu du Drive. */
  source: S | null
  /** Le projet, ou `null` si personne n'a lancé l'analyse. */
  project: P | null
  state: ShowState
}

/**
 * L'état d'une émission, **et pourquoi le serveur a fini par le dire**.
 *
 * Quatre valeurs se lisent directement. `interrupted` était le cas difficile :
 * `progression()` lit une `Map` du processus Next, qu'un redémarrage vide **sans
 * laisser d'erreur**, et un arrêt demandé écrit délibérément `error: null` —
 * un arrêt n'est pas une panne. Vue de la liste, une exécution perdue ou arrêtée
 * était donc indiscernable d'une exécution terminée : même `running: null`, même
 * `error: null`.
 *
 * Une première version le déduisait de `durationSec`, nul tant que l'ingestion
 * n'a pas sondé la source. C'était vrai quand ça répondait et **faux au-delà** :
 * une analyse arrêtée après l'ingestion s'affichait « Analysée », c'est-à-dire
 * exactement dans le cas que quelqu'un vient de provoquer d'un clic, sur la
 * seule carte qu'il regarde. C'était le seul des cinq états qui pouvait mentir.
 *
 * `ProjectListItem.stopped` le remplace. Le champ ne coûte rien : `élémentDeListe`
 * lit déjà `status.json` pour son champ `error`, et `stopped` y était déjà écrit.
 * Il se tait pendant qu'une exécution tourne, comme `error`, pour la même
 * raison — deux écrans qui se contredisent sur le même projet valent moins que
 * pas d'écran.
 */
export function showState(project: LibraryProject | null, projectExpected: boolean): ShowState {
  if (project === null) {
    // **Une source qui annonce un projet que la liste ne porte pas encore n'est
    // pas une source neuve.** Les deux requêtes ne se rafraîchissent pas
    // ensemble : `marquerSourceAnalysée` inscrit le `projectId` dans le cache
    // des sources dès la réponse de création, et la liste des projets arrive au
    // tour suivant. Retomber sur `new` pendant cette fenêtre reproposerait
    // « lancer l'analyse » sur un projet qui vient d'en lancer une, et le second
    // clic rend un 409 (`ExécutionEnCoursError`). `créerProjet` lance avant de
    // répondre : « en cours » est donc aussi le plus probable des deux.
    return projectExpected ? 'analyzing' : 'new'
  }
  // Ce qui tourne l'emporte sur ce qui a échoué et sur ce qui a été arrêté,
  // comme dans `analyseProjet` : les deux décrivent la dernière exécution
  // *terminée*, et le serveur les tait d'ailleurs tant qu'une autre tourne.
  if (project.running !== null) return 'analyzing'
  if (project.error !== null) return 'failed'
  return project.stopped ? 'interrupted' : 'analyzed'
}

/**
 * La bibliothèque : les replays dans leur ordre, **puis les projets orphelins**.
 *
 * **Un projet dont la source a disparu du Drive garde une carte.** Sans elle il
 * n'aurait plus de replay, donc plus de rangée, et tout le travail fait dessus —
 * les clips gardés, les montages, les rendus déjà sur le disque — deviendrait
 * inatteignable depuis l'interface, sans qu'aucun écran ne le signale. Le cas
 * n'est pas théorique : le dossier des replays est un partage 9p qui décroche de
 * deux façons, et un fichier renommé côté Windows suffit.
 *
 * Ces entrées passent **après** les replays, jamais mêlées : ce sont des restes,
 * pas des propositions de travail.
 */
export function buildLibrary<S extends LibrarySource, P extends LibraryProject>(
  sources: readonly S[],
  projects: readonly P[],
): LibraryEntry<S, P>[] {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const claimed = new Set<string>()

  const entries = sources.map((source): LibraryEntry<S, P> => {
    const project = source.projectId === null ? null : (byId.get(source.projectId) ?? null)
    if (project !== null) claimed.add(project.id)
    return {
      key: source.name,
      title: titreProjet(withoutExtension(source.name)),
      fileName: source.name,
      source,
      project,
      state: showState(project, source.projectId !== null),
    }
  })

  for (const project of projects) {
    if (claimed.has(project.id)) continue
    entries.push({
      key: project.id,
      // Une entrée orpheline n'a plus de fichier : son identifiant est tout ce
      // qui reste, et c'est de lui que le serveur tire déjà `project.title`.
      title: project.title,
      fileName: null,
      source: null,
      project,
      state: showState(project, true),
    })
  }

  return entries
}

/**
 * Les cinq filtres.
 *
 * **`interrupted` se range avec `failed`**, et c'est le regroupement que demande
 * le retour d'usage — « analyse interrompue / en erreur » y est un seul état.
 * Les deux appellent d'ailleurs le même geste : reprendre l'analyse.
 */
export type LibraryFilter = 'all' | 'toAnalyze' | 'running' | 'analyzed' | 'errors'

export const LIBRARY_FILTERS: readonly { value: LibraryFilter; label: string }[] = [
  { value: 'all', label: 'Tous' },
  { value: 'toAnalyze', label: 'À analyser' },
  { value: 'running', label: 'En cours' },
  { value: 'analyzed', label: 'Analysés' },
  { value: 'errors', label: 'Erreurs' },
]

export function matchesFilter(state: ShowState, filter: LibraryFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'toAnalyze':
      return state === 'new'
    case 'running':
      return state === 'analyzing'
    case 'analyzed':
      return state === 'analyzed'
    case 'errors':
      return state === 'failed' || state === 'interrupted'
  }
}

/**
 * Un texte ramené à ce qui se compare : sans accents, sans casse, sans bords.
 *
 * **Sans la décomposition, chercher « entre » ne trouve pas « ENTRE-NOUS » et
 * chercher « caro » ne trouve pas « Caró »** — les noms de replays viennent de
 * titres d'émissions saisis à la main, et personne ne tape les accents dans une
 * boîte de recherche. `NFD` sépare la lettre de son signe, la plage `U+0300` à
 * `U+036F` retire les signes, et ce qui reste se compare en minuscules.
 */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .trim()
}

/**
 * Les entrées d'un filtre, restreintes à une recherche.
 *
 * La recherche porte sur ce que la carte écrit — son titre et son nom de
 * fichier, voir `matchesSearch`. Une requête vide ne retire rien.
 */
export function filterEntries<S extends LibrarySource, P extends LibraryProject>(
  entries: readonly LibraryEntry<S, P>[],
  filter: LibraryFilter,
  search: string,
): LibraryEntry<S, P>[] {
  const query = normalizeForSearch(search)
  return entries.filter(
    (e) => matchesFilter(e.state, filter) && (query === '' || matchesSearch(e, query)),
  )
}

/**
 * Le titre **et** le nom de fichier, parce que la carte montre les deux.
 *
 * Chercher dans un identifiant qu'aucun écran n'affiche rendrait des cartes
 * qu'on ne saurait pas expliquer ; chercher dans le seul titre, à l'inverse,
 * ferait échouer la requête de quelqu'un qui a le nom du fichier sous les yeux
 * dans son explorateur et le recopie. La règle est donc la même dans les deux
 * sens : on cherche dans ce qui est écrit sur la carte.
 */
function matchesSearch(
  entry: LibraryEntry<LibrarySource, LibraryProject>,
  query: string,
): boolean {
  if (normalizeForSearch(entry.title).includes(query)) return true
  return entry.fileName !== null && normalizeForSearch(entry.fileName).includes(query)
}

/**
 * Combien d'entrées chaque filtre retiendrait, **avant la recherche**.
 *
 * Avant, parce que ces comptes servent à choisir un filtre : les faire fondre au
 * fil de la frappe transformerait le seul repère fixe de l'écran en une seconde
 * information mouvante, et « Erreurs 0 » cesserait de vouloir dire « rien n'a
 * échoué ».
 */
export function countsByFilter<S extends LibrarySource, P extends LibraryProject>(
  entries: readonly LibraryEntry<S, P>[],
): Record<LibraryFilter, number> {
  const counts = { all: 0, toAnalyze: 0, running: 0, analyzed: 0, errors: 0 }
  for (const entry of entries) {
    for (const { value } of LIBRARY_FILTERS) {
      if (matchesFilter(entry.state, value)) counts[value] += 1
    }
  }
  return counts
}

/**
 * Le nom de fichier sans son extension — l'identifiant qu'en tirera le serveur.
 *
 * **C'est la moitié pure de `projectIdFromSource`** (`src/server/paths.ts`), qui
 * fait la même chose après avoir résolu le chemin. La recopier ici plutôt que de
 * l'importer est ce que la frontière de pureté impose : cette fonction-là passe
 * par `path` et par `resolveSource`, donc par le système de fichiers, et
 * `src/core/` n'y a pas accès.
 *
 * La conséquence à connaître : les deux dérivations doivent rester d'accord, et
 * rien ne le vérifie mécaniquement. Ce qui limite le risque est ce que chacune
 * garantit de son côté — un nom qui ne suit aucune convention **ressort tel
 * quel** plutôt que d'être deviné (spec §12), donc un désaccord change au pire
 * un titre affiché, jamais une clé de liste ni une URL : la clé reste le nom de
 * fichier, et le lien vers le projet vient de `projectId`.
 *
 * Le point d'extension est le dernier de la chaîne, et il n'en est un que s'il
 * a quelque chose devant lui : `.env` n'a pas d'extension, `deux.points.mp4`
 * garde son premier point. Un nom qui ne serait plus qu'une chaîne vide après
 * découpe est rendu entier — c'est le `|| nom` de l'original.
 */
export function withoutExtension(name: string): string {
  const point = name.lastIndexOf('.')
  if (point <= 0) return name
  return name.slice(0, point) || name
}
