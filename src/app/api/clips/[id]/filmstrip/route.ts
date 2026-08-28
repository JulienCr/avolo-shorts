import { readFile } from 'node:fs/promises'

import { getClip, getDb } from '@/server/db'
import { notFound, route } from '@/server/http'
import { filmstrip } from '@/server/thumbs'

/**
 * `GET /api/clips/:id/filmstrip` — la planche du clip, douze vues tuilées sur
 * une seule ligne.
 *
 * Le chemin vient du projet lu en base, jamais d'un morceau d'URL : l'id de
 * clip arrive du réseau. Fichier petit, lu d'un coup — une image, pas une vidéo.
 */
export const GET = route(
  'GET /api/clips/:id/filmstrip',
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const clip = getClip(getDb(), id)
    if (clip === undefined) throw notFound(`Clip inconnu : ${id}`)

    const file = await filmstrip(clip)
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
