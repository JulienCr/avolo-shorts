'use client'

/**
 * La position de lecture, et le mot qu'elle désigne.
 *
 * **Pourquoi un état à part, et pas un `useState` dans la page.** La position
 * change à chaque `timeupdate`, soit quatre fois par seconde ; la remonter dans
 * la page rendrait à cette cadence l'arbre entier — le transcript virtualisé et
 * la superposition de cadrage compris —, et le surlignage du mot en cours ne
 * ferait qu'aggraver la chose puisqu'il a besoin de cette position dans l'autre
 * colonne. Ici, chaque mot rendu s'abonne à « suis-je le mot actif » : deux mots
 * se rendent quand le surlignage avance, et rien d'autre ne bouge.
 *
 * **Ce store ne porte que ce que la lecture sait d'elle-même.** Le montage, le
 * cadrage et la sélection restent dans `@/store/editor` : deux copies d'une même
 * donnée divergent toujours, et c'est celle qu'on regarde qui se trompe.
 */

import { create } from 'zustand'

/**
 * Ce qu'il faut d'un mot pour savoir si la lecture est dessus.
 *
 * `end` n'est pas consulté, et c'est la conséquence directe de la règle du
 * silence ci-dessous : le mot actif est le dernier **commencé**, pas le dernier
 * en cours. Le champ reste pour que `ClipWord` entre ici sans conversion.
 */
type Intervalle = { start: number; end: number }

/**
 * Le mot que cette position désigne, ou `null` avant le premier.
 *
 * **Dichotomique, parce qu'elle s'exécute quatre fois par seconde** sur les
 * vingt mille mots d'une émission.
 *
 * **Un silence garde le dernier mot prononcé.** Rendre `null` entre deux mots
 * ferait clignoter le surlignage à chaque respiration et disparaître le repère
 * pendant les pauses de jeu — or c'est le seul organe qui dise où en est la
 * lecture, puisque l'écran n'a pas de tête de lecture (spec §3.3).
 */
export function motÀ(mots: readonly Intervalle[], position: number): number | null {
  let bas = 0
  let haut = mots.length - 1
  let trouvé = -1
  while (bas <= haut) {
    const milieu = (bas + haut) >> 1
    if (mots[milieu].start <= position) {
      trouvé = milieu
      bas = milieu + 1
    } else {
      haut = milieu - 1
    }
  }
  return trouvé < 0 ? null : trouvé
}

type EtatLecture = {
  /** La position dans la **source**, en secondes — celle du proxy, pas celle du clip monté. */
  position: number
  enLecture: boolean
  /** L'index du mot sous la lecture, ou `null`. */
  motActif: number | null
  /**
   * Les mots du transcript indexé, tels que `indexTranscript` les rend.
   *
   * Ils vivent ici parce que `motActif` s'en dérive : le calculer ailleurs
   * obligerait un composant à s'abonner à la position pour le faire, ce qui est
   * exactement ce que ce store existe pour éviter.
   */
  mots: readonly Intervalle[]
  definirMots: (mots: readonly Intervalle[]) => void
  definirPosition: (position: number) => void
  definirLecture: (enLecture: boolean) => void
  /** Au changement de clip, et dans les tests. */
  reinitialiser: () => void
}

const VIDE = {
  position: 0,
  enLecture: false,
  motActif: null,
  mots: [] as readonly Intervalle[],
}

export const useLecture = create<EtatLecture>((set, get) => ({
  ...VIDE,

  definirMots(mots) {
    // **Le mot actif se recalcule, il ne se garde pas.** Le transcript est
    // réindexé à chaque coupe : l'index 1 d'avant ne désigne pas le mot d'après,
    // et un index gardé tel quel surlignerait un mot au hasard.
    set({ mots, motActif: motÀ(mots, get().position) })
  },

  definirPosition(position) {
    set({ position, motActif: motÀ(get().mots, position) })
  },

  definirLecture(enLecture) {
    set({ enLecture })
  },

  reinitialiser() {
    set({ ...VIDE })
  },
}))
