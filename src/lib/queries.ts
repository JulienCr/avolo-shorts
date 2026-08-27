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

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import {
  createProject,
  exportClip,
  fetchLlmAvailability,
  fetchSettings,
  getClip,
  getProject,
  listCandidates,
  listProjects,
  patchClip,
  runProject,
  saveSettings,
  stopAnalysis,
  type CandidateClip,
  type ClipDetail,
  type ClipPatch,
  type PatchClipResult,
  type RunTarget,
  type Settings,
  type SettingsPatch,
} from '@/lib/api'
// Import à part du bloc au-dessus : ce fichier est partagé avec une autre PR
// en cours, et la règle est d'ajouter en fin de fichier sans réordonner
// l'existant — y compris ses imports.
import { correctTranscript, getTranscript, type TranscriptCorrectionRequest } from '@/lib/api'
// Import à part, même règle : ce fichier est partagé avec une autre PR en
// cours, on ajoute en fin de fichier sans réordonner l'existant.
import { postRegenerateHook } from '@/lib/api'
// Import à part, même règle, pour la même raison.
import { getCorrectionHistory, removeCorrectionEntry, undoCorrection } from '@/lib/api'
// Import à part, même règle, pour la même raison.
import { fetchPublicationAvailability, getPublications, publishClip } from '@/lib/api'
// Import à part, même règle, pour la même raison.
import {
  listPlanningPool,
  listPlanningSchedule,
  schedulePublication,
  unschedulePublication,
} from '@/lib/api'
import type { TranscriptLine } from '@/lib/editing'
import type { Platform, PublicationRecord } from '@/core/publication'

export const keys = {
  projets: ['projects'] as const,
  projet: (projectId: string) => ['project', projectId] as const,
  candidats: (projectId: string) => ['candidates', projectId] as const,
  /**
   * Le préfixe de **toutes** les listes de candidats, pour les invalider sans
   * connaître le projet. TanStack apparie par préfixe : une clé plus courte
   * couvre toutes celles qui commencent par elle.
   *
   * Un test tient les deux ensemble — une divergence rendrait l'invalidation
   * silencieusement sans effet, ce qui est le pire des deux mondes.
   */
  tousCandidats: ['candidates'] as const,
  clip: (clipId: string) => ['clip', clipId] as const,
  /**
   * Les réglages, une seule entrée pour toute l'application.
   *
   * Pas de clé par famille : la route rend l'objet entier — c'est ce qui permet
   * à l'écran d'afficher les valeurs *effectives* après une écriture partielle —
   * et deux entrées pour un même corps se périmeraient l'une sans l'autre.
   */
  settings: ['settings'] as const,
  /** Le transcript entier d'une émission — pas la fenêtre autour d'un clip. */
  transcript: (projectId: string) => ['transcript', projectId] as const,
  /** L'historique de la correction automatique — voir `useCorrectionHistory`. */
  correctionHistory: (projectId: string) => ['correction-history', projectId] as const,
  /** La disponibilité des fournisseurs de langage — voir `useLlmAvailability`. */
  llmAvailability: ['llm-availability'] as const,
  /** La disponibilité des plateformes de publication — voir `usePublicationAvailability`. */
  publicationAvailability: ['publication-availability'] as const,
  /** Les publications d'un clip — voir `usePublications`. */
  publications: (clipId: string) => ['publications', clipId] as const,
  /** Le vivier du planning : clips exportés, à jour, pas encore programmés. */
  planningPool: ['planning-pool'] as const,
  /** Le calendrier du planning entre deux bornes — voir `usePlanningSchedule`. */
  planningSchedule: (from: number, to: number) => ['planning-schedule', from, to] as const,
}

export function useProjects() {
  return useQuery({
    queryKey: keys.projets,
    queryFn: listProjects,
    // **Le sondage de la bibliothèque**, et il ne coûte que ce qu'il rapporte :
    // tant qu'au moins une analyse tourne, on redemande la liste toutes les deux
    // secondes ; sinon on se tait. C'est ce qui rend supportable de lancer une
    // analyse puis d'aller trier un autre projet — l'état arrive tout seul, sans
    // qu'on ait à revenir voir.
    //
    // Le prix est celui d'un `GET /api/projects` : une lecture de la base, une
    // lecture de `Map` et un petit fichier local par projet. **Rien qui touche au
    // Drive**, et c'est la raison pour laquelle `ProjectListItem` ne porte que
    // ces deux champs-là (`src/lib/api.ts`) : sonder l'état complet d'un projet
    // exécuterait `readingPresence` vingt et une fois, sur un montage 9p, toutes
    // les deux secondes.
    refetchInterval: (query) => (query.state.data?.some((p) => p.running !== null) ? 2_000 : false),
  })
}

