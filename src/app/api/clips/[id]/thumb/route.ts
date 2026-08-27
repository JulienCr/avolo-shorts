import { readFile } from 'node:fs/promises'

import { getClip, getDb } from '@/server/db'
import { notFound, route } from '@/server/http'
import { renderPoster, vignette } from '@/server/thumbs'

/**
 * `GET /api/clips/:id/thumb` — l'affiche d'un clip.
 *
 * **Le rendu livré d'abord, le proxy en repli.** Un clip du vivier a une
 * livraison à jour : son affiche vient du premier repère du rendu 9:16, qui
 * porte le cadrage, le hook et les sous-titres (`renderPoster`). Un candidat
 * sans rendu retombe sur `vignette`, tirée du proxy, comme avant ce lot.
 *
 * Le chemin vient du projet lu en base, jamais d'un morceau d'URL : l'id de
 * clip arrive du réseau. Fichier petit, lu d'un coup — une image, pas une vidéo.
 */
export const GET = route(
  'GET /api/clips/:id/thumb',
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const clip = getClip(getDb(), id)
    if (clip === undefined) throw notFound(`Clip inconnu : ${id}`)

    const file = (await renderPoster(clip)) ?? (await vignette(clip))
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
