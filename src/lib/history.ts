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

/**
 * L'état courant, ce qui le précède et ce qu'on vient d'annuler — le plus
 * récent en dernier dans les deux piles.
 *
 * **`future` n'est pas un confort.** Un `Ctrl+Z` sans `Ctrl+Shift+Z` transforme
 * le geste de sécurité en pari : on n'annule plus pour voir, on annule en
 * espérant. La pile s'arrête aux segments — l'instantané élargi au cadrage
 * (`{ segments, ratio, mode, dérogations }`) appartient à l'itération 1, avec le
 * cadrage automatique dont il tire son sens.
 */
export type History = { present: Segment[]; past: Segment[][]; future: Segment[][] }

/**
 * La profondeur de la pile.
 *
 * Un instantané pèse quelques dizaines d'octets et une séance de montage tient
 * en quelques dizaines de gestes : le plafond n'est pas là pour la mémoire, il
 * est là pour qu'une interface qui boucle par erreur ne grossisse pas sans fin.
 */
export const HISTORY_LIMIT = 200

export function startHistory(segments: Segment[]): History {
  return { present: segments, past: [], future: [] }
}

/** Vrai quand il reste quelque chose à dépiler. */
export function canUndo(history: History): boolean {
  return history.past.length > 0
}

/** Vrai quand une annulation attend d'être refaite. */
export function canRedo(history: History): boolean {
  return history.future.length > 0
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
    // **Un nouveau geste efface ce qu'il y avait à refaire.** La branche qu'on
    // vient d'abandonner n'a plus de sens : la garder ferait réapparaître, sur
    // un `Ctrl+Shift+Z`, un montage que personne ne pourrait plus situer.
    future: [],
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
    future: [...history.future, history.present],
  }
}

/**
 * Rempile.
 *
 * Symétrique de `undoHistory`, plafond compris : `future` ne peut pas grandir
 * plus que `past` ne rétrécit, donc il n'a pas besoin du sien. Sur une pile
 * vide, rend l'historique **inchangé** — un `Ctrl+Shift+Z` de trop est un geste
 * ordinaire.
 */
export function redoHistory(history: History): History {
  if (history.future.length === 0) return history
  return {
    present: history.future[history.future.length - 1],
    past: [...history.past, history.present],
    future: history.future.slice(0, -1),
  }
}
