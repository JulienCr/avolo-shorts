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

import { moveBoundary, type Clip, type Ratio, type Segment } from '@/core/edl'
import type { ChampsSuivis } from '@/lib/enregistrement'
import {
  moveBoundaryToWord,
  removeSelection,
  restoreWord,
  type ClipWord,
} from '@/lib/editing'
import {
  canRedo,
  canUndo,
  pushHistory,
  redoHistory,
  startHistory,
  undoHistory,
  type History,
} from '@/lib/history'

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
  /**
   * Pose une borne extérieure **à un temps**, et non sur un mot.
   *
   * Le pendant de `poserBorne` pour la bande de temps : les oreilles y sont
   * libres à l'image près, sans aimantation aux mots ni aux plans, et le contrôle
   * est celui d'un banc de montage. `moveBoundaryToWord` reste le chemin du
   * transcript ; celui-ci vise `moveBoundary`, un étage plus bas, qui prend déjà
   * un temps.
   *
   * **Elle passe par `pushHistory` comme sa voisine**, donc annulation et
   * rétablissement marchent sans rien ajouter — et l'écriture part par
   * l'enregistrement différé, qui suit `segments`. Aucun second chemin d'écriture.
   *
   * Nommée en anglais parce qu'elle est neuve (`CLAUDE.md`, « La langue ») ; ses
   * voisines françaises sont la dette de l'issue #73, qu'un balayage soldera.
   */
  setBoundaryAt: (time: number, edge: 'start' | 'end') => void
  annuler: () => void
  /**
   * Refait le geste annulé. **Le pendant d'`annuler`, et il n'est pas
   * optionnel** : annuler sans pouvoir rétablir transforme le geste de sécurité
   * en pari. La touche, elle, appartient à l'écran.
   */
  retablir: () => void
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

    // **Rien ne s'empile dans `past`.** Ce n'est pas un geste de l'utilisateur,
    // et un `Ctrl+Z` qui défait une réconciliation remettrait l'intention que le
    // serveur vient d'écarter — laquelle repartirait avec un jeton neuf, donc
    // gagnant. La pile reste en revanche entière : c'est ce qui sépare cette
    // réconciliation d'un rechargement forcé, qui jetterait le montage de la
    // séance pour un cas qui, à un onglet, n'est pas une anomalie.
    //
    // **Mais `future` se vide dès que le montage change.** La branche qu'on
    // vient de quitter décrit un montage antérieur au gagnant : un
    // `Ctrl+Shift+Z` l'y remettrait, et l'enregistrement différé le renverrait
    // — exactement le défaut que cette réconciliation ferme. C'est la même règle
    // que `pushHistory`, pour la même raison : un changement de branche périme
    // ce qu'il y avait à refaire. Un refus qui ne porte que sur le cadrage, lui,
    // ne change pas de branche et laisse la pile en place. (relevé par Copilot)
    set({
      ...(valeurs.segments === undefined
        ? {}
        : { historique: { ...etat.historique, present: valeurs.segments, future: [] } }),
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

  setBoundaryAt(time, edge) {
    const { historique } = get()
    // **La sélection se vide, comme dans `poserBorne`.** On a d'abord voulu la
    // garder — aucun mot n'est en cause dans ce geste-ci. Mais elle survit alors
    // à un déplacement de borne qui peut l'avoir mise dehors, et le `Suppr`
    // suivant retire un passage déjà retiré : rien ne change à l'écran, un
    // instantané s'empile dans la pile d'annulation, et le clavier a l'air
    // cassé. Une sélection qu'on ne voit plus ne doit pas rester agissante.
    // (relevé par Aristarque)
    set({
      historique: pushHistory(historique, moveBoundary(historique.present, edge, time)),
      selection: null,
    })
  },

  annuler() {
    set((etat) => (canUndo(etat.historique) ? { historique: undoHistory(etat.historique) } : etat))
  },

  retablir() {
    set((etat) => (canRedo(etat.historique) ? { historique: redoHistory(etat.historique) } : etat))
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

export function usePeutRetablir(): boolean {
  return useEditeur((etat) => etat.historique.future.length > 0)
}
