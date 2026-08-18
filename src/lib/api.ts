/**
 * La frontière entre l'interface et les données. **Le seul fichier qui sait d'où
 * elles viennent.**
 *
 * Il a été écrit contre des fixtures pendant que les routes n'existaient pas, en
 * pariant que le jour où elles arriveraient, seul ce fichier changerait. C'est
 * ce qui s'est passé : les corps sont devenus des `fetch`, les types n'ont pas
 * bougé d'une ligne, et aucun composant n'a été touché.
 *
 * ```
 * GET   /api/projects                       -> ProjectSummary[]
 * POST  /api/projects        { source }     -> RunPlan       (202)
 * GET   /api/projects/:id                   -> ProjectStatus
 * POST  /api/projects/:id/run  { target }   -> RunPlan       (202)
 * GET   /api/projects/:id/candidates        -> CandidateClip[]
 * GET   /api/clips/:id                      -> ClipDetail
 * PATCH /api/clips/:id       { ClipPatch }  -> PatchClipResult
 * POST  /api/clips/:id/export  { force? }   -> ExportResult
 * ```
 *
 * Les trois `POST` ont vécu sans appelant le temps d'une itération, et la chaîne
 * s'arrêtait là où ils manquaient : pas d'entrée pour créer un projet, pas de
 * relance, et un export qui ne se déclenchait qu'en `curl`.
 *
 * Les champs `string | null` — `thumbnailUrl`, `proxyUrl`, les URL de
 * `ClipOutputs` — suivent tous la même règle. Le serveur les remplit quand
 * l'artefact est là et rend `null` sinon, jamais une URL morte : un projet créé
 * il y a trois secondes n'a ni proxy ni vignettes, et `null` a un rendu prévu et
 * testé à l'œil.
 *
 * **Les identifiants sont encodés.** Ceux des projets viennent du nom du fichier
 * d'origine, accents et espaces compris (spec §12), et ceux des clips en
 * héritent : `2026-01-11-méchante_000123456-000234567`. Sans encodage, la
 * moindre espace casserait l'URL.
 */

import type { Clip, ClipStatus, Ratio, Segment } from '@/core/edl'
import type { TranscriptLine } from '@/lib/editing'

export type { Clip, ClipStatus, Ratio, Segment }

/** Les étapes du graphe d'analyse (tâche 6). */
export type StepName = 'proxy' | 'audio' | 'transcript' | 'candidates' | 'renders'

/**
 * Les étapes que le lanceur sait fabriquer.
 *
 * **`renders` n'en est pas**, et le serveur refuse en 400. Un rendu se demande
 * par clip (`exportClip`), parce que c'est par clip qu'on choisit le ratio, le
 * cadrage et les sous-titres. Le graphe garde l'étape parce qu'elle décrit une
 * dépendance réelle ; la nommer ici ferait proposer une cible qui rendrait un
 * plan vide, sans rien dire de pourquoi.
 */
export type RunTarget = Exclude<StepName, 'renders'>

/**
 * Ce que rend une demande d'analyse, création de projet comprise.
 *
 * **202, et pas 201.** L'analyse dure trente à quarante-cinq minutes : ce que la
 * réponse confirme est qu'elle est acceptée et lancée, pas qu'elle est faite.
 * L'avancement se lit ensuite dans `ProjectStatus.running`, et l'échec éventuel
 * dans `ProjectStatus.error`.
 */
export type RunPlan = {
  projectId: string
  /**
   * Les étapes qui vont tourner, dépendances remontées. **Un plan vide est une
   * réponse valide et fréquente** : tout était déjà là, il n'y avait rien à
   * faire. C'est là que se lit le saut d'étape — demander `candidates` sur un
   * projet déjà transcrit ne rend que `['candidates']`.
   */
  plan: StepName[]
}

/**
 * Un projet, vu du client.
 *
 * **Pas de `sourcePath`.** Le chemin du fichier existe côté serveur — il est
 * dans la table `projects` (tâche 6) — mais il ne traverse pas cette frontière :
 * aucun écran ne le lit, et le publier ici l'exposerait à tout consommateur de
 * l'API, y compris l'API externe de la spec §5, avec le point de montage et
 * l'organisation interne du Drive partagé dedans. Un type d'API est une
 * promesse : ce qu'il porte finit par sortir.
 */
