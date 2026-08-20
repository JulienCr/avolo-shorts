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
import { HOOK_DEFAULTS, hookLayout, type ResolvedHook } from '@/core/hook'

afterEach(cleanup)

function resolved(overrides: Partial<ResolvedHook> = {}): ResolvedHook {
  return { ...HOOK_DEFAULTS, text: 'Regarde ça', badge: '', ...overrides }
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

  it("force content-box sur le span de texte — le preflight Tailwind pose border-box globalement, sous quoi `max-width` inclurait déjà le rembourrage et le soustraire une seconde fois réduirait la largeur utile en double (relevé par Copilot, PR #117, passe 4)", () => {
    const { container } = render(<HookOverlay hook={resolved()} />)
    const span = container.querySelector('[data-hook="card"]') as HTMLElement
    expect(span.style.boxSizing).toBe('content-box')
  })

  it("n'utilise pas pre-wrap — wrapLines (rasteriseur PNG) réduit les espaces répétés à un seul, `pre-wrap` les aurait conservés et désaccordé la largeur de la boîte de la preview de celle du rendu (relevé par Copilot, PR #117, passe 4)", () => {
    const { container } = render(<HookOverlay hook={resolved()} />)
    const span = container.querySelector('[data-hook="card"]') as HTMLElement
    expect(span.style.whiteSpace).toBe('normal')
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
     * **Le décalque du chevauchement, et le piège qui va avec.** Les deux
     * moteurs empilent à l'envers l'un de l'autre : dans le canevas c'est le
     * dernier peint qui gagne (la pastille), dans le DOM c'est le frère
     * suivant (le carton). Sans `zIndex`, cette preview montrerait l'inverse
     * exact du fichier rendu.
     */
    it('mord sur le carton par une marge négative, et passe DEVANT lui', () => {
      const hook = badged()
      const layout = hookLayout(hook)
      const { container } = render(<HookOverlay hook={hook} />)
      const badge = container.querySelector('[data-hook="badge"]') as HTMLElement
      expect(badge.style.marginBottom).toBe(`calc(${percent(-layout.badgeOverlapFraction)}cqw)`)
      expect(badge.style.zIndex).toBe('1')
      expect(badge.style.position).toBe('relative')
    })

    it('ne revient jamais à la ligne — le rasteriseur ne l’enroule pas', () => {
      const { container } = render(<HookOverlay hook={badged()} />)
      const badge = container.querySelector('[data-hook="badge"]') as HTMLElement
      expect(badge.style.whiteSpace).toBe('nowrap')
    })

    it('sa hauteur vient de badgeHeightFraction, calculée et non mesurée', () => {
      const hook = badged()
      const layout = hookLayout(hook)
      const { container } = render(<HookOverlay hook={hook} />)
      const badge = container.querySelector('[data-hook="badge"]') as HTMLElement
      expect(badge.style.height).toBe(`calc(${percent(layout.badgeHeightFraction)}cqw)`)
    })

    it('le retrait ne s’applique que sur un bord, jamais au centre', () => {
      const left = render(<HookOverlay hook={badged({ alignment: 'left' })} />)
      const badgeLeft = left.container.querySelector('[data-hook="badge"]') as HTMLElement
      expect(badgeLeft.style.marginLeft).not.toBe('')
      expect(badgeLeft.style.marginRight).toBe('')
      cleanup()

      const center = render(<HookOverlay hook={badged({ alignment: 'center' })} />)
      const badgeCenter = center.container.querySelector('[data-hook="badge"]') as HTMLElement
      expect(badgeCenter.style.marginLeft).toBe('')
      expect(badgeCenter.style.marginRight).toBe('')
    })

    it('rien ne rend quand l’accroche est vide, badge ou pas', () => {
      const { container } = render(<HookOverlay hook={resolved({ text: '', badge: 'DÉFI 10' })} />)
      expect(container.firstChild).toBeNull()
    })
  })

})