export function useProject(projectId: string, options: { enabled?: boolean } = {}) {
  const client = useQueryClient()

  const request = useQuery({
    queryKey: keys.projet(projectId),
    queryFn: () => getProject(projectId),
    enabled: options.enabled ?? true,
    // L'analyse dure 30 à 45 minutes : tant qu'une exécution est en cours, on
    // redemande l'état toutes les deux secondes, et on s'arrête dès qu'elle est
    // finie. Interroger en permanence un projet au repos ne renseignerait
    // personne.
    refetchInterval: (query) => (query.state.data?.running ? 2_000 : false),
  })

  // **La fin d'une exécution invalide les candidats — et le transcript.**
  // Ouvrir l'écran de tri avant que le repérage n'ait rendu quoi que ce soit
  // met une liste vide en cache, et rien ne la remplace : `useCandidates`
  // n'interroge pas en boucle, et seule cette requête-ci suit l'avancement. La
  // grille restait donc vide jusqu'à un rechargement complet — sur une analyse
  // de quarante minutes, c'est le moment exact où l'on regarde. Le proxy
  // arrivant après les candidats, la même invalidation fait apparaître les
  // vignettes. (relevé par Codex)
  //
  // **Le transcript pour la même raison** : une retranscription remplace le
  // sidecar, mais le panneau reste monté et sa requête reste fraîche trente
  // secondes (`src/app/providers.tsx`) — sans cette invalidation il continue
  // d'afficher l'ancien texte après la fin de WhisperX, et une correction
  // dessus échouerait en 409 sur une ancre déjà périmée. (relevé par Copilot
  // et par Aristarque)
  const inCurrent = request.data?.running != null
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !inCurrent) {
      void client.invalidateQueries({ queryKey: keys.candidats(projectId) })
      void client.invalidateQueries({ queryKey: keys.transcript(projectId) })
    }
    wasRunning.current = inCurrent
  }, [inCurrent, client, projectId])

  return request
}

export function useCandidates(projectId: string) {
  return useQuery({ queryKey: keys.candidats(projectId), queryFn: () => listCandidates(projectId) })
}

