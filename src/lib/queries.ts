'use client'

/**
 * Les accès aux données, vus par les composants.
 *
 * Rien ici ne sait d'où viennent les données : tout passe par `@/lib/api`. Le
 * passage des fixtures au `fetch` n'a d'ailleurs rien changé à ce fichier — ce
 * qu'il porte, ce sont les règles de fraîcheur, pas la provenance : quand
 * redemander l'état, quand invalider les candidats, et comment une écriture
 * optimiste se défait.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import {
  getClip,
  getProject,
  listCandidates,
  listProjects,
  patchClip,
  type CandidateClip,
  type ClipDetail,
  type ClipPatch,
  type PatchClipResult,
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
  const client = useQueryClient()

  const requête = useQuery({
    queryKey: cles.projet(projectId),
    queryFn: () => getProject(projectId),
    // L'analyse dure 30 à 45 minutes : tant qu'une exécution est en cours, on
    // redemande l'état toutes les deux secondes, et on s'arrête dès qu'elle est
    // finie. Interroger en permanence un projet au repos ne renseignerait
    // personne.
    refetchInterval: (query) => (query.state.data?.running ? 2_000 : false),
  })

  // **La fin d'une exécution invalide les candidats.** Ouvrir l'écran de tri
  // avant que le repérage n'ait rendu quoi que ce soit met une liste vide en
  // cache, et rien ne la remplace : `useCandidats` n'interroge pas en boucle, et
  // seule cette requête-ci suit l'avancement. La grille restait donc vide
  // jusqu'à un rechargement complet — sur une analyse de quarante minutes, c'est
  // le moment exact où l'on regarde. Le proxy arrivant après les candidats, la
  // même invalidation fait apparaître les vignettes. (relevé par Codex)
  const enCours = requête.data?.running != null
  const tournait = useRef(false)
  useEffect(() => {
    if (tournait.current && !enCours) {
      void client.invalidateQueries({ queryKey: cles.candidats(projectId) })
    }
    tournait.current = enCours
  }, [enCours, client, projectId])

  return requête
}

export function useCandidats(projectId: string) {
  return useQuery({ queryKey: cles.candidats(projectId), queryFn: () => listCandidates(projectId) })
}

export function useClip(clipId: string) {
  return useQuery({ queryKey: cles.clip(clipId), queryFn: () => getClip(clipId) })
}

type Variables = {
  clipId: string
  projectId: string
  patch: ClipPatch
  /**
   * **Posé par `onMutate`, jamais par l'appelant.** C'est le seul canal qui aille
   * de `onMutate` à `mutationFn` : le contexte que `onMutate` rend part vers
   * `onSuccess` et `onError`, pas vers la fonction qui lance la requête, et les
   * deux reçoivent en revanche le même objet de variables.
   */
  seq?: number
}

/**
 * Le dernier jeton d'ordre distribué. Au module, donc partagé par tous les
 * écrans et tous les clips — la comparaison, elle, se fait par clip côté
 * serveur, et une horloge commune ne coûte rien.
 */
let dernierJeton = 0

/**
 * Le dernier jeton parti par clip, et les clips dont deux écritures se sont
 * chevauchées. **Au module, comme le jeton lui-même.**
 *
 * Portés par des `useRef`, ils vivaient une fois par instance du hook — or
 * l'écran de tri et l'écran de clip l'instancient chacun de leur côté. Une
 * écriture qui survit à la navigation (elle part en `keepalive`) croisait alors
 * celle du nouvel écran sans qu'aucune des deux instances ne voie l'autre : la
 * garde de réponse et la relecture de réconciliation raisonnaient chacune sur la
 * moitié des faits. La base restait juste — le jeton, lui, était déjà commun —
 * mais le cache pouvait s'arrêter sur le clip le plus ancien. (relevé par
 * Copilot)
 */
const derniereÉcriture = new Map<string, number>()
const clipsChevauchés = new Set<string>()

