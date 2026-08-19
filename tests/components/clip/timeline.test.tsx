// @vitest-environment jsdom

/**
 * La bande de temps.
 *
 * Elle ajoute le geste que le transcript ne sait pas exprimer — gagner la
 * demi-seconde de silence avant une réplique — et elle le fait **en temps
 * source, coupes visibles**. Ces tests tiennent les trois décisions qui
 * pourraient se défaire par réflexe : une seule écriture par geste, des oreilles
 * libres qui ne s'aimantent à rien, et une fenêtre qui n'enferme pas dans ses
 * trois secondes de contexte.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { Timeline } from '@/components/clip/timeline'
import { useLecture } from '@/components/clip/lecture'
import { framing, shot } from '../../fixtures/framing'

// jsdom n'implémente pas la capture de pointeur : sans ces bouchons, le premier
// `pointerdown` lève et le geste ne commence jamais.
beforeAll(() => {
  Element.prototype.setPointerCapture = function () {}
  Element.prototype.releasePointerCapture = function () {}
  Element.prototype.hasPointerCapture = function () {
    return true
  }
})

/**
 * Un événement de pointeur **qui porte sa coordonnée**.
 *
 * jsdom n'a pas de constructeur `PointerEvent` : `fireEvent.pointerDown(el, {
 * clientX })` fabrique alors un `Event` nu, et `clientX` arrive `undefined` dans
 * le gestionnaire — ce qui rendait tous les calculs de position `NaN` sans que
 * rien ne le dise. Un `MouseEvent` du bon type porte la coordonnée, et React le
 * livre au même `onPointerDown`.
 */
function pointeur(cible: Element | Window, type: string, clientX: number) {
  fireEvent(cible, new MouseEvent(type, { clientX, bubbles: true, cancelable: true }))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useLecture.getState().reinitialiser()
})

/** La bande occupe 1000 px : une fraction lue vaut donc un millième de la fenêtre. */
function mesurerLaBande() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        width: 1000,
        height: 48,
        top: 0,
        left: 0,
        right: 1000,
        bottom: 48,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  )
}

function monter(surcharges: Partial<Parameters<typeof Timeline>[0]> = {}) {
  const onScrub = vi.fn()
  const onBoundary = vi.fn()
  render(
    <Timeline
      segments={[{ start: 100, end: 120 }]}
      framing={framing({ shots: [shot(0, 110, '1:1', 0.5), shot(110, 200, '16:9', 0.5)] })}
      proxyUrl="/api/projects/p1/proxy"
      sourceDuration={5940}
      onScrub={onScrub}
      onBoundary={onBoundary}
      {...surcharges}
    />,
  )
  return { onScrub, onBoundary }
}

function bande() {
  const element = document.querySelector('[data-timeline]')
  if (element === null) throw new Error('la bande de temps n’est pas rendue')
  return element
}

function oreille(bord: 'start' | 'end') {
  const element = document.querySelector(`[data-edge="${bord}"]`)
  if (element === null) throw new Error(`l’oreille « ${bord} » n’est pas rendue`)
  return element
}

describe('la fenêtre', () => {
  it('montre trois secondes de contexte de chaque côté', () => {
    // Sans ce contexte on ne peut que resserrer, jamais élargir, et la moitié de
    // l'intérêt des oreilles disparaît. Le clip va de 100 à 120.
    monter()
    expect(screen.getByText('0:01:37')).toBeTruthy()
    expect(screen.getByText('0:02:03')).toBeTruthy()
  })

  it('dit que les creux sont les coupes', () => {
    // Une bande en temps source montre les passages retirés à leur vraie place.
    // Sans cette ligne, ils passent pour des blancs de rendu.
    monter()
    expect(screen.getByText(/les creux sont les passages retirés/i)).toBeTruthy()
  })

  it('n’affiche pas de bande quand tout a été retiré', () => {
    // Il n'y a plus de bornes. L'écran dit ailleurs comment en sortir : le
    // répéter ici ferait deux phrases pour un seul état.
    monter({ segments: [] })
    expect(document.querySelector('[data-timeline]')).toBeNull()
    expect(screen.getByText(/réapparaîtra dès qu’un passage sera remonté/i)).toBeTruthy()
  })
})