export function useClip(clipId: string) {
  return useQuery({ queryKey: keys.clip(clipId), queryFn: () => getClip(clipId) })
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
let lastToken = 0

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
const lastWrite = new Map<string, number>()
const clipsOverlapping = new Set<string>()

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
function gestureToken(): number {
  const now = Date.now()
  lastToken = now > lastToken ? now : lastToken + 1
  return lastToken
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
  const inFlight = (clipId: string): number =>
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
      const token = gestureToken()
      variables.seq = token
      lastWrite.set(clipId, token)
      // Deux, parce que celle-ci y est déjà.
      if (inFlight(clipId) > 1) clipsOverlapping.add(clipId)

      // Annuler les requêtes en vol : une réponse partie avant la modification
      // arriverait après elle et l'écraserait.
      await client.cancelQueries({ queryKey: keys.candidats(projectId) })
      await client.cancelQueries({ queryKey: keys.clip(clipId) })

      // **L'instantané ne porte que le clip touché, pas la liste entière.**
      // Sur vingt-cinq cartes on en trie plusieurs par seconde, donc plusieurs
      // écritures se chevauchent : une liste complète capturée avant celle-ci,
      // restaurée telle quelle en cas d'échec, annulerait au passage les
      // décisions prises entre-temps sur les *autres* cartes — et qui, elles,
      // ont réussi.
      const previousCandidate = client
        .getQueryData<CandidateClip[]>(keys.candidats(projectId))
        ?.find((c) => c.id === clipId)
      const previousClip = client.getQueryData<ClipDetail>(keys.clip(clipId))?.clip

      client.setQueryData<CandidateClip[]>(keys.candidats(projectId), (list) =>
        list?.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
      )
      client.setQueryData<ClipDetail>(keys.clip(clipId), (detail) =>
        detail ? { ...detail, clip: { ...detail.clip, ...patch } } : detail,
      )

      return { previousCandidate, previousClip, jeton: variables.seq }
    },

    onError(_error, { clipId, projectId }, context) {
      // Une écriture dépassée ne défait pas celle qui l'a suivie.
      if (context?.jeton !== lastWrite.get(clipId)) return

      // Remettre ce clip-là comme il était, **dans le cache tel qu'il est
      // maintenant** — pas invalider : invalider laisserait l'écran dans son
      // état optimiste, donc faux, le temps du rechargement.
      const previousCandidate = context?.previousCandidate
      if (previousCandidate) {
        client.setQueryData<CandidateClip[]>(keys.candidats(projectId), (list) =>
          list?.map((c) => (c.id === clipId ? previousCandidate : c)),
        )
      }
      const previousClip = context?.previousClip
      if (previousClip) {
        client.setQueryData<ClipDetail>(keys.clip(clipId), (detail) =>
          detail ? { ...detail, clip: previousClip } : detail,
        )
      }
    },

    onSuccess({ clip, outputs, framing, seq }: PatchClipResult, { clipId, projectId }, context) {
      // **Le plancher du serveur, avant tout le reste.** Nos jetons viennent de
      // l'horloge ; une horloge remise en arrière nous ferait produire des
      // numéros que le serveur a déjà dépassés, donc des écritures refusées
      // jusqu'à ce qu'elle rattrape. Une réponse suffit à se recaler, et ce
      // recalage vaut même pour une réponse qu'on s'apprête à ignorer.
      // (relevé par Copilot)
      if (seq > lastToken) lastToken = seq

      // Idem à l'endroit : une réponse arrivée après celle d'une écriture plus
      // récente remettrait l'ancien état, sans erreur et sans trace.
      if (context?.jeton !== lastWrite.get(clipId)) return

      // Le serveur normalise les segments (tâche 10, étape 2) : c'est sa version
      // qui fait foi, pas celle qu'on lui a envoyée. Là encore, on ne touche que
      // l'entrée concernée.
      //
      // **Le même geste que `applied` soit vrai ou faux.** Refusée, l'écriture
      // rend le clip *gagnant* : l'adopter est exactement ce qu'il faut faire —
      // c'est l'état de la base, et c'est le seul chemin par lequel une écriture
      // venue d'un autre onglet revient à l'écran sans rechargement.
      client.setQueryData<CandidateClip[]>(keys.candidats(projectId), (list) =>
        list?.map((c) => (c.id === clipId ? { ...c, ...clip } : c)),
      )
      // Les sorties viennent du serveur elles aussi : une écriture qui remonte
      // un clip exporté écarte ses MP4, et le cache ne doit pas garder l'URL
      // d'un fichier que ce `PATCH` vient de faire disparaître.
      //
      // **Le cadrage aussi, et c'est celui des trois qui bouge le plus souvent.**
      // Le ratio et les crops se recalculent sur les segments et ne sont pas
      // stockés : retirer un passage peut les changer sans qu'aucun geste de
      // cadrage n'ait eu lieu. Ne pas l'adopter laisserait le rectangle, l'aperçu
      // et le panneau d'export sur le cadrage d'avant la coupe jusqu'à la
      // prochaine navigation — pendant que l'export, lui, utiliserait déjà le
      // nouveau. C'est exactement le mensonge que le champ existe pour fermer, et
      // le publier sans l'adopter le déplace d'un cran au lieu de le refermer.
      // (relevé par Codex)
      client.setQueryData<ClipDetail>(keys.clip(clipId), (detail) =>
        detail ? { ...detail, clip, outputs, framing } : detail,
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
    onSettled(_data, _error, { clipId, projectId }: Variables) {
      if (!clipsOverlapping.has(clipId)) return
      // Une, parce que celle-ci y est encore.
      if (inFlight(clipId) > 1) return
      clipsOverlapping.delete(clipId)
      void client.invalidateQueries({ queryKey: keys.clip(clipId) })
      void client.invalidateQueries({ queryKey: keys.candidats(projectId) })
    },
  })
}

/**
 * Rendre un clip. **Synchrone, et long : de dix secondes à une minute.**
 *
 * Le hook n'en fait pas une écriture optimiste, contrairement au tri : il n'y a
 * rien à afficher par avance, et l'attente est à montrer plutôt qu'à absorber —
 * un bouton muet pendant une minute passe pour cassé. `isPending` est donc la
 * surface d'attente de l'écran d'export, pas un détail d'implémentation.
 *
 * **Le clip s'invalide après coup**, et c'est la première des deux règles de
 * fraîcheur. `ExportResult` rend des **noms de fichiers** — publier les chemins
 * absolus du serveur exposerait l'arborescence de la machine — alors que ce sont
 * les `ClipOutputs` de `GET /api/clips/:id` qui portent les URL lisibles par un
 * `<video>` ou un `<a>`. Adopter la réponse dans le cache laisserait donc les
 * sorties telles qu'elles étaient avant le rendu.
 *
 * **Les listes de candidats aussi**, et c'est la seconde. Le rendu pose
 * `exported`, et ce statut vit dans la même liste que le compte des gardés, la
 * phase du projet et le clip suivant à monter : sans cela la carte resterait sur
 * « gardé » tant que la liste est en cache. Par préfixe, faute de connaître le
 * projet ici — une liste inactive n'est alors pas rechargée, seulement marquée
 * périmée. (relevé par Copilot)
 *
 * **`skipped: true` est un cas nominal**, et le plus fréquent quand on rouvre un
 * clip déjà exporté : rien n'a été refait, tout est en place. Le traiter comme
 * une erreur ferait passer un export réussi pour un échec.
 *
 * **Et `ExportResult.clip` est facultatif.** Une passe de repérage qui se
 * termine pendant le rendu réécrit le jeu de clips du projet, et la route
 * sérialise alors un corps sans ce champ : rien ici ne le lit, et un appelant
 * qui voudrait le faire doit le garder.
 */
