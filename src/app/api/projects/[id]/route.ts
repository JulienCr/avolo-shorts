import { getDb, getProject } from '@/server/db'
import { introuvable, json, route } from '@/server/http'
import { progression, relevéPrésence } from '@/server/run'
import { résuméProjet } from '@/server/vues'

/**
 * `GET /api/projects/:id` — l'état d'un projet : ce qui est là, et ce qui tourne.
 *
 * **`steps` se relit sur le disque à chaque appel**, il n'est jamais servi
 * depuis une mémoire de processus. C'est ce qui fait qu'un redémarrage de Next —
 * et il y en a un à chaque édition en développement — ne perd que le suivi
 * d'avancement, jamais la vérité.
 */
export const GET = route(
  'GET /api/projects/:id',
  async (_requête: Request, contexte: { params: Promise<{ id: string }> }) => {
    const { id } = await contexte.params
    const projet = getProject(getDb(), id)
    if (projet === undefined) throw introuvable(`Projet inconnu : ${id}`)

    return json({
      project: résuméProjet(projet),
      steps: await relevéPrésence(projet),
      running: progression(id),
    })
  },
)
