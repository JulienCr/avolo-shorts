import fs from 'node:fs'

import type { Clip, Segment } from '@/core/edl'
import { titleProject } from '@/core/pipeline'
import { isGuard } from '@/core/phase'
import type { CandidateClip, ProjectListItem, ProjectSummary } from '@/lib/api'
import type { TranscriptLine } from '@/lib/editing'
import type { Project } from '@/server/db'
import { candidatesPath, proxyPath } from '@/server/paths'
import { pathTranscript, lireStatus, progression } from '@/server/run'
import { lireTranscript, type TranscriptLu } from '@/server/steps/candidates'

/**
 * Ce que les routes rendent, et **ce qu'elles ne rendent pas**.
 *
 * Un seul fichier construit les formes de `src/lib/api.ts`, parce qu'un seul
 * geste suffit alors à respecter le contrat — et parce que le contrat est
 * d'abord une liste de choses à ne pas publier. `Project` porte `sourcePath` et
 * `stagedPath`, deux chemins absolus du serveur : le point de montage du Drive
 * partagé et l'organisation interne de la bibliothèque. `ProjectSummary` ne les
 * expose pas, et `summaryProject` est le seul endroit d'où un projet sort.
 */

/** Le projet, vu du client. Quatre champs, et pas un de plus. */
export function summaryProject(project: Project): ProjectSummary {
  return {
    id: project.id,
    title: titleProject(project.id),
    // `durationSec` est nul tant que l'ingestion n'a pas sondé la source : c'est
    // l'état d'un projet créé il y a trois secondes, pas une anomalie. Zéro
    // s'affiche en `0:00` là où `null` casserait le formatage.
    durationSec: project.durationSec ?? 0,
    createdAt: new Date(project.createdAt).toISOString(),
  }
}

/**
 * Le projet dans la bibliothèque : son résumé, ce qui tourne, et le dernier
 * échec.
 *
 * **Rien ici ne touche au Drive, et c'est la seule chose qui compte.** La
 * bibliothèque appelle cette fonction une fois par projet — vingt et une fois
 * aujourd'hui —, donc tout ce qu'elle fait est multiplié d'autant. `progression`
 * lit une `Map` du processus ; `lireStatus` lit un petit fichier local. Ni
 * `readingPresence`, ni `urlProxy`, ni quoi que ce soit qui sonde un montage 9p
 * avec un délai de garde : quatre fils du vivier de libuv suffisent à figer tout
 * ce qui touche au disque dans le serveur (voir le cache de `run.ts`).
 *
 * **Les deux lectures sont synchrones, et c'est voulu.** `lireStatus` fait un
 * `readFileSync` sur un fichier de quelques centaines d'octets dans
 * `PROJECTS_DIR`, jamais sur le Drive : vingt et un se comptent en fractions de
 * milliseconde. Les rendre asynchrones n'y gagnerait rien et supprimerait la
 * seule propriété qui rende la réponse cohérente — rien ne s'intercale entre le
 * `progression` et le `lireStatus` d'un même projet, donc aucun d'eux ne décrit
 * un instant que l'autre ignore.
 *
 * `error` se tait pendant qu'une exécution tourne, exactement comme dans
 * `GET /api/projects/:id` : l'échec affiché serait celui d'avant, et deux
 * écrans qui se contredisent sur le même projet valent moins que pas d'écran du
 * tout. `stopped` se tait pour la même raison.
 *
 * **Une seule lecture de `status.json` pour tous les champs.** La bibliothèque
 * appelle cette fonction une fois par projet ; en faire deux doublerait le
 * relevé, et laisserait la porte ouverte à une réponse qui mêle deux versions du
 * fichier.
 */
