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

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PreviewOutput, lScreenPart, paintOutput } from '@/components/clip/output-preview'
import { usePlayback } from '@/components/clip/playback'
import { DEFAULT_CAPTION_STYLE } from '@/core/captions/ass'
import { splitIntoCards } from '@/core/captions/cards'
import { retimeWords } from '@/core/captions/retime'
import { HOOK_DEFAULTS, type ResolvedHook } from '@/core/hook'
import { RATIOS } from '@/core/framing'
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

describe('lScreenPart', () => {
  it('donne la part de la hauteur du téléphone que chaque ratio occupe', () => {
    // C'est le chiffre que l'écran doit montrer et que le sélecteur de ratio
    // demandait d'imaginer.
    expect(Math.round(lScreenPart('16:9') * 100)).toBe(32)
    expect(Math.round(lScreenPart('1:1') * 100)).toBe(56)
    expect(Math.round(lScreenPart('4:5') * 100)).toBe(70)
    expect(lScreenPart('9:16')).toBe(1)
  })
})

describe('paintOutput', () => {
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

describe('PreviewOutput', () => {
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

    act(() => usePlayback.getState().definePosition(60))
    rerender(<PreviewOutput video={video()} framing={two} ratio="auto" cropX={0.5} />)
    expect(container.textContent).toContain('32')
    expect(container.textContent).toContain('16:9')
  })

  /**
   * **Le calque du hook est frère du canvas, jamais peint dedans**
   * (`hook-overlay.tsx`) : il couvre toujours la boîte 9:16 entière, et un
   * changement de ratio — qui redimensionne le canvas — ne doit rien lui
   * faire. C'est la garantie décisive : peindre le hook dans le canvas
   * l'aurait enfermé dans la bande centrale et fait sauter de place à chaque
   * changement de ratio.
   *
   * **L'assertion porte sur la boîte porteuse, pas sur la classe du
   * calque.** `HookOverlay` rend toujours la même `className` statique quel
   * que soit l'endroit où il est monté — comparer deux rendus de cette
   * classe ne prouverait rien d'autre que son invariance interne, et
   * laisserait passer une régression qui l'imbriquerait dans la boîte que le
   * canvas dimensionne. Ce qui doit rester fixe, c'est `aspectRatio` sur la
   * boîte elle-même — posé une fois sur `9:16`, indépendamment de la prop
   * `ratio` — puisque c'est elle qui donne au calque toute sa boîte, jamais
   * la part que le canvas occupe. (relevé en review interne)
   */
  it('le calque du hook ne bouge pas quand le ratio du clip change : la boîte porteuse reste au format 9:16', () => {
    context()
    const v = video()
    const burning: ResolvedHook = { ...HOOK_DEFAULTS, text: 'Regarde ça', badge: '' }
    const { container, rerender } = render(
      <PreviewOutput video={v} framing={framing()} ratio="1:1" cropX={0.5} hook={burning} />,
    )
    const boxBefore = container.querySelector('canvas')?.parentElement as HTMLElement
    const layerBefore = container.querySelector('[aria-hidden="true"].absolute.inset-0')
    expect(layerBefore).not.toBeNull()
    expect(boxBefore.style.aspectRatio).toBe(String(RATIOS['9:16']))

    rerender(<PreviewOutput video={v} framing={framing()} ratio="16:9" cropX={0.5} hook={burning} />)
    const boxAfter = container.querySelector('canvas')?.parentElement as HTMLElement
    const layerAfter = container.querySelector('[aria-hidden="true"].absolute.inset-0')
    expect(layerAfter).not.toBeNull()
    // La même boîte, toujours au même format 9:16 : rien dans la géométrie
    // du calque ne dépend du canvas qu'il recouvre, qui lui a changé de
    // hauteur entre les deux rendus (`part * 100 %` d'une boîte plus large).
    expect(boxAfter.style.aspectRatio).toBe(String(RATIOS['9:16']))
    expect(boxAfter).toBe(boxBefore)
    expect(layerAfter?.parentElement).toBe(boxAfter)
  })

  it('le calque du hook disparaît quand le hook est désactivé ou le texte vide', () => {
    context()
    const v = video()
    const { container, rerender } = render(
      <PreviewOutput
        video={v}
        framing={framing()}
        ratio="1:1"
        cropX={0.5}
        hook={{ ...HOOK_DEFAULTS, enabled: false, text: 'Regarde ça', badge: '' }}
      />,
    )
    expect(container.querySelector('[aria-hidden="true"].absolute.inset-0')).toBeNull()

    rerender(
      <PreviewOutput
        video={v}
        framing={framing()}
        ratio="1:1"
        cropX={0.5}
        hook={{ ...HOOK_DEFAULTS, enabled: true, text: '', badge: '' }}
      />,
    )
    expect(container.querySelector('[aria-hidden="true"].absolute.inset-0')).toBeNull()
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

  // Point A.4 du retour d'usage : ce point de montage est **fidèle**, sur la
  // timeline du clip (`retimeWords`) — c'est ce qui le distingue du calque
  // indicatif du lecteur de l'émission.
  describe('le calque des sous-titres', () => {
    it('ne pose aucun calque tant que captionCards est absent', () => {
      context()
      const { container } = render(
        <PreviewOutput video={video()} framing={framing()} ratio="1:1" cropX={0.5} />,
      )
      expect(container.querySelector('[data-caption="card"]')).toBeNull()
    })

    it("suit la timeline du clip via segments, et met à jour au timeupdate", () => {
      context()
      const v = video()
      const segments = [{ start: 100, end: 110 }]
      const cards = splitIntoCards(
        retimeWords([{ word: 'salut', start: 100, end: 100.4 }], segments),
      )
      const { container } = render(
        <PreviewOutput
          video={v}
          framing={framing()}
          ratio="1:1"
          cropX={0.5}
          captionCards={cards}
          captionStyle={DEFAULT_CAPTION_STYLE}
          segments={segments}
        />,
      )
      // `video.currentTime` vaut 0 au montage : hors segment, donc hors clip.
      expect(container.querySelector('[data-caption="card"]')).toBeNull()

      act(() => {
        v.currentTime = 100.1
        fireEvent.timeUpdate(v)
      })
      expect(container.querySelector('[data-caption="card"]')?.textContent).toContain('SALUT')
    })
  })
})
