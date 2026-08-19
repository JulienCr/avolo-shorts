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
type Interval = { start: number; end: number }

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
export function wordTo(words: readonly Interval[], position: number): number | null {
  let bottom = 0
  let top = words.length - 1
  let found = -1
  while (bottom <= top) {
    const middle = (bottom + top) >> 1
    if (words[middle].start <= position) {
      found = middle
      bottom = middle + 1
    } else {
      top = middle - 1
    }
  }
  return found < 0 ? null : found
}

type StatePlayback = {
  /** La position dans la **source**, en secondes — celle du proxy, pas celle du clip monté. */
  position: number
  inPlayback: boolean
  /** L'index du mot sous la lecture, ou `null`. */
  wordActive: number | null
  /**
   * Les mots du transcript indexé, tels que `indexTranscript` les rend.
   *
   * Ils vivent ici parce que `wordActive` s'en dérive : le calculer ailleurs
   * obligerait un composant à s'abonner à la position pour le faire, ce qui est
   * exactement ce que ce store existe pour éviter.
   */
  words: readonly Interval[]
  defineWords: (words: readonly Interval[]) => void
  definePosition: (position: number) => void
  definePlayback: (inPlayback: boolean) => void
  /** Au changement de clip, et dans les tests. */
  reset: () => void
}

const EMPTY = {
  position: 0,
  inPlayback: false,
  wordActive: null,
  words: [] as readonly Interval[],
}

export const usePlayback = create<StatePlayback>((set, get) => ({
  ...EMPTY,

  defineWords(words) {
    // **Le mot actif se recalcule, il ne se garde pas.** Le transcript est
    // réindexé à chaque coupe : l'index 1 d'avant ne désigne pas le mot d'après,
    // et un index gardé tel quel surlignerait un mot au hasard.
    set({ words, wordActive: wordTo(words, get().position) })
  },

  definePosition(position) {
    set({ position, wordActive: wordTo(get().words, position) })
  },

  definePlayback(inPlayback) {
    set({ inPlayback })
  },

  reset() {
    set({ ...EMPTY })
  },
}))
