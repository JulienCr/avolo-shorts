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

/** Les cinq étapes de l'itération 0, chacune adossée à un artefact. */
export type StepName = 'proxy' | 'audio' | 'transcript' | 'candidates' | 'renders'

/**
 * Le graphe, écrit dans le sens « ce dont j'ai besoin ».
 *
 * `proxy` et `audio` ne dépendent que de la source, qui n'est pas une étape :
 * elle est là ou le projet n'existe pas. Et **`transcript` ne dépend pas du
 * proxy** : WhisperX lit le WAV, pas la vidéo. Viser le transcript ne doit donc
 * pas déclencher douze minutes de proxy pour rien — c'est tout l'intérêt de
 * décrire le graphe plutôt que d'aligner les étapes dans une liste.
 */
const DEPS: Record<StepName, readonly StepName[]> = {
  proxy: [],
  audio: [],
  transcript: ['audio'],
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
 * empêcher. Une étape se refait donc dès qu'une de ses dépendances se refait.
 *
 * Une étape nommée dans `force` mais qui ne mène pas à `target` est ignorée :
 * forcer le proxy en demandant le transcript ne construit pas le proxy. `force`
 * dit *comment* atteindre la cible, il n'en ajoute pas d'autre.
 *
 * L'ordre rendu est celui de l'exécution : toute étape y apparaît après ses
 * dépendances.
 */
export function planSteps(
  target: StepName,
  exists: Record<StepName, boolean>,
  force: readonly StepName[] = [],
): StepName[] {
  const forcées = new Set(force)
  const plan: StepName[] = []
  // Mémoïsation : un graphe en losange visiterait sinon deux fois la même
  // branche, et l'inscrirait deux fois au plan.
  const àRefaire = new Map<StepName, boolean>()

  const visiter = (step: StepName): boolean => {
    const connu = àRefaire.get(step)
    if (connu !== undefined) return connu

    // Les dépendances d'abord, toutes : c'est ce qui les place avant dans le
    // plan, et ce qui propage un `force` vers l'aval. Pas de `some` ni de `||`
    // en tête de boucle — un court-circuit sauterait la visite d'une dépendance,
    // donc son inscription au plan.
    let refaire = false
    for (const dep of DEPS[step]) {
      if (visiter(dep)) refaire = true
    }

    refaire = refaire || forcées.has(step) || !exists[step]
    àRefaire.set(step, refaire)
    if (refaire) plan.push(step)
    return refaire
  }

  visiter(target)
  return plan
}
