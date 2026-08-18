// @vitest-environment jsdom

/**
 * L'aperçu de sortie — le lot qui rend visible la mesure qui fonde le projet.
 *
 * L'aperçu montrait la source 16:9 avec un rectangle et deux bandes assombries,
 * donc **ce qu'on garde de la source**. Or ce que le choix du ratio décide,
 * c'est la part de l'écran du téléphone que le contenu occupera : 32 % de la
 * hauteur en 16:9, 56 % en 1:1, 70 % en 4:5. Arbitrer entre 1:1 et 4:5 en
 * comparant deux rectangles larges sur une image couchée cache exactement la
 * différence qu'on cherche à voir.
 */

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApercuSortie, partDeLEcran, peindreSortie } from '@/components/clip/apercu-sortie'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Une vidéo comme le proxy en donne une : 960x540, prête à peindre. */
function vidéo(w = 960, h = 540) {
  const v = document.createElement('video')
  Object.defineProperty(v, 'videoWidth', { value: w, configurable: true })
  Object.defineProperty(v, 'videoHeight', { value: h, configurable: true })
  return v
}

function contexte() {
  const ctx = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    fillStyle: '',
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  )
  return ctx
}

describe('partDeLEcran', () => {
  it('donne la part de la hauteur du téléphone que chaque ratio occupe', () => {
    // C'est le chiffre que l'écran doit montrer et que le sélecteur de ratio
    // demandait d'imaginer.
    expect(Math.round(partDeLEcran('16:9') * 100)).toBe(32)
    expect(Math.round(partDeLEcran('1:1') * 100)).toBe(56)
    expect(Math.round(partDeLEcran('4:5') * 100)).toBe(70)
    expect(partDeLEcran('9:16')).toBe(1)
  })
})

describe('peindreSortie', () => {
  it('découpe pleine hauteur, au ratio choisi, autour de `cropX`', () => {
    const ctx = { drawImage: vi.fn() }
    peindreSortie(ctx as unknown as CanvasRenderingContext2D, vidéo(), {
      ratio: '1:1',
      cropX: 0.5,
      largeur: 200,
      hauteur: 200,
    })

    const [, sx, sy, sw, sh, dx, dy, dw, dh] = ctx.drawImage.mock.calls[0]
    // Un 1:1 dans du 960x540 : 540 de côté, centré.
    expect([sw, sh]).toEqual([540, 540])
    expect([sx, sy]).toEqual([210, 0])
    expect([dx, dy, dw, dh]).toEqual([0, 0, 200, 200])
  })

  it('suit le cadre quand `cropX` se déplace', () => {
    const ctx = { drawImage: vi.fn() }
    peindreSortie(ctx as unknown as CanvasRenderingContext2D, vidéo(), {
      ratio: '9:16',
      cropX: 0,
      largeur: 108,
      hauteur: 192,
    })
    expect(ctx.drawImage.mock.calls[0][1]).toBe(0)
  })

  it('ne peint rien tant que la vidéo n’a pas de dimensions', () => {
    // Le proxy se charge en requêtes partielles : le premier rendu tombe avant
    // les métadonnées, et un `drawImage` sur une source de 0x0 lève.
    const ctx = { drawImage: vi.fn() }
    peindreSortie(ctx as unknown as CanvasRenderingContext2D, vidéo(0, 0), {
      ratio: '1:1',
      cropX: 0.5,
      largeur: 200,
      hauteur: 200,
    })
    expect(ctx.drawImage).not.toHaveBeenCalled()
  })
})

describe('ApercuSortie', () => {
  it('repeint quand le cadre bouge alors que la vidéo est en pause', () => {
    // **Le déclencheur qui compte.** Le geste réel est « on met en pause, on
    // regarde, on ajuste », et une vidéo en pause ne produit aucune image, donc
    // aucun `requestVideoFrameCallback`. Ne câbler que le callback livrerait un
    // aperçu qui ne bouge pas sur l'écran dont c'est la seule raison d'être.
    const ctx = contexte()
    const v = vidéo()
    const { rerender } = render(<ApercuSortie video={v} ratio="1:1" cropX={0.5} />)
    ctx.drawImage.mockClear()

    rerender(<ApercuSortie video={v} ratio="1:1" cropX={0.2} />)
    expect(ctx.drawImage).toHaveBeenCalledTimes(1)
    expect(ctx.drawImage.mock.calls[0][1]).toBeLessThan(210)
  })

  it('repeint quand le ratio change', () => {
    const ctx = contexte()
    const v = vidéo()
    const { rerender } = render(<ApercuSortie video={v} ratio="1:1" cropX={0.5} />)
    ctx.drawImage.mockClear()

    rerender(<ApercuSortie video={v} ratio="9:16" cropX={0.5} />)
    expect(ctx.drawImage.mock.calls[0][3]).toBeCloseTo(540 * (9 / 16), 0)
  })

  it('se rabat sur `timeupdate` quand `requestVideoFrameCallback` n’existe pas', () => {
    // Chrome 84, Firefox 110, Safari 17.4. Sans conséquence sur une machine
    // fixe, mais la garde évite un échec silencieux et c'est une ligne.
    const ctx = contexte()
    const v = vidéo()
    render(<ApercuSortie video={v} ratio="1:1" cropX={0.5} />)
    ctx.drawImage.mockClear()

    fireEvent.timeUpdate(v)
    expect(ctx.drawImage).toHaveBeenCalledTimes(1)
  })

  it('demande une image à chaque trame quand le navigateur sait le faire', () => {
    const ctx = contexte()
    const demander = vi.fn(() => 1)
    const prototype = HTMLVideoElement.prototype as unknown as Record<string, unknown>
    prototype.requestVideoFrameCallback = demander
    prototype.cancelVideoFrameCallback = vi.fn()
    try {
      const { unmount } = render(<ApercuSortie video={vidéo()} ratio="1:1" cropX={0.5} />)
      expect(demander).toHaveBeenCalled()
      // Démonté ici, tant que le prototype porte encore de quoi annuler.
      unmount()
    } finally {
      delete prototype.requestVideoFrameCallback
      delete prototype.cancelVideoFrameCallback
    }
    expect(ctx.drawImage).toHaveBeenCalled()
  })

  it('tient l’emplacement tant qu’aucune vidéo n’est là', () => {
    contexte()
    const { container } = render(<ApercuSortie video={null} ratio="4:5" cropX={0.5} />)
    expect(container.textContent).toContain('70')
  })
})
