import { getDb, getProject } from '@/server/db'
import { ErrorHttp, notFound, json, route } from '@/server/http'
import { progression } from '@/server/run'
import { proposeTranscriptCorrections } from '@/server/steps/transcript-correction'

/**
 * `POST /api/projects/:id/transcript/correction` — propose des corrections
 * du transcript par modèle (spec §9, étage 2).
 * @returns Une proposition, jamais une écriture — voir `TranscriptCorrectionRequest`
 * pour le chemin de validation. 404 sans transcript, 409 pendant une
 * exécution (issue #93, contrainte de VRAM — `CLAUDE.md`).
 */
export const POST = route(
  'POST /api/projects/:id/transcript/correction',
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const db = getDb()
    const project = getProject(db, id)
    if (project === undefined) throw notFound(`Projet inconnu : ${id}`)

    if (progression(id) !== null) {
      throw new ErrorHttp(
        409,
        'Une retranscription est en cours pour ce projet : attendre qu’elle se termine avant de corriger le transcript.',
      )
    }

    const result = await proposeTranscriptCorrections(db, project, {
      signal: request.signal,
      isRunning: (projectId) => progression(projectId) !== null,
    })
    if (!result.ok) throw notFound("Ce projet n'a pas encore de transcript.")

    // `request` a la forme de `TranscriptCorrectionRequest` (`@/lib/api`) :
    // l'écran valide une proposition en rappelant `POST .../transcript` telle
    // quelle, sans traduction côté client.
    return json({
      proposals: result.proposals.map((p) => ({
        request: {
          lineId: p.lineId,
          from: p.correction.from,
          to: p.correction.to,
          expected: p.correction.expected,
          replacement: p.correction.replacement,
        },
        timecode: p.timecode,
        original: p.original,
        replacement: p.replacement,
      })),
      rejected: result.rejected,
    })
  },
)
