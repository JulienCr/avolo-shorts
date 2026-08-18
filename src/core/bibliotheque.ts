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

/**
 * L'état d'une émission dans la bibliothèque.
 *
 * Cinq valeurs, et **quatre se lisent sur ce que la liste des projets porte
 * déjà**. La cinquième, `interrompue`, mérite son paragraphe (voir
 * `étatDÉmission`).
 */
export type ÉtatÉmission =
  /** Aucun projet : le replay est là, personne ne l'a analysé. */
  | 'neuve'
  /** Une exécution tourne. */
  | 'analyse'
  /** Une exécution a été perdue ou arrêtée sans laisser d'échec. */
  | 'interrompue'
  /** La dernière exécution terminée a échoué. */
  | 'echec'
  /** Le projet est au repos et son ingestion a abouti. */
  | 'analysée'

/** Ce que la bibliothèque lit d'un replay. */
export type SourceLisible = {
  name: string
  /** Le projet déjà créé sur cette source, ou `null`. */
  projectId: string | null
}

/** Ce que la bibliothèque lit d'un projet — les deux lectures gratuites, et le résumé. */
export type ProjetLisible = {
  id: string
  title: string
  /**
   * La durée sondée à l'ingestion. **Zéro veut dire « pas encore sondée »**, et
   * c'est ce qui rend `interrompue` observable sans rien demander de plus au
   * serveur : `résuméProjet` rend `projet.durationSec ?? 0`, et la colonne n'est
   * écrite qu'une fois l'ingestion passée.
   */
  durationSec: number
  running: { step: StepName; progress: number } | null
  error: string | null
}

/**
 * Une carte de la bibliothèque.
 *
 * `source` et `projet` sont rendus tels quels, pas résumés : la carte affiche la
 * vignette, la taille et la date du replay, l'avancement et le message d'échec
 * du projet. Les recopier ici ferait un troisième modèle à tenir d'accord avec
 * deux contrats d'API.
 */
export type EntréeBibliothèque<S extends SourceLisible, P extends ProjetLisible> = {
  /**
   * La clé de liste, **stable d'un relevé à l'autre**.
   *
   * Le nom du replay pour une entrée qui en a un, l'identifiant du projet sinon.
   * Les deux espaces ne se chevauchent pas — un nom de fichier porte son
   * extension, un identifiant de projet non — et de toute façon une entrée
   * orpheline n'existe que parce qu'aucune source ne la réclame.
   */
  clé: string
  /** Ce qui s'affiche et sur quoi porte la recherche. */
  titre: string
  /** Le replay, ou `null` s'il a disparu du Drive. */
  source: S | null
  /** Le projet, ou `null` si personne n'a lancé l'analyse. */
  projet: P | null
  état: ÉtatÉmission
}

/**
 * L'état d'une émission, **et ce que le serveur ne dit pas encore**.
 *
 * Les quatre premières valeurs se lisent directement. `interrompue` est le cas
 * difficile : `progression()` lit une `Map` du processus Next, qu'un redémarrage
 * vide **sans laisser d'erreur**, et il y a un redémarrage à chaque édition en
 * développement. Vue de la liste, une exécution perdue est donc indiscernable
 * d'une exécution terminée : même `running: null`, même `error: null`.
 *
 * Ce qui la rend malgré tout observable est `durationSec`. L'ingestion est la
 * première étape du plan, et c'est elle qui écrit la durée : un projet au repos
 * qui n'en a pas n'a pas fini ce qu'il avait commencé. La déduction est vraie
 * quand elle répond, et muette au-delà — une exécution perdue **après**
 * l'ingestion retombe sur `analysée`.
 *
 * **Ce qu'elle ne couvre pas, et ce qui le couvrirait.** Deux cas échappent à la
 * déduction et retombent sur `analysée` : une exécution perdue **après**
 * l'ingestion, et une analyse **arrêtée** depuis l'écran — `publierLArrêt`
 * (`src/server/run.ts`) écrit délibérément `error: null`, parce qu'un arrêt
 * demandé n'est pas une panne.
 *
 * Le serveur, lui, sait les deux. `status.json` porte `arrêtée`, `pid` et
 * `finishedAt`, et `élémentDeListe` (`src/server/vues.ts`) lit déjà ce fichier
 * pour son champ `error` : la lecture est payée, il n'y aurait qu'un champ à
 * publier. Le choix de ne pas le faire est écrit dans `Statut.arrêtée` et il
 * tient pour l'écran de projet, où `phaseProjet` déduit `interrompu` de
 * `steps` ; **la bibliothèque, elle, n'a pas `steps`** — c'est justement le
 * sondage qu'elle refuse de payer. La branche ci-dessous est ce qui reste.
 * (contrat manquant, signalé)
 */
