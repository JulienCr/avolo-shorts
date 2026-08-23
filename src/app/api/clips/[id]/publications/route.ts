import { getClip, getDb, getPublications } from '@/server/db'
import { notFound, json, route } from '@/server/http'

/**
 * `GET /api/clips/:id/publications` — l'état de chaque publication.
 *
 * Une route séparée plutôt qu'un champ de plus sur `GET /api/clips/:id` :
 * l'écran de clip interroge cet état seul, à son propre rythme
 * (`refetchInterval` tant qu'une ligne est `in_progress`), sans vouloir
 * redemander tout `ClipDetail` à chaque sondage.
 */
export const GET = route(
  'GET /api/clips/:id/publications',
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const db = getDb()
    if (getClip(db, id) === undefined) throw notFound(`Clip inconnu : ${id}`)
    return json({ publications: getPublications(db, id) })
  },
)
