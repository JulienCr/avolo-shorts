import { z } from 'zod'

import { getDb, unschedulePublications } from '@/server/db'
import { body, json, route } from '@/server/http'

/**
 * `POST /api/planning/unschedule` — retire une échéance.
 *
 * **`POST`, pas `DELETE` avec un corps** : ce dépôt n'a jamais posé de corps
 * sur une requête `DELETE`, cette route n'invente pas le motif.
 */
const REQUEST = z.strictObject({
  clipIds: z
    .array(z.string())
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'un clip ne peut pas apparaître deux fois',
    }),
})

export const POST = route('POST /api/planning/unschedule', async (request: Request) => {
  const { clipIds } = await body(request, REQUEST)
  const removed = unschedulePublications(getDb(), clipIds)
  return json({ removed })
})