export type ProjectSummary = {
  id: string
  /** Dérivé du nom de fichier d'origine, jamais d'un hachage (spec §12). */
  title: string
  durationSec: number
  createdAt: string
}

/**
 * L'état d'un projet : ce qui est déjà là, et ce qui tourne.
 *
 * `steps` est la **présence de l'artefact**, pas une clé de validité — c'est le
 * graphe de l'itération 0 (spec §4). `running` est `null` quand rien ne tourne,
 * et c'est ce que l'écran de tri interroge toutes les deux secondes tant qu'une
 * analyse est en cours.
 */
export type ProjectStatus = {
  project: ProjectSummary
  steps: Record<StepName, boolean>
  running: { step: StepName; progress: number } | null
  /**
   * L'échec de la **dernière exécution terminée**, ou `null` si elle s'est bien
   * passée — et `null` aussi tant que rien n'a jamais tourné.
   *
   * Sans lui, une analyse de quarante minutes qui échoue est indiscernable
   * d'une analyse qui n'a rien trouvé : `running` retombe à `null`, la liste
   * reste vide, et l'écran de tri annonce « aucun candidat ». Le lanceur rend
   * la main bien après la réponse 202, donc c'est le seul chemin par lequel un
   * échec de tâche de fond peut revenir jusqu'à l'écran.
   *
   * Le message est déjà épuré de ses chemins absolus, comme celui d'une réponse
   * d'erreur.
   */
  error: string | null
}

/**
 * Un candidat, tel que l'écran de tri l'affiche.
 *
 * `preview` porte les trois premières phrases de l'extrait, préparées côté
 * serveur : les calculer ici obligerait à charger tout le transcript pour
 * afficher vingt-cinq cartes.
 *
 * Il n'y a **pas de champ `duration`** : elle se calcule par
 * `clipDuration(clip.segments)`. La porter ici en ferait une donnée à tenir
 * synchronisée, donc une donnée qui finirait par mentir après une coupe.
 */
export type CandidateClip = Clip & {
  preview: string
  thumbnailUrl: string | null
}

/**
 * Un clip et de quoi le monter.
 *
 * `lines` couvre l'étendue du clip **plus une marge de contexte** de part et
 * d'autre : sans elle, on ne pourrait qu'enlever, jamais étendre. Les mots hors
 * segments — contexte compris — s'affichent barrés, et c'est la même règle pour
 * les deux, donc un seul cas à écrire.
 *
 * Cette fenêtre se calcule sur l'étendue d'origine du candidat, pas sur
 * `clip.segments` : retirer tous les mots d'un clip laisse une liste vide, et
 * une fenêtre dérivée de cette liste-là n'existerait plus — on perdrait le
 * transcript au moment précis où il faut le relire pour reconstruire le clip.
 * La route la lit dans `candidates.json`, l'artefact que le repérage écrit et
 * que l'édition ne réécrit pas.
 */
export type ClipDetail = {
  clip: Clip
  project: ProjectSummary
  lines: TranscriptLine[]
  proxyUrl: string | null
  /** Ce que l'export a produit, et où le lire. */
  outputs: ClipOutputs
}

/**
 * Les sorties d'un clip, en URL.
 *
 * **Jamais de chemin absolu du serveur** : c'est la même règle que pour
 * `ProjectSummary`, et pour la même raison — un type d'API est une promesse, et
 * ce qu'il porte finit par sortir. `POST /api/clips/:id/export` rend des noms de
 * fichiers ; ici ce sont des URL, directement lisibles par un `<video>` ou un
 * `<a>`.
 *
 * **Un clip a une ou deux vidéos**, et `variant9x16Due` dit laquelle des deux
 * situations on regarde quand `variant9x16Url` vaut `null` :
 *
 * - `variant9x16Due === false` — le ratio résolu est **déjà** 9:16, la variante
 *   à fond flouté serait le même cadre réencodé une seconde fois. Elle
 *   n'existera jamais, et son absence n'est pas une anomalie : une interface qui
 *   afficherait « rendu manquant » ici le ferait sur le clip le mieux livré de
 *   la bibliothèque ;
 * - `variant9x16Due === true` — elle est due. `null` veut alors dire « pas
 *   encore produite », et c'est un export qui reste à faire.
 */
