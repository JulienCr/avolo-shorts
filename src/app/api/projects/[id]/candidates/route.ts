import { getClips, getDb, getProject } from '@/server/db'
import { introuvable, json, route } from '@/server/http'
import { candidat, transcriptDuProjet } from '@/server/vues'

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
  async (_requête: Request, contexte: { params: Promise<{ id: string }> }) => {
    const { id } = await contexte.params
    const db = getDb()
    const projet = getProject(db, id)
    if (projet === undefined) throw introuvable(`Projet inconnu : ${id}`)

    const transcript = await transcriptDuProjet(projet)
    return json(getClips(db, id).map((clip) => candidat(clip, transcript)))
  },
)
