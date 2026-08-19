/**
 * Le pipeline se comporte comme un `make` (spec §5) : on demande une cible, et
 * le système recalcule ce qui manque en amont. Rien d'autre. Changer de logo ne
 * doit pas retranscrire deux heures d'audio.
 *
 * **En itération 0, « à jour » veut dire « le fichier est là ».** Pas encore de
 * clé de validité — version d'outil, paramètres, empreinte des entrées —, c'est
 * l'itération 4 (spec §4). D'où la signature : `planSteps` reçoit un relevé de
 * présence déjà fait, elle ne regarde jamais le disque. C'est ce qui la rend
 * testable en CI sans GPU, sans ffmpeg et sans vidéo.
 */

/** Les six étapes, chacune adossée à un artefact. */
export type StepName = 'proxy' | 'audio' | 'transcript' | 'analysis' | 'candidates' | 'renders'

/**
 * Le graphe, écrit dans le sens « ce dont j'ai besoin ».
 *
 * `proxy` et `audio` ne dépendent que de la source, qui n'est pas une étape :
 * elle est là ou le projet n'existe pas. Et **`transcript` ne dépend pas du
 * proxy** : WhisperX lit le WAV, pas la vidéo. Viser le transcript ne doit donc
 * pas déclencher douze minutes de proxy pour rien — c'est tout l'intérêt de
 * décrire le graphe plutôt que d'aligner les étapes dans une liste.
 *
 * **`analysis` dépend du proxy, et de lui seul.** YOLO et le score de scène de
 * ffmpeg tournent sur le proxy 960x540 (spec §6) ; ni le WAV ni le transcript
 * n'entrent dans un calcul d'image. La symétrie avec `transcript` est exacte :
 * l'une lit le son, l'autre lit l'image, et aucune n'attend l'autre.
 *
 * `renders` ne dépend pas encore d'`analysis`. Le cadrage automatique arrive
 * dans la même itération mais par un autre chemin — le rendu se lance par clip
 * (`POST /api/clips/:id/export`), pas par le graphe —, et lui inventer une
 * dépendance ici ferait recalculer les rendus au premier changement de modèle
 * sans que personne ne l'ait demandé.
 */
const DEPS: Record<StepName, readonly StepName[]> = {
  proxy: [],
  audio: [],
  transcript: ['audio'],
  analysis: ['proxy'],
  candidates: ['transcript'],
  renders: ['candidates'],
}

/**
 * Ce qu'il faut exécuter, et dans quel ordre, pour atteindre `target`.
 *
 * - `exists` : le relevé de présence des artefacts, fait par l'appelant
 *   (`src/server/run.ts`), qui seul a le droit de toucher au disque.
 * - `force` : les étapes à refaire même si leur artefact est là. Le drapeau
 *   court-circuite la présence pour le cas où les paramètres n'ont pas changé
 *   mais où l'on veut malgré tout d'autres propositions (spec §5).
 *
 * **`force` entraîne l'aval avec lui.** Reforcer le transcript sans reprendre le
 * repérage ni les rendus laisserait sur le disque des candidats calculés sur un
 * texte qui n'existe plus — la contradiction silencieuse que le graphe est censé
 * empêcher. Une étape se refait donc dès qu'une de ses dépendances est forcée.
 *
 * **La présence, elle, ne remonte pas.** Un artefact présent est bon, et ce qui
 * l'a produit ne le regarde plus : une dépendance absente sous un artefact
 * présent n'est pas reconstruite. C'est ce qui distingue ce graphe d'un `make`,
 * et ce que le sidecar exige — voir `àRefaire` plus bas.
 *
 * Une étape nommée dans `force` mais qui ne mène pas à `target` est ignorée :
 * forcer le proxy en demandant le transcript ne construit pas le proxy. `force`
 * dit *comment* atteindre la cible, il n'en ajoute pas d'autre.
 *
 * L'ordre rendu est celui de l'exécution : toute étape y apparaît après ses
 * dépendances.
 */
export function shotSteps(
  target: StepName,
  exists: Record<StepName, boolean>,
  forced: readonly StepName[] = [],
): StepName[] {
  const forced = new Set(forced)

  // Deux questions distinctes, et les confondre est le piège de cet étage.
  //
  // 1. « Une étape en amont va-t-elle être refaite ? » — seul `force` la pose,
  //    et elle descend le graphe.
  // 2. « Faut-il fabriquer une dépendance absente ? » — elle ne se pose que si
  //    l'étape courante doit elle-même être fabriquée.
  //
  // Les mélanger fait remonter la *présence* comme le fait un `make`, et
  // reconstruit alors une dépendance absente sous un artefact déjà là.
  const forcedInUpstream = (step: StepName): boolean =>
    forced.has(step) || DEPS[step].some(forcedInUpstream)

  /**
   * Une étape présente est une étape bonne — c'est la définition même du graphe
   * par présence. Ce que sa fabrication a consommé ne la regarde plus.
   *
   * Le cas qui l'exige est le cas courant : le transcript vit dans un sidecar à
   * côté de la vidéo et survit à la suppression du projet, `audio.wav` non.
   * Recréer le projet donne donc `transcript: true, audio: false`, et remonter
   * la présence rendrait le WAV puis retranscrirait deux heures cinquante — pour
   * réécrire à l'identique le fichier qu'on avait déjà.
   */
  const toRedo = (step: StepName): boolean => forcedInUpstream(step) || !exists[step]

  const shot: StepName[] = []
  const registered = new Set<StepName>()

  const schedule = (step: StepName): void => {
    if (registered.has(step)) return
    registered.add(step)
    // Les dépendances d'abord : c'est ce qui les place avant dans le plan.
    for (const dep of DEPS[step]) {
      if (toRedo(dep)) schedule(dep)
    }
    shot.push(step)
  }

  if (toRedo(target)) schedule(target)
  return shot
}
