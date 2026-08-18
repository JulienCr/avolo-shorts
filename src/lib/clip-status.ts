/**
 * Le statut d'un clip, vu par l'écran de tri.
 *
 * Ce module existe parce que deux endroits avaient chacun leur idée de ce que
 * « gardé » veut dire : la carte comptait `exported` comme gardé, le
 * gestionnaire de clic ne reconnaissait que `kept`. Cliquer le bouton affiché
 * « Gardé » sur un clip exporté l'envoyait donc vers `kept` — un changement
 * d'état invisible à l'écran, qui perdait au passage la trace de l'export.
 *
 * Une seule définition, lue par les deux.
 *
 * **Elle a déménagé dans `@/core/parcours` et ce module la ré-exporte.**
 * `phaseProjet` en a besoin pour l'axe du travail humain, et la frontière de
 * pureté interdit à `src/core` d'importer `src/lib` : la recopier là-bas aurait
 * rendu deux endroits à un module qui existe précisément parce qu'ils
 * divergeaient. Les appelants, eux, n'ont pas bougé.
 */

import type { ClipStatus } from '@/core/edl'
import { estEcarte, estGarde } from '@/core/parcours'

export { estEcarte, estGarde }

export const LIBELLES_STATUT: Record<ClipStatus, string> = {
  candidate: 'proposition',
  kept: 'gardé',
  discarded: 'écarté',
  exported: 'exporté',
}

/** Les deux seules décisions que l'écran de tri sait prendre. */
export type Decision = 'kept' | 'discarded'

/**
 * Le statut après un clic sur « garder » ou « écarter ».
 *
 * **Le même bouton reprend sa décision** : rappuyer dessus ramène le clip au
 * rang de proposition. Un tri se corrige plus souvent qu'on ne le croit, et
 * exiger un troisième bouton pour défaire coûterait une colonne de plus sur
 * vingt-cinq cartes.
 */
export function basculerStatut(
  courant: ClipStatus,
  decision: Decision,
): Exclude<ClipStatus, 'exported'> {
  const actif = decision === 'kept' ? estGarde(courant) : estEcarte(courant)
  return actif ? 'candidate' : decision
}
