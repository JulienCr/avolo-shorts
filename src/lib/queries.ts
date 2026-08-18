'use client'

/**
 * Les accès aux données, vus par les composants.
 *
 * Rien ici ne sait d'où viennent les données : tout passe par `@/lib/api`. Le
 * jour où ses corps deviennent des `fetch` (tâche 10), ce fichier ne bouge pas
 * non plus.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  getClip,
  getProject,
  listCandidates,
  listProjects,
  patchClip,
  type CandidateClip,
  type Clip,
  type ClipDetail,
  type ClipPatch,
} from '@/lib/api'

export const cles = {
  projets: ['projets'] as const,
  projet: (projectId: string) => ['projet', projectId] as const,
  candidats: (projectId: string) => ['candidats', projectId] as const,
  clip: (clipId: string) => ['clip', clipId] as const,
}

export function useProjets() {
  return useQuery({ queryKey: cles.projets, queryFn: listProjects })
}

export function useProjet(projectId: string) {
  return useQuery({
    queryKey: cles.projet(projectId),
    queryFn: () => getProject(projectId),
    // L'analyse dure 30 à 45 minutes : tant qu'une exécution est en cours, on
    // redemande l'état toutes les deux secondes, et on s'arrête dès qu'elle est
    // finie. Interroger en permanence un projet au repos ne renseignerait
    // personne.
    refetchInterval: (query) => (query.state.data?.running ? 2_000 : false),
  })
}

export function useCandidats(projectId: string) {
  return useQuery({ queryKey: cles.candidats(projectId), queryFn: () => listCandidates(projectId) })
}

export function useClip(clipId: string) {
  return useQuery({ queryKey: cles.clip(clipId), queryFn: () => getClip(clipId) })
}

type Variables = { clipId: string; projectId: string; patch: ClipPatch }

/**
 * L'écriture, **optimiste**.
 *
 * Garder ou écarter doit tenir en un clic, sans boîte de dialogue et sans
 * attente : sur vingt-cinq candidats, un aller-retour serveur par carte
 * transforme le tri en file d'attente. On écrit donc le cache tout de suite, et
 * on ne le remet en cause que si l'écriture échoue.
 */
export function usePatchClip() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({ clipId, patch }: Variables) => patchClip(clipId, patch),

    async onMutate({ clipId, projectId, patch }: Variables) {
      // Annuler les requêtes en vol : une réponse partie avant la modification
      // arriverait après elle et l'écraserait.
      await client.cancelQueries({ queryKey: cles.candidats(projectId) })
      await client.cancelQueries({ queryKey: cles.clip(clipId) })

      // **L'instantané ne porte que le clip touché, pas la liste entière.**
      // Sur vingt-cinq cartes on en trie plusieurs par seconde, donc plusieurs
      // écritures se chevauchent : une liste complète capturée avant celle-ci,
      // restaurée telle quelle en cas d'échec, annulerait au passage les
      // décisions prises entre-temps sur les *autres* cartes — et qui, elles,
      // ont réussi.
      const precedentCandidat = client
        .getQueryData<CandidateClip[]>(cles.candidats(projectId))
        ?.find((c) => c.id === clipId)
      const precedentClip = client.getQueryData<ClipDetail>(cles.clip(clipId))?.clip

      client.setQueryData<CandidateClip[]>(cles.candidats(projectId), (liste) =>
        liste?.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
      )
      client.setQueryData<ClipDetail>(cles.clip(clipId), (detail) =>
        detail ? { ...detail, clip: { ...detail.clip, ...patch } } : detail,
      )

      return { precedentCandidat, precedentClip }
    },

    onError(_erreur, { clipId, projectId }, contexte) {
      // Remettre ce clip-là comme il était, **dans le cache tel qu'il est
      // maintenant** — pas invalider : invalider laisserait l'écran dans son
      // état optimiste, donc faux, le temps du rechargement.
      const precedentCandidat = contexte?.precedentCandidat
      if (precedentCandidat) {
        client.setQueryData<CandidateClip[]>(cles.candidats(projectId), (liste) =>
          liste?.map((c) => (c.id === clipId ? precedentCandidat : c)),
        )
      }
      const precedentClip = contexte?.precedentClip
      if (precedentClip) {
        client.setQueryData<ClipDetail>(cles.clip(clipId), (detail) =>
          detail ? { ...detail, clip: precedentClip } : detail,
        )
      }
    },

    onSuccess(clip: Clip, { clipId, projectId }) {
      // Le serveur normalise les segments (tâche 10, étape 2) : c'est sa version
      // qui fait foi, pas celle qu'on lui a envoyée. Là encore, on ne touche que
      // l'entrée concernée.
      client.setQueryData<CandidateClip[]>(cles.candidats(projectId), (liste) =>
        liste?.map((c) => (c.id === clipId ? { ...c, ...clip } : c)),
      )
      client.setQueryData<ClipDetail>(cles.clip(clipId), (detail) =>
        detail ? { ...detail, clip } : detail,
      )
    },
  })
}
