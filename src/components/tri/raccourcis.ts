'use client'

import { useEffect, useRef } from 'react'

/**
 * Les raccourcis du tri, et leur garde.
 *
 * **Ce n'est pas un confort d'expert.** Vingt-cinq à trente cartes, deux
 * décisions par carte : sur cette forme-là, l'aller-retour vers la souris
 * devient le coût dominant, et le clavier fait passer le tri de dix minutes à
 * trois (spec §2.5).
 *
 * Toutes ces touches sont directes en AZERTY. Une première version de la
 * conception proposait `[`, `]` et `/`, qui demandent `Alt Gr` ou `Shift` sur le
 * clavier de la seule personne qui utilisera cet outil : un raccourci à deux
 * mains n'économise rien sur un geste répété trente fois.
 */

/**
 * Les éléments qui traitent déjà une touche, et à qui on n'en vole donc aucune.
 *
 * **« Interactif » ne veut pas dire « champ de saisie ».** La garde d'origine
 * n'écartait que `input, textarea, select` et le contenu éditable, ce qui
 * suffisait à trois raccourcis dont aucun n'était une touche d'activation. Ce
 * n'est plus vrai ici : les flèches sur un onglet du tri déplaceraient **à la
 * fois** l'onglet actif et la carte sélectionnée, et `Espace` sur un bouton
 * l'active. (relevé par Codex)
 */
const DÉJÀ_PRIS = [
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  '[role="button"]',
  '[role="tab"]',
  '[role="slider"]',
  'summary',
  // **Le contenu éditable est nommé ici en plus d'`isContentEditable`.** La
  // propriété est héritée — un `<span>` dans un `<div contenteditable>` la rend
  // vraie — mais elle n'est pas implémentée par `jsdom`, où elle vaut toujours
  // faux. Sans ces trois sélecteurs, la garde se comporterait autrement sous
  // test que dans le navigateur, et c'est le test qui aurait tort.
  // `contenteditable="false"` n'y est pas : il désigne un îlot non éditable.
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
].join(', ')

/**
 * La cible de cet événement traite-t-elle déjà la touche ?
 *
 * **Le contrôle `instanceof HTMLElement` n'est pas une précaution de style** :
 * la cible d'un événement clavier n'est pas toujours un élément — `window` et
 * `document` en sont aussi, et `closest` n'existe pas dessus. Sans lui, le
 * gestionnaire lève une `TypeError` et **aucun raccourci ne fonctionne**, sans
 * rien afficher d'autre qu'une ligne de console.
 *
 * Une cible qui n'est pas un élément est donc écartée : on ne sait rien d'elle,
 * et se taire coûte moins cher que de voler une frappe.
 */
export function traiteDéjàLaTouche(cible: EventTarget | null): boolean {
  if (!(cible instanceof HTMLElement)) return true
  return cible.isContentEditable || cible.closest(DÉJÀ_PRIS) !== null
}

/**
 * Ce que les sept touches déclenchent. L'écran fournit les gestes, le hook ne
 * connaît que les touches.
 */
export type ActionsTri = {
  precedent: () => void
  suivant: () => void
  /** Garder, **et avancer d'une carte** : décider sans avancer oblige à un geste sur deux. */
  garder: () => void
  /** Écarter, et avancer de même. */
  ecarter: () => void
  ouvrir: () => void
  /** Défaire la dernière décision, **et revenir sur sa carte** : sinon on corrige à l'aveugle. */
  defaire: () => void
  aide: () => void
}

/**
 * Quelle action une touche déclenche, ou `null`.
 *
 * Les quatre flèches sont ramenées à deux directions plutôt que traitées comme
 * les axes d'une grille : le nombre de colonnes dépend de la largeur de la
 * fenêtre, donc « la carte du dessous » n'a pas de rang stable, alors que « la
 * carte suivante » en a un. C'est aussi la lecture qui s'accorde avec `J`/`K`.
 */
function actionPourTouche(touche: string, actions: ActionsTri): (() => void) | null {
  switch (touche.length === 1 ? touche.toLowerCase() : touche) {
    case 'j':
    case 'ArrowDown':
    case 'ArrowRight':
      return actions.suivant
    case 'k':
    case 'ArrowUp':
    case 'ArrowLeft':
      return actions.precedent
    case 'g':
      return actions.garder
    case 'e':
      return actions.ecarter
    case 'Enter':
      return actions.ouvrir
    case 'u':
      return actions.defaire
    case '?':
      return actions.aide
    default:
      return null
  }
}

export function useRaccourcisTri(actions: ActionsTri): void {
  // **Les gestes derrière une référence, l'écoute posée une seule fois.** Les
  // sept fonctions changent à chaque rendu — elles ferment sur la liste et sur
  // la sélection —, et les mettre en dépendance de l'effet retirerait puis
  // reposerait l'écouteur à chaque frappe. La référence garde les dernières
  // sans rien réabonner.
  const dernières = useRef(actions)
  useEffect(() => {
    dernières.current = actions
  })

  useEffect(() => {
    function surTouche(événement: KeyboardEvent) {
      // `Ctrl+E` ouvre la barre d'adresse, `Cmd+G` cherche l'occurrence
      // suivante : voler ces touches-là ferait perdre un geste du navigateur
      // pour rien. `Shift` reste admis — `?` en a besoin sur un AZERTY.
      if (événement.ctrlKey || événement.metaKey || événement.altKey) return
      if (traiteDéjàLaTouche(événement.target)) return

      const action = actionPourTouche(événement.key, dernières.current)
      if (action === null) return
      événement.preventDefault()
      action()
    }

    window.addEventListener('keydown', surTouche)
    return () => window.removeEventListener('keydown', surTouche)
  }, [])
}
