import { describe, it, expect, vi } from 'vitest'

import { HOOK_DEFAULTS, resolveHook, type ResolvedHook } from '@/core/hook'
import { renderHookAss } from '@/core/hook-ass'

/**
 * `src/core/hook-ass.ts` — le second émetteur ASS, celui du hook.
 *
 * **Égalité de chaîne sur le document produit**, comme `tests/core/captions.test.ts`
 * le fait pour `renderAss` : le format ASS est sensible à la casse, à l'ordre
 * des champs et aux virgules, et un test qui ne regarderait qu'un sous-ensemble
 * laisserait passer un champ décalé sans qu'aucune assertion ne s'en aperçoive.
 */

function resolved(overrides: Partial<ResolvedHook> = {}): ResolvedHook {
  return { ...resolveHook(HOOK_DEFAULTS, { hookText: 'Une accroche', hookStyle: {} }), ...overrides }
}

describe('renderHookAss', () => {
  it('rend null sur un texte vide', () => {
    expect(renderHookAss(resolved({ text: '' }))).toBeNull()
  })

  it('rend null sur un hook désactivé', () => {
    expect(renderHookAss(resolved({ enabled: false }))).toBeNull()
  })

  it('déclare PlayResX ET PlayResY, contrairement à renderAss', () => {
    const ass = renderHookAss(resolved())
    expect(ass).toContain('PlayResX: 384\n')
    expect(ass).toContain('PlayResY: 288\n')
  })

  it('pose WrapStyle: 0 dans [Script Info]', () => {
    expect(renderHookAss(resolved())).toContain('WrapStyle: 0\n')
  })


  it("replie une couleur invalide sans lever, comme styleColor", () => {
    expect(() => renderHookAss(resolved({ textColor: 'pas-une-couleur' }))).not.toThrow()
  })

  it('un `}` dans le texte devient `)`, comme dans renderAss', () => {
    const ass = renderHookAss(resolved({ text: 'Alors {ça} part en vrille' }))
    expect(ass).toContain('Alors (ça) part en vrille')
    expect(ass).not.toContain('{ça}')
  })

  it('un `\\` dans le texte devient `/`', () => {
    const ass = renderHookAss(resolved({ text: 'C:\\Users\\julien' }))
    expect(ass).toContain('C:/Users/julien')
  })

  it('none ne pose aucune balise de fondu', () => {
    const ass = renderHookAss(resolved({ enter: 'none', exit: 'none' }))
    expect(ass).not.toContain('\\fad')
  })

  it('un seul côté en fade pose 0 de l\'autre', () => {
    const ass = renderHookAss(resolved({ enter: 'fade', exit: 'none' }))
    expect(ass).toContain('{\\fad(300,0)}')
  })

  it('glitch ne rend PAS un fondu — il se replie sur aucune transition, avec un avertissement', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ass = renderHookAss(resolved({ enter: 'glitch', exit: 'glitch' }))
    expect(ass).not.toContain('\\fad')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('scanline se replie de la même façon, avec un avertissement', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ass = renderHookAss(resolved({ enter: 'scanline', exit: 'none' }))
    expect(ass).not.toContain('\\fad')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("l'alignement bas pose MarginV depuis le bas (43, comme MARGIN_LOW des sous-titres)", () => {
    const ass = renderHookAss(resolved({ position: 'bottom' }))
    const styleLine = ass?.split('\n').find((l) => l.startsWith('Style: ')) ?? ''
    // Alignment 1 (bas-gauche par défaut : alignment global reste 'center', donc 2), MarginV 43.
    expect(styleLine.endsWith(',2,24,24,43,1')).toBe(true)
  })

  it('le centre ne pose aucune marge verticale (0)', () => {
    const ass = renderHookAss(resolved({ position: 'center' }))
    const styleLine = ass?.split('\n').find((l) => l.startsWith('Style: ')) ?? ''
    expect(styleLine.endsWith(',5,24,24,0,1')).toBe(true)
  })

  it("rend le document complet, égalité de chaîne, pour un hook par défaut", () => {
    const ass = renderHookAss(resolved({ text: 'Salut' }))
    expect(ass).toBe(
      '\uFEFF[Script Info]\n' +
        'ScriptType: v4.00+\n' +
        'PlayResX: 384\n' +
        'PlayResY: 288\n' +
        'WrapStyle: 0\n' +
        'ScaledBorderAndShadow: yes\n' +
        '\n' +
        '[V4+ Styles]\n' +
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, ' +
        'OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ' +
        'ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, ' +
        'Alignment, MarginL, MarginR, MarginV, Encoding\n' +
        'Style: Default,Anton,47,&H00FFFFFF,&H00FFFFFF,&H66000000,&HFF000000,1,0,0,0,100,100,0,0,3,0,0,8,24,24,24,1\n' +
        '\n' +
        '[Events]\n' +
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
        'Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\fad(300,300)}Salut\n',
    )
  })
})
