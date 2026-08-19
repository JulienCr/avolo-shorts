import { describe, it, expect } from 'vitest'
import { shotStartMs, shotsForSegments, snapToShots } from '@/core/shots'
import type { Shot } from '@/core/shots'
import type { Segment } from '@/core/edl'

const shot = (start: number, end: number): Shot => ({ start, end })
const seg = (start: number, end: number): Segment => ({ start, end })

describe('shotStartMs', () => {
  it('donne le début du plan dans la source, en millisecondes', () => {
    expect(shotStartMs(shot(12.3456, 20))).toBe(12346)
    expect(shotStartMs(shot(0, 5))).toBe(0)
  })

  // Le point qui se paie en bug silencieux. Une dérogation indexée sur le rang
  // du plan dans le clip se décale dès qu'on retire un segment en amont : les
  // dérogations atterrissent sur les mauvais plans, et rien ne le signale.
  it('ne dépend pas du montage : le même plan garde sa clé quand le clip change', () => {
    const shots = [shot(0, 5), shot(5, 9), shot(9, 30)]
    expect(shots.map(shotStartMs)).toEqual([0, 5000, 9000])
    // Le premier plan sort du clip : le troisième garde la sienne.
    expect(shotStartMs(shots[2])).toBe(9000)
  })
})

describe('shotsForSegments', () => {
  const shots = [shot(0, 10), shot(10, 25), shot(25, 40)]

  it('garde les plans qui recoupent un segment, dans l’ordre de la source', () => {
    expect(shotsForSegments(shots, [seg(12, 30)])).toEqual([shot(10, 25), shot(25, 40)])
  })

  // Rogner le plan sur le segment changerait sa clé, donc décrocherait toutes
  // les dérogations posées dessus au premier ajustement de montage.
  it('rend le plan tel qu’il est dans la source, jamais rogné sur le segment', () => {
    const [first] = shotsForSegments(shots, [seg(12, 14)])
    expect(first).toEqual(shot(10, 25))
    expect(shotStartMs(first)).toBe(10000)
  })

  it('ne rend pas deux fois un plan que deux segments traversent', () => {
    expect(shotsForSegments(shots, [seg(11, 12), seg(20, 21)])).toEqual([shot(10, 25)])
  })

  it('ignore un plan qui ne fait que toucher une borne, sans image commune', () => {
    expect(shotsForSegments(shots, [seg(10, 20)])).toEqual([shot(10, 25)])
  })

  it('accepte une liste de plans désordonnée', () => {
    expect(shotsForSegments([shot(25, 40), shot(0, 10)], [seg(0, 40)])).toEqual([
      shot(0, 10),
      shot(25, 40),
    ])
  })

  it('sans segment ou sans plan, rend une liste vide', () => {
    expect(shotsForSegments(shots, [])).toEqual([])
    expect(shotsForSegments([], [seg(0, 40)])).toEqual([])
  })
})

describe('snapToShots', () => {
  it('pose la borne sur la frontière de plan la plus proche', () => {
    const shots = [shot(0, 10), shot(10, 30)]
    expect(snapToShots([seg(10.3, 25)], shots, 1)).toEqual([seg(10, 25)])
  })

  it('choisit la plus proche quand deux frontières sont dans la fenêtre', () => {
    const shots = [shot(0, 10), shot(10, 12), shot(12, 30)]
    expect(snapToShots([seg(11.4, 25)], shots, 2)).toEqual([seg(12, 25)])
  })

  // À défaut de frontière, jump cut assumé : la borne reste où la délimitation
  // l’a posée plutôt que d’aller chercher une coupe lointaine.
  it('laisse la borne en place quand aucune frontière n’est dans la tolérance', () => {
    expect(snapToShots([seg(14, 25)], [shot(0, 10), shot(10, 30)], 1)).toEqual([seg(14, 25)])
  })

  it('déplace les deux bornes indépendamment', () => {
    const shots = [shot(0, 10), shot(10, 20), shot(20, 30)]
    expect(snapToShots([seg(9.8, 20.4)], shots, 1)).toEqual([seg(10, 20)])
  })

  // Deux segments séparés par un retrait, et une frontière de plan pile dans le
  // trou : les rapprocher jusqu’à ce qu’ils se touchent ferait fusionner les
  // deux segments et **ressusciterait le passage retiré**, sans erreur ni trace.
  it('ne fait jamais se rejoindre deux segments séparés par un retrait', () => {
    const shots = [shot(0, 21), shot(21, 40)]
    const render = snapToShots([seg(10, 20), seg(22, 30)], shots, 2)
    expect(render).toEqual([seg(10, 21), seg(22, 30)])
  })

  it('ne peut pas vider un segment en repliant sa fin sur son début', () => {
    const render = snapToShots([seg(10, 10.4)], [shot(0, 10), shot(10, 30)], 1)
    expect(render).toEqual([seg(10, 10.4)])
  })

  it('accepte une liste de plans désordonnée et des segments désordonnés', () => {
    const shots = [shot(20, 30), shot(0, 10), shot(10, 20)]
    expect(snapToShots([seg(20.2, 29.7), seg(0.1, 9.9)], shots, 1)).toEqual([
      seg(0, 10),
      seg(20, 30),
    ])
  })

  it('rend une liste normalisée', () => {
    const render = snapToShots([seg(5, 3), seg(10, 20), seg(15, 25)], [], 1)
    expect(render).toEqual([seg(10, 25)])
  })

  it('sans plan, rend les segments inchangés — tout est jump cut', () => {
    expect(snapToShots([seg(10, 20)], [], 1)).toEqual([seg(10, 20)])
  })

  it('a une tolérance par défaut, et une tolérance nulle ne déplace rien', () => {
    const shots = [shot(0, 10), shot(10, 30)]
    expect(snapToShots([seg(10.2, 25)], shots)).toEqual([seg(10, 25)])
    expect(snapToShots([seg(10.2, 25)], shots, 0)).toEqual([seg(10.2, 25)])
  })

  it('ignore une tolérance non finie plutôt que de déplacer n’importe où', () => {
    const shots = [shot(0, 10), shot(10, 30)]
    expect(snapToShots([seg(14, 25)], shots, Number.NaN)).toEqual([seg(14, 25)])
    expect(snapToShots([seg(14, 25)], shots, Number.POSITIVE_INFINITY)).toEqual([seg(14, 25)])
  })
})
