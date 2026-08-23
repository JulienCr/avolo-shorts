import { PLATFORMS, defaultPlatformAvailability, type Platform, type PlatformAvailability } from '@/core/publication'
import { effectiveSettings, getDb } from '@/server/db'
import type { PublicationAdapter } from '@/server/publication/adapter'
import { createMetaAdapter } from '@/server/publication/meta'
import { createTikTokAdapter } from '@/server/publication/tiktok'
import { createUploadPostAdapter } from '@/server/publication/upload-post'

/**
 * Déclaration canonique du registre de connecteurs (contrat de la PR
 * « Wave B (UI) », section « SHARED SEAM »). TikTok direct et Meta passent
 * **avant** Upload Post, à plateforme égale — gratuit l'emporte sur dix
 * téléversements par mois (issue #146), et Upload Post n'a jamais porté
 * TikTok que sur une offre payante — un ordre délibéré, pas un accident.
 *
 * Mémorisé : `groupByAdapter` (`service.ts`) regroupe par identité d'objet, et
 * une instance neuve à chaque appel ferait manquer tout regroupement entre
 * deux plateformes prises par le même connecteur.
 */
let adapters: PublicationAdapter[] | undefined
export function publicationAdapters(): PublicationAdapter[] {
  adapters ??= [createTikTokAdapter(), createMetaAdapter(), createUploadPostAdapter()]
  return adapters
}

/**
 * L'adaptateur qui prend cette plateforme.
 *
 * **Le réglage `publication.<plateforme>` décide, l'ordre du tableau retombe.**
 * Une préférence qui nomme un connecteur enregistré et le portant l'emporte ;
 * `auto`, ou un identifiant sans registre (`tiktok` avant que son adaptateur
 * n'existe), retombe sur le premier du tableau à porter la plateforme — jamais
 * une erreur, jamais `undefined` pour cette seule raison.
 */
export function adapterFor(platform: Platform): PublicationAdapter | undefined {
  const adapters = publicationAdapters()
  const preference = effectiveSettings(getDb()).publication[platform]
  if (preference !== 'auto') {
    const preferred = adapters.find((adapter) => adapter.id === preference)
    if (preferred !== undefined && preferred.platforms.includes(platform)) return preferred
  }
  return adapters.find((adapter) => adapter.platforms.includes(platform))
}

/**
 * L'état de chaque plateforme, résolu depuis le même adaptateur que
 * `adapterFor` — sinon la disponibilité affichée peut porter sur un
 * connecteur différent de celui qui publiera réellement.
 */
export async function publicationAvailability(): Promise<Record<Platform, PlatformAvailability>> {
  const merged = defaultPlatformAvailability() as Record<Platform, PlatformAvailability>
  const cache = new Map<PublicationAdapter, Record<Platform, PlatformAvailability>>()
  for (const platform of PLATFORMS) {
    const adapter = adapterFor(platform)
    if (adapter === undefined) continue
    let state = cache.get(adapter)
    if (state === undefined) {
      state = await adapter.availability(process.env)
      cache.set(adapter, state)
    }
    merged[platform] = state[platform]
  }
  return merged
}
