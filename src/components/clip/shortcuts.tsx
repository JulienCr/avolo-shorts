'use client'

import { Fragment, useEffect, useRef } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * The clip screen's shortcuts, and the guard that keeps them from stealing a
 * keystroke.
 *
 * Fourteen keys (spec §4.1), all direct on AZERTY. `Ctrl+F` replaces the
 * browser's own, which virtualization neutralizes anyway — the rendered
 * transcript carries only a few dozen sentences out of several hundred.
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
  /** `P`. The decision and its toggle live in `toggleStatus` (`@/lib/clip-status`). */
  keep: () => void
  /** `X`. Same remark as `keep`. */
  discard: () => void
  help: () => void
  aSelection: boolean
}

/**
 * The actions behind a ref, the listener attached once — same reason as
 * `useShortcutsReview` (`@/components/review/shortcuts`): the functions
 * change on every render, and listing them as effect dependencies would
 * tear down and reattach the listener on every keystroke.
 */
export function useShortcuts(actions: ActionsShortcuts) {
  const last = useRef(actions)
  useEffect(() => {
    last.current = actions
  })

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (wouldSteal(e.target, e.key)) return
      const {
        playbackOrPause, cancel, restore, remove, escape,
        poserBound, find, keep, discard, help, aSelection,
      } = last.current
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
      } else if (key === 'p') {
        e.preventDefault()
        keep()
      } else if (key === 'x') {
        e.preventDefault()
        discard()
      } else if (e.key === '?') {
        e.preventDefault()
        help()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * Les raccourcis, écrits quelque part.
 *
 * `?` existe parce que le reste existe : quatorze raccourcis qui ne se découvrent
 * que dans un attribut `title` sont quatorze raccourcis que personne n'utilise. La
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
  { key: 'P', effect: 'Garder le clip' },
  { key: 'X', effect: 'Écarter le clip' },
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
