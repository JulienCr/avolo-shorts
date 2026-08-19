'use client'

import { Fragment, useEffect } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * Les raccourcis de l'écran de clip, et la garde qui les empêche de voler une
 * frappe.
 *
 * Douze touches (spec §4.1), **toutes directes en AZERTY** : `I` et `O` sont la
 * convention des bancs de montage pour les points d'entrée et de sortie, et un
 * raccourci à deux mains n'économise rien sur un geste répété trente fois.
 * `Ctrl+F` remplace celui du navigateur, que la virtualisation neutralise de
 * toute façon — le transcript rendu ne porte qu'une trentaine de phrases sur
 * plusieurs centaines.
 */

/** Ce qui saisit du texte : ces éléments prennent **toutes** les touches. */
const FIELDS = 'input, textarea, select'

/** Ce qui s'active à l'`Espace` et à l'`Entrée`. */
const ACTIVATABLE = 'button, [role="button"], a[href], summary'

/** Ce qui se déplace aux flèches. */
const ARROWS = '[role="slider"], [role="tab"], [role="radio"], [role="option"]'

/**
 * Ce qui possède **toutes** les touches : une boîte de dialogue et son contenu.
 *
 * Sans cette ligne, `Échap` referme la liste des raccourcis *et* vide la
 * sélection du transcript, et `Suppr`, `I` ou `O` montent le clip pendant qu'on
 * lit une confirmation d'écrasement. Un modal capture le focus précisément pour
 * que rien derrière lui ne réponde. (relevé par Copilot)
 */
const MODALS = '[role="dialog"], [role="alertdialog"]'

/**
 * Le modal qui **héberge** les gestes de l'écran au lieu de les suspendre.
 *
 * La règle du dessus vise les boîtes qui interrompent le travail : on lit une
 * confirmation d'écrasement, on consulte la liste des raccourcis, et rien
 * derrière ne doit répondre. Le tiroir de montage est l'inverse — c'est *là* que
 * `Suppr` retire, que `I` et `O` posent les bornes, que `Ctrl+Z` annule. Le
 * ranger avec les autres tuerait les quatre gestes du produit au moment précis
 * où on les presse, et sans rien afficher.
 *
 * L'exception est **déclarée par le modal**, pas devinée ici : un sélecteur qui
 * nommerait le tiroir par sa classe ou son rôle se romprait à la première
 * refonte, en silence.
 */
const SHORTCUT_HOST = '[data-clip-shortcuts]'

/**
 * Cette touche appartient-elle déjà à la cible ?
 *
 * **La garde est par touche, et c'est le seul énoncé qui tienne.** Écarter tout
 * élément interactif tuerait le geste principal du produit : chaque mot du
 * transcript est un `[role="button"]`, et `Suppr` s'y presse précisément pour
 * retirer la sélection. Ne regarder que les champs de saisie — ce que faisait la
 * garde d'origine, écrite pour trois raccourcis dont aucun n'était une touche
 * d'activation — laisse au contraire `Espace` activer le bouton d'export **et**
 * lancer la lecture.
 *
 * Le contrôle `instanceof HTMLElement` n'est pas une précaution de style : la
 * cible d'un événement clavier n'est pas toujours un élément — `window` et
 * `document` en sont aussi, et `closest` n'existe pas dessus. Sans lui, le
 * gestionnaire levait une `TypeError` et **aucun raccourci ne fonctionnait**,
 * sans rien afficher d'autre qu'une ligne de console.
 */
export function wouldSteal(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.closest(FIELDS)) return true
  const modal = target.closest(MODALS)
  if (modal !== null && !modal.matches(SHORTCUT_HOST)) return true
  if ((key === ' ' || key === 'Enter') && target.closest(ACTIVATABLE)) return true
  if (key.startsWith('Arrow') && target.closest(ARROWS)) return true
  return false
}