export type ClipOutputs = {
  /**
   * Le rendu au ratio du clip. Toujours produit par un export — donc `null` ne
   * veut dire qu'une chose : rien n'a encore été exporté.
   */
  mp4Url: string | null
  /** La variante 9:16 sur fond flouté. Voir `variant9x16Due` avant de lire ce `null`. */
  variant9x16Url: string | null
  /** Vrai quand la variante 9:16 est **due**, c'est-à-dire quand le ratio résolu ne l'est pas. */
  variant9x16Due: boolean
  /** Le `.txt` de publication : titre, description, mots-dièse. */
  textsUrl: string | null
}

/**
 * Ce qui s'édite sur un clip.
 *
 * Ni `id`, ni `projectId`, ni `pass` : ils identifient le clip et sa provenance,
 * ils ne se corrigent pas depuis l'interface. `PATCH /api/clips/:id` les refuse
 * — son schéma est strict — et normalise les segments avant écriture.
 */
export type ClipPatch = Partial<
  Pick<Clip, 'segments' | 'ratio' | 'cropX' | 'title' | 'description' | 'captions' | 'branding'>
> & {
  /**
   * **`exported` est absent, et c'est délibéré.** Un clip devient exporté parce
   * qu'un MP4 a été produit (`POST /api/clips/:id/export`, tâche 14), jamais
   * parce que quelqu'un l'a écrit. Laisser le client poser ce statut
   * permettrait de marquer comme exporté un clip dont rien n'a été rendu, et
   * `mergeCandidates` le ferait alors survivre à toutes les passes suivantes.
   *
   * La route le refuse aussi : le type ne protège que ce dépôt-ci.
   */
  status?: Exclude<ClipStatus, 'exported'>
}

/**
 * Ce que rend `PATCH /api/clips/:id`.
 *
 * **`applied: false` est un cas nominal, pas un échec.** Il dit « une écriture
 * plus récente a gagné », et la réponse est un 200 : le serveur a fait son
 * travail, il a simplement refusé de remonter le temps. Une interface qui le
 * traiterait comme un échec afficherait « la sauvegarde a échoué » sur le clip
 * le mieux enregistré de la session, et réessaierait une écriture dont on vient
 * d'établir qu'elle est périmée. Le vrai échec, lui, lève une `ApiError`.
 *
 * `clip` porte toujours l'état de la base. Il n'y a donc jamais de relecture à
 * faire derrière, et l'adopter est le bon geste dans les deux cas.
 */
export type PatchClipResult = {
  /**
   * Faux dès qu'**un** champ de ce patch a été écarté parce qu'un geste plus
   * récent l'avait déjà touché. Les autres champs du même patch, eux, sont
   * écrits : l'ordre se compare champ par champ, parce que deux patches
   * partiels qui ne se recouvrent pas ne se contredisent sur rien.
   *
   * **Un appelant qui tient un état local doit s'y remettre d'accord**, et pas
   * seulement mettre son cache à jour. L'écran de clip garde ses segments, son
   * ratio et son crop dans un store séparé, et son enregistrement différé
   * compare cet état à `clip` : sans réconciliation, il verrait à nouveau un
   * écart, renverrait l'intention qu'on vient de refuser — avec un jeton neuf,
   * donc gagnant — et l'ordre qu'on a payé ne servirait à rien. Ignorer ce
   * booléen ne perd pas de données, il annule la garantie. (relevé par Copilot)
   */
  applied: boolean
  clip: Clip
  /**
   * Les sorties **après** cette écriture.
   *
   * Elles voyagent avec la réponse parce qu'un `PATCH` peut les faire
   * disparaître : remonter un clip déjà exporté écarte les MP4, qui décrivaient
   * le montage d'avant. Sans ce champ, un cache tenu par écriture optimiste
   * garderait l'URL d'un rendu qui n'existe plus, et le lecteur vidéo pointerait
   * sur un 404 jusqu'au prochain rechargement.
   */
  outputs: ClipOutputs
  /**
   * Le plus grand jeton d'ordre que la base retient pour ce clip.
   *
   * `patchClip` le pose lui-même comme plancher : les jetons viennent de
   * l'horloge du navigateur, et une horloge remise en arrière produirait des
   * numéros inférieurs à ce que le serveur a déjà appliqué — donc des écritures
   * refusées jusqu'à ce que l'horloge rattrape. Une réponse suffit à recaler.
   */
  seq: number
}