export function useExporter() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({ clipId, force }: { clipId: string; force?: boolean }) =>
      exportClip(clipId, force),
    onSuccess(_result, { clipId }) {
      void client.invalidateQueries({ queryKey: keys.clip(clipId) })
      void client.invalidateQueries({ queryKey: keys.tousCandidats })
    },
  })
}

/**
 * Ingérer un replay et lancer son analyse.
 *
 * **La liste des projets s'invalide** : le nouveau projet doit y apparaître, et
 * c'est la seule chose que cette réponse change de ce qui est en cache.
 *
 * **La redirection appartient à l'écran, pas au hook.** La réponse est un 202 et
 * rend un `RunPlan` : elle confirme que l'analyse est acceptée et lancée, pas
 * qu'elle est faite. Ce qu'on fait de `projectId` — y aller, l'annoncer, rester
 * sur la grille — est une décision de parcours, et un hook qui naviguerait
 * empêcherait d'en changer sans le réécrire.
 */
export function useCreateProject() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (source: string) => createProject(source),
    onSuccess() {
      void client.invalidateQueries({ queryKey: keys.projets })
    },
  })
}

/**
 * Relancer une analyse : la reprise d'une exécution morte, et le repérage forcé.
 *
 * **Les deux gestes, un seul hook.** Ils ne diffèrent que par leurs arguments —
 * `RESUME_TARGETS` sans `force` pour l'une, `'candidates'` avec `force` pour
 * l'autre — et par ce que l'écran dit avant de les déclencher. Leur fraîcheur,
 * elle, est la même.
 *
 * **L'état du projet s'invalide, et c'est la règle qui compte.** `useProject`
 * n'interroge en boucle que tant que `running` est non nul (`refetchInterval`
 * rend `false` au repos) : après le 202, le cache porte encore `running: null`,
 * l'interrogation ne repart pas, et l'écran resterait immobile devant une
 * analyse qui tourne — c'est-à-dire exactement l'impasse que le bouton de
 * reprise existe pour fermer.
 *
 * **Les candidats aussi.** Un repérage forcé remplace les propositions en
 * attente (`eraseArtifact` retire `candidates.json` avant de toucher à la
 * base) : la liste en cache décrit alors la passe d'avant. Par clé complète et
 * non par préfixe, contrairement à `useExporter` : on connaît le projet ici.
 *
 * **Pas d'écriture optimiste.** La réponse est un 202 qui rend un `RunPlan` : ce
 * qu'elle confirme, c'est que l'analyse est acceptée, pas qu'elle est faite. Il
 * n'y a rien à afficher par avance, et `isPending` ne dure que le temps de
 * l'aller-retour.
 *
 * **Un 409 est un cas nommé, pas un échec générique.** `launch` lève
 * `ExecutionInCurrentError` quand une exécution tourne déjà, et la route en fait
 * un 409 : `ApiError` porte le code, et l'écran a de quoi dire « une exécution
 * tourne déjà » plutôt que « la relance a échoué ».
 */
export function useRetry() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({
      projectId,
      targets,
      force,
    }: {
      projectId: string
      targets: RunTarget | readonly RunTarget[]
      force?: boolean | readonly RunTarget[]
    }) => runProject(projectId, targets, force),
    onSuccess(_shot, { projectId }) {
      // **Les candidats, seulement au succès.** Une relance refusée n'a rien
      // lancé : la liste décrit toujours la même passe, et la recharger ferait
      // payer une requête pour un état identique.
      void client.invalidateQueries({ queryKey: keys.candidats(projectId) })
    },
    onSettled(_shot, _error, { projectId }) {
      // **L'état du projet, quoi qu'il arrive — et surtout quand ça échoue.**
      // Un 409 dit qu'une exécution tourne déjà : c'est exactement le moment où
      // l'écran doit aller la chercher. Invalider au seul succès laissait le
      // cache sur `running: null`, donc `useProject` sans interrogation en boucle
      // — et l'écran promettait de suivre une exécution qu'il ne verrait jamais.
      // (relevé par Copilot)
      void client.invalidateQueries({ queryKey: keys.projet(projectId) })
    },
  })
}