export function listElement(project: Project): ProjectListItem {
  const running = progression(project.id)
  const status = running === null ? lireStatus(project.id) : null
  return {
    ...summaryProject(project),
    running,
    error: status?.error ?? null,
    // Même relevé qu'`error`, sans coût de plus — voir `ProjectListItem.warning`.
    warning: status?.warning ?? null,
    // **Publié parce que la liste n'a pas `steps`.** L'écran de projet déduit
    // « interrompue » de `phaseProject`, qui lit le relevé de présence ; la
    // bibliothèque ne l'a pas, et c'est délibéré — sonder vingt et un projets
    // sur un montage 9p figerait tout ce qui touche au disque. Sans ce champ,
    // une analyse arrêtée après l'ingestion est indiscernable d'une analyse
    // finie : rien ne tourne, rien n'a échoué, et la durée est connue.
    //
    // `?? false` couvre un `status.json` d'avant cette PR, qui ne porte pas le
    // champ : on le lit comme « pas arrêtée », ce qui est la lecture prudente —
    // un vieux fichier décrit une exécution qu'aucune route ne pouvait arrêter.
    stopped: status?.stopped ?? false,
    // Sans coût de plus : `status` est déjà lu pour `error`/`stopped` ci-dessus.
    everRan: running !== null || status !== null,
  }
}

/**
 * L'URL du proxy, ou `null` s'il n'est pas encore encodé.
 *
 * **`null` a un rendu prévu et testé à l'œil, une URL morte n'en a pas** — c'est
 * la note de `api.ts`, et elle vaut aussi bien ici : le proxy arrive douze
 * minutes après la création du projet.
 *
 * L'identifiant est encodé : les noms de replays portent accents et espaces.
 */
export function urlProxy(projectId: string): string | null {
  if (!fs.existsSync(proxyPath(projectId))) return null
  return `/api/projects/${encodeURIComponent(projectId)}/proxy`
}

/**
 * L'URL de l'affiche d'un clip.
 *
 * `delivered` dit que la route servira le rendu livré, pas le proxy — voir
 * `renderPoster` : sans lui, un clip sans proxy mais avec une livraison à jour
 * (le vivier) se voyait caché une affiche qui existe pourtant.
 *
 * **`?poster=render` porte ce choix jusqu'à la route**, qui sert le même
 * chemin à l'écran de tri en 16:9. Sans ce paramètre, un clip gardé et déjà
 * exporté s'y verrait servir le repère du rendu 9:16, cadré pour un tout
 * autre conteneur (relevé par Codex).
 */
export function urlVignette(clip: Clip, delivered = false): string | null {
  if (!delivered && !fs.existsSync(proxyPath(clip.projectId))) return null
  const suffix = delivered ? '?poster=render' : ''
  return `/api/clips/${encodeURIComponent(clip.id)}/thumb${suffix}`
}

// ---------------------------------------------------------------------------
// Le transcript
// ---------------------------------------------------------------------------

/**
 * Le dernier transcript lu, gardé en mémoire.
 *
 * L'écran de tri redemande les candidats à chaque visite et l'écran de clip à
 * chaque clip ouvert ; le transcript d'une émission de deux heures fait un
 * mégaoctet de JSON. La clé porte la taille et la date de modification, donc un
 * transcript refait par une nouvelle passe invalide l'entrée de lui-même : on ne
 * peut pas servir l'ancien texte sous les nouveaux candidats.
 */
let memory: { key: string; transcript: TranscriptLu } | null = null

export async function projectTranscript(project: Project): Promise<TranscriptLu | null> {
  const file = await pathTranscript(project)
  if (file === null) return null

  const info = fs.statSync(file)
  const key = `${file}:${info.size}:${Math.trunc(info.mtimeMs)}`
  if (memory?.key === key) return memory.transcript

  const transcript = lireTranscript(file)
  memory = { key, transcript }
  return transcript
}

/**
 * Les phrases, telles que l'écran de clip les affiche.
 *
 * **Une phrase sans mot aligné est écartée.** La surface d'édition travaille au
 * mot : une ligne qui n'en porte aucun occuperait une hauteur, ne se
 * sélectionnerait pas, et ne pourrait ni entrer dans un segment ni en sortir.
 */
export function transcriptLines(transcript: TranscriptLu): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  transcript.segments.forEach((segment, i) => {
    if (segment.words.length === 0) return
    lines.push({
      id: `l${i}`,
      start: segment.start,
      end: segment.end,
      words: segment.words,
    })
  })
  return lines
}

