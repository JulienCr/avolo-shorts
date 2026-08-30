import { readFile } from 'node:fs/promises'

import { getClip, getDb } from '@/server/db'
import { notFound, route } from '@/server/http'
import { filmstrip } from '@/server/thumbs'
import { parseFilmstripCount } from '@/lib/filmstrip'

/**
 * `GET /api/clips/:id/filmstrip` — la planche du clip, `count` vues tuilées
 * sur une seule ligne.
 *
 * Le chemin vient du projet lu en base, jamais d'un morceau d'URL : l'id de
 * clip arrive du réseau. Fichier petit, lu d'un coup — une image, pas une
 * vidéo. `count` est validé côté serveur (`parseFilmstripCount`) : un client
 * choisit la largeur de sa bande, jamais la taille du tuilage ffmpeg.
 */
export const GET = route(
  'GET /api/clips/:id/filmstrip',
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const clip = getClip(getDb(), id)
    if (clip === undefined) throw notFound(`Clip inconnu : ${id}`)

    const count = parseFilmstripCount(new URL(request.url).searchParams.get('count'))
    const file = await filmstrip(clip, count)
    if (file === null) throw notFound(`Pas de planche disponible pour ${clip.id}.`)

    const data = await readFile(file)
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(data.byteLength),
        // Courte, non « immuable » : `clipBounds` déplace la planche, et
        // `PATCH` efface le fichier mais pas une copie déjà en cache
        // navigateur.
        'Cache-Control': 'public, max-age=60',
      },
    })
  },
)
