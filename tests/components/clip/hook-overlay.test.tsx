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
import { afterEach, describe, expect, it } from 'vitest'

import { HookOverlay } from '@/components/clip/hook-overlay'
import { outputSize } from '@/core/framing'
import { HOOK_DEFAULTS, hookGeometry, hookLayout, type HookMeasure, type ResolvedHook } from '@/core/hook'

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

  it('convertit la marge de sécurité gauche/droite (marginXFraction) en cqw', () => {
    const hook = resolved({ position: 'top' })
    const layout = hookLayout(hook)
    const { container } = render(<HookOverlay hook={hook} />)
    const inner = container.firstElementChild?.firstElementChild as HTMLElement
    expect(inner.style.paddingLeft).toMatch(new RegExp(`^calc\\(${percent(layout.marginXFraction)}cqw\\)$`))
    expect(inner.style.paddingRight).toMatch(new RegExp(`^calc\\(${percent(layout.marginXFraction)}cqw\\)$`))
  })

  it('convertit la marge du haut (position top) en cqw, et laisse le bas nul', () => {
    const hook = resolved({ position: 'top' })
    const layout = hookLayout(hook)
    const { container } = render(<HookOverlay hook={hook} />)
    const inner = container.firstElementChild?.firstElementChild as HTMLElement
    expect(inner.style.paddingTop).toMatch(new RegExp(`^calc\\(${percent(layout.marginYFraction)}cqw\\)$`))
    expect(inner.style.paddingBottom).toBe('')
  })

  it('convertit la marge du bas (position bottom) en cqh — hauteur, pas largeur, différente de celle du haut', () => {
    const top = hookLayout(resolved({ position: 'top' }))
    const bottom = hookLayout(resolved({ position: 'bottom' }))
    expect(bottom.marginYFraction).not.toBe(top.marginYFraction)
    const { container } = render(<HookOverlay hook={resolved({ position: 'bottom' })} />)
    const inner = container.firstElementChild?.firstElementChild as HTMLElement
    // `cqh`, pas `cqw` : la marge basse protège une zone de chrome de
    // plateforme dont l'étendue suit la hauteur du canevas, voir la doc de
    // `HOOK_MARGIN_BOTTOM_FRACTION` dans `@/core/hook`.
    expect(inner.style.paddingBottom).toMatch(new RegExp(`^calc\\(${percent(bottom.marginYFraction)}cqh\\)$`))
    expect(inner.style.paddingTop).toBe('')
  })

  it('la position centre ne pose ni marge haute ni marge basse', () => {
    const { container } = render(<HookOverlay hook={resolved({ position: 'center' })} />)
    const inner = container.firstElementChild?.firstElementChild as HTMLElement
    expect(inner.style.paddingTop).toBe('')
    expect(inner.style.paddingBottom).toBe('')
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
