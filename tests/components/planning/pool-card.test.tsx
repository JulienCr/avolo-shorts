// @vitest-environment jsdom

/**
 * `PoolCard` seule : la vignette, son repli, les deux actions toujours
 * présentes sans survol, et les badges d'état de publication.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PoolCard } from '@/components/planning/pool-card'
import { PLATFORMS, type Platform } from '@/core/publication'
import type { PlanningPoolClip, PublicationDetail } from '@/lib/api'
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
    stale: false,
    ...fields,
  }
}

function detail(status: PublicationDetail['status']): PublicationDetail {
  return { status, error: null, updatedAt: 1000, remoteUrl: null }
}

function everywhere(status: PublicationDetail['status']): Partial<Record<Platform, PublicationDetail>> {
  return Object.fromEntries(PLATFORMS.map((platform) => [platform, detail(status)]))
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

describe('PoolCard — l’état de publication', () => {
  function renderCard(fields: Partial<PlanningPoolClip>) {
    return render(
      <PoolCard clip={clip(fields)} selected={false} current onToggle={vi.fn()} onPreview={vi.fn()} onFocus={vi.fn()} />,
    )
  }

  // `aggregatePublicationStatus({})` rend `'planned'` sur un objet vide : sans
  // la garde de la carte, tout clip vierge s'annoncerait « programmé ».
  it('un clip sans aucune ligne ne porte aucun badge d’état', () => {
    renderCard({})
    expect(screen.queryByText('programmé')).toBeNull()
    expect(screen.queryByText('publié')).toBeNull()
  })

  it('un clip publié partout porte le badge « publié »', () => {
    renderCard({ statuses: everywhere('published') })
    expect(screen.getByText('publié')).toBeTruthy()
  })

  /**
   * `aggregatePublicationStatus` n'agrège que les lignes reçues : sur un clip
   * parti vers une seule des quatre plateformes il rend `'published'`, et la
   * carte annonçait « publié » un clip que les onglets rangent en « Partiels »
   * et qui reste programmable (relevé par Copilot).
   */
  it('un clip publié sur une seule plateforme se lit « partiel », pas « publié »', () => {
    renderCard({ statuses: { instagram: detail('published') } })
    expect(screen.queryByText('publié')).toBeNull()
    expect(screen.getByText('partiel')).toBeTruthy()
  })

  it('un dépôt sur une seule plateforme ne s’annonce pas « déposé » non plus', () => {
    renderCard({ statuses: { tiktok: detail('submitted') } })
    expect(screen.queryByText('déposé')).toBeNull()
    expect(screen.getByText('partiel')).toBeTruthy()
  })

  it('un échec mêlé à un succès se lit « échec partiel », pas « échec »', () => {
    renderCard({ statuses: { instagram: detail('published'), tiktok: detail('failed') } })
    expect(screen.getByText('échec partiel')).toBeTruthy()
  })

  it('le rendu périmé se signale, et ne remplace pas l’état', () => {
    renderCard({ stale: true, statuses: everywhere('published') })
    expect(screen.getByText('rendu périmé')).toBeTruthy()
    expect(screen.getByText('publié')).toBeTruthy()
  })

  // `POST /api/planning/schedule` rend 400 sur un clip sans plateforme libre :
  // la case ne doit pas proposer un geste que le serveur refuse.
  it('la case disparaît quand plus aucune plateforme n’est programmable', () => {
    renderCard({ statuses: everywhere('published') })
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('la case reste sur un clip dont une seule plateforme est partie', () => {
    renderCard({ statuses: { instagram: detail('published') } })
    expect(screen.getByRole('checkbox')).toBeTruthy()
  })
})