export type ActionsShortcuts = {
  /** `Espace`. Ne part que si le focus n'est ni dans un champ ni sur un activable. */
  playbackOrPause: () => void
  cancel: () => void
  restore: () => void
  remove: () => void
  escape: () => void
  poserBound: (edge: 'start' | 'end') => void
  find: () => void
  help: () => void
  aSelection: boolean
}

export function useShortcuts({
  playbackOrPause,
  cancel,
  restore,
  remove,
  escape,
  poserBound,
  find,
  help,
  aSelection,
}: ActionsShortcuts) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (wouldSteal(e.target, e.key)) return
      const command = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()

      // **Le rétablissement passe avant l'annulation.** Sans garde sur
      // `shiftKey`, `Ctrl+Shift+Z` tombe dans la branche de l'annulation et
      // annule : le raccourci standard du rétablissement défait un geste de plus
      // au lieu de le refaire, sans rien dire. (relevé par Aristarque)
      if (command && key === 'z' && e.shiftKey) {
        e.preventDefault()
        restore()
      } else if (command && key === 'y') {
        // La seconde convention, celle de Windows. Elle ne coûte qu'une ligne et
        // évite de se demander laquelle des deux marche ici.
        e.preventDefault()
        restore()
      } else if (command && key === 'z') {
        e.preventDefault()
        cancel()
      } else if (command && key === 'f') {
        e.preventDefault()
        find()
      } else if (command) {
        // Aucun raccourci nu ne doit répondre à une combinaison du navigateur :
        // `Ctrl+O` ouvre un fichier, `Ctrl+I` bascule les outils de développement.
        return
      } else if (e.key === ' ') {
        e.preventDefault()
        playbackOrPause()
      } else if (aSelection && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault()
        remove()
      } else if (e.key === 'Escape') {
        escape()
      } else if (key === 'i') {
        e.preventDefault()
        poserBound('start')
      } else if (key === 'o') {
        e.preventDefault()
        poserBound('end')
      } else if (e.key === '?') {
        e.preventDefault()
        help()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playbackOrPause, cancel, restore, remove, escape, poserBound, find, help, aSelection])
}

/**
 * Les raccourcis, écrits quelque part.
 *
 * `?` existe parce que le reste existe : douze raccourcis qui ne se découvrent
 * que dans un attribut `title` sont douze raccourcis que personne n'utilise. La
 * primitive `dialog` porte le piège de focus, la fermeture par `Échap` et le
 * retour du focus au déclencheur — les trois choses qu'une boîte écrite à la
 * main rate.
 */
const TABLE: { key: string; effect: string }[] = [
  { key: 'Espace', effect: 'Lecture, pause' },
  { key: 'Ctrl+Z', effect: 'Annuler le dernier geste' },
  { key: 'Ctrl+Shift+Z', effect: 'Rétablir' },
  { key: 'Suppr', effect: 'Retirer la sélection' },
  { key: 'Échap', effect: 'Vider la sélection' },
  { key: 'I', effect: 'Commencer le clip sur le mot sélectionné' },
  { key: 'O', effect: 'Terminer le clip sur le mot sélectionné' },
  { key: 'Ctrl+F', effect: 'Chercher dans le transcript' },
  { key: '←  →', effect: 'Mot précédent, suivant (dans le transcript)' },
  { key: 'Entrée', effect: 'Placer la lecture sur le mot, ou le remonter' },
  { key: '?', effect: 'Cette liste' },
]

export function DialogueShortcuts({
  open,
  onOpen,
}: {
  open: boolean
  onOpen: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Raccourcis</DialogTitle>
          <DialogDescription>
            Toutes ces touches sont directes en AZERTY.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.8rem]">
          {TABLE.map(({ key, effect }) => (
            <Fragment key={key}>
              <dt className="text-right font-mono text-[0.8rem] whitespace-nowrap text-muted-foreground">
                {key}
              </dt>
              <dd>{effect}</dd>
            </Fragment>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
