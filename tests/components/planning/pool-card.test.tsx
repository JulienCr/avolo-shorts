// @vitest-environment jsdom

/**
 * `PoolCard` seule : la vignette, son repli, et les deux actions toujours
 * présentes sans survol.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PoolCard } from '@/components/planning/pool-card'
import type { PlanningPoolClip } from '@/lib/api'
import { installPointerEventPolyfill } from '../../fixtures/pointer-event'

installPointerEventPolyfill()

afterEach(cleanup)

function clip(fields: Partial<PlanningPoolClip> = {}): PlanningPoolClip {
  return {
    clipId: 'c1',
    projectId: '2026-06-15-cqlp',
    title: 'La chute',
    duration: 42,
    thumbnailUrl: null,
    description: '',
    outputs: { mp4Url: null, mp4Due: false, variant9x16Url: null, variant9x16Due: false, textsUrl: null },
    statuses: {},
    ...fields,
  }
}

describe('PoolCard', () => {
  it('affiche la vignette quand elle existe', () => {
    render(
      <PoolCard
        clip={clip({ thumbnailUrl: '/api/thumb/c1.jpg' })}
        selected={false}
        current
        onToggle={vi.fn()}
        onPreview={vi.fn()}
        onFocus={vi.fn()}
      />,
    )
    const img = screen.getByAltText('La chute') as HTMLImageElement
    expect(img.src).toContain('/api/thumb/c1.jpg')
  })

  it('affiche un repli sans image cassée quand la vignette manque', () => {
    render(
      <PoolCard
        clip={clip({ thumbnailUrl: null })}
        selected={false}
        current
        onToggle={vi.fn()}
        onPreview={vi.fn()}
        onFocus={vi.fn()}
      />,
    )
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('vignette indisponible')).toBeTruthy()
  })

  it('bascule sur le repli quand l’image échoue à charger, sans image cassée', () => {
    render(
      <PoolCard
        clip={clip({ thumbnailUrl: '/api/clips/c1/thumb' })}
        selected={false}
        current
        onToggle={vi.fn()}
        onPreview={vi.fn()}
        onFocus={vi.fn()}
      />,
    )
    const img = screen.getByAltText('La chute')
    fireEvent.error(img)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('vignette indisponible')).toBeTruthy()
  })

  it('les deux actions sont dans le DOM sans survol', () => {
    render(
      <PoolCard
        clip={clip()}
        selected={false}
        current
        onToggle={vi.fn()}
        onPreview={vi.fn()}
        onFocus={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /Aperçu/ })).toBeTruthy()
    const editLink = screen.getByRole('link', { name: /Éditer/ })
    expect(editLink.getAttribute('href')).toBe('/clips/c1')
  })

  it('encode l’identifiant du clip dans le lien d’édition', () => {
    render(
      <PoolCard
        clip={clip({ clipId: 'clip é' })}
        selected={false}
        current
        onToggle={vi.fn()}
        onPreview={vi.fn()}
        onFocus={vi.fn()}
      />,
    )
    const editLink = screen.getByRole('link', { name: /Éditer/ })
    expect(editLink.getAttribute('href')).toBe('/clips/clip%20%C3%A9')
  })

  it('la case reflète la sélection et appelle onToggle', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(
      <PoolCard
        clip={clip()}
        selected={false}
        current
        onToggle={onToggle}
        onPreview={vi.fn()}
        onFocus={vi.fn()}
      />,
    )
    const checkbox = screen.getByRole('checkbox', { name: /La chute/ })
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
    await user.click(checkbox)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('appelle onPreview au clic sur « Aperçu »', async () => {
    const user = userEvent.setup()
    const onPreview = vi.fn()
    render(
      <PoolCard
        clip={clip()}
        selected={false}
        current
        onToggle={vi.fn()}
        onPreview={onPreview}
        onFocus={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Aperçu/ }))
    expect(onPreview).toHaveBeenCalledTimes(1)
  })

  it('le tabIndex glissant sort les contrôles du parcours quand la carte n’est pas courante', () => {
    render(
      <PoolCard
        clip={clip()}
        selected={false}
        current={false}
        onToggle={vi.fn()}
        onPreview={vi.fn()}
        onFocus={vi.fn()}
      />,
    )
    expect(screen.getByRole('checkbox', { name: /La chute/ }).getAttribute('tabindex')).toBe('-1')
    expect(screen.getByRole('button', { name: /Aperçu/ }).getAttribute('tabindex')).toBe('-1')
    expect(screen.getByRole('link', { name: /Éditer/ }).getAttribute('tabindex')).toBe('-1')
  })
})
