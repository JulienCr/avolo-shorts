import { z } from 'zod'

import type { WordCorrection } from '@/lib/editing'
import { getClips, getDb, getProject } from '@/server/db'
import { ErreurHttp, corps, introuvable, json, route } from '@/server/http'
import { correctTranscript, type TranscriptCorrectionRefusal } from '@/server/steps/transcript'
import { clipsTouchedBySpan, lignesDuTranscript, transcriptDuProjet } from '@/server/vues'

/**
 * `GET  /api/projects/:id/transcript` — le transcript entier de l'émission.
 * `POST /api/projects/:id/transcript` — une correction manuelle, une phrase à
 * la fois.
 *
 * Une route à part de `GET /api/projects/:id/candidates`, qui ne sert que la
 * fenêtre de 120 s autour d'un clip (`CONTEXTE_S`, `src/server/vues.ts`) : la
 * vue Émission a besoin des ~20 000 mots de l'émission, et les deux besoins
 * n'ont aucune raison de partager une réponse.
 */

export const GET = route(
  'GET /api/projects/:id/transcript',
  async (_requête: Request, contexte: { params: Promise<{ id: string }> }) => {
    const { id } = await contexte.params
    const db = getDb()
    const projet = getProject(db, id)
    if (projet === undefined) throw introuvable(`Projet inconnu : ${id}`)

    // Un transcript absent ne fait pas échouer la route : c'est l'état normal
    // d'un projet dont seule l'ingestion a eu lieu, et la surface l'affiche
    // comme telle plutôt que par une page d'erreur.
    const transcript = await transcriptDuProjet(projet)
    return json(transcript === null ? [] : lignesDuTranscript(transcript))
  },
)

/**
 * Le corps d'une correction : un empan de mots d'une phrase, et son
 * remplacement. Voir `WordCorrection` (`src/lib/editing.ts`) pour la forme et
 * ce qu'elle décide des timings.
 */
const CORRECTION = z.strictObject({
  /** L'identifiant de la phrase, tel que `lignesDuTranscript` le rend (`l0`, `l1`, …). */
  lineId: z.string().min(1),
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  /** Le texte actuellement attendu à `[from, to]` — l'ancre, vérifiée avant d'écrire. */
  expected: z.array(z.string()),
  /** Le remplacement. Vide efface l'empan. */
  replacement: z.array(z.string()),
})

/** Le statut que mérite un refus, selon ce qu'il dit du monde. */
const STATUT_DU_REFUS: Record<TranscriptCorrectionRefusal, number> = {
  'no-transcript': 404,
  'unknown-line': 404,
  'out-of-range': 400,
  'anchor-mismatch': 409,
}

export const POST = route(
  'POST /api/projects/:id/transcript',
  async (requête: Request, contexte: { params: Promise<{ id: string }> }) => {
    const { id } = await contexte.params
    const { lineId, ...empan } = await corps(requête, CORRECTION)
    const correction: WordCorrection = empan

    const db = getDb()
    const projet = getProject(db, id)
    if (projet === undefined) throw introuvable(`Projet inconnu : ${id}`)

    const résultat = await correctTranscript(projet, lineId, correction)
    if (!résultat.ok) {
      throw new ErreurHttp(STATUT_DU_REFUS[résultat.reason], messageDuRefus(résultat.reason))
    }

    // **Explicite, pas une invalidation silencieuse.** Le repérage se relance
    // par le graphe (`POST /run { target: 'candidates', force: ['transcript'] }`,
    // déjà exposé par le bouton de retranscription) ; les rendus déjà exportés,
    // eux, ne sont pas encore périmés par le mécanisme d'empreinte
    // (`src/server/steps/render.ts` ne compare pas le texte — voir le rapport
    // de cette PR). Nommer les clips touchés est ce que cette route peut faire
    // sans toucher à ce fichier.
    const clips = clipsTouchedBySpan(getClips(db, id), { start: résultat.line.start, end: résultat.line.end })

    return json({ line: résultat.line, clipsTouched: clips })
  },
)

function messageDuRefus(raison: TranscriptCorrectionRefusal): string {
  switch (raison) {
    case 'no-transcript':
      return "Ce projet n'a pas encore de transcript."
    case 'unknown-line':
      return 'Cette phrase du transcript est introuvable — le transcript a peut-être changé. Recharger.'
    case 'out-of-range':
      return "L'empan corrigé déborde de la phrase."
    case 'anchor-mismatch':
      return 'Le texte a changé sous vos yeux. Recharger le transcript avant de corriger à nouveau.'
  }
}
