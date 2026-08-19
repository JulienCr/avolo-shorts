/**
 * Le mot barré cliqué loin devant (spec §7.1).
 *
 * Le même geste répond à deux intentions selon l'endroit, et c'est ce que ces
 * tests fixent : un mot barré **à l'intérieur** de l'étendue du clip est un
 * trou, le remonter le comble ; un mot barré **à l'extérieur** est une borne, le
 * remonter veut dire « le clip commence là », pas « ajoute une île de trois
 * dixièmes de seconde à quarante secondes d'ici ».
 */

import { describe, expect, it } from 'vitest'

import { gestureOnWordBar } from '@/components/clip/word-gesture'

const extent = { start: 100, end: 200 }

describe('gesteSurMotBarré', () => {
  it('comble le trou quand le mot est dans l’étendue', () => {
    expect(gestureOnWordBar(extent, { start: 140, end: 140.4 })).toEqual({ kind: 'remonter' })
  })

  it('déplace la borne de début quand le mot est avant', () => {
    expect(gestureOnWordBar(extent, { start: 40, end: 40.3 })).toEqual({
      kind: 'borne',
      bord: 'start',
    })
  })

  it('déplace la borne de fin quand le mot est après', () => {
    expect(gestureOnWordBar(extent, { start: 320, end: 320.3 })).toEqual({
      kind: 'borne',
      bord: 'end',
    })
  })

  it('comble le trou quand le mot chevauche une borne', () => {
    // Un mot à cheval sur le bord est déjà dans le clip pour partie : le
    // remonter n'est pas une redéfinition de l'étendue.
    expect(gestureOnWordBar(extent, { start: 99.8, end: 100.2 })).toEqual({ kind: 'remonter' })
    expect(gestureOnWordBar(extent, { start: 199.8, end: 200.2 })).toEqual({ kind: 'remonter' })
  })

  it('remonte, faute d’étendue, quand tous les mots ont été retirés', () => {
    // Plus aucun segment : il n'y a pas de bord dont ce mot serait dehors, et
    // `restoreWord` reconstruit exactement le clip qu'on redemande.
    expect(gestureOnWordBar(null, { start: 40, end: 40.3 })).toEqual({ kind: 'remonter' })
  })
})
