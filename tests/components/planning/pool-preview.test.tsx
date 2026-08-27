// @vitest-environment jsdom

/**
 * `PoolPreview` : le rendu joué, les quatre plateformes, la description
 * vide, et le lien d'édition.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PoolPreview } from '@/components/planning/pool-preview'
import type { PlanningPoolClip } from '@/lib/api'

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

  it('les quatre plateformes se rendent, une absence lit « programmable »', () => {
    render(
      <PoolPreview
        clip={clip({ statuses: { instagram: 'published' } })}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText(/Instagram · publié/)).toBeTruthy()
    expect(screen.getByText(/Facebook · programmable/)).toBeTruthy()
    expect(screen.getByText(/TikTok · programmable/)).toBeTruthy()
    expect(screen.getByText(/YouTube Shorts · programmable/)).toBeTruthy()
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
})
