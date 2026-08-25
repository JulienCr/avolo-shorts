/**
 * Ce que veut dire « cliquer un mot barré », selon l'endroit (spec §7.1).
 *
 * Le `ROADMAP.md` le laissait ouvert : « cliquer un mot barré loin devant le
 * clip crée un segment isolé de quelques dixièmes à cet endroit. C'est ce que le
 * plan demandait, `Ctrl+Z` le défait, mais c'est un piège possible. » C'en est
 * un, et la raison est que **le même geste répond à deux intentions selon
 * l'endroit** :
 *
 * - un mot barré **à l'intérieur** de l'étendue du clip est un trou — on a
 *   retiré une hésitation et on la remet. `restoreWord` fait exactement ça ;
 * - un mot barré **à l'extérieur** est une borne — « le clip commence là »,
 *   jamais « ajoute une île de trois dixièmes de seconde à quarante secondes
 *   d'ici ». `moveBoundaryToWord` sur le bord le plus proche, qui est le seul
 *   bord du bon côté.
 *
 * Aucune mécanique nouvelle : les deux fonctions existent, il ne manquait que la
 * comparaison de deux nombres qui les départage.
 */

/** Le geste que le clic demande. */
export type GestureWord = { kind: 'restore' } | { kind: 'boundary'; edge: 'start' | 'end' }

/**
 * Le geste pour ce mot barré, sachant l'étendue du clip.
 *
 * **Un mot à cheval sur un bord compte comme dedans.** Il est déjà dans le clip
 * pour partie, et le remonter n'est pas une redéfinition de l'étendue : c'est le
 * même trou à combler, sur un mot que la coupe a coupé en deux.
 *
 * `extent` vaut `null` quand tous les mots ont été retirés. Il n'y a alors
 * aucun bord dont ce mot serait dehors, et `restoreWord` reconstruit exactement
 * le clip qu'on redemande.
 */
export function gestureOnWordBar(
  extent: { start: number; end: number } | null,
  word: { start: number; end: number },
): GestureWord {
  if (extent === null) return { kind: 'restore' }
  if (word.end <= extent.start) return { kind: 'boundary', edge: 'start' }
  if (word.start >= extent.end) return { kind: 'boundary', edge: 'end' }
  return { kind: 'restore' }
}
