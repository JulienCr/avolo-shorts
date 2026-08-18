'use client'

import { useQuery } from '@tanstack/react-query'

import { listSources } from '@/lib/api'

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
 * `listerSources` sonde un montage 9p sous délai de garde, et une sonde de plus
 * toutes les deux secondes prendrait les fils du vivier de libuv que l'analyse en
 * cours utilise.
 */
export const cleSources = ['sources'] as const

export function useSources() {
  return useQuery({ queryKey: cleSources, queryFn: listSources })
}
