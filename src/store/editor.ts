'use client'

/**
 * L'état local de l'écran de clip.
 *
 * Ce que ce store porte, et pourquoi il ne porte que ça : le montage en cours
 * (`segments` et son historique), le cadrage, et la sélection de mots. Le reste
 * — le clip tel qu'il est enregistré, le transcript, le projet — vient de
 * TanStack Query et n'a rien à faire ici : deux copies d'une même donnée
 * divergent toujours, et c'est celle qu'on regarde qui se trompe.
 *
 * L'annulation est une **pile d'instantanés** (`@/lib/history`), pas un journal
 * d'opérations inversibles. Spec §13 : l'EDL est une structure simple.
 */

import { create } from 'zustand'

import type { Clip, Ratio, Segment } from '@/core/edl'
import type { ChampsSuivis } from '@/lib/enregistrement'
import {
  moveBoundaryToWord,
  removeSelection,
  restoreWord,
  type ClipWord,
} from '@/lib/editing'
import { canUndo, pushHistory, startHistory, undoHistory, type History } from '@/lib/history'

/**
 * Une sélection : deux index de mots, dans l'ordre où on les a désignés.
 *
 * `ancre` est le mot où le geste a commencé, `tete` celui où il en est. Les
 * garder distincts — plutôt qu'un couple trié — est ce qui permet d'étendre une
 * sélection vers la gauche : trier tout de suite perdrait de quel côté elle
 * grandit.
 */
export type Selection = { ancre: number; tete: number }

type EtatEditeur = {
  clipId: string | null
  historique: History
  ratio: Ratio | 'auto'
  cropX: number
  selection: Selection | null
  /** Vrai pendant un glissé de sélection, pour que le survol étende. */
  enGlissade: boolean

  /** Charge un clip. Ne fait rien si c'est déjà celui-là — voir le commentaire. */
  charger: (clip: Clip) => void
  /**
   * Remet le montage d'accord avec le serveur après un `PATCH` refusé pour jeton
   * périmé. **Le seul chemin qui écrive ces champs sans passer par un geste.**
   */
  reconcilier: (clipId: string, valeurs: Partial<ChampsSuivis>) => void
  retirerSelection: (mots: ClipWord[]) => void
  remonterMot: (mots: ClipWord[], index: number) => void
  poserBorne: (mots: ClipWord[], index: number, bord: 'start' | 'end') => void
  annuler: () => void
  commencerSelection: (index: number, etendre: boolean) => void
  etendreSelection: (index: number) => void
  terminerSelection: () => void
  viderSelection: () => void
  choisirRatio: (ratio: Ratio | 'auto') => void
  /**
   * Une valeur, ou une fonction de la précédente — comme `setState`.
   *
   * La seconde forme n'est pas un confort : les flèches du clavier se répètent
   * plus vite que React ne rend, et six frappes lues dans la même fermeture
   * calculent six fois le même résultat à partir de la même valeur. Le cadre
   * n'avançait alors que d'un cran.
   */
  deplacerCrop: (cropX: number | ((precedent: number) => number)) => void
}

export const useEditeur = create<EtatEditeur>((set, get) => ({
  clipId: null,
  historique: startHistory([]),
  ratio: 'auto',
  cropX: 0.5,
  selection: null,
  enGlissade: false,

  charger(clip) {
    // **La garde qui compte.** Ce store se charge depuis une requête, et une
    // requête se rejoue : un refetch au retour d'onglet, une invalidation après
    // enregistrement. Recharger sans condition écraserait alors le montage en
    // cours par la version du serveur, et viderait la pile d'annulation avec.
    // On ne recharge donc qu'au changement de clip.
    if (get().clipId === clip.id) return
    set({
      clipId: clip.id,
      historique: startHistory(clip.segments),
      ratio: clip.ratio,
      cropX: clip.cropX,
      selection: null,
      enGlissade: false,
    })
  },

  reconcilier(clipId, valeurs) {
    // **La garde du clip, et elle n'est pas décorative.** Une écriture part en
    // `keepalive` et survit à la navigation : sa réponse peut arriver alors que
    // l'écran a déjà chargé le clip suivant. Sans ce test, un refus concernant
    // le clip qu'on vient de quitter viendrait écrire dans le montage du clip
    // qu'on ouvre.
    const etat = get()
    if (etat.clipId !== clipId) return

    // **`present` seul : ni `past`, ni `future`.** Ce n'est pas un geste de
    // l'utilisateur, donc rien ne s'empile — un `Ctrl+Z` qui défait une
    // réconciliation remettrait l'intention que le serveur vient d'écarter, et
    // la renverrait avec un jeton neuf, donc gagnant. Et la pile reste entière :
    // c'est ce qui sépare cette réconciliation d'un rechargement forcé, qui
    // jetterait le montage de la séance pour un cas qui, à un onglet, n'est pas
    // une anomalie.
    set({
      ...(valeurs.segments === undefined
        ? {}
        : { historique: { ...etat.historique, present: valeurs.segments } }),
      ...(valeurs.ratio === undefined ? {} : { ratio: valeurs.ratio }),
      ...(valeurs.cropX === undefined ? {} : { cropX: valeurs.cropX }),
    })
  },

  retirerSelection(mots) {
    const { selection, historique } = get()
    if (!selection) return
    const suivant = removeSelection(historique.present, mots, selection.ancre, selection.tete)
    set({ historique: pushHistory(historique, suivant), selection: null })
  },

  remonterMot(mots, index) {
    const { historique } = get()
    set({
      historique: pushHistory(historique, restoreWord(historique.present, mots, index)),
      // Le clic qui remonte un mot commence par le sélectionner : le laisser
      // sélectionné ferait porter les boutons de borne sur un mot qu'on vient
      // de rendre, sans l'avoir voulu.
      selection: null,
    })
  },

  poserBorne(mots, index, bord) {
    const { historique } = get()
    const suivant = moveBoundaryToWord(historique.present, mots, index, bord)
    set({ historique: pushHistory(historique, suivant), selection: null })
  },

  annuler() {
    set((etat) => (canUndo(etat.historique) ? { historique: undoHistory(etat.historique) } : etat))
  },

  commencerSelection(index, etendre) {
    set((etat) => ({
      selection:
        etendre && etat.selection
          ? { ancre: etat.selection.ancre, tete: index }
          : { ancre: index, tete: index },
      enGlissade: !etendre,
    }))
  },

  etendreSelection(index) {
    set((etat) =>
      etat.selection && etat.enGlissade
        ? { selection: { ancre: etat.selection.ancre, tete: index } }
        : etat,
    )
  },

  terminerSelection() {
    set({ enGlissade: false })
  },

  viderSelection() {
    set({ selection: null, enGlissade: false })
  },

  choisirRatio(ratio) {
    set({ ratio })
  },

  deplacerCrop(cropX) {
    set((etat) => ({ cropX: typeof cropX === 'function' ? cropX(etat.cropX) : cropX }))
  },
}))

/** Les segments montés, tels qu'ils sont à cet instant. */
export function useSegments(): Segment[] {
  return useEditeur((etat) => etat.historique.present)
}

export function usePeutAnnuler(): boolean {
  return useEditeur((etat) => etat.historique.past.length > 0)
}