/**
 * Les réglages effectifs.
 *
 * **Aucune interrogation en boucle, et pas d'invalidation au retour sur la
 * page** : ce sont des valeurs que seul cet écran modifie, sur cette machine.
 * Les redemander périodiquement coûterait une requête pour un état qui ne change
 * que quand on le change.
 */
export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: fetchSettings })
}

/**
 * Écrire un patch de réglages.
 *
 * **La réponse remplace le cache, elle ne l'invalide pas.** La route rend les
 * réglages *résultants* — la base complétée par les défauts, champs non touchés
 * compris —, donc il n'y a rien à aller rechercher. Invalider ferait une seconde
 * requête pour obtenir exactement le corps qu'on vient de recevoir.
 *
 * **Pas d'écriture optimiste**, contrairement au tri : un réglage refusé pour
 * cause de valeur hors bornes est un cas courant — on tape « 0 » dans un champ
 * dont le plancher est 1 —, et l'affichage doit revenir à la valeur qui
 * s'applique, pas à celle qu'on a tapée.
 *
 * **Rien d'autre ne s'invalide, et c'est la règle qui compte** : changer un
 * réglage ne recalcule aucune émission (retour d'usage §6.1). Invalider les
 * projets ou les candidats laisserait croire le contraire. Deux exceptions.
 * La disponibilité de publication : depuis que `publication.<plateforme>`
 * choisit le connecteur, l'état affiché dépend du réglage — sans invalidation
 * il resterait celui de l'ancien connecteur jusqu'aux 30 s de `staleTime`.
 * Et `framing` : `GET /api/clips/:id` calcule désormais `ClipDetail.framing`
 * et `outputs` sur ces réglages (issue #180) — sans invalidation, rouvrir un
 * clip déjà en cache dans les 30 s montre l'ancien split ou une URL déjà
 * périmée côté serveur.
 */
export function useSaveSettings() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (patch: SettingsPatch) => saveSettings(patch),
    onSuccess(settings: Settings, patch: SettingsPatch) {
      client.setQueryData(keys.settings, settings)
      if (patch.publication !== undefined) {
        void client.invalidateQueries({ queryKey: keys.publicationAvailability })
      }
      if (patch.framing !== undefined) {
        void client.invalidateQueries({ queryKey: ['clip'] })
      }
    },
  })
}

/**
 * Arrêter l'analyse en cours d'un projet.
 *
 * **L'état du projet s'invalide quoi qu'il arrive**, comme pour `useRetry` et
 * pour la même raison inversée : après l'arrêt, `running` doit retomber à `null`
 * tout de suite. `useProject` interroge en boucle tant que quelque chose tourne,
 * donc le prochain sondage le verrait de toute façon — mais deux secondes plus
 * tard, sur la seule surface censée dire ce qui se passe.
 *
 * **La bibliothèque aussi** : `useProjects` n'interroge en boucle que tant qu'un
 * projet porte un `running`. Sans cette invalidation, une liste ouverte dans un
 * autre onglet garderait l'analyse arrêtée pour vivante, et son sondage
 * s'arrêterait sur cet état-là.
 *
 * **`stopped: false` n'est pas un échec.** Rien ne tournait — l'analyse venait
 * de finir, ou un redémarrage du serveur a emporté l'exécution. L'écran n'a rien
 * à dire de plus que ce que l'état rafraîchi montre déjà.
 *
 * **Les candidats ne s'invalident pas.** Un arrêt ne produit rien : les
 * propositions à l'écran sont exactement celles d'avant.
 */
export function useStopAnalysis() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (projectId: string) => stopAnalysis(projectId),
    onSettled(_result, _error, projectId) {
      void client.invalidateQueries({ queryKey: keys.projet(projectId) })
      void client.invalidateQueries({ queryKey: keys.projets })
    },
  })
}

// ---------------------------------------------------------------------------
// Le transcript de l'émission (vue Émission, §2.3)
// ---------------------------------------------------------------------------

/**
 * Le transcript entier d'une émission.
 *
 * **`enabled` par défaut à `true`, mais la surface qui l'appelle le pose à
 * `false` tant qu'elle n'est pas ouverte.** Une émission fait ~20 000 mots :
 * les tirer à chaque montage de la vue Émission, qu'on ouvre le transcript ou
 * non, paierait une requête inutile la plupart du temps — la vue Émission se
 * monte à chaque visite du projet, le transcript s'ouvre rarement.
 *
 * Pas d'interrogation en boucle : contrairement à `useProject`, rien ici ne
 * suit une exécution en cours. Une retranscription se voit ailleurs — l'état
 * du projet, que `useRetry` invalide déjà — et cette liste se rafraîchit
 * en revenant sur l'écran, comme `useCandidates`.
 */
