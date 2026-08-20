// @vitest-environment jsdom

/**
 * Le calque de preview du hook. Ce que ces tests fixent :
 *
 * - il disparaît quand le hook n'est pas incrusté (désactivé, ou texte vide) —
 *   point 5 des critères d'acceptation ;
 * - il couvre toute la boîte, en position absolue, indépendamment de tout
 *   ratio — point 4 ;
 * - ses unités sont converties depuis le repère `PlayResX 384 × PlayResY 288`
 *   de `hookLayout`, jamais recalculées.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { HookOverlay, rgbaFrom } from '@/components/clip/hook-overlay'
import { HOOK_DEFAULTS, type ResolvedHook } from '@/core/hook'

afterEach(cleanup)

function resolved(overrides: Partial<ResolvedHook> = {}): ResolvedHook {
  return { ...HOOK_DEFAULTS, text: 'Regarde ça', ...overrides }
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
    const { getByText } = render(<HookOverlay hook={resolved({ text: 'Regarde ça' })} />)
    expect(getByText('Regarde ça')).toBeTruthy()
  })

  it("couvre toute la boîte, en position absolue, et ne pilote pas d'interaction", () => {
    const { container } = render(<HookOverlay hook={resolved()} />)
    const layer = container.firstElementChild as HTMLElement
    expect(layer.className).toContain('absolute')
    expect(layer.className).toContain('inset-0')
    expect(layer.className).toContain('pointer-events-none')
    expect(layer.getAttribute('aria-hidden')).toBe('true')
  })

  // **Chaque valeur est enveloppée dans `calc(…)`**, même à un seul terme
  // (voir `cqw`/`cqh` dans `hook-overlay.tsx`) : jsdom, le moteur CSS de ces
  // tests, refuse une longueur `cqw`/`cqh` nue mais accepte et évalue un
  // `calc()` qui la contient — un navigateur réel traite les deux formes de
  // façon identique. D'où les motifs plutôt qu'une égalité stricte : jsdom
  // évalue l'expression et arrondit le flottant à sa façon.
  it('convertit les marges horizontales du script ASS (384) en cqw', () => {
    const { container } = render(<HookOverlay hook={resolved({ position: 'top' })} />)
    const inner = (container.firstElementChild?.firstElementChild) as HTMLElement
    // marginL = marginR = 24, 24 / 384 * 100 = 6.25
    expect(inner.style.paddingLeft).toMatch(/^calc\(6\.25cqw\)$/)
    expect(inner.style.paddingRight).toMatch(/^calc\(6\.25cqw\)$/)
  })

  it('convertit la marge du haut (position top) en cqh, et laisse le bas nul', () => {
    const { container } = render(<HookOverlay hook={resolved({ position: 'top' })} />)
    const inner = (container.firstElementChild?.firstElementChild) as HTMLElement
    // marginV du haut = 24, 24 / 288 * 100 = 8.333...
    expect(inner.style.paddingTop).toMatch(/^calc\(8\.333/)
    expect(inner.style.paddingBottom).toBe('')
  })

  it('convertit la marge du bas (position bottom), différente de celle du haut', () => {
    const { container } = render(<HookOverlay hook={resolved({ position: 'bottom' })} />)
    const inner = (container.firstElementChild?.firstElementChild) as HTMLElement
    // marginV du bas = 43, 43 / 288 * 100 = 14.930...
    expect(inner.style.paddingBottom).toMatch(/^calc\(14\.930/)
    expect(inner.style.paddingTop).toBe('')
  })

  it('la position centre ne pose ni marge haute ni marge basse', () => {
    const { container } = render(<HookOverlay hook={resolved({ position: 'center' })} />)
    const inner = (container.firstElementChild?.firstElementChild) as HTMLElement
    expect(inner.style.paddingTop).toBe('')
    expect(inner.style.paddingBottom).toBe('')
  })

  it('la taille du texte dérive de `sizeUnits`, floor(size * 0,85)', () => {
    const { container } = render(<HookOverlay hook={resolved({ size: 56 })} />)
    const span = container.querySelector('span') as HTMLElement
    // sizeUnits = floor(56 * 0.85) = 47, 47 / 288 * 100 = 16.319...
    expect(span.style.fontSize).toMatch(/^calc\(16\.319/)
  })
})

describe('rgbaFrom', () => {
  it('convertit une couleur hex et une opacité en pourcentage vers `rgba()`', () => {
    expect(rgbaFrom('#000000', 60)).toBe('rgba(0, 0, 0, 0.6)')
    expect(rgbaFrom('#FFFFFF', 100)).toBe('rgba(255, 255, 255, 1)')
    expect(rgbaFrom('#FF0000', 0)).toBe('rgba(255, 0, 0, 0)')
  })
})
