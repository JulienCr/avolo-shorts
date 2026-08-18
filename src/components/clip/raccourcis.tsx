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
const CHAMPS = 'input, textarea, select'

/** Ce qui s'active à l'`Espace` et à l'`Entrée`. */
const ACTIVABLES = 'button, [role="button"], a[href], summary'

/** Ce qui se déplace aux flèches. */
const FLECHES = '[role="slider"], [role="tab"], [role="radio"], [role="option"]'

/**
 * Ce qui possède **toutes** les touches : une boîte de dialogue et son contenu.
 *
 * Sans cette ligne, `Échap` referme la liste des raccourcis *et* vide la
 * sélection du transcript, et `Suppr`, `I` ou `O` montent le clip pendant qu'on
 * lit une confirmation d'écrasement. Un modal capture le focus précisément pour
 * que rien derrière lui ne réponde. (relevé par Copilot)
 */
const MODAUX = '[role="dialog"], [role="alertdialog"]'

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
export function volerait(cible: EventTarget | null, touche: string): boolean {
  if (!(cible instanceof HTMLElement)) return false
  if (cible.isContentEditable || cible.closest(CHAMPS)) return true
  if (cible.closest(MODAUX)) return true
  if ((touche === ' ' || touche === 'Enter') && cible.closest(ACTIVABLES)) return true
  if (touche.startsWith('Arrow') && cible.closest(FLECHES)) return true
  return false
}

export type ActionsRaccourcis = {
  /** `Espace`. Ne part que si le focus n'est ni dans un champ ni sur un activable. */
  lectureOuPause: () => void
  annuler: () => void
  retablir: () => void
  retirer: () => void
  echapper: () => void
  poserBorne: (bord: 'start' | 'end') => void
  chercher: () => void
  aide: () => void
  aSelection: boolean
}

export function useRaccourcis({
  lectureOuPause,
  annuler,
  retablir,
  retirer,
  echapper,
  poserBorne,
  chercher,
  aide,
  aSelection,
}: ActionsRaccourcis) {
  useEffect(() => {
    function surTouche(e: KeyboardEvent) {
      if (volerait(e.target, e.key)) return
      const commande = e.ctrlKey || e.metaKey
      const touche = e.key.toLowerCase()

      // **Le rétablissement passe avant l'annulation.** Sans garde sur
      // `shiftKey`, `Ctrl+Shift+Z` tombe dans la branche de l'annulation et
      // annule : le raccourci standard du rétablissement défait un geste de plus
      // au lieu de le refaire, sans rien dire. (relevé par Aristarque)
      if (commande && touche === 'z' && e.shiftKey) {
        e.preventDefault()
        retablir()
      } else if (commande && touche === 'y') {
        // La seconde convention, celle de Windows. Elle ne coûte qu'une ligne et
        // évite de se demander laquelle des deux marche ici.
        e.preventDefault()
        retablir()
      } else if (commande && touche === 'z') {
        e.preventDefault()
        annuler()
      } else if (commande && touche === 'f') {
        e.preventDefault()
        chercher()
      } else if (commande) {
        // Aucun raccourci nu ne doit répondre à une combinaison du navigateur :
        // `Ctrl+O` ouvre un fichier, `Ctrl+I` bascule les outils de développement.
        return
      } else if (e.key === ' ') {
        e.preventDefault()
        lectureOuPause()
      } else if (aSelection && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault()
        retirer()
      } else if (e.key === 'Escape') {
        echapper()
      } else if (touche === 'i') {
        e.preventDefault()
        poserBorne('start')
      } else if (touche === 'o') {
        e.preventDefault()
        poserBorne('end')
      } else if (e.key === '?') {
        e.preventDefault()
        aide()
      }
    }

    window.addEventListener('keydown', surTouche)
    return () => window.removeEventListener('keydown', surTouche)
  }, [lectureOuPause, annuler, retablir, retirer, echapper, poserBorne, chercher, aide, aSelection])
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
const TABLE: { touche: string; effet: string }[] = [
  { touche: 'Espace', effet: 'Lecture, pause' },
  { touche: 'Ctrl+Z', effet: 'Annuler le dernier geste' },
  { touche: 'Ctrl+Shift+Z', effet: 'Rétablir' },
  { touche: 'Suppr', effet: 'Retirer la sélection' },
  { touche: 'Échap', effet: 'Vider la sélection' },
  { touche: 'I', effet: 'Commencer le clip sur le mot sélectionné' },
  { touche: 'O', effet: 'Terminer le clip sur le mot sélectionné' },
  { touche: 'Ctrl+F', effet: 'Chercher dans le transcript' },
  { touche: '←  →', effet: 'Mot précédent, suivant (dans le transcript)' },
  { touche: 'Entrée', effet: 'Placer la lecture sur le mot, ou le remonter' },
  { touche: '?', effet: 'Cette liste' },
]

export function DialogueRaccourcis({
  ouvert,
  onOuvert,
}: {
  ouvert: boolean
  onOuvert: (ouvert: boolean) => void
}) {
  return (
    <Dialog open={ouvert} onOpenChange={onOuvert}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Raccourcis</DialogTitle>
          <DialogDescription>
            Toutes ces touches sont directes en AZERTY.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.8rem]">
          {TABLE.map(({ touche, effet }) => (
            <Fragment key={touche}>
              <dt className="text-right font-mono text-[0.8rem] whitespace-nowrap text-muted-foreground">
                {touche}
              </dt>
              <dd>{effet}</dd>
            </Fragment>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
