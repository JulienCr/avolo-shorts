import { defaultPlatformAvailability, type Platform, type PlatformAvailability } from '@/core/publication'
import type { PublicationAdapter } from '@/server/publication/adapter'
import { createUploadPostAdapter } from '@/server/publication/upload-post'

/**
 * Déclaration canonique du registre de connecteurs (contrat de la PR
 * « Wave B (UI) », section « SHARED SEAM »). Un futur `meta.ts` s'y ajoute par
 * une seule ligne, placée **avant** Upload Post — Meta direct est gratuit et
 * autorise 100 publications par 24 h, contre 10 par mois sur le palier
 * gratuit d'Upload Post — sans rien restructurer ici.
 */
export function publicationAdapters(): PublicationAdapter[] {
  return [createUploadPostAdapter()]
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
