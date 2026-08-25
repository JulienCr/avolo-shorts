import { z } from 'zod'

import type { WordCorrection } from '@/lib/editing'
import { getClips, getDb, getProject } from '@/server/db'
import { ErrorHttp, body, notFound, json, route } from '@/server/http'
import { progression } from '@/server/run'
import { correctTranscript, type TranscriptCorrectionRejection } from '@/server/steps/transcript'
import { clipsTouchedBySpan, transcriptLines, projectTranscript } from '@/server/views'

/**
 * `GET  /api/projects/:id/transcript` — le transcript entier de l'émission.
 * `POST /api/projects/:id/transcript` — une correction manuelle, une phrase à
 * la fois.
 *
 * Une route à part de `GET /api/projects/:id/candidates`, qui ne sert que la
 * fenêtre de 120 s autour d'un clip (`CONTEXT_S`, `src/server/views.ts`) : la
 * vue Émission a besoin des ~20 000 mots de l'émission, et les deux besoins
 * n'ont aucune raison de partager une réponse.
 */

export const GET = route(
  'GET /api/projects/:id/transcript',
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const db = getDb()
    const project = getProject(db, id)
    if (project === undefined) throw notFound(`Projet inconnu : ${id}`)

    // Un transcript absent ne fait pas échouer la route : c'est l'état normal
    // d'un projet dont seule l'ingestion a eu lieu, et la surface l'affiche
    // comme telle plutôt que par une page d'erreur.
    const transcript = await projectTranscript(project)
    return json(transcript === null ? [] : transcriptLines(transcript))
  },
)

/**
 * Le corps d'une correction : un empan de mots d'une phrase, et son
 * remplacement. Voir `WordCorrection` (`src/lib/editing.ts`) pour la forme et
 * ce qu'elle décide des timings.
 */
/**
 * Un mot, un seul — jamais plusieurs mots collés ni une chaîne vide.
 *
 * **Le contrat annonce des listes de mots** (`WordCorrection`,
 * `src/lib/editing.ts`) : `redistributeTiming` répartit l'empan au prorata de
 * la longueur de chaque token, et `applyWordCorrection` compare `expected`
 * mot à mot contre `words[from..to]`. Un token `'deux mots'` ou `''` passerait
 * le schéma large d'origine puis se persisterait comme un seul `Word` — ce qui
 * casse l'indexation par position que `lineIndex` et le tableau de mots
 * supposent partout ailleurs. (relevé par Copilot)
 */
const WORD = z
  .string()
  .min(1, 'un mot ne peut pas être vide')
  .regex(/^\S+$/, 'un mot ne peut pas contenir d’espace')

const CORRECTION = z.strictObject({
  /** L'identifiant de la phrase, tel que `transcriptLines` le rend (`l0`, `l1`, …). */
  lineId: z.string().min(1),
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  /** Le texte actuellement attendu à `[from, to]` — l'ancre, vérifiée avant d'écrire. */
  expected: z.array(WORD),
  /** Le remplacement. Vide efface l'empan. */
  replacement: z.array(WORD),
})

/** Le statut que mérite un refus, selon ce qu'il dit du monde. */
const REJECTION_STATUS: Record<TranscriptCorrectionRejection, number> = {
  'no-transcript': 404,
  'unknown-line': 404,
  'out-of-range': 400,
  'anchor-mismatch': 409,
  'run-in-progress': 409,
}

export const POST = route(
  'POST /api/projects/:id/transcript',
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const { lineId, ...span } = await body(request, CORRECTION)
    const correction: WordCorrection = span

    const db = getDb()
    const project = getProject(db, id)
    if (project === undefined) throw notFound(`Projet inconnu : ${id}`)

    // **Une retranscription en cours écrase le sidecar derrière une
    // correction qui vient de s'annoncer réussie.** `progression` lit une
    // table en mémoire, sans toucher au disque — le refus arrive avant toute
    // lecture du transcript, pas après une course perdue. (relevé par
    // Copilot)
    if (progression(id) !== null) {
      throw new ErrorHttp(
        409,
        'Une retranscription est en cours pour ce projet : attendre qu’elle se termine avant de corriger le transcript.',
      )
    }

    // **Revérifiée juste avant l'écriture**, par `correctTranscript` lui-même
    // — voir son commentaire pour ce que cette seconde sonde referme.
    const result = await correctTranscript(project, lineId, correction, (projectId) => progression(projectId) !== null)
    if (!result.ok) {
      throw new ErrorHttp(REJECTION_STATUS[result.reason], rejectionMessage(result.reason))
    }

    // Nomme les clips touchés, n'invalide pas leur rendu : voir spec §9
    // (« deux conséquences restent partielles ») pour ce que `discardRenderStale`
    // saurait faire ici et pourquoi rien ne l'appelle encore.
    const clips = clipsTouchedBySpan(getClips(db, id), result.correctedSpan)

    return json({ line: result.line, clipsTouched: clips })
  },
)

function rejectionMessage(reason: TranscriptCorrectionRejection): string {
  switch (reason) {
    case 'no-transcript':
      return "Ce projet n'a pas encore de transcript."
    case 'unknown-line':
      return 'Cette phrase du transcript est introuvable — le transcript a peut-être changé. Recharger.'
    case 'out-of-range':
      return "L'empan corrigé déborde de la phrase."
    case 'anchor-mismatch':
      return 'Le texte a changé sous vos yeux. Recharger le transcript avant de corriger à nouveau.'
    case 'run-in-progress':
      return 'Une retranscription est en cours pour ce projet : attendre qu’elle se termine avant de corriger le transcript.'
  }
}
