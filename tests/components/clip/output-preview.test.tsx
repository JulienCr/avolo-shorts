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

import { actAsync, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PreviewOutput, lScreenPart, paintOutput } from '@/components/clip/output-preview'
import { usePlayback } from '@/components/clip/playback'
import { framing, manualFraming, shot } from '../../fixtures/framing'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  // La position de lecture est un store de module : sans remise à zéro, le plan
  // désigné par un test suivrait le test d'après.
  usePlayback.getState().reset()
})

/** Une vidéo comme le proxy en donne une : 960x540, prête à peindre. */
function video(w = 960, h = 540) {
  const v = document.createElement('video')
  Object.defineProperty(v, 'videoWidth', { value: w, configurable: true })
  Object.defineProperty(v, 'videoHeight', { value: h, configurable: true })
  return v
}

function context() {
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
    expect(Math.round(lScreenPart('16:9') * 100)).toBe(32)
    expect(Math.round(lScreenPart('1:1') * 100)).toBe(56)
    expect(Math.round(lScreenPart('4:5') * 100)).toBe(70)
    expect(lScreenPart('9:16')).toBe(1)
  })
})

describe('peindreSortie', () => {
  it('découpe pleine hauteur, au ratio choisi, autour de `cropX`', () => {
    const ctx = { drawImage: vi.fn() }
    paintOutput(ctx as unknown as CanvasRenderingContext2D, video(), {
      ratio: '1:1',
      cropX: 0.5,
      width: 200,
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
    paintOutput(ctx as unknown as CanvasRenderingContext2D, video(), {
      ratio: '9:16',
      cropX: 0,
      width: 108,
      hauteur: 192,
    })
    expect(ctx.drawImage.mock.calls[0][1]).toBe(0)
  })

  it('ne peint rien tant que la vidéo n’a pas de dimensions', () => {
    // Le proxy se charge en requêtes partielles : le premier rendu tombe avant
    // les métadonnées, et un `drawImage` sur une source de 0x0 lève.
    const ctx = { drawImage: vi.fn() }
    paintOutput(ctx as unknown as CanvasRenderingContext2D, video(0, 0), {
      ratio: '1:1',
      cropX: 0.5,
      width: 200,
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
    const ctx = context()
    const v = video()
    const { rerender } = render(
      <PreviewOutput video={v} framing={manualFraming('1:1', 0.5)} ratio="1:1" cropX={0.5} />,
    )
    ctx.drawImage.mockClear()

    rerender(
      <PreviewOutput video={v} framing={manualFraming('1:1', 0.5)} ratio="1:1" cropX={0.2} />,
    )
    expect(ctx.drawImage).toHaveBeenCalledTimes(1)
    expect(ctx.drawImage.mock.calls[0][1]).toBeLessThan(210)
  })

  it('repeint quand le ratio change', () => {
    const ctx = context()
    const v = video()
    const { rerender } = render(
      <PreviewOutput video={v} framing={framing()} ratio="1:1" cropX={0.5} />,
    )
    ctx.drawImage.mockClear()

    rerender(<PreviewOutput video={v} framing={framing()} ratio="9:16" cropX={0.5} />)
    expect(ctx.drawImage.mock.calls[0][3]).toBeCloseTo(540 * (9 / 16), 0)
  })

  it('se rabat sur `timeupdate` quand `requestVideoFrameCallback` n’existe pas', () => {
    // Chrome 84, Firefox 110, Safari 17.4. Sans conséquence sur une machine
    // fixe, mais la garde évite un échec silencieux et c'est une ligne.
    const ctx = context()
    const v = video()
    render(<PreviewOutput video={v} framing={framing()} ratio="1:1" cropX={0.5} />)
    ctx.drawImage.mockClear()

    fireEvent.timeUpdate(v)
    expect(ctx.drawImage).toHaveBeenCalledTimes(1)
  })

  it('demande une image à chaque trame quand le navigateur sait le faire', () => {
    const ctx = context()
    const request = vi.fn(() => 1)
    const prototype = HTMLVideoElement.prototype as unknown as Record<string, unknown>
    prototype.requestVideoFrameCallback = request
    prototype.cancelVideoFrameCallback = vi.fn()
    try {
      const { unmount } = render(
        <PreviewOutput video={video()} framing={framing()} ratio="1:1" cropX={0.5} />,
      )
      expect(request).toHaveBeenCalled()
      // Démonté ici, tant que le prototype porte encore de quoi annuler.
      unmount()
    } finally {
      delete prototype.requestVideoFrameCallback
      delete prototype.cancelVideoFrameCallback
    }
    expect(ctx.drawImage).toHaveBeenCalled()
  })

  it('tient l’emplacement tant qu’aucune vidéo n’est là', () => {
    context()
    const { container } = render(
      <PreviewOutput video={null} framing={framing()} ratio="4:5" cropX={0.5} />,
    )
    expect(container.textContent).toContain('70')
  })

  /**
   * **Le cadre suit le plan sous la lecture**, et la part d'écran avec lui : le
   * ratio se choisit par plan, donc l'aperçu montre ce que la variante 9:16
   * produira à cet instant-là — 56,3 % de la hauteur pour un 1:1, 31,6 % pour un
   * 16:9. C'est ce qui fait passer la décision en revue sans qu'on la demande.
   */
  it('suit le plan sous la lecture quand le cadrage est calculé', () => {
    context()
    const two = framing({
      ratio: '16:9',
      shots: [shot(0, 50, '1:1', 0.3), shot(50, 100, '16:9', 0.5)],
    })
    usePlayback.getState().definePosition(10)
    const { container, rerender } = render(
      <PreviewOutput video={video()} framing={two} ratio="auto" cropX={0.5} />,
    )
    expect(container.textContent).toContain('56')
    expect(container.textContent).toContain('1:1')

    actAsync(() => usePlayback.getState().definePosition(60))
    rerender(<PreviewOutput video={video()} framing={two} ratio="auto" cropX={0.5} />)
    expect(container.textContent).toContain('32')
    expect(container.textContent).toContain('16:9')
  })

  /**
   * Le pendant : sans analyse, le crop du clip reprend la main, et c'est le seul
   * cas où le curseur sert encore à quelque chose.
   */
  it('suit le réglage manuel quand aucun calcul n’a eu lieu', () => {
    const ctx = context()
    const v = video()
    const { rerender } = render(
      <PreviewOutput video={v} framing={manualFraming('1:1', 0.5)} ratio="1:1" cropX={0.5} />,
    )
    ctx.drawImage.mockClear()
    rerender(
      <PreviewOutput video={v} framing={manualFraming('1:1', 0.5)} ratio="1:1" cropX={0.1} />,
    )
    expect(ctx.drawImage.mock.calls[0][1]).toBeLessThan(210)
  })
})
