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
  createProject,
  exportClip,
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
import type { TranscriptLine } from '@/lib/editing'

export const cles = {
  projets: ['projets'] as const,
  projet: (projectId: string) => ['projet', projectId] as const,
  candidats: (projectId: string) => ['candidats', projectId] as const,
  /**
   * Le préfixe de **toutes** les listes de candidats, pour les invalider sans
   * connaître le projet. TanStack apparie par préfixe : une clé plus courte
   * couvre toutes celles qui commencent par elle.
   *
   * Un test tient les deux ensemble — une divergence rendrait l'invalidation
   * silencieusement sans effet, ce qui est le pire des deux mondes.
   */
  tousCandidats: ['candidats'] as const,
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
}

export function useProjets() {
  return useQuery({
    queryKey: cles.projets,
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
    // exécuterait `relevéPrésence` vingt et une fois, sur un montage 9p, toutes
    // les deux secondes.
    refetchInterval: (query) => (query.state.data?.some((p) => p.running !== null) ? 2_000 : false),
  })
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

    onSuccess({ clip, outputs, framing, seq }: PatchClipResult, { clipId, projectId }, contexte) {
      // **Le plancher du serveur, avant tout le reste.** Nos jetons viennent de
      // l'horloge ; une horloge remise en arrière nous ferait produire des
      // numéros que le serveur a déjà dépassés, donc des écritures refusées
      // jusqu'à ce qu'elle rattrape. Une réponse suffit à se recaler, et ce
      // recalage vaut même pour une réponse qu'on s'apprête à ignorer.
      // (relevé par Copilot)
      if (seq > dernierJeton) dernierJeton = seq

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
      client.setQueryData<ClipDetail>(cles.clip(clipId), (detail) =>
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
    onSuccess(_resultat, { clipId }) {
      void client.invalidateQueries({ queryKey: cles.clip(clipId) })
      void client.invalidateQueries({ queryKey: cles.tousCandidats })
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
export function useCreerProjet() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (source: string) => createProject(source),
    onSuccess() {
      void client.invalidateQueries({ queryKey: cles.projets })
    },
  })
}

/**
 * Relancer une analyse : la reprise d'une exécution morte, et le repérage forcé.
 *
 * **Les deux gestes, un seul hook.** Ils ne diffèrent que par leurs arguments —
 * `CIBLES_DE_REPRISE` sans `force` pour l'une, `'candidates'` avec `force` pour
 * l'autre — et par ce que l'écran dit avant de les déclencher. Leur fraîcheur,
 * elle, est la même.
 *
 * **L'état du projet s'invalide, et c'est la règle qui compte.** `useProjet`
 * n'interroge en boucle que tant que `running` est non nul (`refetchInterval`
 * rend `false` au repos) : après le 202, le cache porte encore `running: null`,
 * l'interrogation ne repart pas, et l'écran resterait immobile devant une
 * analyse qui tourne — c'est-à-dire exactement l'impasse que le bouton de
 * reprise existe pour fermer.
 *
 * **Les candidats aussi.** Un repérage forcé remplace les propositions en
 * attente (`effacerArtefact` retire `candidates.json` avant de toucher à la
 * base) : la liste en cache décrit alors la passe d'avant. Par clé complète et
 * non par préfixe, contrairement à `useExporter` : on connaît le projet ici.
 *
 * **Pas d'écriture optimiste.** La réponse est un 202 qui rend un `RunPlan` : ce
 * qu'elle confirme, c'est que l'analyse est acceptée, pas qu'elle est faite. Il
 * n'y a rien à afficher par avance, et `isPending` ne dure que le temps de
 * l'aller-retour.
 *
 * **Un 409 est un cas nommé, pas un échec générique.** `lancer` lève
 * `ExécutionEnCoursError` quand une exécution tourne déjà, et la route en fait
 * un 409 : `ApiError` porte le code, et l'écran a de quoi dire « une exécution
 * tourne déjà » plutôt que « la relance a échoué ».
 */
export function useRelancer() {
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
    onSuccess(_plan, { projectId }) {
      // **Les candidats, seulement au succès.** Une relance refusée n'a rien
      // lancé : la liste décrit toujours la même passe, et la recharger ferait
      // payer une requête pour un état identique.
      void client.invalidateQueries({ queryKey: cles.candidats(projectId) })
    },
    onSettled(_plan, _erreur, { projectId }) {
      // **L'état du projet, quoi qu'il arrive — et surtout quand ça échoue.**
      // Un 409 dit qu'une exécution tourne déjà : c'est exactement le moment où
      // l'écran doit aller la chercher. Invalider au seul succès laissait le
      // cache sur `running: null`, donc `useProjet` sans interrogation en boucle
      // — et l'écran promettait de suivre une exécution qu'il ne verrait jamais.
      // (relevé par Copilot)
      void client.invalidateQueries({ queryKey: cles.projet(projectId) })
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
  return useQuery({ queryKey: cles.settings, queryFn: fetchSettings })
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
 * projets ou les candidats laisserait croire le contraire.
 */
export function useSaveSettings() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (patch: SettingsPatch) => saveSettings(patch),
    onSuccess(settings: Settings) {
      client.setQueryData(cles.settings, settings)
    },
  })
}

/**
 * Arrêter l'analyse en cours d'un projet.
 *
 * **L'état du projet s'invalide quoi qu'il arrive**, comme pour `useRelancer` et
 * pour la même raison inversée : après l'arrêt, `running` doit retomber à `null`
 * tout de suite. `useProjet` interroge en boucle tant que quelque chose tourne,
 * donc le prochain sondage le verrait de toute façon — mais deux secondes plus
 * tard, sur la seule surface censée dire ce qui se passe.
 *
 * **La bibliothèque aussi** : `useProjets` n'interroge en boucle que tant qu'un
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
    onSettled(_resultat, _erreur, projectId) {
      void client.invalidateQueries({ queryKey: cles.projet(projectId) })
      void client.invalidateQueries({ queryKey: cles.projets })
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
 * Pas d'interrogation en boucle : contrairement à `useProjet`, rien ici ne
 * suit une exécution en cours. Une retranscription se voit ailleurs — l'état
 * du projet, que `useRelancer` invalide déjà — et cette liste se rafraîchit
 * en revenant sur l'écran, comme `useCandidats`.
 */
export function useTranscript(projectId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: cles.transcript(projectId),
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
      client.setQueryData(cles.transcript(projectId), (lignes: TranscriptLine[] | undefined) =>
        lignes?.map((l) => (l.id === line.id ? line : l)),
      )
    },
  })
}
