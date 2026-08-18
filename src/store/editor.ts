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
'use client'

import { create } from 'zustand'

import type { Clip, Ratio, Segment } from '@/core/edl'
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
  retirerSelection: (mots: ClipWord[]) => void
  remonterMot: (mots: ClipWord[], index: number) => void
  poserBorne: (mots: ClipWord[], index: number, bord: 'start' | 'end') => void
  annuler: () => void
  commencerSelection: (index: number, etendre: boolean) => void
  etendreSelection: (index: number) => void
  terminerSelection: () => void
  viderSelection: () => void
  choisirRatio: (ratio: Ratio | 'auto') => void
  deplacerCrop: (cropX: number) => void
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
    set({ cropX })
  },
}))

/** Les segments montés, tels qu'ils sont à cet instant. */
export function useSegments(): Segment[] {
  return useEditeur((etat) => etat.historique.present)
}

export function usePeutAnnuler(): boolean {
  return useEditeur((etat) => etat.historique.past.length > 0)
}
