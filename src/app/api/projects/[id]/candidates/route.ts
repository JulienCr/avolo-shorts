import { getClips, getDb, getProject } from '@/server/db'
import { notFound, json, route } from '@/server/http'
import { candidate, projectTranscript } from '@/server/views'

/**
 * `GET /api/projects/:id/candidates` — les propositions, prêtes à trier.
 *
 * L'aperçu et la vignette sont préparés ici, et c'est délibéré : les calculer
 * dans le navigateur obligerait l'écran de tri à charger tout le transcript pour
 * afficher vingt-cinq cartes.
 *
 * Un transcript absent ne fait pas échouer la route. Les candidats existent en
 * base, ils s'affichent et se trient ; seul l'aperçu reste vide, et c'est bien
 * meilleur qu'une page d'erreur — le cas se produit quand le sidecar est resté
 * sur un Drive qui ne répond plus.
 */
export const GET = route(
  'GET /api/projects/:id/candidates',
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const db = getDb()
    const project = getProject(db, id)
    if (project === undefined) throw notFound(`Projet inconnu : ${id}`)

    const transcript = await projectTranscript(project)
    return json(getClips(db, id).map((clip) => candidate(clip, transcript)))
  },
)
