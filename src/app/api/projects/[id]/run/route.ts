import { z } from 'zod'

import { corps, json, route } from '@/server/http'
import { CIBLES_LANÇABLES, lancer } from '@/server/run'

/**
 * `POST /api/projects/:id/run` — recalculer jusqu'à une ou plusieurs cibles.
 *
 * C'est la route qui porte la reprise (spec §12) : on nomme un résultat, le
 * système remonte les dépendances, refait ce qui manque, et s'arrête là.
 * **Demander `candidates` sur un projet dont le transcript existe ne relance que
 * le repérage** — et la réponse le dit, puisqu'elle rend le plan.
 *
 * `renders` n'est pas une cible ici : un rendu se demande par clip, parce que
 * c'est par clip qu'on choisit ratio, cadrage et sous-titres. Voir
 * `POST /api/clips/:id/export`.
 */

const CIBLE = z.enum(CIBLES_LANÇABLES)

const DEMANDE = z.strictObject({
  /**
   * Une cible, ou plusieurs.
   *
   * **Une cible nomme un résultat à atteindre, pas une étape à refaire**, et
   * c'est ce qui rend la liste nécessaire : `lancer` en prend une depuis
   * toujours, `créerProjet` lui en passe trois, et le bouton de reprise a besoin
   * des mêmes. Viser `candidates` seul ne construit jamais le proxy, puisque
   * rien n'en dépend dans le graphe — le transcript lit le WAV, pas la vidéo.
   * L'écran devrait alors enchaîner deux appels en attendant la fin du premier,
   * séquence que l'interface n'a aucune raison de porter (spec §9.4).
   *
   * **La forme à une cible reste valide**, et pas seulement par égard pour les
   * appelants existants : c'est la forme du cas le plus fréquent, relancer le
   * repérage.
   *
   * **`.min(1)`, parce qu'un plan vide veut déjà dire autre chose.** Il dit
   * « tout était là, il n'y avait rien à faire », et l'écran l'affiche comme un
   * succès. Une liste vide acceptée répondrait donc « c'est fait » à une demande
   * qui ne visait rien.
   */
  target: z.union([CIBLE, z.array(CIBLE).min(1)]),
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
  force: z.union([z.boolean(), z.array(CIBLE)]).optional(),
})

export const POST = route(
  'POST /api/projects/:id/run',
  async (requête: Request, contexte: { params: Promise<{ id: string }> }) => {
    const { id } = await contexte.params
    const { target, force } = await corps(requête, DEMANDE)
    // **Une répétition se réduit, elle ne se refuse pas.** Le résultat d'une
    // liste qui se répète est parfaitement défini — `planPourCibles` ne planifie
    // jamais deux fois la même étape —, donc un 400 serait de la pédanterie.
    //
    // Mais la transmettre telle quelle ne l'était pas : `lancer` garde la liste
    // reçue dans `cibles`, et `status.json` la réécrit à chaque mise à jour,
    // jusqu'à une fois par seconde pendant les six minutes d'un proxy. Mille
    // `candidates` rendaient chaque écriture arbitrairement volumineuse pour un
    // plan identique. Dédupliquée, la liste est bornée par `CIBLES_LANÇABLES`.
    // (relevé par Copilot)
    const cibles = [...new Set(Array.isArray(target) ? target : [target])]
    const lancement = await lancer(id, cibles, {
      force: Array.isArray(force) ? [...new Set(force)] : force,
    })
    // 202 : accepté et lancé. Un plan vide est une réponse valide et fréquente —
    // tout est déjà là, il n'y avait rien à faire.
    return json(lancement, { status: 202 })
  },
)
