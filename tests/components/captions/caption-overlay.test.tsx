// @vitest-environment jsdom

/**
 * Le calque de preview des sous-titres, sur le modèle de `hook-overlay.test.tsx`.
 *
 * Ce que ces tests fixent : le carton actif se trouve par recherche binaire —
 * `activeCardIndex` — sur les bornes de premier/dernier mot ; le mot actif suit
 * exactement le même calcul de bornes que `renderAss` (actif depuis son propre
 * `start` jusqu'au `start` du suivant) ; rien ne se rend hors de tout carton ;
 * et les marqueurs `data-caption="card"`/`"active"` existent pour que
 * `show-view.test.tsx` puisse les interroger sans dépendre de l'ordre du DOM.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { CaptionOverlay, activeCardIndex } from '@/components/captions/caption-overlay'
import { DEFAULT_CAPTION_STYLE } from '@/core/captions/ass'
import { splitIntoCards } from '@/core/captions/cards'
import type { Word } from '@/core/transcript'

afterEach(cleanup)

function words(...specs: [string, number, number][]): Word[] {
  return specs.map(([word, start, end]) => ({ word, start, end }))
}

describe('activeCardIndex', () => {
  const cards = splitIntoCards(
    words(['alpha', 0, 0.4], ['bravo', 0.5, 0.9], ['charlie', 3, 3.4], ['delta', 3.5, 3.9]),
  )

  it('rend -1 avant le premier carton', () => {
    expect(activeCardIndex(cards, -1)).toBe(-1)
  })

  it('trouve le premier carton', () => {
    expect(activeCardIndex(cards, 0.2)).toBe(0)
  })

  it('rend -1 dans le silence entre deux cartons', () => {
    expect(activeCardIndex(cards, 1.5)).toBe(-1)
  })

  it('trouve le second carton', () => {
    expect(activeCardIndex(cards, 3.6)).toBe(1)
  })

  it('rend -1 après le dernier carton', () => {
    expect(activeCardIndex(cards, 10)).toBe(-1)
  })
})

describe('CaptionOverlay', () => {
  const cards = splitIntoCards(words(['salut', 0, 0.4], ['toi', 0.5, 0.9]))

  it('ne rend rien hors de tout carton', () => {
    const { container } = render(<CaptionOverlay cards={cards} time={5} style={DEFAULT_CAPTION_STYLE} />)
    expect(container.querySelector('[data-caption="card"]')).toBeNull()
  })

  it('affiche le carton actif en majuscules', () => {
    render(<CaptionOverlay cards={cards} time={0.1} style={DEFAULT_CAPTION_STYLE} />)
    expect(screen.getByText('SALUT')).toBeTruthy()
    expect(screen.getByText('TOI')).toBeTruthy()
  })

  it('respecte uppercase: false', () => {
    render(
      <CaptionOverlay cards={cards} time={0.1} style={{ ...DEFAULT_CAPTION_STYLE, uppercase: false }} />,
    )
    expect(screen.getByText('salut')).toBeTruthy()
  })

  // Même calcul de bornes que `renderAss` : un mot est actif depuis son propre
  // `start` jusqu'au `start` du suivant, le dernier tenant jusqu'à la fin du
  // carton.
  it('marque un seul mot actif à la fois, et il avance avec le temps', () => {
    const { rerender } = render(
      <CaptionOverlay cards={cards} time={0.1} style={DEFAULT_CAPTION_STYLE} />,
    )
    expect(document.querySelector('[data-caption="active"]')?.textContent).toBe('SALUT')

    rerender(<CaptionOverlay cards={cards} time={0.5} style={DEFAULT_CAPTION_STYLE} />)
    expect(document.querySelector('[data-caption="active"]')?.textContent).toBe('TOI')
  })

  it('colore le mot actif en highlightColor, les autres en fontColor', () => {
    render(
      <CaptionOverlay
        cards={cards}
        time={0.1}
        style={{ ...DEFAULT_CAPTION_STYLE, highlightColor: '#FFE500', fontColor: '#FFFFFF' }}
      />,
    )
    const active = document.querySelector('[data-caption="active"]') as HTMLElement
    const other = screen.getByText('TOI')
    expect(active.style.color).toBe('rgb(255, 229, 0)')
    expect(other.style.color).toBe('rgb(255, 255, 255)')
  })

  // `marginV: 0` est légal (`bound(style.marginV, 0, 200, ...)`) : la correction
  // de demi-interligne doit alors porter sur `marginBottom`, jamais sur
  // `paddingBottom` — un `padding` négatif s'écrête à zéro (relevé en passe 2).
  it('paddingBottom ne devient jamais négatif quand marginV vaut 0, et marginBottom porte la correction', () => {
    const { container } = render(
      <CaptionOverlay cards={cards} time={0.1} style={{ ...DEFAULT_CAPTION_STYLE, marginV: 0 }} />,
    )
    const card = container.querySelector('[data-caption="card"]') as HTMLElement
    expect(card.style.paddingBottom).toBe('calc(0cqh)')
    expect(card.style.marginBottom).toMatch(/^calc\(-[\d.]+cqh\)$/)
  })
})
