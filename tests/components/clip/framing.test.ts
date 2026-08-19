// @vitest-environment jsdom

/**
 * Ce que l'écran de clip lit du cadrage que le serveur publie.
 *
 * **La règle que ces tests tiennent : l'écran ne montre jamais autre chose que
 * ce que le fichier contiendra.** Chaque écart entre le repli de l'écran et
 * celui de `splitByShot` est un mensonge qui ne se verrait qu'en comparant
 * l'aperçu au rendu, trois minutes d'export plus tard.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  isComputedFraming,
  shotIndexAt,
  originMessage,
  unmeasuredShots,
  effectiveRatio,
  shotRatios,
  useCurrentShot,
} from '@/components/clip/framing'
import { usePlayback } from '@/components/clip/playback'
import { framing, manualFraming, shot } from '../../fixtures/framing'

afterEach(() => usePlayback.getState().reset())

/** Deux plans qui couvrent [10, 30] : hors de cet intervalle, aucun plan. */
const TWO = framing({
  ratio: '16:9',
  shots: [shot(10, 20, '1:1', 0.3), shot(20, 30, '16:9', 0.5)],
})

describe('shotIndexAt', () => {
  it('rend le plan qui contient la position', () => {
    expect(shotIndexAt(TWO.shots, 15)).toBe(0)
    expect(shotIndexAt(TWO.shots, 25)).toBe(1)
  })

  // Les plans se suivent bout à bout : une frontière appartient au plan qui
  // commence, jamais aux deux.
  it('donne une frontière au plan qui commence', () => {
    expect(shotIndexAt(TWO.shots, 20)).toBe(1)
  })

  it('rend -1 hors de tout plan', () => {
    expect(shotIndexAt(TWO.shots, 5)).toBe(-1)
    expect(shotIndexAt(TWO.shots, 40)).toBe(-1)
    expect(shotIndexAt([], 15)).toBe(-1)
  })
})

describe('useCurrentShot', () => {
  const lire = (c = TWO) => renderHook(() => useCurrentShot(c)).result

  it('suit la lecture de plan en plan', () => {
    act(() => usePlayback.getState().definePosition(15))
    expect(lire().current?.ratio).toBe('1:1')
    act(() => usePlayback.getState().definePosition(25))
    expect(lire().current?.ratio).toBe('16:9')
  })

  /**
   * **Avant la première `timeupdate`, la position vaut zéro** et tombe avant le
   * début du clip. Montrer le cadre du premier plan est ce que le rendu montrera
   * à sa première image ; un cadre centré serait une image que personne ne verra.
   */
  it('montre le premier plan avant que la lecture ait commencé', () => {
    expect(lire().current?.shot).toEqual({ start: 10, end: 20 })
  })

  /**
   * **Un intervalle qu'aucun plan ne couvre rend `null`**, et les appelants
   * retombent alors sur le 16:9 centré — exactement ce que `splitByShot`
   * donne au rendu dans le même cas. Le cas est atteignable : les plans
   * partitionnent la durée du *proxy*, et la source peut finir quelques images
   * plus loin. Y montrer le cadre du premier plan ferait dire à l'écran autre
   * chose que ce que le fichier contiendra. (relevé par Codex)
   */
  it('ne montre aucun plan sur un intervalle qu’aucun ne couvre', () => {
    act(() => usePlayback.getState().definePosition(40))
    expect(lire().current).toBeNull()
    // Et le repli des appelants est bien celui du rendu.
    expect(effectiveRatio(null, 'auto')).toBe('16:9')
  })

  it('rend null quand il n’y a aucun plan du tout', () => {
    expect(lire(framing({ shots: [] })).current).toBeNull()
  })
})

describe('effectiveRatio', () => {
  it('prend le ratio du plan quand le clip est en auto', () => {
    expect(effectiveRatio(shot(0, 10, '4:5', 0.5), 'auto')).toBe('4:5')
  })

  /**
   * Un ratio épinglé vaut pour tous les plans, et l'écran le sait sans attendre
   * le serveur : `computeFraming` le prend verbatim. C'est ce qui évite au
   * sélecteur — le contrôle le plus manipulé de cet écran — de répondre avec six
   * cents millisecondes de retard à chaque clic.
   */
  it('prend le ratio épinglé sans attendre le serveur', () => {
    expect(effectiveRatio(shot(0, 10, '4:5', 0.5), '1:1')).toBe('1:1')
    expect(effectiveRatio(null, '9:16')).toBe('9:16')
  })
})

describe('shotRatios', () => {
  it('rend les cadres distincts, du plus étroit au plus large', () => {
    expect(
      shotRatios(
        framing({
          shots: [shot(0, 1, '16:9', 0.5), shot(1, 2, '9:16', 0.5), shot(2, 3, '16:9', 0.5)],
        }),
      ),
    ).toEqual(['9:16', '16:9'])
  })
})

describe('unmeasuredShots', () => {
  it('ne compte que les plans que personne n’a cadrés', () => {
    const c = framing({
      shots: [shot(0, 1, '1:1', 0.5), shot(1, 2, '1:1', 0.5, 'default'), shot(2, 3, '1:1', 0.5, 'manual')],
    })
    expect(unmeasuredShots(c)).toBe(1)
  })
})

describe('isComputedFraming et originMessage', () => {
  it('ne dit rien d’un cadrage calculé', () => {
    expect(isComputedFraming(framing())).toBe(true)
    expect(originMessage(framing())).toBeNull()
  })

  // Les trois replis laissent le curseur utile, et chacun a son remède.
  it.each(['no-analysis', 'unreadable-analysis', 'no-shots'] as const)(
    'rend la main au réglage manuel et le dit — %s',
    (origin) => {
      const c = manualFraming('9:16', 0.4, origin)
      expect(isComputedFraming(c)).toBe(false)
      expect(originMessage(c)).toBeTruthy()
    },
  )
})
