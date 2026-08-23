import { json, route } from '@/server/http'
import { publicationAvailability } from '@/server/publication'

/**
 * `GET /api/publication/availability` — chaque plateforme est-elle branchée ?
 *
 * Même discipline que `GET /api/llm/availability` : le secret sert à
 * interroger Upload Post (`publicationAvailability`, `@/server/publication`),
 * mais ne quitte jamais le serveur — la réponse ne porte que la disponibilité
 * par plateforme, jamais la clé elle-même. (relevé par Copilot)
 * **Genuinement asynchrone**, contrairement à la version LLM — elle interroge
 * Upload Post en direct, mise en cache 60 s par l'adaptateur lui-même
 * (`upload-post.ts`) : cette route n'ajoute pas un second cache.
 */
export const GET = route('GET /api/publication/availability', async () =>
  json(await publicationAvailability()),
)