export function étatDÉmission(projet: ProjetLisible | null, projetAttendu: boolean): ÉtatÉmission {
  if (projet === null) {
    // **Une source qui annonce un projet que la liste ne porte pas encore n'est
    // pas une source neuve.** Les deux requêtes ne se rafraîchissent pas
    // ensemble : `marquerSourceAnalysée` inscrit le `projectId` dans le cache
    // des sources dès la réponse de création, et la liste des projets arrive au
    // tour suivant. Retomber sur `neuve` pendant cette fenêtre reproposerait
    // « lancer l'analyse » sur un projet qui vient d'en lancer une, et le second
    // clic rend un 409 (`ExécutionEnCoursError`). `créerProjet` lance avant de
    // répondre : « en cours » est donc aussi le plus probable des deux.
    return projetAttendu ? 'analyse' : 'neuve'
  }
  // Ce qui tourne l'emporte sur ce qui a échoué, comme dans `analyseProjet` :
  // `error` décrit la dernière exécution *terminée*.
  if (projet.running !== null) return 'analyse'
  if (projet.error !== null) return 'echec'
  return projet.durationSec > 0 ? 'analysée' : 'interrompue'
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
export function bibliothèque<S extends SourceLisible, P extends ProjetLisible>(
  sources: readonly S[],
  projets: readonly P[],
): EntréeBibliothèque<S, P>[] {
  const parId = new Map(projets.map((p) => [p.id, p]))
  const réclamés = new Set<string>()

  const entrées = sources.map((source): EntréeBibliothèque<S, P> => {
    const projet = source.projectId === null ? null : (parId.get(source.projectId) ?? null)
    if (projet !== null) réclamés.add(projet.id)
    return {
      clé: source.name,
      titre: source.name,
      source,
      projet,
      état: étatDÉmission(projet, source.projectId !== null),
    }
  })

  for (const projet of projets) {
    if (réclamés.has(projet.id)) continue
    entrées.push({
      clé: projet.id,
      titre: projet.title,
      source: null,
      projet,
      état: étatDÉmission(projet, true),
    })
  }

  return entrées
}

/**
 * Les cinq filtres.
 *
 * **`interrompue` se range avec `echec`**, et c'est le regroupement que demande
 * le retour d'usage — « analyse interrompue / en erreur » y est un seul état.
 * Les deux appellent d'ailleurs le même geste : reprendre l'analyse.
 */
export type Filtre = 'tous' | 'aanalyser' | 'encours' | 'analysees' | 'erreurs'

export const FILTRES: readonly { valeur: Filtre; libelle: string }[] = [
  { valeur: 'tous', libelle: 'Tous' },
  { valeur: 'aanalyser', libelle: 'À analyser' },
  { valeur: 'encours', libelle: 'En cours' },
  { valeur: 'analysees', libelle: 'Analysés' },
  { valeur: 'erreurs', libelle: 'Erreurs' },
]

export function retenuParFiltre(état: ÉtatÉmission, filtre: Filtre): boolean {
  switch (filtre) {
    case 'tous':
      return true
    case 'aanalyser':
      return état === 'neuve'
    case 'encours':
      return état === 'analyse'
    case 'analysees':
      return état === 'analysée'
    case 'erreurs':
      return état === 'echec' || état === 'interrompue'
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
export function normaliser(texte: string): string {
  return texte
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .trim()
}

/**
 * Les entrées d'un filtre, restreintes à une recherche.
 *
 * La recherche porte sur le titre seul : c'est ce qui s'affiche, et chercher
 * dans un identifiant qu'aucun écran ne montre rendrait des cartes qu'on ne
 * saurait pas expliquer. Une requête vide ne retire rien.
 */
export function filtrer<S extends SourceLisible, P extends ProjetLisible>(
  entrées: readonly EntréeBibliothèque<S, P>[],
  filtre: Filtre,
  recherche: string,
): EntréeBibliothèque<S, P>[] {
  const requête = normaliser(recherche)
  return entrées.filter(
    (e) =>
      retenuParFiltre(e.état, filtre) &&
      (requête === '' || normaliser(e.titre).includes(requête)),
  )
}

/**
 * Combien d'entrées chaque filtre retiendrait, **avant la recherche**.
 *
 * Avant, parce que ces comptes servent à choisir un filtre : les faire fondre au
 * fil de la frappe transformerait le seul repère fixe de l'écran en une seconde
 * information mouvante, et « Erreurs 0 » cesserait de vouloir dire « rien n'a
 * échoué ».
 */
export function comptesParFiltre<S extends SourceLisible, P extends ProjetLisible>(
  entrées: readonly EntréeBibliothèque<S, P>[],
): Record<Filtre, number> {
  const comptes = { tous: 0, aanalyser: 0, encours: 0, analysees: 0, erreurs: 0 }
  for (const entrée of entrées) {
    for (const { valeur } of FILTRES) {
      if (retenuParFiltre(entrée.état, valeur)) comptes[valeur] += 1
    }
  }
  return comptes
}
