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
 * `readingPresence`, qui sonde le montage 9p sous délai de garde, et quatre fils
 * du vivier de libuv suffisent à figer tout ce qui touche au disque dans le
 * serveur, analyse en cours comprise.
 *
 * **Donc pur, et sans `@/lib/api`.** La frontière de pureté interdit à
 * `src/core/` d'importer `src/lib/` ; les types d'entrée sont décrits
 * structurellement et paramétrés, ce qui rend ce module testable sans DOM, sans
 * réseau, et rend au passage aux composants les objets complets qu'ils affichent.
 */

import type { StepName } from '@/core/graph'
import { titleProject } from '@/core/pipeline'
import type { Wait } from '@/core/resources'

/**
 * L'état d'une émission dans la bibliothèque.
 *
 * Cinq valeurs, et **quatre se lisent sur ce que la liste des projets porte
 * déjà**. La cinquième, `interrupted`, mérite son paragraphe (voir `showState`).
 */
export type ShowState =
  /** Aucun projet, ou un projet créé sans lancement (`everRan: false`, spec §12). */
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
  running: { step: StepName; progress: number; waiting: Wait | null } | null
  error: string | null
  /**
   * La dernière exécution terminée a-t-elle été **arrêtée** ?
   *
   * Faux pendant qu'une exécution tourne, exactement comme `error`, et pour la
   * même raison : ce qu'on afficherait serait l'arrêt d'avant.
   */
  stopped: boolean
  /** Distingue un projet créé sans lancement d'une exécution interrompue (spec §12). */
  everRan: boolean
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
   * Le titre affiché, **dérivé du nom de fichier par `titleProject`**.
   *
   * `2025-06-15-cqlp.mp4` n'est pas un titre : la date en tête trie un dossier,
   * elle ne se lit pas.
   *
   * **Et il ne bouge pas au moment de l'analyse**, les deux côtés partant du nom
   * de fichier — ici `source.name`, côté serveur `basename(sourcePath)`. Passer
   * par `project.id`, qui a perdu ses accents, changerait le titre sous les yeux.
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
  /** Le replay, ou `null` quand l'entrée n'en a pas — voir `replay`. */
  source: S | null
  /**
   * Ce qu'on sait du fichier derrière cette entrée.
   *
   * **Trois états et non deux, parce que « absent » et « pas regardé » ne se
   * ressemblent que par leur silence.** Un projet sans source correspondante est
   * orphelin *si le dossier a été lu* ; si `GET /api/sources` a échoué, on ne
   * sait simplement pas, et le déclarer orphelin accuserait le Drive d'avoir
   * perdu un fichier qu'on n'a pas cherché. (relevé par Copilot)
   */
  replay: 'present' | 'missing' | 'unknown'
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
 * `ProjectListItem.stopped` le remplace. Le champ ne coûte rien : `listElement`
 * lit déjà `status.json` pour son champ `error`, et `stopped` y était déjà écrit.
 * Il se tait pendant qu'une exécution tourne, comme `error`, pour la même
 * raison — deux écrans qui se contredisent sur le même projet valent moins que
 * pas d'écran.
 *
 * `project === null` rend toujours `'new'` : `createProject` ne lance plus
 * rien par défaut depuis le 23 août 2026 (spec §12), donc la fenêtre entre la
 * réponse de création et le tour de sondage suivant — pendant laquelle la
 * source connaît déjà un `projectId` que la liste des projets ne porte pas
 * encore, voir `markSourceAnalyzed` — décrit toujours un projet qui n'a rien
 * lancé, jamais une analyse en cours.
 */