export function useTranscript(projectId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: keys.transcript(projectId),
    queryFn: () => getTranscript(projectId),
    enabled: options.enabled ?? true,
  })
}

/**
 * Écrit une correction manuelle sur le sidecar, une phrase à la fois.
 *
 * **Pas d'écriture optimiste.** Contrairement au tri, une correction refusée
 * — l'ancre ne correspond plus (409), l'empan déborde (400) — doit montrer le
 * texte tel qu'il est vraiment sur le disque, jamais celui qu'on vient de
 * taper : afficher la frappe par avance ferait croire à une correction
 * acceptée qui ne l'était pas.
 *
 * **Le cache se remplace par la réponse, il ne s'invalide pas.** La route
 * rend la phrase telle qu'elle vient d'être écrite et relue ; redemander tout
 * le transcript pour une correction d'un mot coûterait un aller-retour de
 * vingt mille mots pour obtenir exactement ce qu'on tient déjà.
 *
 * **Une phrase vidée de tous ses mots est retirée du cache, pas seulement
 * remplacée.** `transcriptLines` (`src/server/views.ts`) écarte déjà une
 * phrase sans mot aligné — c'est ce qu'un `GET` frais rendrait après une
 * suppression totale. Remplacer sans filtrer laissait une ligne fantôme, sans
 * mot, à son horodatage d'avant : le sidecar était correct, seul le cache
 * divergeait de ce que le serveur aurait rendu. (relevé en review)
 */
export function useCorrectTranscript() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({
      projectId,
      correction,
    }: {
      projectId: string
      correction: TranscriptCorrectionRequest
    }) => correctTranscript(projectId, correction),
    onSuccess({ line }, { projectId }) {
      client.setQueryData(keys.transcript(projectId), (lines: TranscriptLine[] | undefined) =>
        lines
          ?.map((l) => (l.id === line.id ? line : l))
          .filter((l) => l.words.length > 0),
      )
    },
    // **Un 409 laisse le cache sur la version périmée qui a causé le refus.**
    // `expected` ne correspondait plus à l'ancre : ce que le cache tient est
    // donc déjà faux, et la requête reste fraîche trente secondes
    // (`src/app/providers.tsx`) — fermer puis rouvrir le tiroir ne
    // garantit pas un `GET`. Invalider force la relecture du texte
    // réellement sur le disque. (relevé par Copilot)
    onError(_error, { projectId }) {
      void client.invalidateQueries({ queryKey: keys.transcript(projectId) })
    },
  })
}

/**
 * La disponibilité des trois fournisseurs de langage.
 *
 * **Comme `useSettings` : aucune interrogation en boucle.** Une clé ne
 * s'ajoute ou ne disparaît pas pendant qu'un onglet reste ouvert — c'est une
 * variable d'environnement du serveur —, donc la redemander périodiquement
 * coûterait une requête pour un état qui ne change qu'à un redémarrage.
 */
export function useLlmAvailability() {
  return useQuery({ queryKey: keys.llmAvailability, queryFn: fetchLlmAvailability })
}

/**
 * Régénère le hook du clip par le modèle — le bouton « Régénérer » de
 * `hook-fields.tsx`, seul appelant.
 *
 * **Pas d'écriture optimiste.** Contrairement au tri, on ne sait pas d'avance
 * ce que le modèle va rendre ; le champ affiche un état « en cours » pendant
 * l'appel plutôt qu'une valeur devinée.
 *
 * **Le cache se pose depuis la réponse, sans redemander le clip — mais seul
 * `hookText` en est tiré.** `POST /api/clips/:id/hook` rend le clip entier
 * tel que le serveur vient de l'écrire, relu juste avant l'écriture
 * (`route.ts`). Ce jeu réseau tient jusqu'à 30 s (`TIMEOUT_MS`), assez pour
 * qu'un `PATCH` concurrent (édition du titre, de la description, du montage)
 * pose sur le cache une valeur plus récente que celle capturée par cette
 * relecture serveur : écraser `detail.clip` en entier avec `result.clip`
 * ferait revenir en arrière un champ que ce `PATCH` vient de faire avancer.
 * Ne fusionner que `hookText` — le seul champ que cette mutation possède —
 * laisse les autres au dernier écrivain qui les a réellement touchés.
 * (relevé par Aristarque)
 */
