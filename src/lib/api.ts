/**
 * La frontière entre l'interface et les données. **Le seul fichier qui saura
 * d'où elles viennent.**
 *
 * Les routes REST de la tâche 10 (spec §12) n'existent pas encore. L'interface
 * est donc construite contre les fixtures de `./fixtures`, derrière ces
 * fonctions-ci. Quand les routes arriveront, seul ce fichier change : chaque
 * corps devient un `fetch`, les types restent, et aucun composant ne bouge.
 *
 * C'est ce que ce fichier doit à la tâche 10 — le contrat ci-dessous est ce que
 * ses routes ont à honorer :
 *
 * ```
 * GET   /api/projects                  -> ProjectSummary[]
 * GET   /api/projects/:id              -> ProjectStatus
 * GET   /api/projects/:id/candidates   -> CandidateClip[]
 * GET   /api/clips/:id                 -> ClipDetail
 * PATCH /api/clips/:id  { ClipPatch }  -> Clip
 * ```
 *
 * Deux champs sont volontairement `string | null` : `thumbnailUrl` et
 * `proxyUrl`. Les artefacts qu'ils désignent n'existent pas en itération 0 tant
 * que le pipeline n'a pas tourné, et une interface qui suppose leur présence
 * casse à la première visite. `null` a un rendu prévu et testé à l'œil ; une URL
 * morte n'en a pas.
 */

import type { Clip, ClipStatus, Ratio, Segment } from '@/core/edl'
import type { TranscriptLine } from '@/lib/editing'
import {
  fixtureCandidates,
  fixtureClipDetail,
  fixtureProject,
  fixtureProjectStatus,
  patchFixtureClip,
} from '@/lib/fixtures'

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
 * **Exigence pour la tâche 10 :** cette fenêtre se calcule sur l'étendue
 * d'origine du candidat, pas sur `clip.segments`. Retirer tous les mots d'un
 * clip laisse une liste vide, et une fenêtre dérivée de cette liste-là
 * n'existerait plus : on perdrait le transcript au moment précis où il faut le
 * relire pour reconstruire le clip. La route a donc besoin de garder cette
 * étendue — le premier jeu de segments de la passe de repérage suffit.
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
 * ils ne se corrigent pas depuis l'interface. `PATCH /api/clips/:id` normalise
 * les segments avant écriture (tâche 10, étape 2).
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
   * **Exigence pour la tâche 10 :** la route doit refuser `exported` venant du
   * client, comme elle refuse déjà `id`, `projectId` et `pass`. Le type ne
   * protège que ce dépôt-ci.
   */
  status?: Exclude<ClipStatus, 'exported'>
}

/**
 * La latence simulée des fixtures.
 *
 * Pas zéro, et c'est délibéré : à zéro, les états de chargement et la mise à
 * jour optimiste du tri ne se voient jamais, donc leurs défauts non plus. Ces
 * deux constantes disparaissent avec les fixtures.
 */
const LATENCE_LECTURE_MS = 90
const LATENCE_ECRITURE_MS = 180

function attendre(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function listProjects(): Promise<ProjectSummary[]> {
  await attendre(LATENCE_LECTURE_MS)
  return [fixtureProject()]
}

export async function getProject(projectId: string): Promise<ProjectStatus> {
  await attendre(LATENCE_LECTURE_MS)
  return fixtureProjectStatus(projectId)
}

export async function listCandidates(projectId: string): Promise<CandidateClip[]> {
  await attendre(LATENCE_LECTURE_MS)
  return fixtureCandidates(projectId)
}

export async function getClip(clipId: string): Promise<ClipDetail> {
  await attendre(LATENCE_LECTURE_MS)
  return fixtureClipDetail(clipId)
}

export async function patchClip(clipId: string, patch: ClipPatch): Promise<Clip> {
  await attendre(LATENCE_ECRITURE_MS)
  return patchFixtureClip(clipId, patch)
}