/**
 * Les trois premières phrases de l'extrait, **préparées côté serveur**.
 *
 * Les calculer dans le navigateur obligerait l'écran de tri à charger tout le
 * transcript pour afficher vingt-cinq cartes (note de `CandidateClip`).
 *
 * **Le recouvrement se teste segment par segment, jamais sur les bornes
 * extérieures.** Un clip est une liste : raccourcir par le milieu — ce que fait
 * tout ce produit — laisse un trou, et une carte qui montrerait le texte de ce
 * trou annoncerait ce qu'on vient précisément d'enlever. Sur `[60,65]+[85,90]`,
 * les trois premières phrases pouvaient même être entièrement hors du clip.
 * (relevé par Copilot)
 */
export function preview(transcript: TranscriptLu, segments: readonly Segment[]): string {
  return transcript.segments
    .filter((s) => segments.some((seg) => s.end > seg.start && s.start < seg.end))
    .slice(0, 3)
    .map((s) => s.text.trim())
    .filter((t) => t !== '')
    .join(' ')
}

// ---------------------------------------------------------------------------
// L'étendue d'origine
// ---------------------------------------------------------------------------

type Extent = { start: number; end: number }

/** Le dernier `candidates.json` lu, à la même enseigne que le transcript. */
let memoryCandidates: { key: string; extents: Map<string, Extent> } | null = null

/**
 * L'étendue **d'origine** d'un candidat, celle sur laquelle se fenêtre le
 * transcript de l'écran de clip.
 *
 * C'est une exigence explicite de `src/lib/api.ts`, et elle tient à un cas qui
 * arrive : **retirer tous les mots d'un clip laisse une liste de segments
 * vide**. Une fenêtre calculée sur cette liste-là n'existerait plus — on perdrait
 * le transcript au moment précis où il faut le relire pour reconstruire le clip,
 * et le clip paraîtrait introuvable au rechargement.
 *
 * La source est `candidates.json`, l'artefact que le repérage écrit et que
 * personne ne réécrit ensuite : `PATCH /api/clips/:id` n'écrit qu'en base. Ce
 * fichier porte donc les bornes telles que la passe les a proposées, ce qui est
 * exactement « le premier jeu de segments de la passe de repérage ».
 *
 * Rend `null` quand rien ne renseigne l'étendue — un clip écrit à la main, un
 * artefact effacé. L'appelant sert alors le transcript entier : trop de texte
 * est un défaut de confort, pas de correction, et c'est le seul repli qui ne
 * perde rien.
 */
export function extentOrigin(clip: Clip): Extent | null {
  const sinceArtifact = extentSinceArtifact(clip)
  if (sinceArtifact !== null) return sinceArtifact
  if (clip.segments.length === 0) return null
  return {
    start: clip.segments[0].start,
    end: clip.segments[clip.segments.length - 1].end,
  }
}

function extentSinceArtifact(clip: Clip): Extent | null {
  const file = candidatesPath(clip.projectId)
  let info: fs.Stats
  try {
    info = fs.statSync(file)
  } catch {
    return null
  }

  const key = `${file}:${info.size}:${Math.trunc(info.mtimeMs)}`
  if (memoryCandidates?.key !== key) {
    const extents = new Map<string, Extent>()
    try {
      const read: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const raw of Array.isArray(read) ? read : []) {
        const c = raw as Partial<Clip>
        const segments = c.segments ?? []
        if (typeof c.id !== 'string' || segments.length === 0) continue
        const start = segments[0]?.start
        const end = segments[segments.length - 1]?.end
        // **Des nombres, vérifiés.** Un artefact corrompu mais JSON-valide —
        // `"start": "foo"` — donnerait une étendue non numérique, donc une
        // fenêtre `NaN` qui ne retient aucune ligne : l'écran de clip s'ouvrirait
        // vide au lieu de retomber sur le transcript entier, et le repli qui
        // existe pour ce cas serait justement contourné. (relevé par Aristarque)
        if (typeof start !== 'number' || typeof end !== 'number') continue
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue
        extents.set(c.id, { start, end })
      }
    } catch (cause) {
      // Un artefact illisible ne doit pas empêcher d'ouvrir un clip : on retombe
      // sur ses segments courants, et le journal dit pourquoi.
      console.warn(`candidates.json illisible pour ${clip.projectId} :`, cause)
    }
    memoryCandidates = { key, extents }
  }

  return memoryCandidates.extents.get(clip.id) ?? null
}

