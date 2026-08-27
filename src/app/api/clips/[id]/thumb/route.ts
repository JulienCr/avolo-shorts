import { readFile } from 'node:fs/promises'

import type { Clip } from '@/core/edl'
import { getClip, getDb } from '@/server/db'
import { notFound, route } from '@/server/http'
import { renderPoster, vignette } from '@/server/thumbs'

/**
 * `GET /api/clips/:id/thumb` — l'affiche d'un clip.
 *
 * **Le proxy par défaut, le rendu livré sur demande explicite.** Cette route
 * sert aussi l'écran de tri et le bandeau de couverture, en 16:9 — leur
 * fournir le repère du rendu 9:16 les recadrerait en une bande centrale
 * illisible (relevé par Codex sur ce lot). Seul `?poster=render`, posé par le
 * vivier du planning (`urlVignette(clip, true)`), bascule vers `renderPoster`.
 *
 * Le chemin vient du projet lu en base, jamais d'un morceau d'URL : l'id de
 * clip arrive du réseau. Fichier petit, lu d'un coup — une image, pas une vidéo.
 */
export const GET = route(
  'GET /api/clips/:id/thumb',
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const clip = getClip(getDb(), id)
    if (clip === undefined) throw notFound(`Clip inconnu : ${id}`)

    const preferRender = new URL(request.url).searchParams.get('poster') === 'render'
    const file = preferRender ? ((await poster(clip)) ?? (await vignette(clip))) : await vignette(clip)
    // Ni rendu à jour ni proxy : rien à en tirer. Ce n'est pas une panne —
    // c'est l'état d'un projet dont l'encodage n'a pas fini, et l'interface a
    // un repli pour `thumbnailUrl: null` comme pour un 404.
    if (file === null) throw notFound(`Pas d’affiche disponible pour ${clip.id}.`)

    const data = await readFile(file)
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(data.byteLength),
        // Courte, et non « immuable » : la vignette suit le premier segment du
        // clip, que l'écran de clip déplace. `PATCH` efface le fichier quand ce
        // segment bouge, mais il ne peut rien contre une copie déjà dans le
        // cache du navigateur.
        'Cache-Control': 'public, max-age=60',
      },
    })
  },
)

/**
 * L'affiche du rendu, ou `null` quand elle ne se produit pas.
 *
 * **Le repli est ici parce que la préférence est ici.** `renderPoster` jette sur
 * un rendu illisible, et `??` n'attrape que `null` : la route rendait donc 500
 * là où elle servait le proxy avant que l'affiche existe. L'échec se journalise
 * plutôt que de disparaître — une image de secours n'est pas une panne, mais un
 * rendu qu'ffmpeg refuse en est une, et elle doit se lire quelque part.
 */
async function poster(clip: Clip): Promise<string | null> {
  try {
    return await renderPoster(clip)
  } catch (cause) {
    console.warn(
      `Affiche indisponible pour ${clip.id} : ${cause instanceof Error ? cause.message : String(cause)} ` +
        `La vignette du proxy prend le relais.`,
    )
    return null
  }
}
