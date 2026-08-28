// @vitest-environment jsdom

/**
 * `PoolGrid` : les six onglets et leurs compteurs, la navigation clavier
 * bidimensionnelle (héritée de `PoolList`), les états vides et la ligne de
 * sélection masquée.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PoolGrid } from '@/components/planning/pool-grid'
import { PLATFORMS, type Platform } from '@/core/publication'
import type { PlanningPoolClip, PublicationDetail } from '@/lib/api'

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
    stale: false,
    ...fields,
  }
}

/** Les quatre plateformes en ligne : le clip est « publié », plus « à publier ». */
function publishedEverywhere(): Partial<Record<Platform, PublicationDetail>> {
  return Object.fromEntries(
    PLATFORMS.map((platform) => [platform, { status: 'published', error: null, updatedAt: 1000, remoteUrl: null }]),
  )
}

const CLIPS = [clip('a'), clip('b'), clip('c')]

/** Les props d'onglet, que chaque rendu doit porter. */
const VIEW = { view: 'toPublish', onView: vi.fn() } as const

describe('PoolGrid — navigation clavier', () => {
  it('atteint chaque carte depuis la première par ArrowDown, et revient par ArrowUp', async () => {
    const user = userEvent.setup()
    render(<PoolGrid {...VIEW} clips={CLIPS} loading={false} selected={new Set()} onToggle={vi.fn()} onPreview={vi.fn()} />)

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
      <PoolGrid {...VIEW} clips={CLIPS} loading={false} selected={new Set()} onToggle={vi.fn()} onPreview={vi.fn()} />,
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
      <PoolGrid {...VIEW} clips={[]} loading onToggle={vi.fn()} onPreview={vi.fn()} selected={new Set()} />,
    )
    expect(screen.queryByText(/Aucun clip exporté/)).toBeNull()
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it('vivier vide : le bloc en pointillés', () => {
    render(<PoolGrid {...VIEW} clips={[]} loading={false} onToggle={vi.fn()} onPreview={vi.fn()} selected={new Set()} />)
    expect(screen.getByText(/Aucun clip exporté/)).toBeTruthy()
  })

  it('filtre sans résultat : message distinct, avec le bouton « Tout afficher »', async () => {
    const user = userEvent.setup()
    render(<PoolGrid {...VIEW} clips={CLIPS} loading={false} onToggle={vi.fn()} onPreview={vi.fn()} selected={new Set()} />)

    await user.type(screen.getByLabelText('Rechercher un clip'), 'introuvable')
    expect(screen.getByText('Aucun clip ne correspond au filtre.')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Tout afficher' }))
    expect(screen.getByText('Clip a')).toBeTruthy()
  })

  it('signale les clips sélectionnés masqués par le filtre', async () => {
    const user = userEvent.setup()
    render(
      <PoolGrid {...VIEW} clips={CLIPS} loading={false} onToggle={vi.fn()} onPreview={vi.fn()} selected={new Set(['a'])} />,
    )
    await user.type(screen.getByLabelText('Rechercher un clip'), 'introuvable')
    expect(screen.getByText('1 clip sélectionné est masqué par le filtre.')).toBeTruthy()
  })
})

describe('PoolGrid — les onglets', () => {
  it('rend les six onglets, chacun avec son compte', () => {
    render(
      <PoolGrid
        {...VIEW}
        clips={[clip('a'), clip('parti', { statuses: publishedEverywhere() })]}
        loading={false}
        onToggle={vi.fn()}
        onPreview={vi.fn()}
        selected={new Set()}
      />,
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'À publier1',
      'Programmés0',
      'Publié1',
      'Partiels0',
      'Erreurs0',
      'Tout2',
    ])
  })

  it('l’onglet actif décide de ce que la grille montre', () => {
    const clips = [clip('a'), clip('parti', { statuses: publishedEverywhere() })]
    const props = { clips, loading: false, onToggle: vi.fn(), onPreview: vi.fn(), selected: new Set<string>() }

    const { rerender } = render(<PoolGrid {...props} view="toPublish" onView={vi.fn()} />)
    expect(screen.getByText('Clip a')).toBeTruthy()
    expect(screen.queryByText('Clip parti')).toBeNull()

    rerender(<PoolGrid {...props} view="published" onView={vi.fn()} />)
    expect(screen.getByText('Clip parti')).toBeTruthy()
    expect(screen.queryByText('Clip a')).toBeNull()
  })

  it('remonte l’onglet cliqué plutôt que de le garder', async () => {
    const user = userEvent.setup()
    const onView = vi.fn()
    render(
      <PoolGrid
        {...VIEW}
        onView={onView}
        clips={CLIPS}
        loading={false}
        onToggle={vi.fn()}
        onPreview={vi.fn()}
        selected={new Set()}
      />,
    )
    await user.click(screen.getByRole('tab', { name: /Publié/ }))
    expect(onView).toHaveBeenCalledWith('published')
  })

  // Deux vides à ne pas confondre : l'onglet n'a rien, ou le filtre cache ce
  // qu'il a. Seul le second offre « Tout afficher ».
  it('un onglet vide dit sa propre raison, sans bouton de remise à zéro', () => {
    render(
      <PoolGrid
        {...VIEW}
        view="errors"
        clips={CLIPS}
        loading={false}
        onToggle={vi.fn()}
        onPreview={vi.fn()}
        selected={new Set()}
      />,
    )
    expect(screen.getByText('Aucun clip en échec.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Tout afficher' })).toBeNull()
  })
})
