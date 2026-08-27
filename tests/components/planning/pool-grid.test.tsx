// @vitest-environment jsdom

/**
 * `PoolGrid` : la navigation clavier bidimensionnelle (héritée de
 * `PoolList`), les trois états — chargement, vivier vide, filtre sans
 * résultat — et la ligne de sélection masquée.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PoolGrid } from '@/components/planning/pool-grid'
import type { PlanningPoolClip } from '@/lib/api'

afterEach(cleanup)

function clip(id: string, fields: Partial<PlanningPoolClip> = {}): PlanningPoolClip {
  return {
    clipId: id,
    projectId: '2026-06-15-cqlp',
    title: `Clip ${id}`,
    duration: 42,
    thumbnailUrl: null,
    description: '',
    outputs: { mp4Url: null, mp4Due: false, variant9x16Url: null, variant9x16Due: false, textsUrl: null },
    statuses: {},
    ...fields,
  }
}

const CLIPS = [clip('a'), clip('b'), clip('c')]

describe('PoolGrid — navigation clavier', () => {
  it('atteint chaque carte depuis la première par ArrowDown, et revient par ArrowUp', async () => {
    const user = userEvent.setup()
    render(<PoolGrid clips={CLIPS} loading={false} selected={new Set()} onToggle={vi.fn()} onPreview={vi.fn()} />)

    const cards = CLIPS.map((c) => screen.getByText(c.title).closest('[data-clip]') as HTMLElement)

    cards[0].focus()
    expect(document.activeElement).toBe(cards[0])

    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(cards[1])

    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(cards[2])

    // Ne dépasse pas la dernière carte.
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(cards[2])

    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(cards[1])

    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(cards[0])

    // Ne remonte pas au-delà de la première carte.
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(cards[0])
  })

  it('sur deux colonnes, ↑/↓ sautent de deux et ←/→ d’une seule', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <PoolGrid clips={CLIPS} loading={false} selected={new Set()} onToggle={vi.fn()} onPreview={vi.fn()} />,
    )
    const grid = container.querySelector('[class*="grid"]') as HTMLElement
    grid.style.gridTemplateColumns = '1fr 1fr'

    const cards = CLIPS.map((c) => screen.getByText(c.title).closest('[data-clip]') as HTMLElement)

    cards[0].focus()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(cards[1])

    cards[0].focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(cards[2])
  })
})

describe('PoolGrid — états', () => {
  it('affiche des squelettes pendant le chargement, pas l’état vide', () => {
    const { container } = render(
      <PoolGrid clips={[]} loading onToggle={vi.fn()} onPreview={vi.fn()} selected={new Set()} />,
    )
    expect(screen.queryByText(/Aucun clip à programmer/)).toBeNull()
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it('vivier vide : le bloc en pointillés', () => {
    render(<PoolGrid clips={[]} loading={false} onToggle={vi.fn()} onPreview={vi.fn()} selected={new Set()} />)
    expect(screen.getByText(/Aucun clip à programmer/)).toBeTruthy()
  })

  it('filtre sans résultat : message distinct, avec le bouton « Tout afficher »', async () => {
    const user = userEvent.setup()
    render(<PoolGrid clips={CLIPS} loading={false} onToggle={vi.fn()} onPreview={vi.fn()} selected={new Set()} />)

    await user.type(screen.getByLabelText('Rechercher un clip'), 'introuvable')
    expect(screen.getByText('Aucun clip ne correspond au filtre.')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Tout afficher' }))
    expect(screen.getByText('Clip a')).toBeTruthy()
  })

  it('signale les clips sélectionnés masqués par le filtre', async () => {
    const user = userEvent.setup()
    render(
      <PoolGrid clips={CLIPS} loading={false} onToggle={vi.fn()} onPreview={vi.fn()} selected={new Set(['a'])} />,
    )
    await user.type(screen.getByLabelText('Rechercher un clip'), 'introuvable')
    expect(screen.getByText('1 clip sélectionné est masqué par le filtre.')).toBeTruthy()
  })
})