describe('les oreilles', () => {
  it('portent le timecode plutôt qu’un nombre de secondes', () => {
    // « 100 » ne se compare à rien ; « 0:01:40 » se compare à ce qu'on lit
    // partout ailleurs à l'écran.
    monter()
    expect(oreille('start').getAttribute('aria-valuetext')).toBe('0:01:40')
    expect(oreille('end').getAttribute('aria-valuetext')).toBe('0:02:00')
  })

  it('n’écrivent qu’une fois par geste, pas une fois par mouvement', () => {
    // Poser la borne à chaque `pointermove` empilerait soixante instantanés dans
    // la pile d'annulation pour un seul glissé, et `Ctrl+Z` défairait alors un
    // soixantième de geste.
    mesurerLaBande()
    const { onBoundary } = monter()
    const poignee = oreille('start')
    pointeur(poignee, 'pointerdown', 115)
    pointeur(poignee, 'pointermove', 200)
    pointeur(poignee, 'pointermove', 300)
    expect(onBoundary).not.toHaveBeenCalled()

    pointeur(window, 'pointerup', 300)
    expect(onBoundary).toHaveBeenCalledTimes(1)
  })

  it('sont libres à l’image près, sans aimantation', () => {
    // Le contrôle est celui d'un banc de montage : la borne vaut exactement ce
    // que la main a demandé, quitte à tomber au milieu d'un mot. La fenêtre va
    // de 97 à 123, sur 1000 px : 500 px valent donc 110 s.
    mesurerLaBande()
    const { onBoundary } = monter()
    const poignee = oreille('start')
    pointeur(poignee, 'pointerdown', 500)
    pointeur(window, 'pointerup', 500)

    const [temps, bord] = onBoundary.mock.calls[0]
    expect(bord).toBe('start')
    expect(temps).toBeCloseTo(110, 5)
  })

  it('ne traversent pas l’autre borne', () => {
    // Une borne d'entrée posée après la sortie laisserait une durée négative.
    mesurerLaBande()
    const { onBoundary } = monter()
    pointeur(oreille('start'), 'pointerdown', 990)
    pointeur(window, 'pointerup', 990)
    expect(onBoundary.mock.calls[0][0]).toBeLessThan(120)
  })

  it('avancent d’une image à la flèche, d’un pas large sous Maj', () => {
    const { onBoundary } = monter()
    fireEvent.keyDown(oreille('start'), { key: 'ArrowLeft' })
    expect(onBoundary.mock.calls[0][0]).toBeCloseTo(100 - 1 / 30, 5)

    fireEvent.keyDown(oreille('start'), { key: 'ArrowRight', shiftKey: true })
    expect(onBoundary.mock.calls[1][0]).toBeCloseTo(100.5, 5)
  })

  it('laissent les flèches à l’oreille et non à l’écran', () => {
    // `role="slider"` : la garde des raccourcis écarte déjà les flèches d'un
    // curseur, donc une oreille focalisée les reçoit sans se les faire voler.
    monter()
    expect(oreille('start').getAttribute('role')).toBe('slider')
    expect(oreille('start').getAttribute('tabindex')).toBe('0')
  })

  it('ne sortent pas de la source', () => {
    // Tirer loin à gauche ne demande pas un temps négatif : il n'y a rien avant
    // le début de l'émission.
    mesurerLaBande()
    const { onBoundary } = monter({ segments: [{ start: 1, end: 20 }] })
    pointeur(oreille('start'), 'pointerdown', -5000)
    pointeur(window, 'pointerup', -5000)
    expect(onBoundary.mock.calls[0][0]).toBe(0)
  })
})

describe('le scrub', () => {
  it('confie la position au lecteur à la fin du geste', () => {
    // Pendant le geste, c'est la vignette qui montre l'image : faire chercher le
    // lecteur principal soixante fois par seconde tuerait la lecture et ferait
    // sauter l'aperçu de sortie, qui s'accroche à ses trames.
    mesurerLaBande()
    const { onScrub } = monter()
    pointeur(bande(), 'pointerdown', 500)
    expect(onScrub).not.toHaveBeenCalled()
    pointeur(window, 'pointerup', 500)
    expect(onScrub).toHaveBeenCalledTimes(1)
    expect(onScrub.mock.calls[0][0]).toBeCloseTo(110, 5)
  })

  it('atteint un passage retiré', () => {
    // C'est tout l'intérêt d'une bande en temps source : on regarde ce qu'il y a
    // dans le trou avant de décider de le remonter. La lecture, elle, saute les
    // retraits — c'est l'écran qui le tranche, pas la bande.
    mesurerLaBande()
    const { onScrub } = monter({
      segments: [
        { start: 100, end: 105 },
        { start: 115, end: 120 },
      ],
    })
    pointeur(bande(), 'pointerdown', 500)
    pointeur(window, 'pointerup', 500)
    const temps = onScrub.mock.calls[0][0]
    expect(temps).toBeGreaterThan(105)
    expect(temps).toBeLessThan(115)
  })
})
