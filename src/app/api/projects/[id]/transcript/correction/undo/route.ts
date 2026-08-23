import { z } from 'zod'

import { getClips, getDb, getProject } from '@/server/db'
import { ErrorHttp, body, notFound, json, route } from '@/server/http'
import { progression } from '@/server/run'
import { undoCorrectionEntry, type UndoCorrectionOutcome } from '@/server/steps/transcript-correction'
import { clipsTouchedBySpan } from '@/server/views'

/**
 * `POST /api/projects/:id/transcript/correction/undo` — défait une
 * substitution de l'historique de correction automatique (spec §9, correction
 * du 23 août 2026) : l'inverse, par le même chemin d'écriture que la
 * correction manuelle (`correctTranscript`), mêmes gardes, même file.
 *
 * **Même garde 409 que la correction manuelle**, et pour la même raison :
 * une retranscription en cours écraserait le sidecar derrière un défaire qui
 * vient de s'annoncer réussi.
 */
export const POST = route(
  'POST /api/projects/:id/transcript/correction/undo',
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const { id: entryId } = await body(request, z.strictObject({ id: z.string().min(1) }))

    const db = getDb()
    const project = getProject(db, id)
    if (project === undefined) throw notFound(`Projet inconnu : ${id}`)

    if (progression(id) !== null) {
      throw new ErrorHttp(
        409,
        'Une retranscription est en cours pour ce projet : attendre qu’elle se termine avant de défaire une correction.',
      )
    }

    const result: UndoCorrectionOutcome = await undoCorrectionEntry(
      project,
      entryId,
      (projectId) => progression(projectId) !== null,
    )
    if (!result.ok) throw new ErrorHttp(REJECTION_STATUS[result.reason], rejectionMessage(result.reason))

    const clips = clipsTouchedBySpan(getClips(db, id), result.correctedSpan)
    return json({ entries: result.entries, clipsTouched: clips })
  },
)

/** Le refus qu'`undoCorrectionEntry` peut rendre — sorti par extraction plutôt que redit. */
type UndoRejection = Extract<UndoCorrectionOutcome, { ok: false }>['reason']

const REJECTION_STATUS: Record<UndoRejection, number> = {
  'unknown-entry': 404,
  'no-transcript': 404,
  'unknown-line': 404,
  'out-of-range': 400,
  'anchor-mismatch': 409,
  'run-in-progress': 409,
}

function rejectionMessage(reason: UndoRejection): string {
  switch (reason) {
    case 'unknown-entry':
      return 'Cette substitution ne se trouve plus dans l’historique — il a peut-être changé. Recharger.'
    case 'no-transcript':
      return "Ce projet n'a pas encore de transcript."
    case 'unknown-line':
      return 'Cette phrase du transcript est introuvable — le transcript a peut-être changé. Recharger.'
    case 'out-of-range':
      return "L'empan à défaire déborde de la phrase."
    case 'anchor-mismatch':
      return 'Le texte a changé sous vos yeux depuis cette correction. Recharger le transcript avant de la défaire.'
    case 'run-in-progress':
      return 'Une retranscription est en cours pour ce projet : attendre qu’elle se termine avant de défaire une correction.'
  }
}
