import fs from 'node:fs'
import { z } from 'zod'

import { normalizeSegments, type Clip } from '@/core/edl'
import { getClip, getDb, getProject, putClip } from '@/server/db'
import { corps, introuvable, json, route } from '@/server/http'
import { vignettePath } from '@/server/thumbs'
import { lignesAutourDuClip, résuméProjet, transcriptDuProjet, urlProxy } from '@/server/vues'

/**
 * `GET /api/clips/:id` — un clip et de quoi le monter.
 * `PATCH /api/clips/:id` — l'édition de l'EDL.
 */

/**
 * Ce que le client a le droit d'écrire.
 *
 * **Un objet strict, et c'est le cœur du contrôle.** Trois champs identifient le
 * clip et sa provenance — `id`, `projectId`, `pass` — et ne se corrigent pas
 * depuis l'interface : les refuser un par un obligerait à penser à chaque
 * nouveau champ, alors qu'un objet strict refuse d'emblée tout ce qui n'est pas
 * nommé ici.
 *
 * **`exported` est absent de `status`, et c'est délibéré.** Un clip devient
 * exporté parce qu'un MP4 a été produit (`POST /api/clips/:id/export`), jamais
 * parce que quelqu'un l'a écrit. Laisser passer ce statut permettrait de marquer
 * exporté un clip dont rien n'a été rendu — et `mergeCandidates` le ferait alors
 * survivre à toutes les passes suivantes, puisqu'il tient tout statut non
 * `candidate` pour une décision humaine.
 */
const ÉDITION = z.strictObject({
  segments: z.array(z.strictObject({ start: z.number().finite(), end: z.number().finite() })).optional(),
  ratio: z.enum(['9:16', '4:5', '1:1', '16:9', 'auto']).optional(),
  // Le centre horizontal du crop : un nombre entre 0 et 1, le crop étant pleine
  // hauteur (spec §2).
  cropX: z.number().min(0).max(1).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  captions: z.boolean().optional(),
  branding: z.boolean().optional(),
  status: z.enum(['candidate', 'kept', 'discarded']).optional(),
})

export const GET = route(
  'GET /api/clips/:id',
  async (_requête: Request, contexte: { params: Promise<{ id: string }> }) => {
    const { id } = await contexte.params
    const db = getDb()
    const clip = getClip(db, id)
    if (clip === undefined) throw introuvable(`Clip inconnu : ${id}`)
    const projet = getProject(db, clip.projectId)
    if (projet === undefined) throw introuvable(`Projet inconnu : ${clip.projectId}`)

    const transcript = await transcriptDuProjet(projet)
    return json({
      clip,
      project: résuméProjet(projet),
      // La fenêtre se calcule sur l'étendue **d'origine** du candidat, jamais sur
      // ses segments courants : un clip vidé de tous ses mots n'en a plus, et sa
      // fenêtre disparaîtrait au moment précis où il faut relire le transcript
      // pour le reconstruire. Voir `étendueOrigine`.
      lines: transcript === null ? [] : lignesAutourDuClip(transcript, clip),
      proxyUrl: urlProxy(clip.projectId),
    })
  },
)

export const PATCH = route(
  'PATCH /api/clips/:id',
  async (requête: Request, contexte: { params: Promise<{ id: string }> }) => {
    const { id } = await contexte.params
    // **Le corps d'abord, la base ensuite.** Lire le clip avant d'attendre le
    // corps ouvre une fenêtre entre la lecture et l'écriture, et l'interface
    // lance délibérément des écritures qui se chevauchent (`usePatchClip`) : deux
    // gestionnaires lisaient alors la même ligne, puis chacun réécrivait sa
    // fusion, et la modification du premier disparaissait sans un mot. Lecture,
    // fusion et écriture se suivent maintenant sans point d'attente, ce qui suffit
    // sur le fil unique de Node. (relevé par Copilot)
    const édition = await corps(requête, ÉDITION)

    const db = getDb()
    const clip = getClip(db, id)
    if (clip === undefined) throw introuvable(`Clip inconnu : ${id}`)

    const suivant: Clip = {
      ...clip,
      ...édition,
      // **Normalisés avant écriture**, toujours : triés, sans chevauchement,
      // sans segment vide. Ce que le client envoie est une intention, pas une
      // forme canonique — un glissement de sélection produit très bien deux
      // segments qui se touchent, et les garder séparés ouvrirait un décodeur
      // ffmpeg de plus au rendu.
      segments: normalizeSegments(édition.segments ?? clip.segments),
    }
    putClip(db, suivant)

    // La vignette est tirée du premier segment : si celui-ci a bougé, l'image en
    // cache ne montre plus le début du clip. On l'efface plutôt que de la
    // laisser mentir — elle se refabrique au prochain affichage de la carte.
    //
    // **Au pire des cas, pas d'erreur.** L'écriture en base est déjà validée à
    // ce point : lever ici rendrait 500 sur un montage pourtant enregistré, et
    // l'écriture optimiste de l'interface remettrait l'ancienne version à
    // l'écran alors que la base porte la nouvelle. Une vignette périmée est un
    // défaut d'affichage, une divergence client/serveur en est un autre.
    // (relevé par Codex)
    if (suivant.segments[0]?.start !== clip.segments[0]?.start) {
      try {
        fs.rmSync(vignettePath(clip.projectId, clip.id), { force: true })
      } catch (cause) {
        console.warn(`Vignette non effacée pour ${clip.id} :`, cause)
      }
    }

    return json(suivant)
  },
)
