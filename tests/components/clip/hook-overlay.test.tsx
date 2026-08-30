// @vitest-environment jsdom

/**
 * Le calque de preview du hook. Ce que ces tests fixent :
 *
 * - il disparaît quand le hook n'est pas incrusté (désactivé, ou texte vide) —
 *   point 5 des critères d'acceptation ;
 * - il couvre toute la boîte, en position absolue, indépendamment de tout
 *   ratio — point 4 ;
 * - ses unités sont converties depuis les fractions de largeur de
 *   `hookLayout`, jamais recalculées — critère 3 : la même fonction que le
 *   rasteriseur PNG du rendu.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as useTextMeasure from '@/components/captions/use-text-measure'
import { HookOverlay } from '@/components/clip/hook-overlay'
import { outputSize } from '@/core/framing'
import {
  HOOK_DEFAULTS,
  hookGeometry,
  hookLayout,
  hookPlacement,
  type HookMeasure,
  type ResolvedHook,
} from '@/core/hook'

afterEach(cleanup)

function resolved(overrides: Partial<ResolvedHook> = {}): ResolvedHook {
  return { ...HOOK_DEFAULTS, text: 'Regarde ça', badge: '', ...overrides }
}

/**
 * Le même canevas que `hook-overlay.tsx`, et la même mesure que jsdom lui
 * impose : `createDomMeasure` s'y replie sur `() => 0` (pas de vrai canevas
 * sous jsdom), donc `hookGeometry` calculé ici avec ce repli reproduit
 * exactement ce que le composant a lui-même calculé.
 */
const CANVAS = outputSize('9:16')
const noopMeasure: HookMeasure = () => () => 0

function geometryFor(hook: ResolvedHook) {
  return hookGeometry(hook, CANVAS, noopMeasure)
}

/**
 * Le pourcentage `cqw` extrait d'un style — jsdom et `Number.prototype.toString`
 * ne sérialisent pas le même nombre de décimales, donc une comparaison de
 * chaînes exacte casse sur un chiffre sans rapport avec ce que le test vérifie.
 */
function cqwPercent(value: string): number {
  const match = /^calc\(([-\d.]+)cqw\)$/.exec(value)
  if (match === null) throw new Error(`pas un calc(...cqw) : ${value}`)
  return Number.parseFloat(match[1])
}

function expectCqwPx(value: string, px: number): void {
  expect(cqwPercent(value)).toBeCloseTo(((px / CANVAS.w) * 100), 6)
}

/** Même chose que `cqwPercent`, pour `compositeHeight`/`cardHeightDrawn` — voir le point D de la passe 2. */
function cqhPercent(value: string): number {
  const match = /^calc\(([-\d.]+)cqh\)$/.exec(value)
  if (match === null) throw new Error(`pas un calc(...cqh) : ${value}`)
  return Number.parseFloat(match[1])
}

function expectCqhPx(value: string, px: number): void {
  expect(cqhPercent(value)).toBeCloseTo(((px / CANVAS.h) * 100), 6)
}

/**
 * Le pourcentage attendu pour une fraction donnée, dans la forme que
 * `cqw()`/`cqh()` de `hook-overlay.tsx` produit — `calc(Xcqw)`. jsdom, le
 * moteur CSS de ces tests, refuse une longueur `cqw` nue mais accepte et
 * évalue un `calc()` qui la contient ; un navigateur réel traite les deux
 * formes de façon identique.
 */
function percent(fraction: number): string {
  return String(fraction * 100)
}