/**
 * La marge de transcript montrée autour du clip.
 *
 * C'est ce dont on dispose pour **étendre** les bornes : sans marge, l'écran de
 * clip ne saurait qu'enlever. Deux minutes de chaque côté couvrent le cas réel —
 * le repérage cale déjà les bornes sur les mots — et donnent assez de phrases
 * pour que la virtualisation travaille.
 */
export const CONTEXT_S = 120

/** La fenêtre de phrases d'un clip. Tout le transcript si l'étendue est inconnue. */
export function clipLinesAround(transcript: TranscriptLu, clip: Clip): TranscriptLine[] {
  const lines = transcriptLines(transcript)
  const extent = extentOrigin(clip)
  if (extent === null) return lines
  const start = extent.start - CONTEXT_S
  const fin = extent.end + CONTEXT_S
  return lines.filter((l) => l.end > start && l.start < fin)
}

/**
 * Un candidat, tel que l'écran de tri l'affiche.
 *
 * L'aperçu suit les segments **courants**, contrairement à la fenêtre de
 * transcript de l'écran de clip : on trie sur ce que le clip contient
 * maintenant, on monte avec ce qu'il y avait autour au départ.
 */
export function candidate(clip: Clip, transcript: TranscriptLu | null): CandidateClip {
  // Un clip vidé de ses segments n'a plus rien à recouper : on retombe sur son
  // étendue d'origine, faute de quoi sa carte n'aurait plus de texte du tout.
  const pieces: readonly Segment[] =
    clip.segments.length > 0 ? clip.segments : interval(extentOrigin(clip))
  return {
    ...clip,
    preview: transcript === null ? '' : preview(transcript, pieces),
    thumbnailUrl: urlVignette(clip),
  }
}

function interval(extent: Extent | null): Segment[] {
  return extent === null ? [] : [{ start: extent.start, end: extent.end }]
}

// ---------------------------------------------------------------------------
// La correction manuelle du transcript
// ---------------------------------------------------------------------------

/**
 * Les clips **sous-titrés** dont les segments recouvrent l'empan `[start,
 * end]`, par titre.
 *
 * **Pour rendre explicite une conséquence que le graphe ne porte pas
 * encore.** Corriger un mot dans une phrase déjà montée dans un clip ne
 * change ni ses bornes ni son cadrage — rien que `renderIsStale`
 * (`src/server/steps/render.ts`) compare aujourd'hui — donc un clip déjà
 * exporté ne se marque pas périmé tout seul : ses sous-titres incrustés
 * viennent de ce texte-là, au moment du rendu, et resteront ceux d'avant la
 * correction tant que personne ne réexporte. Nommer ces clips à l'écran est
 * ce qui rend la conséquence visible sans lui inventer une seconde
 * mécanique d'invalidation à côté du graphe.
 *
 * **`captions: false` exclut**, et c'est la même conséquence : un clip sans
 * sous-titres incrustés ne porte aucun rendu que la correction périme, donc
 * l'avertissement mentirait sur ce qu'il affecte. (relevé par Copilot)
 *
 * **`isGuard` exclut aussi.** `getClips` rend également les propositions en
 * attente et les clips écartés, qui n'ont encore aucun rendu à périmer — les
 * signaler ferait porter à l'écran une conséquence qui ne s'est pas produite.
 * (relevé par Copilot)
 *
 * Le recouvrement se teste sur les segments courants du clip, comme pour
 * `candidat` — c'est ce que le clip contient *maintenant*, indépendamment de
 * l'étendue qui a servi à le proposer.
 */
export function clipsTouchedBySpan(
  clips: readonly Clip[],
  span: { start: number; end: number },
): { id: string; title: string }[] {
  return clips
    .filter(
      (c) =>
        isGuard(c.status) &&
        c.captions &&
        c.segments.some((s) => s.end > span.start && s.start < span.end),
    )
    .map((c) => ({ id: c.id, title: c.title }))
}
