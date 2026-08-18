import { describe, expect, it } from 'vitest'

import type { Segment } from '@/core/edl'
import { canUndo, pushHistory, startHistory, undoHistory } from '@/lib/history'

const a: Segment[] = [{ start: 0, end: 100 }]
const b: Segment[] = [
  { start: 0, end: 40 },
  { start: 60, end: 100 },
]
const c: Segment[] = [{ start: 0, end: 40 }]

describe('startHistory', () => {
  it('démarre sans rien à annuler', () => {
    const h = startHistory(a)
    expect(h.present).toBe(a)
    expect(canUndo(h)).toBe(false)
  })
})

describe('pushHistory', () => {
  it('empile l’état précédent et avance', () => {
    const h = pushHistory(startHistory(a), b)
    expect(h.present).toBe(b)
    expect(h.past).toEqual([a])
    expect(canUndo(h)).toBe(true)
  })

  it('n’empile rien quand le geste n’a rien changé', () => {
    // Retirer une sélection déjà retirée, cliquer deux fois le même mot barré :
    // empiler donnerait des Ctrl+Z qui ne font rien, ce qui fait douter de
    // l'outil.
    const h = startHistory(a)
    expect(pushHistory(h, [{ start: 0, end: 100 }])).toBe(h)
  })

  it('distingue deux listes de même longueur', () => {
    const h = pushHistory(startHistory(a), [{ start: 0, end: 99 }])
    expect(canUndo(h)).toBe(true)
  })

  it('plafonne la pile en jetant les plus anciens', () => {
    let h = startHistory([{ start: 0, end: 0.5 }])
    for (let i = 1; i <= 10; i++) h = pushHistory(h, [{ start: 0, end: i }], 3)
    expect(h.past).toHaveLength(3)
    // Les trois derniers états, pas les trois premiers : on annule vers
    // l'arrière proche.
    expect(h.past.map((s) => s[0].end)).toEqual([7, 8, 9])
    expect(h.present[0].end).toBe(10)
  })
})

describe('undoHistory', () => {
  it('revient à l’état précédent', () => {
    const h = undoHistory(pushHistory(startHistory(a), b))
    expect(h.present).toBe(a)
    expect(canUndo(h)).toBe(false)
  })

  it('dépile dans l’ordre inverse, geste par geste', () => {
    let h = pushHistory(pushHistory(startHistory(a), b), c)
    h = undoHistory(h)
    expect(h.present).toBe(b)
    h = undoHistory(h)
    expect(h.present).toBe(a)
  })

  it('un Ctrl+Z de trop ne casse rien', () => {
    const h = startHistory(a)
    expect(undoHistory(h)).toBe(h)
  })
})