/**
 * Le numéro d'ordre du **geste**, à envoyer au serveur.
 *
 * Il part de l'horloge et non de zéro, et c'est ce qui le distingue du compteur
 * `derniere` plus bas. Ce dernier ordonne les réponses dans un cache qui meurt
 * avec la page : reparti de zéro à chaque montage, il conviendrait très bien.
 * Le serveur, lui, garde le dernier jeton appliqué **entre deux
 * rechargements** : un compteur remis à 1 y arriverait derrière tout ce que la
 * session précédente a écrit, et le serveur refuserait une modification
 * parfaitement fraîche. C'est le défaut inverse de celui qu'on corrige, et il
 * coûte plus cher — une écriture perdue plutôt qu'une écriture désordonnée.
 *
 * Strictement croissant, même sur deux gestes tombés dans la même milliseconde :
 * `Date.now()` ne les distinguerait pas, et le serveur accepte les jetons égaux
 * — deux écritures se retrouveraient départagées par leur ordre d'arrivée,
 * c'est-à-dire par ce dont on se méfie.
 *
 * **À appeler dans la pile du geste lui-même**, c'est-à-dire avant le premier
 * point d'attente de `onMutate`. Voir la note qui accompagne son appel.
 */
function jetonDuGeste(): number {
  const maintenant = Date.now()
  dernierJeton = maintenant > dernierJeton ? maintenant : dernierJeton + 1
  return dernierJeton
}

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

  // **Le numéro du dernier geste parti, par clip.**
  //
  // Deux clics rapides sur la même carte se chevauchent : si le second réussit
  // avant que le premier n'échoue, le rollback du premier écraserait une
  // décision pourtant confirmée. Et une réponse tardive du premier écraserait
  // de même celle du second. On ne tient donc compte d'une réponse que si elle
  // est encore la dernière écriture lancée sur ce clip.
  //
  // **C'est le jeton envoyé au serveur, pas un second compteur.** Il l'a été,
  // et il était pris après les points d'attente de `onMutate` : deux gestes
  // pouvaient y prendre leurs numéros dans le désordre, et la garde se trompait
  // alors sur laquelle des deux réponses était la dernière — le même défaut que
  // côté serveur, un étage plus haut. Un seul numéro, pris une seule fois, ne
  // peut pas donner deux ordres différents. (relevé par Copilot)

  // **Les clips dont deux écritures se sont réellement chevauchées.**
  //
  // La garde ci-dessus travaille sur la réponse **entière**, alors que le
  // serveur, lui, ordonne champ par champ : un `{ title }` ancien et un
  // `{ status }` récent qui se croisent sont tous les deux écrits en base, mais
  // le cache ne garde que la réponse la plus récente — celle du `status`, qui
  // porte le titre d'avant — et ignore l'autre. Le cache diverge alors de la
  // base jusqu'au prochain chargement. (relevé par Copilot)
  //
  // Reproduire la comparaison par champ ici ne suffirait pas : le serveur
  // modifie aussi des champs que personne n'a demandés — remonter un clip
  // exporté le repasse en `kept` et efface ses sorties. Seule une relecture dit
  // la vérité, et on ne la paie que dans le cas qui la rend nécessaire.

  /**
   * Les écritures en vol sur ce clip, **celle qui appelle comprise** :
   * `onMutate` et `onSettled` s'exécutent tous deux avant que TanStack ne sorte
   * la mutation de l'état `pending`.
   */
  const enVol = (clipId: string): number =>
    client.isMutating({
      predicate: (mutation) => (mutation.state.variables as Variables | undefined)?.clipId === clipId,
    })

  return useMutation({
    // Le jeton a été posé sur ces variables par `onMutate`, qui s'exécute avant.
    mutationFn: ({ clipId, patch, seq }: Variables) => patchClip(clipId, patch, seq),

    async onMutate(variables: Variables) {
      const { clipId, projectId, patch } = variables

      // **Le jeton se prend ici, avant le premier `await`.**
      //
      // Ces quelques lignes s'exécutent dans la pile du geste lui-même —
      // TanStack appelle `onMutate` sans rien attendre avant —, donc deux clics
      // successifs prennent leurs jetons dans l'ordre où ils ont eu lieu. Le
      // prendre dans `mutationFn` serait plus tard mais **pas plus tard dans le
      // même ordre** : `mutationFn` ne part qu'une fois `onMutate` terminé, et
      // `cancelQueries` ne dure pas le même temps pour tout le monde — le second
      // geste, qui n'a plus rien à annuler puisque le premier vient de le faire,
      // peut finir avant lui et prendre le plus petit numéro. Le vieux geste
      // passerait alors pour le plus récent, ce qui est exactement le défaut que
      // ce jeton existe pour fermer. (relevé par Codex)
      const jeton = jetonDuGeste()
      variables.seq = jeton
      derniereÉcriture.set(clipId, jeton)
      // Deux, parce que celle-ci y est déjà.
      if (enVol(clipId) > 1) clipsChevauchés.add(clipId)

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

      return { precedentCandidat, precedentClip, jeton: variables.seq }
    },

    onError(_erreur, { clipId, projectId }, contexte) {
      // Une écriture dépassée ne défait pas celle qui l'a suivie.
      if (contexte?.jeton !== derniereÉcriture.get(clipId)) return

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

    onSuccess({ clip, outputs }: PatchClipResult, { clipId, projectId }, contexte) {
      // Idem à l'endroit : une réponse arrivée après celle d'une écriture plus
      // récente remettrait l'ancien état, sans erreur et sans trace.
      if (contexte?.jeton !== derniereÉcriture.get(clipId)) return

      // Le serveur normalise les segments (tâche 10, étape 2) : c'est sa version
      // qui fait foi, pas celle qu'on lui a envoyée. Là encore, on ne touche que
      // l'entrée concernée.
      //
      // **Le même geste que `applied` soit vrai ou faux.** Refusée, l'écriture
      // rend le clip *gagnant* : l'adopter est exactement ce qu'il faut faire —
      // c'est l'état de la base, et c'est le seul chemin par lequel une écriture
      // venue d'un autre onglet revient à l'écran sans rechargement.
      client.setQueryData<CandidateClip[]>(cles.candidats(projectId), (liste) =>
        liste?.map((c) => (c.id === clipId ? { ...c, ...clip } : c)),
      )
      // Les sorties viennent du serveur elles aussi : une écriture qui remonte
      // un clip exporté écarte ses MP4, et le cache ne doit pas garder l'URL
      // d'un fichier que ce `PATCH` vient de faire disparaître.
      client.setQueryData<ClipDetail>(cles.clip(clipId), (detail) =>
        detail ? { ...detail, clip, outputs } : detail,
      )
    },

    /**
     * La réconciliation, **une seule fois, à la fin de la rafale**.
     *
     * Pas à chaque écriture : le détail d'un clip porte sa fenêtre de
     * transcript, et la redemander après chaque geste ferait payer un montage
     * entier pour un cas qui ne se produit qu'en cas de croisement. Pas non plus
     * pendant la rafale, sans quoi la relecture partirait avant que les
     * écritures qu'elle doit refléter ne soient arrivées.
     *
     * Le rollback de `onError`, lui, reste immédiat : une invalidation laisserait
     * l'écran dans son état optimiste, donc faux, le temps du rechargement.
     */
    onSettled(_données, _erreur, { clipId, projectId }: Variables) {
      if (!clipsChevauchés.has(clipId)) return
      // Une, parce que celle-ci y est encore.
      if (enVol(clipId) > 1) return
      clipsChevauchés.delete(clipId)
      void client.invalidateQueries({ queryKey: cles.clip(clipId) })
      void client.invalidateQueries({ queryKey: cles.candidats(projectId) })
    },
  })
}