export function useRegenerateHook() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (clipId: string) => postRegenerateHook(clipId),
    onSuccess(result, clipId) {
      client.setQueryData<ClipDetail>(keys.clip(clipId), (detail) =>
        detail
          ? {
              ...detail,
              // `hookText` ET `hookBadge`, et **rien d'autre** : la règle
              // documentée juste au-dessus vaut mot pour mot pour ce second
              // champ — écraser `detail.clip` en entier remettrait en place
              // les champs qu'un `PATCH` concurrent a fait avancer pendant
              // l'appel.
              clip: {
                ...detail.clip,
                hookText: result.clip.hookText,
                hookBadge: result.clip.hookBadge,
              },
            }
          : detail,
      )
      // **La régénération peut désormais périmer le rendu exporté**
      // (`discardRenderStale`, `src/app/api/clips/[id]/hook/route.ts`) :
      // le statut peut redescendre d'`exported` à `kept`, et les sorties
      // disparaître du disque. La fusion ci-dessus ne porte volontairement
      // que `hookText`/`hookBadge`, donc c'est cette invalidation qui relit
      // le statut et les sorties à jour — en arrière-plan, sans écraser
      // tout de suite le cache et donc sans revenir en arrière sur un
      // `PATCH` concurrent. (relevé par Copilot)
      void client.invalidateQueries({ queryKey: keys.clip(clipId) })
      void client.invalidateQueries({ queryKey: keys.candidats(result.clip.projectId) })
    },
  })
}

// ---------------------------------------------------------------------------
// La correction automatique du transcript (§2.3, spec §9 étage 2)
// ---------------------------------------------------------------------------

/**
 * L'historique de la correction automatique — les substitutions déjà
 * appliquées pendant l'analyse (spec §9, correction du 23 août 2026).
 *
 * **Pas d'interrogation en boucle** : une correction automatique ne
 * s'applique que pendant une exécution du graphe, dont `useProject` suit déjà
 * `running`. La liste se rafraîchit en revenant sur l'écran, comme
 * `useTranscript`.
 */
export function useCorrectionHistory(projectId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: keys.correctionHistory(projectId),
    queryFn: () => getCorrectionHistory(projectId),
    enabled: options.enabled ?? true,
  })
}

/**
 * Défait une substitution de l'historique — l'inverse, par le même chemin
 * d'écriture que la correction manuelle.
 *
 * **Le cache se remplace par la réponse**, comme `useCorrectTranscript` : la
 * route rend le journal tel qu'il vient d'être écrit et relu, redemander
 * l'historique entier pour une substitution défaite coûterait un aller-retour
 * pour obtenir ce qu'on tient déjà.
 *
 * **Le transcript s'invalide aussi.** Défaire réécrit le mot sur le disque —
 * `useCorrectTranscript` remplace son cache depuis la réponse d'une écriture
 * qu'elle a elle-même déclenchée ; ici l'écriture vient de `undoCorrection`,
 * donc le cache du transcript, lui, ne porte encore que l'ancien mot.
 */
export function useUndoCorrection() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({ projectId, id }: { projectId: string; id: string }) => undoCorrection(projectId, id),
    onSuccess({ entries }, { projectId }) {
      client.setQueryData(keys.correctionHistory(projectId), entries)
      void client.invalidateQueries({ queryKey: keys.transcript(projectId) })
    },
  })
}

/**
 * Retire une entrée de l'historique sans toucher au transcript — le
 * rattrapage de dernier recours (issues #134, #138) pour une entrée dont
 * l'ancre est devenue périmée.
 *
 * **Le transcript ne s'invalide pas ici**, contrairement à `useUndoCorrection` :
 * ce geste n'écrit rien dessus, seulement sur le journal.
 */
export function useRemoveCorrectionEntry() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({ projectId, id }: { projectId: string; id: string }) => removeCorrectionEntry(projectId, id),
    onSuccess({ entries }, { projectId }) {
      client.setQueryData(keys.correctionHistory(projectId), entries)
    },
  })
}

/**
 * La disponibilité des quatre plateformes de publication.
 *
 * **Comme `useLlmAvailability` : aucune interrogation en boucle.** Un
 * connecteur ne se branche pas pendant qu'un onglet reste ouvert.
 */
export function usePublicationAvailability() {
  return useQuery({ queryKey: keys.publicationAvailability, queryFn: fetchPublicationAvailability })
}

/**
 * L'état des publications d'un clip.
 *
 * **Interroge en boucle tant qu'une ligne est `in_progress`, comme
 * `useProject` et `useRetry` sur `running`** : un envoi détaché
 * (`launchPublish`, `src/server/publication/service.ts`) écrit son résultat
 * plus tard, et rien d'autre ne prévient l'écran qu'il est arrivé.
 */
export function usePublications(clipId: string) {
  return useQuery({
    queryKey: keys.publications(clipId),
    queryFn: () => getPublications(clipId).then((r) => r.publications),
    refetchInterval: (query) =>
      query.state.data?.some((p) => p.status === 'in_progress') ? 2_000 : false,
  })
}

