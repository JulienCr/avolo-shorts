import { defaultPlatformAvailability, type Platform, type PlatformAvailability } from '@/core/publication'
import { effectiveSettings, getDb } from '@/server/db'
import type { PublicationAdapter } from '@/server/publication/adapter'
import { createMetaAdapter } from '@/server/publication/meta'
import { createUploadPostAdapter } from '@/server/publication/upload-post'

/**
 * Déclaration canonique du registre de connecteurs (contrat de la PR
 * « Wave B (UI) », section « SHARED SEAM »). Meta est placé **avant** Upload
 * Post — à plateforme égale (Instagram, Facebook), gratuit et 100 publications
 * par 24 h l'emporte sur dix par mois (issue #146) — un ordre délibéré, pas un
 * accident d'insertion.
 *
 * Mémorisé : `groupByAdapter` (`service.ts`) regroupe par identité d'objet, et
 * une instance neuve à chaque appel ferait manquer tout regroupement entre
 * deux plateformes prises par le même connecteur.
 */
let adapters: PublicationAdapter[] | undefined
export function publicationAdapters(): PublicationAdapter[] {
  adapters ??= [createMetaAdapter(), createUploadPostAdapter()]
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
