import { isPublicationStale, type PublicationView } from '@/core/publication'
import { getClip, getDb, getPublications } from '@/server/db'
import { notFound, json, route } from '@/server/http'
import { currentFingerprintForClip } from '@/server/publication/service'

/**
 * `GET /api/clips/:id/publications` — l'état de chaque publication, et si
 * elle est **périmée** par rapport au rendu actuel.
 *
 * Une route séparée plutôt qu'un champ de plus sur `GET /api/clips/:id` :
 * l'écran de clip interroge cet état seul, à son propre rythme
 * (`refetchInterval` tant qu'une ligne est `in_progress`), sans vouloir
 * redemander tout `ClipDetail` à chaque sondage.
 *
 * **`stale` est décidé ici, pas côté client** (issue #145) : les deux valeurs
 * comparées sont désormais dans la même représentation (le condensat SHA-256
 * du serveur), là où le client ne pouvait comparer qu'un `JSON.stringify` des
 * segments à ce même condensat.
 */
export const GET = route(
  'GET /api/clips/:id/publications',
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const db = getDb()
    const clip = getClip(db, id)
    if (clip === undefined) throw notFound(`Clip inconnu : ${id}`)
    const fingerprint = currentFingerprintForClip(db, clip)
    const publications: PublicationView[] = getPublications(db, id).map((row) => ({
      ...row,
      stale: fingerprint !== null && isPublicationStale(row, fingerprint),
    }))
    return json({ publications })
  },
)
