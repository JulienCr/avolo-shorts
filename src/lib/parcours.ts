/**
 * La navigation, décrite une fois.
 *
 * Trois écrans, et c'est le bon nombre : bibliothèque, projet, clip. Ce qui
 * manquait n'était pas un quatrième, c'était qu'aucun ne sache dire où l'on en
 * est ni ce qui vient ensuite — chacun construisait son fil d'Ariane à la main,
 * sous forme d'un tableau positionnel, et le modèle de navigation était donc
 * recopié trois fois.
 *
 * Ce module n'est pas dans `src/core/` : il compose des URL, ce qui est une
 * affaire d'interface. Il dépend de `@/core/parcours` pour la phase, jamais
 * l'inverse.
 */

import type { ClipStatus } from '@/core/edl'
import type { StepName } from '@/core/graph'
import { estGarde, type Phase } from '@/core/parcours'

/** De quoi nommer un projet dans un fil d'Ariane et y revenir. */
type Reperes = { id: string; titre: string }

/**
 * Où l'on est.
 *
 * ```
 * /                    bibliothèque
 *    v
 * /projects/:id        le projet : avancement, puis tri des candidats
 *    v
 * /clips/:id           le clip : transcript, cadrage, export
 * ```
 *
 * **La profondeur ne dépasse jamais trois, et chaque niveau se quitte par le
 * haut.** `inconnu` n'est pas un quatrième niveau : c'est le nom qu'on donne au
 * lieu tant que l'objet n'a pas répondu, ou quand il n'existe pas. Le fil
 * d'Ariane reste ainsi atteignable dans tous les états, y compris « clip
 * introuvable » — sinon la page d'erreur est elle-même une impasse.
 */
export type Lieu =
  | { kind: 'bibliotheque' }
  | { kind: 'projet'; projet: Reperes }
  | { kind: 'clip'; projet: Reperes; clip: { titre: string } }
  | { kind: 'settings' }
  | { kind: 'inconnu'; libelle: string }

