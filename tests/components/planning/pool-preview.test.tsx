// @vitest-environment jsdom

/**
 * `PoolPreview` : le rendu joué, les quatre plateformes, la description
 * vide, et le lien d'édition.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render as renderRaw, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PoolPreview } from '@/components/planning/pool-preview'
import type { PlanningPoolClip, PublicationDetail } from '@/lib/api'

afterEach(cleanup)

/** `PlatformDetailRow` porte la relance, donc une mutation : il lui faut un client. */
function render(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderRaw(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function detail(status: PublicationDetail['status'], fields: Partial<PublicationDetail> = {}): PublicationDetail {
  return { status, error: null, updatedAt: 1_756_000_000_000, remoteUrl: null, ...fields }
}

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

describe('PoolPreview', () => {
  it('joue la variante 9:16 quand elle existe', () => {
    render(
      <PoolPreview
        clip={clip({ outputs: { mp4Url: '/a.mp4', mp4Due: false, variant9x16Url: '/a-9x16.mp4', variant9x16Due: false, textsUrl: null } })}
        onClose={vi.fn()}
      />,
    )
    const video = document.querySelector('video') as HTMLVideoElement
    expect(video.getAttribute('src')).toBe('/a-9x16.mp4')
  })

  it('se rabat sur le rendu natif quand la variante est absente', () => {
    render(
      <PoolPreview
        clip={clip({ outputs: { mp4Url: '/a.mp4', mp4Due: false, variant9x16Url: null, variant9x16Due: false, textsUrl: null } })}
        onClose={vi.fn()}
      />,
    )
    const video = document.querySelector('video') as HTMLVideoElement
    expect(video.getAttribute('src')).toBe('/a.mp4')
  })

  it('dit qu’aucun rendu n’est disponible quand les deux manquent', () => {
    render(<PoolPreview clip={clip()} onClose={vi.fn()} />)
    expect(document.querySelector('video')).toBeNull()
    expect(screen.getByText(/Aucun rendu à jour n’est disponible/)).toBeTruthy()
  })

  it('une plateforme visée donne sa ligne de détail, une absence lit « programmable »', () => {
    render(<PoolPreview clip={clip({ statuses: { instagram: detail('published') } })} onClose={vi.fn()} />)
    expect(screen.getByText('publié')).toBeTruthy()
    expect(screen.getByText('Instagram')).toBeTruthy()
    expect(screen.getByText(/Facebook · programmable/)).toBeTruthy()
    expect(screen.getByText(/TikTok · programmable/)).toBeTruthy()
    expect(screen.getByText(/YouTube Shorts · programmable/)).toBeTruthy()
  })

  // La raison d'un échec ne doit dépendre ni d'un survol ni du clavier : sans
  // elle, l'onglet « Erreurs » n'a rien à dire.
  it('un échec montre son message et son bouton de relance', () => {
    render(
      <PoolPreview
        clip={clip({ statuses: { tiktok: detail('failed', { error: 'jeton expiré' }) } })}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('jeton expiré')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Relancer TikTok' })).toBeTruthy()
  })

  it('un rendu périmé se signale dans l’aperçu', () => {
    render(<PoolPreview clip={clip({ stale: true })} onClose={vi.fn()} />)
    expect(screen.getByText('rendu périmé')).toBeTruthy()
  })

  it('une description vide lit « (sans description) »', () => {
    render(<PoolPreview clip={clip({ description: '' })} onClose={vi.fn()} />)
    expect(screen.getByText('(sans description)')).toBeTruthy()
  })

  it('le pied de la modale pointe vers l’éditeur du clip', () => {
    render(<PoolPreview clip={clip({ clipId: 'c9' })} onClose={vi.fn()} />)
    const link = screen.getByRole('link', { name: 'Éditer' })
    expect(link.getAttribute('href')).toBe('/clips/c9')
  })

  it('rien ne se rend quand clip est null', () => {
    render(<PoolPreview clip={null} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  /**
   * L'ouverture par `?preview=` — sans clic — est précisément le chemin sans
   * geste utilisateur que Chrome refuse pour une lecture non coupée
   * (mesuré : `play()` non coupé rejette avec `NotAllowedError` hors geste).
   */
  it('un rejet de lecture ne fait pas planter et ne coupe pas le son', async () => {
    const play = vi
      .spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockReturnValue(Promise.reject(new DOMException('Refusé', 'NotAllowedError')))

    render(
      <PoolPreview
        clip={clip({ outputs: { mp4Url: null, mp4Due: false, variant9x16Url: '/a-9x16.mp4', variant9x16Due: false, textsUrl: null } })}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => expect(play).toHaveBeenCalledTimes(1))
    const video = document.querySelector('video') as HTMLVideoElement
    expect(video.muted).toBe(false)

    play.mockRestore()
  })

  /**
   * Base UI démonte `DialogContent` à la fermeture, mais notre propre garde
   * (`clip !== null &&`) le fait déjà, avant toute animation de sortie : le
   * `<video>` disparaît du DOM au rendu qui suit, sa lecture s'arrête donc
   * avec lui plutôt que de continuer au-dessus de la grille.
   */
  it('la fermeture retire le lecteur du DOM plutôt que de le laisser jouer', () => {
    const { rerender } = render(
      <PoolPreview
        clip={clip({ outputs: { mp4Url: null, mp4Due: false, variant9x16Url: '/a-9x16.mp4', variant9x16Due: false, textsUrl: null } })}
        onClose={vi.fn()}
      />,
    )
    expect(document.querySelector('video')).not.toBeNull()

    rerender(<PoolPreview clip={null} onClose={vi.fn()} />)
    expect(document.querySelector('video')).toBeNull()
  })
})
