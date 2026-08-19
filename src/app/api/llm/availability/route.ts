import { LLM_PROVIDERS, type LlmAvailability } from '@/lib/api'
import { json, route } from '@/server/http'
import { disponibilitéDuFournisseur } from '@/server/llm/registry'

/**
 * `GET /api/llm/availability` — un fournisseur choisi a-t-il sa clé ?
 *
 * **Le critère du contrat de la PR C** : « un fournisseur sans clé se dit dans
 * l'écran, pas au milieu d'un repérage ». Cette route ne lit jamais la valeur
 * du secret — `disponibilitéDuFournisseur` (`@/server/llm/registry`) ne
 * regarde que sa présence, par `exigerSecret`, dont le message d'erreur est
 * déjà pensé pour ne rien fuiter.
 */
export const GET = route('GET /api/llm/availability', async () =>
  json(
    Object.fromEntries(
      LLM_PROVIDERS.map((provider) => [provider, disponibilitéDuFournisseur(provider)]),
    ) as LlmAvailability,
  ),
)