/**
 * Ce que rend `POST /api/clips/:id/export`.
 *
 * **Des noms de fichiers, pas des URL.** Publier les chemins absolus du serveur
 * exposerait l'arborescence de la machine ; le nom suffit à reconnaître ce qui a
 * été produit. Pour *lire* les fichiers, c'est `ClipOutputs` que rend
 * `GET /api/clips/:id` — donc, après un export, une invalidation du clip.
 */
export type ExportResult = {
  /**
   * Le clip relu **après** le rendu : c'est `renderClip` qui pose le statut
   * `exported`, jamais un `PATCH`.
   *
   * **Facultatif, et ce n'est pas une précaution de style.** Le rendu dure de dix
   * secondes à une minute, et une passe de repérage qui se termine pendant ce
   * temps réécrit le jeu de clips du projet : `renderClip` prévoit explicitement
   * que le clip ait disparu à la relecture. La route sérialise alors un corps
   * sans ce champ. Le typer comme toujours présent ferait lire `clip.status` sur
   * `undefined` au retour d'un export par ailleurs réussi. (relevé par Copilot)
   */
  clip?: Clip
  /** Le rendu au ratio du clip. Toujours produit. */
  mp4: string
  /** La variante 9:16 sur fond flouté, ou `null` quand le clip est déjà en 9:16. */
  variant9x16: string | null
  /** Le `.txt` : titre, description, mots-dièse. */
  texts: string
  /**
   * Vrai quand toutes les sorties étaient déjà là et que `force` ne les visait
   * pas. **C'est un cas nominal**, et le plus fréquent quand on rouvre un clip
   * déjà exporté : rien n'a été refait, tout est en place. Le traiter comme une
   * erreur ferait passer un export réussi pour un échec.
   */
  skipped: boolean
}

/**
 * L'échec d'un appel, avec le code que le serveur a rendu.
 *
 * Le code n'est pas décoratif — il porte les trois natures d'échec que la
 * tâche 9 distingue : 422 quand le fournisseur refuse le matériel (rien à
 * réessayer), 503 quand un service est en panne (tout à réessayer), 500 quand
 * c'est un défaut du programme.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Le message d'échec, tel que le serveur l'a formulé.
 *
 * Les routes rendent `{ error }` ; une page d'erreur de Next, un mandataire ou
 * une coupure ne rendent pas de JSON du tout. Le repli sur le code HTTP existe
 * pour ce cas — sans lui, l'échec serait avalé par une exception d'analyse
 * dans le gestionnaire d'erreur lui-même.
 */
async function échec(réponse: Response): Promise<ApiError> {
  let message = `${réponse.status} ${réponse.statusText}`.trim()
  try {
    const corps: unknown = await réponse.json()
    const texte = (corps as { error?: unknown } | null)?.error
    if (typeof texte === 'string' && texte !== '') message = texte
  } catch {
    // Corps vide ou non JSON : le code suffit.
  }
  return new ApiError(réponse.status, message)
}

async function lire<T>(chemin: string): Promise<T> {
  const réponse = await fetch(chemin, { headers: { accept: 'application/json' } })
  if (!réponse.ok) throw await échec(réponse)
  return (await réponse.json()) as T
}

/**
 * Un `POST` avec un corps JSON. Pas de `keepalive` ici, contrairement à
 * `patchClip` : ces trois-là se déclenchent sur un geste explicite dont on
 * attend la réponse à l'écran, pas dans le dos d'une page qui se ferme.
 */
async function poster<T>(chemin: string, corps: unknown): Promise<T> {
  const réponse = await fetch(chemin, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(corps),
  })
  if (!réponse.ok) throw await échec(réponse)
  return (await réponse.json()) as T
}

export function listProjects(): Promise<ProjectSummary[]> {
  return lire<ProjectSummary[]>('/api/projects')
}

export function getProject(projectId: string): Promise<ProjectStatus> {
  return lire<ProjectStatus>(`/api/projects/${encodeURIComponent(projectId)}`)
}

