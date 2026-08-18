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
 * GET   /api/projects                  -> ProjectSummary[]
 * GET   /api/projects/:id              -> ProjectStatus
 * GET   /api/projects/:id/candidates   -> CandidateClip[]
 * GET   /api/clips/:id                 -> ClipDetail
 * PATCH /api/clips/:id  { ClipPatch }  -> Clip
 * ```
 *
 * Deux champs restent `string | null` : `thumbnailUrl` et `proxyUrl`. Le serveur
 * les remplit quand l'artefact est là et rend `null` sinon — pas une URL morte.
 * Un projet créé il y a trois secondes n'a ni proxy ni vignettes, et `null` a un
 * rendu prévu et testé à l'œil.
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

export function listProjects(): Promise<ProjectSummary[]> {
  return lire<ProjectSummary[]>('/api/projects')
}

export function getProject(projectId: string): Promise<ProjectStatus> {
  return lire<ProjectStatus>(`/api/projects/${encodeURIComponent(projectId)}`)
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
 */
export async function patchClip(clipId: string, patch: ClipPatch): Promise<Clip> {
  const réponse = await fetch(`/api/clips/${encodeURIComponent(clipId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(patch),
    keepalive: true,
  })
  if (!réponse.ok) throw await échec(réponse)
  return (await réponse.json()) as Clip
}
