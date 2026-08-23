import { z } from 'zod'

import { getDb, getProject } from '@/server/db'
import { ErrorHttp, body, notFound, json, route } from '@/server/http'
import { progression } from '@/server/run'
import { removeCorrectionEntry, type RemoveEntryOutcome } from '@/server/steps/transcript-correction'

/**
 * `POST /api/projects/:id/transcript/correction/remove` — retire une entrée
 * de l'historique de correction sans toucher au transcript.
 *
 * **Le rattrapage de dernier recours** (issues #134, #138), à côté de
 * `POST .../correction/undo` plutôt qu'à sa place : une entrée dont l'ancre
 * est devenue périmée ne se défait plus jamais, et cette route est le seul
 * moyen de s'en débarrasser tout de même.
 *
 * **Même garde 409 que le défaire**, pour la même raison : une
 * retranscription en cours peut réécrire le journal derrière ce retrait.
 */
export const POST = route(
  'POST /api/projects/:id/transcript/correction/remove',
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const { id: entryId } = await body(request, z.strictObject({ id: z.string().min(1) }))

    const db = getDb()
    const project = getProject(db, id)
    if (project === undefined) throw notFound(`Projet inconnu : ${id}`)

    if (progression(id) !== null) {
      throw new ErrorHttp(
        409,
        'Une exécution est en cours pour ce projet : attendre qu’elle se termine avant de retirer une entrée de l’historique.',
      )
    }

    const result: RemoveEntryOutcome = await removeCorrectionEntry(
      project,
      entryId,
      (projectId) => progression(projectId) !== null,
    )
    if (!result.ok) {
      throw new ErrorHttp(404, 'Cette entrée ne se trouve plus dans l’historique — il a peut-être changé. Recharger.')
    }

    return json({ entries: result.entries })
  },
)
