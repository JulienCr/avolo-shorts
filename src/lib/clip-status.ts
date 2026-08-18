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
 */

import type { ClipStatus } from '@/core/edl'

export const LIBELLES_STATUT: Record<ClipStatus, string> = {
  candidate: 'proposition',
  kept: 'gardé',
  discarded: 'écarté',
  exported: 'exporté',
}

/**
 * `exported` compte comme gardé : c'est une décision humaine qui a déjà produit
 * un fichier, pas une proposition en attente. `mergeCandidates` le traite
 * d'ailleurs pareil — il survit à une nouvelle passe de repérage (tâche 6).
 */
export function estGarde(status: ClipStatus): boolean {
  return status === 'kept' || status === 'exported'
}

export function estEcarte(status: ClipStatus): boolean {
  return status === 'discarded'
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
