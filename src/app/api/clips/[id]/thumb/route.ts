import { readFile } from 'node:fs/promises'

import { getClip, getDb } from '@/server/db'
import { introuvable, route } from '@/server/http'
import { vignette } from '@/server/thumbs'

/**
 * `GET /api/clips/:id/thumb` — la vignette d'un candidat.
 *
 * Elle est extraite du **proxy** au premier segment du clip, et gardée dans
 * `projects/<projet>/thumbs/`. Le chemin se construit à partir du projet lu en
 * base, jamais d'un morceau d'URL : l'identifiant de clip arrive du réseau, et
 * un clip absent de la base ne nomme aucun fichier.
 *
 * Le fichier est petit — quelques dizaines de kilooctets en 960x540 — et se lit
 * d'un coup. Pas de requêtes partielles ici : c'est une image, pas une vidéo.
 */
export const GET = route(
  'GET /api/clips/:id/thumb',
  async (_requête: Request, contexte: { params: Promise<{ id: string }> }) => {
    const { id } = await contexte.params
    const clip = getClip(getDb(), id)
    if (clip === undefined) throw introuvable(`Clip inconnu : ${id}`)

    const fichier = await vignette(clip)
    // Pas de proxy, donc pas d'image à en tirer. Ce n'est pas une panne : c'est
    // l'état d'un projet dont l'encodage n'a pas fini, et l'interface a un repli
    // pour `thumbnailUrl: null` comme pour un 404.
    if (fichier === null) throw introuvable(`Pas encore de proxy pour ${clip.projectId}.`)

    const données = await readFile(fichier)
    return new Response(new Uint8Array(données), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(données.byteLength),
        // Courte, et non « immuable » : la vignette suit le premier segment du
        // clip, que l'écran de clip déplace. `PATCH` efface le fichier quand ce
        // segment bouge, mais il ne peut rien contre une copie déjà dans le
        // cache du navigateur.
        'Cache-Control': 'public, max-age=60',
      },
    })
  },
)
