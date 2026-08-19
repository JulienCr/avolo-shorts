'use client'

import { useQuery, type QueryClient } from '@tanstack/react-query'

import { listSources, type SourcesListing } from '@/lib/api'

/**
 * Les replays du dossier des sources.
 *
 * **Aucune règle de fraîcheur particulière**, et c'est ce qui explique qu'il vive
 * ici plutôt qu'avec ses voisins de `@/lib/queries` : ce fichier-là porte les
 * règles de fraîcheur — quand redemander l'état, quand invalider les candidats,
 * comment une écriture optimiste se défait — et cette requête n'en a aucune. Le
 * dossier ne change que quand quelqu'un y dépose un replay, la bibliothèque est
 * son seul appelant, et son bouton « Réessayer » est la seule chose qui la
 * relance.
 *
 * Le sondage du dossier serait d'ailleurs le contraire de ce qu'il faut faire :
 * `listSources` sonde un montage 9p sous délai de garde, et une sonde de plus
 * toutes les deux secondes prendrait les fils du vivier de libuv que l'analyse en
 * cours utilise.
 */
export const keySources = ['sources'] as const

export function useSources() {
  return useQuery({ queryKey: keySources, queryFn: listSources })
}

/**
 * Inscrire dans le cache qu'une source vient d'être analysée.
 *
 * **Sans cela, la marque du projet met jusqu'à trente secondes à apparaître**, et
 * c'est exactement la fenêtre où l'on revient : `providers.tsx` pose un
 * `staleTime` de 30 s, et `useCreateProject` n'invalide que la liste des projets.
 * Revenir du projet qu'on vient de créer rejouait donc la liste des sources
 * telle qu'elle était avant — `projectId: null` —, la carte reproposait « Créer
 * le projet », et un second clic pendant l'analyse rend un 409
 * (`ExecutionInCurrentError`). C'est le défaut que la conception §3.1 nomme :
 * proposer deux chemins vers le même endroit sans le dire.
 * (relevé par Copilot et Codex)
 *
 * **On corrige le cache, on ne l'invalide pas.** `GET /api/sources` sonde le
 * montage 9p sous délai de garde, et une invalidation le paierait pour
 * apprendre ce que la réponse de création vient de dire. Rien d'autre ne change
 * dans le dossier du fait d'une création.
 */
export function markSourceAnalyzed(
  client: QueryClient,
  nameSource: string,
  projectId: string,
) {
  client.setQueryData<SourcesListing>(keySources, (listing) =>
    listing === undefined
      ? listing
      : {
          ...listing,
          sources: listing.sources.map((source) =>
            source.name === nameSource ? { ...source, projectId } : source,
          ),
        },
  )
}
