// @vitest-environment jsdom

/**
 * Le lecteur.
 *
 * Ce qui change ici : il ne garde plus la position dans son propre état. Elle
 * change quatre fois par seconde, et le surlignage du transcript en a besoin
 * dans l'autre colonne — la remonter dans la page rendrait l'arbre entier à
 * cette cadence, superposition de cadrage comprise.
 *
 * Et il rend son élément `<video>` à la page, parce qu'un seul flux doit se
 * décoder : le canevas de sortie se peint sur celui-ci.
 */

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClipPlayer, togglePlayback, placePlayback } from '@/components/clip/clip-player'
import { usePlayback } from '@/components/clip/playback'

afterEach(cleanup)
beforeEach(() => usePlayback.getState().reset())

const segments = [
  { start: 10, end: 20 },
  { start: 40, end: 50 },
]

function player(current: number, inPause = true) {
  return { currentTime: current, paused: inPause, play: vi.fn(async () => {}), pause: vi.fn() }
}

describe('basculerLecture', () => {
  it('reprend au segment suivant quand la tête est dans un passage retiré', () => {
    // Revenir au début à chaque reprise obligerait à réécouter tout ce qu'on
    // vient de valider.
    const v = player(30)
    togglePlayback(v, segments)
    expect(v.currentTime).toBe(40)
    expect(v.play).toHaveBeenCalled()
  })

  it('reprend où l’on est quand la tête est dans le montage', () => {
    const v = player(15)
    togglePlayback(v, segments)
    expect(v.currentTime).toBe(15)
  })

  it('met en pause quand ça joue', () => {
    const v = player(15, false)
    togglePlayback(v, segments)
    expect(v.pause).toHaveBeenCalled()
    expect(v.play).not.toHaveBeenCalled()
  })

  it('ne fait rien sans montage', () => {
    const v = player(0)
    togglePlayback(v, [])
    expect(v.play).not.toHaveBeenCalled()
  })
})

describe('placerLecture', () => {
  it('place la tête sur le mot', () => {
    const v = player(0)
    placePlayback(v, segments, 44.5)
    expect(v.currentTime).toBe(44.5)
  })

  it('ramène dans le montage une position qui n’y est pas', () => {
    // Sans cela, la lecture repartirait d'un passage retiré et sauterait
    // aussitôt — un à-coup que personne n'a demandé.
    const v = player(0)
    placePlayback(v, segments, 30)
    expect(v.currentTime).toBe(40)
  })
})

describe('ClipPlayer', () => {
  it('rend son élément vidéo à la page', () => {
    // Un seul flux décode : le canevas de sortie se peint sur celui-ci.
    const onVideo = vi.fn()
    render(<ClipPlayer proxyUrl="/proxy.mp4" segments={segments} onVideo={onVideo} />)
    expect(onVideo.mock.calls[0][0]).toBeInstanceOf(HTMLVideoElement)
  })

  it('publie la position sans la garder pour lui', () => {
    const { container } = render(<ClipPlayer proxyUrl="/proxy.mp4" segments={segments} />)
    const video = container.querySelector('video') as HTMLVideoElement
    video.currentTime = 15
    fireEvent.timeUpdate(video)
    expect(usePlayback.getState().position).toBe(15)
  })

  it('n’annonce aucune vidéo quand le proxy manque', () => {
    const onVideo = vi.fn()
    render(<ClipPlayer proxyUrl={null} segments={segments} onVideo={onVideo} />)
    expect(onVideo).toHaveBeenCalledWith(null)
  })
})
