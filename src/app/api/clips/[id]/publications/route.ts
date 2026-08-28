import { isPublicationStale, platformTexts, type PublicationView } from '@/core/publication'
import { getClip, getDb, getPublications } from '@/server/db'
import { notFound, json, route } from '@/server/http'
import { publicationFingerprint, renderFingerprintForClip } from '@/server/publication/service'

/**
 * `GET /api/clips/:id/publications` — l'état de chaque publication, et si
 * elle est **périmée** par rapport au rendu actuel.
 *
 * Route séparée de `GET /api/clips/:id` : l'écran de clip la sonde seule,
 * à son rythme (`refetchInterval` tant qu'une ligne est `in_progress`).
 *
 * **`stale` est décidé ici, pas côté client** (issue #145), sur le même
 * condensat SHA-256 des deux côtés. Il couvre le rendu **et** les textes
 * de la plateforme (issue #226), pas le rendu seul.
 */
export const GET = route(
  'GET /api/clips/:id/publications',
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const db = getDb()
    const clip = getClip(db, id)
    if (clip === undefined) throw notFound(`Clip inconnu : ${id}`)
    // Une seule lecture du rendu pour tout le clip (relevé en revue,
    // Aristarque) : `clipFraming` et le fichier d'empreinte ne dépendent pas
    // de la plateforme, seul `platformTexts` en dépend.
    const renderFingerprint = renderFingerprintForClip(db, clip)
    const publications: PublicationView[] = getPublications(db, id).map((row) => {
      const fingerprint =
        renderFingerprint === null ? null : publicationFingerprint(renderFingerprint, platformTexts(clip, row.platform))
      return { ...row, stale: fingerprint !== null && isPublicationStale(row, fingerprint) }
    })
    return json({ publications })
  },
)
