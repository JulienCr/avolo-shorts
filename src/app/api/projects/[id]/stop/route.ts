import { getDb, getProject } from '@/server/db'
import { introuvable, json, route } from '@/server/http'
import { stopRun } from '@/server/run'

/**
 * `POST /api/projects/:id/stop` — arrêter l'analyse en cours.
 *
 * **Un arrêt, pas une pause.** Il n'existe aucun mécanisme pour suspendre puis
 * reprendre exactement un ffmpeg ou un WhisperX ; ce que fait cette route est
 * tuer le travail en cours. Ce qui est déjà sur le disque reste, et
 * `POST /api/projects/:id/run` repart à la première étape manquante — c'est le
 * graphe, il n'y a pas de reprise à écrire (retour d'usage §4.1).
 *
 * **Idempotente, et les deux réponses sont des succès.** `stopped: false` dit
 * que rien ne tournait : l'analyse venait de finir, ou un redémarrage du serveur
 * a emporté l'exécution — la table des exécutions est celle du processus. Un
 * 409 ou un 404 dans ce cas ferait afficher une erreur à quelqu'un dont le
 * souhait est déjà réalisé.
 *
 * **404 reste pour le projet inconnu**, et il est distinct du précédent : l'un
 * dit « rien à arrêter », l'autre « ce projet n'existe pas ». Les confondre
 * ferait passer une faute de frappe dans l'identifiant pour un arrêt réussi.
 *
 * La réponse ne prouve pas que les processus sont morts, et ne peut pas le
 * prouver : `forwardAbort` laisse dix secondes à un `SIGTERM` avant le
 * `SIGKILL`, et attendre ferait patienter le navigateur d'autant. Ce qui dit que
 * l'arrêt a eu lieu est `running` qui retombe à `null` dans
 * `GET /api/projects/:id`, sur le sondage qui suivait déjà l'avancement.
 */
export const POST = route(
  'POST /api/projects/:id/stop',
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    if (getProject(getDb(), id) === undefined) throw introuvable(`Projet inconnu : ${id}`)
    return json({ stopped: stopRun(id) })
  },
)