/** L'URL d'un projet. Encodée : les identifiants portent accents et espaces. */
export function lienProjet(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`
}

/**
 * L'URL des paramètres.
 *
 * **Un frère de la bibliothèque, pas un quatrième étage.** Le nom anglais tranche
 * avec `lienProjet` et `lienClip`, ses deux voisins : le dépôt renomme ses
 * identifiants français par l'issue #73, et ce qui s'écrit après la règle ne
 * doit pas ajouter à la dette qu'elle solde.
 *
 * Les réglages ne décrivent aucune émission : ils se rejoignent depuis n'importe
 * où et se quittent par le haut, comme la racine. Les ranger sous une émission aurait
 * suggéré qu'ils lui appartiennent, alors que changer un réglage ne recalcule
 * rien — un recalcul reste une action explicite.
 */
export function settingsLink(): string {
  return '/settings'
}

/** L'URL d'un clip. Même règle : l'identifiant hérite de celui du projet. */
export function lienClip(clipId: string): string {
  return `/clips/${encodeURIComponent(clipId)}`
}

/**
 * Le fil d'Ariane du lieu.
 *
 * **La racine n'y figure pas** : la marque du produit occupe déjà ce cran dans
 * la barre d'application, et l'y répéter ferait deux fois le même lien. Le
 * dernier cran n'a pas de `href` — c'est l'écran où l'on est.
 */
export function chemin(lieu: Lieu): { libelle: string; href?: string }[] {
  switch (lieu.kind) {
    case 'bibliotheque':
      return []
    case 'projet':
      return [{ libelle: lieu.projet.titre }]
    case 'clip':
      return [
        { libelle: lieu.projet.titre, href: lienProjet(lieu.projet.id) },
        { libelle: lieu.clip.titre },
      ]
    case 'settings':
      return [{ libelle: 'Paramètres' }]
    case 'inconnu':
      return [{ libelle: lieu.libelle }]
  }
}

/**
 * Ce qui fait avancer depuis une phase donnée.
 *
 * **L'attente est un résultat de plein droit**, avec sa raison et ce qui la
 * lèvera. C'est le défaut qu'a révélé le couple `{ triable, trie }` : Julien a
 * fini de trier avant que le proxy ne soit encodé, il n'a aucune action qui
 * fasse avancer le montage, et une règle « aucune phase sans action » aurait
 * obligé à en inventer une. L'écran dira donc que le montage s'ouvrira avec le
 * proxy, et proposera la seule chose réellement disponible sans lui : écrire les
 * titres et les descriptions des clips gardés. Ce n'est pas un lot de
 * consolation, c'est un livrable du produit.
 */
export type Suite =
  | { kind: 'action'; libelle: string; cible: string }
  | { kind: 'attente'; raison: string; debloquePar: StepName }

/**
 * L'issue d'une phase : une action, ou une attente nommée.
 *
 * **C'est cette fonction qui garantit qu'aucun état n'est une impasse**, et le
 * fait qu'elle soit unique rend la garantie testable — le test énumère des
 * entrées, les passe à `phaseProjet`, et vérifie qu'elle rend un résultat pour
 * chaque couple ainsi produit.
 *
 * `cible` est une URL, jamais un ordre : ce que l'écran fait de la sienne — un
 * lien, ou un bouton quand la cible est l'écran où l'on est déjà — lui
 * appartient. `suite` ne connaît que l'identifiant du projet : elle ne peut donc
 * pas désigner un clip, et c'est `clipSuivant` qui s'en charge, à l'endroit où
 * la liste est disponible.
 */
export function suite(phase: Phase, projet: { id: string }): Suite {
  const ici = lienProjet(projet.id)

  // **L'état de l'analyse ne commande que lorsqu'il n'y a rien à décider ni à
  // monter**, et c'est l'invariant : la phase choisit ce que l'écran met en
  // avant, elle ne retire jamais ce qui existe. `effacerArtefact` retire
  // `candidates.json` **avant** de toucher à la base, donc les clips de la passe
  // précédente survivent à un repérage forcé — qu'il tourne encore (`attente`),
  // qu'il ait échoué (`echec`) ou qu'un redémarrage du serveur l'ait perdu
  // (`interrompu`). Faire passer une réparation ou une attente devant leur tri
  // et leur montage cacherait à Julien le travail qu'il vient de faire.
  // (relevé par Codex et Copilot)
  //
  // L'incident, lui, ne disparaît pas pour autant : le bandeau d'erreur et le
  // bouton de reprise sont des surfaces propres de l'écran de projet, servies
  // par `ProjectStatus.error` et `running`, pas par cette fonction.
  if (phase.travail === 'rien') {
    // `interrompu` est la seule impasse réelle de l'interface — `progression()`
    // lit une `Map` du processus Next, qu'un redémarrage vide sans laisser
    // d'erreur — et la reprise est l'ajout qui la ferme.
    if (phase.analyse === 'interrompu' || phase.analyse === 'echec') {
      return { kind: 'action', libelle: 'Reprendre l’analyse', cible: ici }
    }
    // On nomme la cause, jamais une durée restante. Le repérage produit
    // l'artefact qui ouvre le tri — ce n'est pas le transcript, même s'il le
    // précède.
    if (phase.analyse === 'attente') {
      return {
        kind: 'attente',
        raison: 'Le repérage n’a pas encore rendu ses propositions.',
        debloquePar: 'candidates',
      }
    }
    // **`suite` nomme la direction, l'écran décide de l'activation.** Une
    // exécution peut très bien tourner ici — l'encodage du proxy pendant qu'on
    // trie — et `lancer` lève alors `ExécutionEnCoursError`, dont la route fait
    // un 409. C'est `running` qui le dit, et `running` n'est pas dans la phase :
    // l'écran de projet l'a sous la main et désactive le contrôle avec sa raison
    // écrite à côté, jamais dans une bulle d'aide.
    return { kind: 'action', libelle: 'Relancer le repérage', cible: ici }
  }

  switch (phase.travail) {
    case 'atrier':
      return { kind: 'action', libelle: 'Trier les propositions', cible: ici }
    case 'livre':
      // Le succès du parcours. Rien n'attend plus, même si le proxy manque : les
      // MP4 sont sur le disque.
      return { kind: 'action', libelle: 'Choisir une autre émission', cible: '/' }
    case 'trie':
      // **Le libellé ne promet aucun clip.** `trie` recouvre deux situations que
      // les deux axes ne distinguent pas : des clips gardés qui attendent leur
      // montage, et une liste dont **tout** a été écarté — non vide, donc pas
      // `rien`, sans gardé, donc pas `livre`. Les séparer demanderait une
      // cinquième valeur de `Travail` ou la liste des clips en argument, et les
      // deux sont gelés par la conception. La cible, elle, est bonne dans les
      // deux cas : l'écran de projet porte la liste, et c'est lui qui dit « 4
      // gardés » ou « rien de gardé, relancer le repérage ». (relevé par Codex)
      return phase.analyse === 'triable'
        ? {
            kind: 'attente',
            raison:
              'Le montage s’ouvrira avec le proxy, en cours d’encodage. Les titres et les descriptions s’écrivent déjà.',
            debloquePar: 'proxy',
          }
        : { kind: 'action', libelle: 'Passer au montage', cible: ici }
  }
}

/**
 * Le clip gardé qui suit celui-ci, ou `null`.
 *
 * C'est ce qui évite de repasser par la grille entre chaque clip : l'écran de
 * montage est réentré trois à cinq fois par émission, et la sortie du
 * sous-parcours a deux issues, « retour au tri » et « clip suivant à monter ».
 *
 * **Sans rebouclage.** Sur le dernier, il n'y a pas de suivant, et le bouton se
 * désactive : reboucler ferait repasser indéfiniment sur des clips déjà montés
 * sans que rien ne dise qu'on a fait le tour.
 *
 * **Et `null` aussi quand `courantId` n'est pas dans la liste.** Un identifiant
 * absent ne désigne aucune position ; rendre le premier gardé ferait sauter dans
 * la liste sans que le geste l'explique.
 */
export function clipSuivant<T extends { id: string; status: ClipStatus }>(
  clips: readonly T[],
  courantId: string,
): T | null {
  const courant = clips.findIndex((c) => c.id === courantId)
  if (courant < 0) return null
  // `estGarde`, et non `status === 'kept'` : rouvrir un clip exporté pour en
  // retoucher le montage est un parcours normal.
  return clips.slice(courant + 1).find((c) => estGarde(c.status)) ?? null
}
