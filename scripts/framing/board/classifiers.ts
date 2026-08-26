/**
 * Les classifieurs d'images utilisés par les planches — issue #191, lot 2.
 *
 * `SINGLE_STATE` est le cas dégénéré : il passe par le même `partitionShot`
 * que tout classifieur bimodal, sans branche spéciale, pour qu'un plan qui
 * n'a qu'un seul état se rende exactement comme les autres.
 */

import { orientationOf } from '@/core/framing'
import type { FrameClassifier } from './share'

export const SINGLE_STATE: FrameClassifier = {
  id: 'single',
  label: 'état unique',
  states: [{ id: 'unique', label: 'unique' }],
  classify: (frame) => (frame.boxes.length > 0 ? 'unique' : null),
}

/**
 * Classe une image sur la frontalité minimale de ses deux personnes retenues
 * — le minimum, pas la moyenne, parce que c'est la personne la plus de profil
 * qui décide si la cellule doit basculer. `null` dès qu'une des deux boîtes
 * n'a pas d'orientation connue, ou que l'image n'a pas exactement deux
 * personnes : ni l'une ni l'autre n'est classable.
 */
export function frontalityBimodal(threshold: number): FrameClassifier {
  return {
    id: `frontality-bimodal@${threshold}`,
    label: 'frontalité : de profil / de face',
    states: [
      { id: 'de-profil', label: 'de profil' },
      { id: 'de-face', label: 'de face' },
    ],
    classify: (frame) => {
      if (frame.boxes.length !== 2) return null
      const frontalities = frame.boxes.map((box) => orientationOf(box).frontality)
      if (frontalities.some((f) => f === null)) return null
      const min = Math.min(...(frontalities as number[]))
      return min < threshold ? 'de-profil' : 'de-face'
    },
  }
}