export function showState(project: LibraryProject | null): ShowState {
  if (project === null) {
    return 'new'
  }
  // Ce qui tourne l'emporte sur ce qui a échoué et sur ce qui a été arrêté,
  // comme dans `analysisProject` : les deux décrivent la dernière exécution
  // *terminée*, et le serveur les tait d'ailleurs tant qu'une autre tourne.
  if (project.running !== null) return 'analyzing'
  if (!project.everRan) return 'new'
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
 *
 * **Et « orphelin » se dit seulement quand on a regardé.** Sur un
 * `GET /api/sources` en échec, les mêmes entrées se fabriquent — les projets
 * doivent rester atteignables, c'était toute la raison d'être de cette
 * branche — mais avec `replay: 'unknown'` : déclarer orphelins vingt projets
 * parce qu'un partage n'a pas répondu accuserait le Drive d'une perte qui n'a
 * pas eu lieu.
 */
export function buildLibrary<S extends LibrarySource, P extends LibraryProject>(
  sources: readonly S[],
  projects: readonly P[],
  /**
   * Le dossier des replays a-t-il été lu ?
   *
   * **Faux quand `GET /api/sources` a échoué.** Les projets restent alors des
   * entrées — sans quoi leurs clips et leurs rendus deviendraient inatteignables
   * sur une panne qui ne les concerne pas —, mais aucun n'est déclaré orphelin :
   * on ne sait pas si son fichier est là. (relevé par Copilot)
   */
  sourcesKnown = true,
): LibraryEntry<S, P>[] {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const claimed = new Set<string>()

  const entries = sources.map((source): LibraryEntry<S, P> => {
    const project = source.projectId === null ? null : (byId.get(source.projectId) ?? null)
    if (project !== null) claimed.add(project.id)
    return {
      key: source.name,
      title: titleProject(withoutExtension(source.name)),
      fileName: source.name,
      source,
      project,
      replay: 'present',
      state: showState(project),
    }
  })

  for (const project of projects) {
    if (claimed.has(project.id)) continue
    entries.push({
      key: project.id,
      // Sans fichier, l'identifiant est tout ce qui reste, et c'est de lui que le
      // serveur tire déjà `project.title`.
      title: project.title,
      fileName: null,
      source: null,
      project,
      replay: sourcesKnown ? 'missing' : 'unknown',
      state: showState(project),
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

/** `œ` et `æ` n'ont pas de décomposition canonique : NFD les laisse entiers. */
const LIGATURES: Record<string, string> = { 'œ': 'oe', 'Œ': 'OE', 'æ': 'ae', 'Æ': 'AE' }

/**
 * Un texte sans ses signes diacritiques, **casse et ponctuation intactes**.
 *
 * Ce qui n'est ni une décomposition `NFD` ni une ligature ressort tel quel : un
 * nom qui ne suit aucune convention n'est jamais deviné (spec §12).
 *
 * @param text N'importe quelle chaîne, y compris vide.
 * @returns La même chaîne, dépliée.
 */
export function foldAccents(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[œŒæÆ]/gu, (c) => LIGATURES[c])
}

/**
 * Un texte ramené à ce qui se compare : sans accents, sans casse, sans bords.
 *
 * **Sans le repli, chercher « entre » ne trouve pas « ENTRE-NOUS » et chercher
 * « caro » ne trouve pas « Caró »** — les noms de replays viennent de titres
 * d'émissions saisis à la main, et personne ne tape les accents dans une boîte
 * de recherche.
 */
export function normalizeForSearch(text: string): string {
  return foldAccents(text).toLowerCase().trim()
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
 * Le nom de fichier sans son extension — la base du titre comme de l'identifiant.
 *
 * Titre client, titre serveur et `projectIdFromSource` passent tous par ici.
 *
 * @param name Un nom de fichier nu, sans dossier.
 * @returns Le nom sans sa **dernière** extension, et seulement si elle a
 *   quelque chose devant elle : `deux.points.mp4` donne `deux.points`, quand
 *   `.env`, dont le point est en tête, sort entier.
 */
export function withoutExtension(name: string): string {
  const point = name.lastIndexOf('.')
  if (point <= 0) return name
  return name.slice(0, point) || name
}
