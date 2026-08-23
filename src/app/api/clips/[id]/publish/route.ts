import { z } from 'zod'

import { PLATFORMS, type Platform } from '@/core/publication'
import { getClip, getDb } from '@/server/db'
import { body, notFound, json, route } from '@/server/http'
import { createUploadPostAdapter } from '@/server/publication/upload-post'
import { launchPublish } from '@/server/publication/service'

/**
 * `POST /api/clips/:id/publish` — lancer une publication.
 *
 * **Immédiat, contrairement à ce qu'il déclenche.** La route pose les lignes
 * `in_progress` et rend aussitôt (spec §6.4) : le téléversement dépend du
 * réseau et peut interroger Upload Post jusqu'à ce que chaque plateforme
 * réponde, ce qu'une requête HTTP ne peut pas porter sans expirer. `launchPublish`
 * (`src/server/publication/service.ts`) fait tout le travail ; cette route ne
 * fait que le brancher au corps de la requête et au registre en cours.
 */

const REQUEST = z.strictObject({
  platforms: z.array(z.enum(PLATFORMS as [Platform, ...Platform[]])).min(1),
  /** Republier une plateforme déjà `published` (spec §6.5). */
  force: z.boolean().optional(),
})

export const POST = route(
  'POST /api/clips/:id/publish',
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const { platforms, force } = await body(request, REQUEST)

    const db = getDb()
    const clip = getClip(db, id)
    if (clip === undefined) throw notFound(`Clip inconnu : ${id}`)

    const { rows } = launchPublish({
      db,
      adapter: createUploadPostAdapter(),
      clip,
      platforms,
      force: force ?? false,
    })

    return json({ publications: rows })
  },
)
