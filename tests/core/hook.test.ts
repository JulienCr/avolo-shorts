import { describe, it, expect } from 'vitest'
import type { Clip } from '@/core/edl'
import {
  HOOK_DEFAULTS,
  hookIsBurned,
  hookLayout,
  normalizeHookText,
  resolveHook,
  type HookSettings,
} from '@/core/hook'

/**
 * `src/core/hook.ts` — l'interface dont héritent l'émetteur ASS (PR suivante)
 * et le calque de preview (PR suivante encore). Sa signature est figée par
 * l'orchestrateur ; ce fichier teste ce qu'elle promet, pas une implémentation
 * qui pourrait changer sous elle.
 */

const clip = (remaining: Partial<Pick<Clip, 'hookText' | 'hookStyle'>> = {}): Pick<
  Clip,
  'hookText' | 'hookStyle'
> => ({
  hookText: 'Il n’avait rien vu venir',
  hookStyle: {},
  ...remaining,
})

describe('resolveHook', () => {
  it('surcharge une seule clé, le reste vient des globaux', () => {
    const resolved = resolveHook(HOOK_DEFAULTS, clip({ hookStyle: { size: 72 } }))
    expect(resolved.size).toBe(72)
    expect(resolved.position).toBe(HOOK_DEFAULTS.position)
    expect(resolved.enabled).toBe(HOOK_DEFAULTS.enabled)
  })

  it('un hookStyle vide vaut les globaux, tels quels', () => {
    const resolved = resolveHook(HOOK_DEFAULTS, clip({ hookStyle: {} }))
    expect({ ...resolved, text: undefined }).toEqual({ ...HOOK_DEFAULTS, text: undefined })
  })

  /**
   * **Une surcharge identique à la valeur globale reste une surcharge.**
   * §7 : « les deux doivent rester distincts ». `resolveHook` ne sait pas
   * dire lequel des deux chemins a produit sa sortie — c'est `Clip.hookStyle`
   * en base qui porte la distinction (voir `tests/server/db.test.ts`,
   * grammaire du hook) — mais ce test tient au moins la moitié qui se prouve
   * ici : la clé surchargée gagne toujours, que sa valeur diffère du global
   * ou non.
   */
  it('une surcharge dont la valeur égale le défaut gagne quand même', () => {
    const identical = resolveHook(
      HOOK_DEFAULTS,
      clip({ hookStyle: { size: HOOK_DEFAULTS.size } }),
    )
    const different = resolveHook(HOOK_DEFAULTS, clip({ hookStyle: { size: 72 } }))
    expect(identical.size).toBe(HOOK_DEFAULTS.size)
    expect(different.size).toBe(72)
  })

  it('le texte vient de hookText, jamais des globaux', () => {
    const resolved = resolveHook(HOOK_DEFAULTS, clip({ hookText: 'Une accroche' }))
    expect(resolved.text).toBe('Une accroche')
  })
})

describe('hookIsBurned', () => {
  it('vrai quand activé et un texte non vide', () => {
    expect(hookIsBurned(resolveHook(HOOK_DEFAULTS, clip()))).toBe(true)
  })

  it('faux quand le texte est vide', () => {
    expect(hookIsBurned(resolveHook(HOOK_DEFAULTS, clip({ hookText: '' })))).toBe(false)
  })

  it('faux quand le texte n’est que des blancs', () => {
    expect(hookIsBurned(resolveHook(HOOK_DEFAULTS, clip({ hookText: '   ' })))).toBe(false)
  })

  it('faux quand désactivé, même avec un texte', () => {
    expect(
      hookIsBurned(resolveHook(HOOK_DEFAULTS, clip({ hookStyle: { enabled: false } }))),
    ).toBe(false)
  })
})

describe('normalizeHookText', () => {
  it('trime et effondre les blancs multiples', () => {
    expect(normalizeHookText('  Il   n’avait   rien   vu  ')).toBe('Il n’avait rien vu')
  })

  it('effondre tabulations et retours à la ligne', () => {
    expect(normalizeHookText('Il\n\tn’avait\nrien vu')).toBe('Il n’avait rien vu')
  })

  it('retire les guillemets droits encadrants', () => {
    expect(normalizeHookText('"Il n’avait rien vu venir"')).toBe('Il n’avait rien vu venir')
  })

  it('retire les guillemets français encadrants', () => {
    expect(normalizeHookText('«Il n’avait rien vu venir»')).toBe('Il n’avait rien vu venir')
  })

  it('ne retire pas un guillemet qui n’encadre pas tout le texte', () => {
    expect(normalizeHookText('Il a dit "non" clairement')).toBe('Il a dit "non" clairement')
  })

  it('plafonne à 10 mots', () => {
    const raw = Array.from({ length: 15 }, (_, i) => `mot${i}`).join(' ')
    expect(normalizeHookText(raw).split(' ')).toHaveLength(10)
  })

  it('plafonne à 120 caractères, après le plafond de mots', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `motexcessivementlong${i}`).join(' ')
    expect(raw.length).toBeGreaterThan(120)
    expect(normalizeHookText(raw).length).toBeLessThanOrEqual(120)
  })

  it('rend une chaîne vide pour une entrée vide ou faite de guillemets vides', () => {
    expect(normalizeHookText('')).toBe('')
    expect(normalizeHookText('   ')).toBe('')
    expect(normalizeHookText('""')).toBe('')
  })
})

const RESOLVED_BASE: HookSettings & { text: string } = { ...HOOK_DEFAULTS, text: 'x' }

describe('hookLayout', () => {
  it.each([
    ['top', 'left', 7],
    ['top', 'center', 8],
    ['top', 'right', 9],
    ['center', 'left', 4],
    ['center', 'center', 5],
    ['center', 'right', 6],
    ['bottom', 'left', 1],
    ['bottom', 'center', 2],
    ['bottom', 'right', 3],
  ] as const)('position %s × alignement %s -> assAlignment %i', (position, alignment, expected) => {
    const layout = hookLayout({ ...RESOLVED_BASE, position, alignment })
    expect(layout.assAlignment).toBe(expected)
  })

  it('les marges horizontales sont les mêmes des deux côtés, quel que soit l’alignement', () => {
    const left = hookLayout({ ...RESOLVED_BASE, alignment: 'left' })
    const right = hookLayout({ ...RESOLVED_BASE, alignment: 'right' })
    expect(left.marginL).toBe(left.marginR)
    expect(right.marginL).toBe(right.marginR)
    expect(left.marginL).toBe(right.marginL)
  })

  it('la marge verticale dépend de la position, jamais de l’alignement', () => {
    const top = hookLayout({ ...RESOLVED_BASE, position: 'top' })
    const bottom = hookLayout({ ...RESOLVED_BASE, position: 'bottom' })
    const center = hookLayout({ ...RESOLVED_BASE, position: 'center' })
    expect(top.marginV).not.toBe(bottom.marginV)
    expect(top.marginV).toBeGreaterThan(0)
    expect(bottom.marginV).toBeGreaterThan(0)
    expect(center.marginV).toBe(0)
  })

  it('la taille suit le facteur 0,85 des sous-titres', () => {
    expect(hookLayout({ ...RESOLVED_BASE, size: 44 }).sizeUnits).toBe(Math.floor(44 * 0.85))
    expect(hookLayout({ ...RESOLVED_BASE, size: 56 }).sizeUnits).toBe(Math.floor(56 * 0.85))
  })
})