/**
 * Les publications de plusieurs clips à la fois, pour `PublishDialog` en
 * sélection groupée (vue Émission).
 *
 * **Un `GET` par clip, pas un lot** : la route ne prend qu'un identifiant
 * (`GET /api/clips/:id/publications`), comme `usePublisher` n'accepte qu'un
 * seul clip par `POST`. Sans cet appel, la modale ne voit jamais qu'une
 * plateforme est déjà `published` : elle la propose par défaut, et le serveur
 * refuse la publication groupée entière faute de `force`. (relevé par
 * Copilot, Codex et Aristarque)
 */
export function usePublicationRecordsByClip(clipIds: readonly string[]) {
  const results = useQueries({
    queries: clipIds.map((clipId) => ({
      queryKey: keys.publications(clipId),
      queryFn: () => getPublications(clipId).then((r) => r.publications),
      refetchInterval: (query: { state: { data?: { status: string }[] } }) =>
        query.state.data?.some((p) => p.status === 'in_progress') ? 2_000 : false,
    })),
  })

  const byClip: Record<string, Partial<Record<Platform, PublicationRecord>>> = {}
  // **Distincte de `byClip[clipId] === undefined`.** Ce dernier veut aussi
  // dire « ce clip n'est pas dans `clipIds` » — un absent n'a jamais chargé
  // ni échoué, il n'a simplement jamais été demandé. `pendingClipIds` ne
  // porte que les clips effectivement interrogés dont la réponse n'est pas
  // encore là. (relevé par Copilot)
  const pendingClipIds = new Set<string>()
  // Distincte de `pendingClipIds` : un échec définitif et un chargement en
  // cours appellent des conduites opposées, l'un se rattrape seul, l'autre pas.
  const failedClipIds = new Set<string>()
  clipIds.forEach((clipId, index) => {
    const result = results[index]
    if (result === undefined) return
    if (result.isPending) {
      pendingClipIds.add(clipId)
      return
    }
    if (result.isError) {
      failedClipIds.add(clipId)
      return
    }
    const rows = result.data
    if (rows === undefined) return
    byClip[clipId] = Object.fromEntries(
      rows.map((row) => [
        row.platform,
        {
          status: row.status,
          remoteUrl: row.remoteUrl,
          publishedFingerprint: row.publishedFingerprint,
          error: row.error,
          stale: row.stale,
        },
      ]),
    )
  })
  return { byClip, pendingClipIds, failedClipIds }
}

/**
 * Lance une publication — le bouton « Confirmer et publier » de `PublishDialog`.
 *
 * **Pas d'écriture optimiste** : la réponse porte les lignes `in_progress`
 * réelles (id de requête compris), que `usePublications` reprendra en boucle
 * jusqu'à leur état final.
 */
export function usePublisher() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({
      clipId,
      platforms,
      force,
    }: {
      clipId: string
      platforms: readonly Platform[]
      force?: boolean
    }) => publishClip(clipId, platforms, force),
    onSuccess(_result, { clipId }) {
      void client.invalidateQueries({ queryKey: keys.publications(clipId) })
    },
  })
}

/**
 * Le vivier du planning — clips exportés, à jour, pas encore programmés.
 *
 * **Pas de sondage** : rien ici ne change sans un geste de l'utilisateur,
 * contrairement à `usePublications` qui suit un envoi détaché.
 */
export function usePlanningPool() {
  return useQuery({ queryKey: keys.planningPool, queryFn: listPlanningPool })
}

/** Le calendrier entre deux bornes (ms, `to` exclu). */
export function usePlanningSchedule(from: number, to: number) {
  return useQuery({
    queryKey: keys.planningSchedule(from, to),
    queryFn: () => listPlanningSchedule(from, to),
  })
}

/**
 * Pose une échéance sur un ou plusieurs clips.
 *
 * **Invalide le vivier et le calendrier** : programmer retire un clip du
 * vivier et l'ajoute au calendrier, et un écran qui en montrerait un seul à
 * jour vaut moins qu'un écran qui redemande les deux.
 */
export function useSchedulePublication() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({ clipIds, scheduledAt }: { clipIds: readonly string[]; scheduledAt: number }) =>
      schedulePublication(clipIds, scheduledAt),
    onSuccess() {
      void client.invalidateQueries({ queryKey: keys.planningPool })
      void client.invalidateQueries({ queryKey: ['planning-schedule'] })
    },
  })
}

/** Retire une échéance encore `planned`, et remet ses clips au vivier. */
export function useUnschedulePublication() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (clipIds: readonly string[]) => unschedulePublication(clipIds),
    onSuccess() {
      void client.invalidateQueries({ queryKey: keys.planningPool })
      void client.invalidateQueries({ queryKey: ['planning-schedule'] })
    },
  })
}
