import { z } from 'zod'

import { corps, json, route } from '@/server/http'
import { CIBLES_LANÇABLES, lancer } from '@/server/run'

/**
 * `POST /api/projects/:id/run` — recalculer jusqu'à une cible.
 *
 * C'est la route qui porte la reprise (spec §12) : on nomme une étape, le
 * système remonte les dépendances, refait ce qui manque, et s'arrête là.
 * **Demander `candidates` sur un projet dont le transcript existe ne relance que
 * le repérage** — et la réponse le dit, puisqu'elle rend le plan.
 *
 * `renders` n'est pas une cible ici : un rendu se demande par clip, parce que
 * c'est par clip qu'on choisit ratio, cadrage et sous-titres. Voir
 * `POST /api/clips/:id/export`.
 */

const DEMANDE = z.strictObject({
  target: z.enum(CIBLES_LANÇABLES),
  /**
   * Les étapes à refaire même si leur artefact est là. `true` vaut « la cible »,
   * ce qui couvre le cas courant — relancer le repérage pour obtenir d'autres
   * propositions sans avoir changé un paramètre (spec §5).
   *
   * `force` entraîne l'aval avec lui, mais c'est `planSteps` qui s'en charge :
   * cette route ne fait que transmettre.
   *
   * **Les mêmes étapes que `target`, pas une de plus.** `renders` y était admis
   * et n'y servait à rien : aucune cible lançable n'en dépend, donc `planSteps`
   * l'ignore, et le client recevait un 202 dont le plan ne parlait pas de ce
   * qu'il venait de demander. (relevé par Aristarque)
   */
  force: z.union([z.boolean(), z.array(z.enum(CIBLES_LANÇABLES))]).optional(),
})

export const POST = route(
  'POST /api/projects/:id/run',
  async (requête: Request, contexte: { params: Promise<{ id: string }> }) => {
    const { id } = await contexte.params
    const { target, force } = await corps(requête, DEMANDE)
    const lancement = await lancer(id, [target], { force })
    // 202 : accepté et lancé. Un plan vide est une réponse valide et fréquente —
    // tout est déjà là, il n'y avait rien à faire.
    return json(lancement, { status: 202 })
  },
)
