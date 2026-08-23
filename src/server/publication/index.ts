import { defaultPlatformAvailability, type Platform, type PlatformAvailability } from '@/core/publication'
import type { PublicationAdapter } from '@/server/publication/adapter'
import { createMetaAdapter } from '@/server/publication/meta'
import { createUploadPostAdapter } from '@/server/publication/upload-post'

/**
 * Déclaration canonique du registre de connecteurs (contrat de la PR
 * « Wave B (UI) », section « SHARED SEAM »). Meta est placé **avant** Upload
 * Post — à plateforme égale (Instagram, Facebook), gratuit et 100 publications
 * par 24 h l'emporte sur dix par mois (issue #146) — un ordre délibéré, pas un
 * accident d'insertion.
 */
export function publicationAdapters(): PublicationAdapter[] {
  return [createMetaAdapter(), createUploadPostAdapter()]
}

/** L'adaptateur qui prend cette plateforme — le premier du tableau à la porter. */
export function adapterFor(platform: Platform): PublicationAdapter | undefined {
  return publicationAdapters().find((adapter) => adapter.platforms.includes(platform))
}

/**
 * L'état de chaque plateforme, agrégé sur tous les adaptateurs.
 *
 * **Le dernier à répondre dans l'ordre de priorité l'emporte** : la boucle
 * parcourt le tableau à l'envers pour que le premier adaptateur (le plus
 * prioritaire) écrase en dernier, comme le veut `adapterFor` sur le même ordre.
 */
export async function publicationAvailability(): Promise<Record<Platform, PlatformAvailability>> {
  const merged = defaultPlatformAvailability() as Record<Platform, PlatformAvailability>
  const adapters = publicationAdapters()
  for (const adapter of [...adapters].reverse()) {
    const state = await adapter.availability(process.env)
    for (const platform of adapter.platforms) merged[platform] = state[platform]
  }
  return merged
}