/**
 * Ingère un replay et lance son analyse.
 *
 * `source` est le **nom du fichier** dans `REPLAY_DIR`, tel que le sélecteur de
 * sources le donne — jamais un chemin absolu : le serveur le rejoint lui-même
 * sur sa racine, et exige que le fichier y soit posé directement. L'identifiant
 * du projet en dérive.
 *
 * Rend la main tout de suite, sur un 202 : c'est le `plan` qui dit ce qui va
 * tourner, et `getProject` qui suit l'avancement.
 */
export function createProject(source: string): Promise<RunPlan> {
  return poster<RunPlan>('/api/projects', { source })
}

/**
 * Recalcule jusqu'à une cible : le serveur remonte les dépendances, refait ce
 * qui manque, et s'arrête là.
 *
 * `force` refait une étape dont l'artefact est pourtant présent — `true` vaut
 * « la cible », ce qui couvre le cas courant : relancer le repérage pour obtenir
 * d'autres propositions sans avoir changé un paramètre.
 */
export function runProject(
  projectId: string,
  target: RunTarget,
  force?: boolean | RunTarget[],
): Promise<RunPlan> {
  return poster<RunPlan>(`/api/projects/${encodeURIComponent(projectId)}/run`, { target, force })
}

export function listCandidates(projectId: string): Promise<CandidateClip[]> {
  return lire<CandidateClip[]>(`/api/projects/${encodeURIComponent(projectId)}/candidates`)
}

export function getClip(clipId: string): Promise<ClipDetail> {
  return lire<ClipDetail>(`/api/clips/${encodeURIComponent(clipId)}`)
}

/**
 * **`keepalive: true`, et c'est tout l'intérêt de cette fonction.**
 *
 * L'écran de clip vide son enregistrement différé sur `pagehide`, c'est-à-dire
 * au moment où le navigateur s'apprête à abandonner la page. Une requête
 * ordinaire lancée là est tuée avec elle : la dernière modification avant une
 * fermeture d'onglet se perdrait — le défaut même que ce vidage existe pour
 * éviter. Avec `keepalive`, le navigateur la mène à terme après la page.
 *
 * La contrepartie est une limite de 64 kio sur le corps, largement au-dessus de
 * ce qu'un patch transporte : une poignée de segments et trois champs de texte.
 *
 * **`seq` date l'intention, pas l'envoi.** C'est un argument à part et non un
 * champ de `ClipPatch` : rien de ce qu'il porte ne s'édite sur un clip, il ne
 * fait que voyager avec. L'appelant qui l'omet renonce à l'ordre — le serveur
 * écrit alors sans rien comparer, ce qui est le bon comportement pour un script
 * dont les écritures ne se chevauchent pas.
 */
export async function patchClip(
  clipId: string,
  patch: ClipPatch,
  seq?: number,
): Promise<PatchClipResult> {
  const réponse = await fetch(`/api/clips/${encodeURIComponent(clipId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    // `undefined` ne survit pas à `JSON.stringify` : sans jeton, le corps est
    // exactement celui d'avant.
    body: JSON.stringify({ ...patch, seq }),
    keepalive: true,
  })
  if (!réponse.ok) throw await échec(réponse)
  return (await réponse.json()) as PatchClipResult
}

/**
 * Rend un clip. **Synchrone, et long : de dix secondes à une minute.**
 *
 * C'est la seule fonction de ce fichier qui fasse attendre. L'analyse dure trois
 * quarts d'heure et passe par un lanceur qu'on interroge ; un export mesure
 * quelques dizaines de secondes — 4,58x le temps réel en NVENC, pour un clip qui
 * en dure vingt à quarante — et la réponse arrive quand les fichiers sont sur le
 * disque. Un bouton muet pendant tout ce temps passe pour cassé : l'attente est
 * à montrer, pas à absorber.
 *
 * **Le ré-export est un cas nominal.** Sans `force`, un clip dont toutes les
 * sorties sont déjà là rend `skipped: true` et rien n'est refait. C'est la
 * réponse la plus fréquente dès qu'on rouvre un clip exporté, et elle veut dire
 * « tout est en place » — pas « ça n'a pas marché ».
 */
export function exportClip(clipId: string, force?: boolean): Promise<ExportResult> {
  return poster<ExportResult>(`/api/clips/${encodeURIComponent(clipId)}/export`, { force })
}
