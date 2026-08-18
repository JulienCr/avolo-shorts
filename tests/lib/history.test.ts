import { describe, expect, it } from 'vitest'

import type { Segment } from '@/core/edl'
import {
  canRedo,
  canUndo,
  pushHistory,
  redoHistory,
  startHistory,
  undoHistory,
} from '@/lib/history'

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

describe('redoHistory', () => {
  it('refait ce qu’on vient d’annuler', () => {
    const h = redoHistory(undoHistory(pushHistory(startHistory(a), b)))
    expect(h.present).toBe(b)
    expect(canUndo(h)).toBe(true)
    expect(canRedo(h)).toBe(false)
  })

  it('refait dans l’ordre où les gestes ont eu lieu', () => {
    let h = pushHistory(pushHistory(startHistory(a), b), c)
    h = undoHistory(undoHistory(h))
    expect(h.present).toBe(a)

    h = redoHistory(h)
    expect(h.present).toBe(b)
    h = redoHistory(h)
    expect(h.present).toBe(c)
  })

  it('un Ctrl+Shift+Z de trop ne casse rien', () => {
    const h = startHistory(a)
    expect(canRedo(h)).toBe(false)
    expect(redoHistory(h)).toBe(h)
  })

  it('un nouveau geste efface ce qu’il y avait à refaire', () => {
    // La branche qu'on vient d'abandonner n'a plus de sens : garder un
    // rétablissement après un geste divergent ferait réapparaître un montage
    // que personne ne pourrait plus situer.
    const h = redoHistory(pushHistory(undoHistory(pushHistory(startHistory(a), b)), c))
    expect(h.present).toBe(c)
    expect(canRedo(h)).toBe(false)
  })

  it('un geste sans effet ne perd pas le rétablissement', () => {
    // `pushHistory` rend l'historique inchangé quand rien n'a bougé : il ne
    // s'est rien passé, donc il n'y a rien à abandonner.
    const h = undoHistory(pushHistory(startHistory(a), b))
    expect(pushHistory(h, [...a])).toBe(h)
  })
})
