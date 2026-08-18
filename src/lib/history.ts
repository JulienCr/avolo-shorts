/**
 * L'annulation : une pile d'instantanés, pas un journal d'opérations.
 *
 * Spec §13 : « l'EDL étant une structure simple, l'annulation est une pile
 * d'instantanés ». Un journal d'opérations inversibles exigerait d'écrire, pour
 * chaque geste, son inverse exact — et l'inverse d'un `removeRange` qui a coupé
 * un segment en deux dépend de l'état d'avant, donc il faudrait de toute façon
 * le mémoriser. Autant mémoriser l'état, qui est une liste de couples de
 * nombres.
 */

import type { Segment } from '@/core/edl'

/** L'état courant et ce qui le précède, le plus récent en dernier. */
export type History = { present: Segment[]; past: Segment[][] }

/**
 * La profondeur de la pile.
 *
 * Un instantané pèse quelques dizaines d'octets et une séance de montage tient
 * en quelques dizaines de gestes : le plafond n'est pas là pour la mémoire, il
 * est là pour qu'une interface qui boucle par erreur ne grossisse pas sans fin.
 */
export const HISTORY_LIMIT = 200

export function startHistory(segments: Segment[]): History {
  return { present: segments, past: [] }
}

/** Vrai quand il reste quelque chose à dépiler. */
export function canUndo(history: History): boolean {
  return history.past.length > 0
}

/** Deux listes de segments désignent-elles le même montage ? */
function sameSegments(a: Segment[], b: Segment[]): boolean {
  if (a.length !== b.length) return false
  return a.every((s, i) => s.start === b[i].start && s.end === b[i].end)
}

/**
 * Empile l'état courant et passe au suivant.
 *
 * **Un geste sans effet n'empile rien.** Retirer une sélection qui tombe dans un
 * trou déjà retiré, cliquer deux fois sur le même mot barré : ces gestes rendent
 * une liste identique, et les empiler donnerait des `Ctrl+Z` qui ne font rien —
 * la manière la plus sûre de faire douter quelqu'un de son propre outil.
 */
export function pushHistory(history: History, next: Segment[], limit = HISTORY_LIMIT): History {
  if (sameSegments(history.present, next)) return history

  const past = [...history.past, history.present]
  return {
    present: next,
    // Les plus anciens partent en premier : on annule toujours vers l'arrière
    // proche, jamais vers le début de la séance.
    past: past.length > limit ? past.slice(past.length - limit) : past,
  }
}

/**
 * Dépile.
 *
 * Sur une pile vide, rend l'historique **inchangé** plutôt que de lever : un
 * `Ctrl+Z` de trop est un geste ordinaire, pas une erreur de programmation. Rendre
 * l'objet identique (`===`) évite au passage un rendu pour rien.
 */
export function undoHistory(history: History): History {
  if (history.past.length === 0) return history
  return {
    present: history.past[history.past.length - 1],
    past: history.past.slice(0, -1),
  }
}