describe('HookOverlay', () => {
  it('ne rend rien quand le hook est désactivé', () => {
    const { container } = render(<HookOverlay hook={resolved({ enabled: false })} />)
    expect(container.firstChild).toBeNull()
  })

  it('ne rend rien quand le texte est vide', () => {
    const { container } = render(<HookOverlay hook={resolved({ text: '' })} />)
    expect(container.firstChild).toBeNull()
  })

  it('ne rend rien quand le texte n’est que des espaces', () => {
    const { container } = render(<HookOverlay hook={resolved({ text: '   ' })} />)
    expect(container.firstChild).toBeNull()
  })

  it('rend le texte quand le hook est incrusté', () => {
    // `uppercase: false` : `HOOK_DEFAULTS.uppercase` vaut `true`, et le
    // rendu en capitales est vérifié séparément juste après.
    const { getByText } = render(
      <HookOverlay hook={resolved({ text: 'Regarde ça', uppercase: false })} />,
    )
    expect(getByText('Regarde ça')).toBeTruthy()
  })

  it('met le texte en capitales quand uppercase est vrai, le laisse tel quel sinon', () => {
    const { getByText: withUppercase } = render(
      <HookOverlay hook={resolved({ text: 'Regarde ça', uppercase: true })} />,
    )
    expect(withUppercase('REGARDE ÇA')).toBeTruthy()
    cleanup()
    const { getByText: withoutUppercase } = render(
      <HookOverlay hook={resolved({ text: 'Regarde ça', uppercase: false })} />,
    )
    expect(withoutUppercase('Regarde ça')).toBeTruthy()
  })

  it("couvre toute la boîte, en position absolue, et ne pilote pas d'interaction", () => {
    const { container } = render(<HookOverlay hook={resolved()} />)
    const layer = container.firstElementChild as HTMLElement
    expect(layer.className).toContain('absolute')
    expect(layer.className).toContain('inset-0')
    expect(layer.className).toContain('pointer-events-none')
    expect(layer.getAttribute('aria-hidden')).toBe('true')
  })

  // Le composite n'est plus positionné par un jeu de marges/`justifyContent`
  // flex, mais par `hookPlacement` — la même fonction que le rasteriseur,
  // sur le canevas complet (relevé par Copilot, passe 3).
  function placementFor(hook: ResolvedHook) {
    const geometry = geometryFor(hook)
    const layout = hookLayout(hook)
    return hookPlacement({ w: geometry.compositeWidth, h: geometry.compositeHeight }, CANVAS, hook, layout)
  }

  it('positionne le composite via hookPlacement (position top, alignment center)', () => {
    const hook = resolved({ position: 'top' })
    const placement = placementFor(hook)
    const { container } = render(<HookOverlay hook={hook} />)
    const composite = container.firstElementChild?.firstElementChild as HTMLElement
    expectCqwPx(composite.style.left, placement.x)
    expectCqhPx(composite.style.top, placement.y)
  })

  it("positionne le composite plus bas en position bottom qu'en position top", () => {
    const top = placementFor(resolved({ position: 'top' }))
    const bottom = placementFor(resolved({ position: 'bottom' }))
    expect(bottom.y).toBeGreaterThan(top.y)
  })

  it("positionne le composite plus à droite en alignment right qu'en alignment left", () => {
    const left = placementFor(resolved({ alignment: 'left' }))
    const right = placementFor(resolved({ alignment: 'right' }))
    expect(right.x).toBeGreaterThan(left.x)
  })

  it("un mot démesuré ne rétrécit pas le composite et ne déborde pas hors de lui", () => {
    // `createDomMeasure` mesuré : un mot très long dépasse `CANVAS.w`, le cas
    // que le rasteriseur borne déjà (`hookPlacement`) et que le flex du calque
    // laissait déborder (relevé par Copilot, passe 3).
    const measureSpy = vi
      .spyOn(useTextMeasure, 'createDomMeasure')
      .mockImplementation((_family, fontSizePx) => (text: string) => text.length * fontSizePx)
    const hook = resolved({ text: 'X'.repeat(200), alignment: 'left' })
    const geometry = hookGeometry(hook, CANVAS, (fontSizePx) => (text: string) => text.length * fontSizePx)
    const { container } = render(<HookOverlay hook={hook} />)
    measureSpy.mockRestore()

    const composite = container.firstElementChild?.firstElementChild as HTMLElement
    expect(composite.style.overflow).toBe('hidden')
    expectCqwPx(composite.style.width, geometry.compositeWidth)
    // Le mot insécable en alignment `left` fait plafonner `compositeWidth` à
    // `CANVAS.w` : `hookPlacement` pince alors `x` à 0, quelle que soit la
    // marge — vérifié à la mesure, pas déduit.
    expectCqwPx(composite.style.left, 0)
  })

  it('la taille du texte dérive de fontSizeFraction (sizePermille / 1000)', () => {
    const hook = resolved({ sizePermille: 150 })
    const layout = hookLayout(hook)
    const { container } = render(<HookOverlay hook={hook} />)
    const span = container.querySelector('[data-hook="card"]') as HTMLElement
    expect(span.style.fontSize).toMatch(new RegExp(`^calc\\(${percent(layout.fontSizeFraction)}cqw\\)$`))
  })

  it('le rayon des coins dérive de radiusFraction (cornerRadiusPermille / 1000)', () => {
    const hook = resolved({ cornerRadiusPermille: 40 })
    const layout = hookLayout(hook)
    const { container } = render(<HookOverlay hook={hook} />)
    const span = container.querySelector('[data-hook="card"]') as HTMLElement
    expect(span.style.borderRadius).toMatch(new RegExp(`^calc\\(${percent(layout.radiusFraction)}cqw\\)$`))
  })

  it('pose une largeur explicite issue de hookGeometry — plus un inline-block qui composerait sa propre boîte', () => {
    const hook = resolved()
    const geometry = geometryFor(hook)
    const { container } = render(<HookOverlay hook={hook} />)
    const card = container.querySelector('[data-hook="card"]') as HTMLElement
    expect(card.style.position).toBe('absolute')
    expectCqwPx(card.style.width, geometry.cardWidth)
    expectCqhPx(card.style.height, geometry.cardHeightDrawn)
  })

  it("pose whiteSpace: pre et les lignes de hookGeometry — wrapLines (rasteriseur PNG) décide déjà la coupure, le navigateur ne doit plus recouper librement (relevé par Copilot, PR #117, passe 4)", () => {
    const hook = resolved()
    const geometry = geometryFor(hook)
    const { container } = render(<HookOverlay hook={hook} />)
    const card = container.querySelector('[data-hook="card"]') as HTMLElement
    expect(card.style.whiteSpace).toBe('pre')
    expect(card.textContent).toBe(geometry.lines.join(''))
  })
  describe('la pastille du badge', () => {
    const badged = (overrides = {}) =>
      resolved({ badge: 'DÉFI 10', ...overrides })

    it('apparaît quand le clip porte un badge, et pas autrement', () => {
      const { container } = render(<HookOverlay hook={badged()} />)
      expect(container.querySelector('[data-hook="badge"]')).not.toBeNull()
      cleanup()
      const noBadge = render(<HookOverlay hook={resolved({ badge: '' })} />)
      expect(noBadge.container.querySelector('[data-hook="badge"]')).toBeNull()
    })

    it('un badge fait de blancs vaut un badge absent', () => {
      const { container } = render(<HookOverlay hook={resolved({ badge: '   ' })} />)
      expect(container.querySelector('[data-hook="badge"]')).toBeNull()
    })

    it('hérite des capitales du hook', () => {
      const { container } = render(<HookOverlay hook={badged({ badge: 'défi 10' })} />)
      expect(container.querySelector('[data-hook="badge"]')?.textContent).toBe('DÉFI 10')
      cleanup()
      const lowercase = render(<HookOverlay hook={badged({ badge: 'défi 10', uppercase: false })} />)
      expect(lowercase.container.querySelector('[data-hook="badge"]')?.textContent).toBe('défi 10')
    })

    it('porte ses deux couleurs, le fond NU — backgroundOpacity est au carton', () => {
      const hook = badged({ badgeColor: '#FFFFFF', badgeBackground: '#E5007D', backgroundOpacity: 40 })
      const { container } = render(<HookOverlay hook={hook} />)
      const badge = container.querySelector('[data-hook="badge"]') as HTMLElement
      expect(badge.style.color).toBe('rgb(255, 255, 255)')
      expect(badge.style.backgroundColor).toBe('rgb(229, 0, 125)')
      // Le carton, lui, reste translucide : les deux ne partagent pas l'opacité.
      const card = container.querySelector('[data-hook="card"]') as HTMLElement
      expect(card.style.backgroundColor).toBe('rgba(0, 0, 0, 0.4)')
    })

    /**
     * **Le décalque du chevauchement, sans `zIndex`.** Les deux moteurs
     * peignent dans le même ordre — carton puis pastille — donc un frère
     * DOM suivant (la pastille) recouvre déjà le précédent par défaut. Posé
     * à `top: 0`, elle mord sur le carton parce que `cardTop` (calculé par
     * `hookGeometry`) descend sous elle du chevauchement.
     */
    it('est positionnée à top: 0 et vient APRÈS le carton dans le DOM — elle le recouvre sans zIndex', () => {
      const hook = badged()
      const { container } = render(<HookOverlay hook={hook} />)
      const badge = container.querySelector('[data-hook="badge"]') as HTMLElement
      const card = container.querySelector('[data-hook="card"]') as HTMLElement
      expect(badge.style.position).toBe('absolute')
      expect(badge.style.top).toBe('0px')
      // `compareDocumentPosition` : le carton précède la pastille.
      expect(card.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('ne revient jamais à la ligne — le rasteriseur ne l’enroule pas', () => {
      const { container } = render(<HookOverlay hook={badged()} />)
      const badge = container.querySelector('[data-hook="badge"]') as HTMLElement
      expect(badge.style.whiteSpace).toBe('nowrap')
    })

    it('sa hauteur vient de hookGeometry, dérivée du layout et non mesurée', () => {
      const hook = badged()
      const geometry = geometryFor(hook)
      const { container } = render(<HookOverlay hook={hook} />)
      const badge = container.querySelector('[data-hook="badge"]') as HTMLElement
      expectCqwPx(badge.style.height, geometry.badgeHeight)
    })

    it('sa position gauche (badgeX) diffère selon l’alignement, jamais au centre par rapport au bord', () => {
      const left = render(<HookOverlay hook={badged({ alignment: 'left' })} />)
      const geometryLeft = geometryFor(badged({ alignment: 'left' }))
      const badgeLeft = left.container.querySelector('[data-hook="badge"]') as HTMLElement
      expectCqwPx(badgeLeft.style.left, geometryLeft.badgeX)
      cleanup()

      const center = render(<HookOverlay hook={badged({ alignment: 'center' })} />)
      const geometryCenter = geometryFor(badged({ alignment: 'center' }))
      const badgeCenter = center.container.querySelector('[data-hook="badge"]') as HTMLElement
      expectCqwPx(badgeCenter.style.left, geometryCenter.badgeX)
    })

    it('rien ne rend quand l’accroche est vide, badge ou pas', () => {
      const { container } = render(<HookOverlay hook={resolved({ text: '', badge: 'DÉFI 10' })} />)
      expect(container.firstChild).toBeNull()
    })
  })

})
