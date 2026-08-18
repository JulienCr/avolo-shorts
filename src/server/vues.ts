import fs from 'node:fs'

import type { Clip } from '@/core/edl'
import { titreProjet } from '@/core/pipeline'
import type { CandidateClip, ProjectSummary } from '@/lib/api'
import type { TranscriptLine } from '@/lib/editing'
import type { Project } from '@/server/db'
import { candidatesPath, proxyPath } from '@/server/paths'
import { cheminTranscript } from '@/server/run'
import { lireTranscript, type TranscriptLu } from '@/server/steps/candidates'

/**
 * Ce que les routes rendent, et **ce qu'elles ne rendent pas**.
 *
 * Un seul fichier construit les formes de `src/lib/api.ts`, parce qu'un seul
 * geste suffit alors à respecter le contrat — et parce que le contrat est
 * d'abord une liste de choses à ne pas publier. `Project` porte `sourcePath` et
 * `stagedPath`, deux chemins absolus du serveur : le point de montage du Drive
 * partagé et l'organisation interne de la bibliothèque. `ProjectSummary` ne les
 * expose pas, et `résuméProjet` est le seul endroit d'où un projet sort.
 */

/** Le projet, vu du client. Quatre champs, et pas un de plus. */
export function résuméProjet(projet: Project): ProjectSummary {
  return {
    id: projet.id,
    title: titreProjet(projet.id),
    // `durationSec` est nul tant que l'ingestion n'a pas sondé la source : c'est
    // l'état d'un projet créé il y a trois secondes, pas une anomalie. Zéro
    // s'affiche en `0:00` là où `null` casserait le formatage.
    durationSec: projet.durationSec ?? 0,
    createdAt: new Date(projet.createdAt).toISOString(),
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

/** Idem pour la vignette, qui se tire du proxy — donc qui en dépend. */
export function urlVignette(clip: Clip): string | null {
  if (!fs.existsSync(proxyPath(clip.projectId))) return null
  return `/api/clips/${encodeURIComponent(clip.id)}/thumb`
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
let mémoire: { clé: string; transcript: TranscriptLu } | null = null

export async function transcriptDuProjet(projet: Project): Promise<TranscriptLu | null> {
  const fichier = await cheminTranscript(projet)
  if (fichier === null) return null

  const info = fs.statSync(fichier)
  const clé = `${fichier}:${info.size}:${Math.trunc(info.mtimeMs)}`
  if (mémoire?.clé === clé) return mémoire.transcript

  const transcript = lireTranscript(fichier)
  mémoire = { clé, transcript }
  return transcript
}

/**
 * Les phrases, telles que l'écran de clip les affiche.
 *
 * **Une phrase sans mot aligné est écartée.** La surface d'édition travaille au
 * mot : une ligne qui n'en porte aucun occuperait une hauteur, ne se
 * sélectionnerait pas, et ne pourrait ni entrer dans un segment ni en sortir.
 */
export function lignesDuTranscript(transcript: TranscriptLu): TranscriptLine[] {
  const lignes: TranscriptLine[] = []
  transcript.segments.forEach((segment, i) => {
    if (segment.words.length === 0) return
    lignes.push({
      id: `l${i}`,
      start: segment.start,
      end: segment.end,
      words: segment.words,
    })
  })
  return lignes
}

/**
 * Les trois premières phrases de l'extrait, **préparées côté serveur**.
 *
 * Les calculer dans le navigateur obligerait l'écran de tri à charger tout le
 * transcript pour afficher vingt-cinq cartes (note de `CandidateClip`).
 */
export function aperçu(transcript: TranscriptLu, début: number, fin: number): string {
  return transcript.segments
    .filter((s) => s.end > début && s.start < fin)
    .slice(0, 3)
    .map((s) => s.text.trim())
    .filter((t) => t !== '')
    .join(' ')
}

// ---------------------------------------------------------------------------
// L'étendue d'origine
// ---------------------------------------------------------------------------

type Étendue = { start: number; end: number }

/** Le dernier `candidates.json` lu, à la même enseigne que le transcript. */
let mémoireCandidats: { clé: string; étendues: Map<string, Étendue> } | null = null

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
export function étendueOrigine(clip: Clip): Étendue | null {
  const depuisArtefact = étendueDepuisArtefact(clip)
  if (depuisArtefact !== null) return depuisArtefact
  if (clip.segments.length === 0) return null
  return {
    start: clip.segments[0].start,
    end: clip.segments[clip.segments.length - 1].end,
  }
}

function étendueDepuisArtefact(clip: Clip): Étendue | null {
  const fichier = candidatesPath(clip.projectId)
  let info: fs.Stats
  try {
    info = fs.statSync(fichier)
  } catch {
    return null
  }

  const clé = `${fichier}:${info.size}:${Math.trunc(info.mtimeMs)}`
  if (mémoireCandidats?.clé !== clé) {
    const étendues = new Map<string, Étendue>()
    try {
      const lus: unknown = JSON.parse(fs.readFileSync(fichier, 'utf8'))
      for (const brut of Array.isArray(lus) ? lus : []) {
        const c = brut as Partial<Clip>
        const segments = c.segments ?? []
        if (typeof c.id !== 'string' || segments.length === 0) continue
        étendues.set(c.id, {
          start: segments[0].start,
          end: segments[segments.length - 1].end,
        })
      }
    } catch (cause) {
      // Un artefact illisible ne doit pas empêcher d'ouvrir un clip : on retombe
      // sur ses segments courants, et le journal dit pourquoi.
      console.warn(`candidates.json illisible pour ${clip.projectId} :`, cause)
    }
    mémoireCandidats = { clé, étendues }
  }

  return mémoireCandidats.étendues.get(clip.id) ?? null
}

/**
 * La marge de transcript montrée autour du clip.
 *
 * C'est ce dont on dispose pour **étendre** les bornes : sans marge, l'écran de
 * clip ne saurait qu'enlever. Deux minutes de chaque côté couvrent le cas réel —
 * le repérage cale déjà les bornes sur les mots — et donnent assez de phrases
 * pour que la virtualisation travaille.
 */
export const CONTEXTE_S = 120

/** La fenêtre de phrases d'un clip. Tout le transcript si l'étendue est inconnue. */
export function lignesAutourDuClip(transcript: TranscriptLu, clip: Clip): TranscriptLine[] {
  const lignes = lignesDuTranscript(transcript)
  const étendue = étendueOrigine(clip)
  if (étendue === null) return lignes
  const début = étendue.start - CONTEXTE_S
  const fin = étendue.end + CONTEXTE_S
  return lignes.filter((l) => l.end > début && l.start < fin)
}

/**
 * Les bornes extérieures d'un clip : ce qu'il couvre **aujourd'hui**.
 *
 * `null` sur un clip vidé de ses segments — c'est un état que l'écran de clip
 * produit, et le seul dont il faut se relever.
 */
export function bornesCourantes(clip: Clip): Étendue | null {
  if (clip.segments.length === 0) return null
  return { start: clip.segments[0].start, end: clip.segments[clip.segments.length - 1].end }
}

/**
 * Un candidat, tel que l'écran de tri l'affiche.
 *
 * L'aperçu suit les bornes **courantes**, contrairement à la fenêtre de
 * transcript de l'écran de clip : on trie sur ce que le clip contient
 * maintenant, on monte avec ce qu'il y avait autour au départ. Un clip vidé
 * retombe sur son étendue d'origine, faute de quoi sa carte n'aurait plus de
 * texte du tout.
 */
export function candidat(clip: Clip, transcript: TranscriptLu | null): CandidateClip {
  const bornes = bornesCourantes(clip) ?? étendueOrigine(clip)
  return {
    ...clip,
    preview:
      transcript === null || bornes === null ? '' : aperçu(transcript, bornes.start, bornes.end),
    thumbnailUrl: urlVignette(clip),
  }
}
