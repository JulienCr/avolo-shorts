import { json, route } from '@/server/http'
import { publicationAvailability } from '@/server/publication'

/**
 * `GET /api/publication/availability` — chaque plateforme est-elle branchée ?
 *
 * Même discipline que `GET /api/llm/availability` : ne lit jamais un secret,
 * seulement sa présence, via `publicationAvailability` (`@/server/publication`).
 * **Genuinement asynchrone**, contrairement à la version LLM — elle interroge
 * Upload Post en direct, mise en cache 60 s par l'adaptateur lui-même
 * (`upload-post.ts`) : cette route n'ajoute pas un second cache.
 */
export const GET = route('GET /api/publication/availability', async () =>
  json(await publicationAvailability()),
)
