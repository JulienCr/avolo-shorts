import { describe, it, expect } from 'vitest'
import type { Clip } from '@/core/edl'
import {
  HOOK_DEFAULTS,
  hookFadeMsFor,
  hookIsBurned,
  hookLayout,
  hookPlacement,
  hookRgba,
  normalizeHookBadge,
  normalizeHookText,
  resolveHook,
  type ResolvedHook,
} from '@/core/hook'

/**
 * `src/core/hook.ts` — l'interface dont héritent le rasteriseur PNG du rendu
 * (`src/server/hook-image.ts`) et le calque de preview (`hook-overlay.tsx`).
 * Ce fichier teste ce qu'elle promet, pas une implémentation qui pourrait
 * changer sous elle.
 */

const clip = (
  remaining: Partial<Pick<Clip, 'hookText' | 'hookBadge' | 'hookStyle'>> = {},
): Pick<Clip, 'hookText' | 'hookBadge' | 'hookStyle'> => ({
  hookText: 'Il n’avait rien vu venir',
  hookBadge: '',
  hookStyle: {},
  ...remaining,
})

describe('resolveHook', () => {
  it('surcharge une seule clé, le reste vient des globaux', () => {
    const resolved = resolveHook(HOOK_DEFAULTS, clip({ hookStyle: { sizePermille: 150 } }))
    expect(resolved.sizePermille).toBe(150)
    expect(resolved.position).toBe(HOOK_DEFAULTS.position)
    expect(resolved.enabled).toBe(HOOK_DEFAULTS.enabled)
  })

  it('un hookStyle vide vaut les globaux, tels quels', () => {
    const resolved = resolveHook(HOOK_DEFAULTS, clip({ hookStyle: {} }))
    // `text` et `badge` neutralisés : ce sont les deux champs de CONTENU que
    // `resolveHook` ajoute aux réglages, et le test porte sur les réglages.
    expect({ ...resolved, text: undefined, badge: undefined }).toEqual({
      ...HOOK_DEFAULTS,
      text: undefined,
      badge: undefined,
    })
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
      clip({ hookStyle: { sizePermille: HOOK_DEFAULTS.sizePermille } }),
    )
    const different = resolveHook(HOOK_DEFAULTS, clip({ hookStyle: { sizePermille: 150 } }))
    expect(identical.sizePermille).toBe(HOOK_DEFAULTS.sizePermille)
    expect(different.sizePermille).toBe(150)
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

  it('plafonne à 6 mots', () => {
    const raw = Array.from({ length: 15 }, (_, i) => `mot${i}`).join(' ')
    expect(normalizeHookText(raw).split(' ')).toHaveLength(6)
  })

  it('plafonne à 120 caractères, après le plafond de mots', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `motexcessivementlong${i}`).join(' ')
    expect(raw.length).toBeGreaterThan(120)
    expect(normalizeHookText(raw).length).toBeLessThanOrEqual(120)
  })

  it('recule au dernier espace plutôt que de couper un mot en deux', () => {
    // Six mots de 25 caractères (150 + 5 espaces = 155) : même après le
    // plafond de 6 mots, la chaîne dépasse encore 120 caractères, donc le
    // plafond de caractères s'exerce toujours — avec seulement 6 mots plus
    // courts, le plafond de mots suffirait à faire passer sous la barre
    // avant que celui des caractères n'ait quoi que ce soit à couper.
    const raw = Array.from({ length: 6 }, () => 'x'.repeat(25)).join(' ')
    expect(raw.length).toBeGreaterThan(120)
    const result = normalizeHookText(raw)
    expect(result.length).toBeLessThanOrEqual(120)
    for (const word of result.split(' ')) {
      expect(word).toHaveLength(25)
    }
  })

  it('garde la coupe dure pour une saisie sans espace', () => {
    const raw = 'x'.repeat(150)
    expect(normalizeHookText(raw)).toBe('x'.repeat(120))
  })

  it('ne recule pas quand la coupe dure tombe déjà sur une frontière de mot', () => {
    // Le 120e caractère termine le deuxième mot pile, et le caractère suivant
    // est l'espace séparateur : reculer quand même supprimerait ce mot entier
    // alors qu'il tient dans la limite. (relevé par Copilot)
    const raw = `${'a'.repeat(100)} ${'b'.repeat(19)} ${'c'.repeat(5)}`
    expect(raw.length).toBeGreaterThan(120)
    expect(normalizeHookText(raw)).toBe(`${'a'.repeat(100)} ${'b'.repeat(19)}`)
  })

  it('ne coupe pas un emoji en deux, en comptant par points de code plutôt que par unités UTF-16', () => {
    // Un emoji hors du plan de base occupe deux unités UTF-16 (une paire de
    // substituts) : `.length`/`.slice` comptent des unités, pas des points de
    // code, et une coupe au 120e caractère peut retomber entre les deux
    // moitiés d'un emoji et rendre un substitut seul, chaîne Unicode
    // invalide. (relevé par Copilot)
    const raw = `${'a'.repeat(119)}😀😀`
    expect(normalizeHookText(raw)).toBe(`${'a'.repeat(119)}😀`)
  })

  it('rend une chaîne vide pour une entrée vide ou faite de guillemets vides', () => {
    expect(normalizeHookText('')).toBe('')
    expect(normalizeHookText('   ')).toBe('')
    expect(normalizeHookText('""')).toBe('')
  })
})

const RESOLVED_BASE: ResolvedHook = { ...HOOK_DEFAULTS, text: 'x', badge: '' }

describe('hookLayout', () => {
  // **Le cœur du critère d'acceptation 2 : les fractions ne dépendent QUE de
  // `resolved`, jamais d'un canevas.** `hookLayout` ne prend pas de largeur ni
  // de hauteur en argument : c'est aux deux consommateurs (rasteriseur PNG,
  // calque de preview) de multiplier par LEUR largeur. Deux canevas de même
  // largeur (1080, natif 1:1/4:5/9:16 et variante 9:16) reçoivent donc
  // exactement les mêmes fractions, et c'est ce qui garantit le même bandeau.
  it('fontSizeFraction est sizePermille/1000', () => {
    expect(hookLayout({ ...RESOLVED_BASE, sizePermille: 90 }).fontSizeFraction).toBe(0.09)
    expect(hookLayout({ ...RESOLVED_BASE, sizePermille: 150 }).fontSizeFraction).toBe(0.15)
  })

  it('radiusFraction est cornerRadiusPermille/1000', () => {
    expect(hookLayout({ ...RESOLVED_BASE, cornerRadiusPermille: 24 }).radiusFraction).toBe(0.024)
    expect(hookLayout({ ...RESOLVED_BASE, cornerRadiusPermille: 0 }).radiusFraction).toBe(0)
  })

  it('lineHeightFraction et le rembourrage sont proportionnels à fontSizeFraction', () => {
    const small = hookLayout({ ...RESOLVED_BASE, sizePermille: 50 })
    const big = hookLayout({ ...RESOLVED_BASE, sizePermille: 100 })
    // Deux fois la taille de police -> deux fois l'interligne et le rembourrage :
    // ce sont des multiples constants de `fontSizeFraction`, pas des valeurs fixes.
    expect(big.lineHeightFraction).toBeCloseTo(small.lineHeightFraction * 2)
    expect(big.paddingXFraction).toBeCloseTo(small.paddingXFraction * 2)
    expect(big.paddingYFraction).toBeCloseTo(small.paddingYFraction * 2)
  })

  it('la marge horizontale ne dépend ni de la taille ni de l’alignement', () => {
    const left = hookLayout({ ...RESOLVED_BASE, alignment: 'left', sizePermille: 60 })
    const right = hookLayout({ ...RESOLVED_BASE, alignment: 'right', sizePermille: 200 })
    expect(left.marginXFraction).toBe(right.marginXFraction)
  })

  it('la marge verticale dépend de la position, jamais de l’alignement', () => {
    const top = hookLayout({ ...RESOLVED_BASE, position: 'top' })
    const bottom = hookLayout({ ...RESOLVED_BASE, position: 'bottom' })
    const center = hookLayout({ ...RESOLVED_BASE, position: 'center' })
    expect(top.marginYFraction).not.toBe(bottom.marginYFraction)
    expect(top.marginYFraction).toBeGreaterThan(0)
    expect(bottom.marginYFraction).toBeGreaterThan(0)
    expect(center.marginYFraction).toBe(0)
    // Même valeur, quel que soit l'alignement — la position seule décide.
    expect(hookLayout({ ...RESOLVED_BASE, position: 'top', alignment: 'left' }).marginYFraction).toBe(
      top.marginYFraction,
    )
  })

  it('maxBoxWidthFraction est une constante, indépendante du hook résolu', () => {
    const a = hookLayout({ ...RESOLVED_BASE, sizePermille: 40, position: 'bottom' })
    const b = hookLayout({ ...RESOLVED_BASE, sizePermille: 200, position: 'top' })
    expect(a.maxBoxWidthFraction).toBe(b.maxBoxWidthFraction)
    expect(a.maxBoxWidthFraction).toBeGreaterThan(0)
    expect(a.maxBoxWidthFraction).toBeLessThanOrEqual(1)
  })
})

describe('le badge', () => {
  it('resolveHook remonte le texte du badge depuis le clip', () => {
    expect(resolveHook(HOOK_DEFAULTS, clip({ hookBadge: 'DÉFI 10' })).badge).toBe('DÉFI 10')
  })

  /**
   * **Le badge ne fait pas brûler à lui seul, et c'est instruit.** Sa
   * géométrie est définie par rapport au carton — le chevauchement, le retrait
   * qui aligne les premières lettres —, donc sans carton il n'a pas d'ancre.
   * Le silence que ça pourrait créer est fermé par une phrase dans l'écran
   * Clip, pas par une incrustation que personne n'a validée à l'image.
   */
  it("n'incruste rien quand le badge est seul, sans accroche", () => {
    const resolved = resolveHook(HOOK_DEFAULTS, clip({ hookText: '', hookBadge: 'DÉFI 10' }))
    expect(hookIsBurned(resolved)).toBe(false)
  })

  it('la pastille est nettement plus petite que le carton', () => {
    const layout = hookLayout(RESOLVED_BASE)
    expect(layout.badgeFontSizeFraction).toBeLessThan(layout.fontSizeFraction)
    expect(layout.badgeFontSizeFraction).toBeGreaterThan(layout.fontSizeFraction / 2.5)
  })

  /**
   * La hauteur de la pastille est **calculée**, jamais mesurée : c'est ce qui
   * permet au calque de preview de poser exactement celle du PNG. Elle doit
   * donc rester une fonction pure des fractions, sans dépendance au texte.
   */
  it('la hauteur de la pastille se déduit de sa police et de son rembourrage', () => {
    const layout = hookLayout(RESOLVED_BASE)
    expect(layout.badgeHeightFraction).toBeCloseTo(
      layout.badgeFontSizeFraction * 1.2 + 2 * layout.badgePaddingYFraction,
      12,
    )
  })

  it('tout suit proportionnellement quand la taille du hook change', () => {
    const small = hookLayout({ ...RESOLVED_BASE, sizePermille: 60 })
    const large = hookLayout({ ...RESOLVED_BASE, sizePermille: 120 })
    expect(large.badgeFontSizeFraction).toBeCloseTo(small.badgeFontSizeFraction * 2, 12)
    expect(large.badgeHeightFraction).toBeCloseTo(small.badgeHeightFraction * 2, 12)
  })

  it('le chevauchement reste une fraction de la hauteur de la pastille', () => {
    const layout = hookLayout(RESOLVED_BASE)
    expect(layout.badgeOverlapFraction).toBeGreaterThan(0)
    expect(layout.badgeOverlapFraction).toBeLessThan(layout.badgeHeightFraction / 2)
  })

  /**
   * Le retrait aligne les deux premières lettres. Il ne peut jamais être
   * négatif : au plancher de taille du hook, le rembourrage de la pastille
   * peut dépasser celui du carton, et un retrait négatif la ferait sortir du
   * carton par le côté que l'alignement était censé tenir.
   */
  it('le retrait de la pastille ne devient jamais négatif', () => {
    for (const sizePermille of [20, 90, 250]) {
      expect(hookLayout({ ...RESOLVED_BASE, sizePermille }).badgeInsetFraction).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('normalizeHookBadge', () => {
  it('plafonne à trois mots', () => {
    expect(normalizeHookBadge('un deux trois quatre cinq')).toBe('un deux trois')
  })

  it('retire les guillemets encadrants, comme le hook', () => {
    expect(normalizeHookBadge('«\u00a0DÉFI 10\u00a0»')).toBe('DÉFI 10')
    expect(normalizeHookBadge('"DÉFI 10"')).toBe('DÉFI 10')
  })

  it('effondre les blancs et taille les bords', () => {
    expect(normalizeHookBadge('  DÉFI   10  ')).toBe('DÉFI 10')
  })

  /**
   * Le plafond de caractères n'est pas cosmétique : le rasteriseur n'enroule
   * PAS la pastille, donc un badge long produirait une boîte large comme le
   * canevas au lieu de revenir à la ligne. C'est ce plafond qui l'en empêche.
   */
  it('plafonne à 24 caractères sans couper au milieu d’un mot', () => {
    const badge = normalizeHookBadge('ABCDEFGHIJ KLMNOPQRSTUVWXYZ')
    expect(badge).toBe('ABCDEFGHIJ')
    expect(Array.from(badge).length).toBeLessThanOrEqual(24)
  })

  it('garde la coupe dure quand il n’y a aucun espace où reculer', () => {
    expect(normalizeHookBadge('A'.repeat(40))).toBe('A'.repeat(24))
  })

  /**
   * **La preuve que la mécanique est partagée et non recopiée** : à plafonds
   * égaux, les deux fonctions doivent traiter identiquement le même cas de
   * coupe. Si quelqu'un réécrit l'une, ce test tombe.
   */
  it('traite les guillemets et les blancs exactement comme normalizeHookText', () => {
    const raw = '  «\u00a0Trois mots ici\u00a0»  '
    expect(normalizeHookBadge(raw)).toBe(normalizeHookText(raw))
  })
})

describe('hookRgba', () => {
  it('convertit une couleur hex et un pourcentage en rgba()', () => {
    expect(hookRgba('#FF00FF', 100)).toBe('rgba(255, 0, 255, 1)')
    expect(hookRgba('#000000', 0)).toBe('rgba(0, 0, 0, 0)')
    expect(hookRgba('#112233', 50)).toBe('rgba(17, 34, 51, 0.5)')
  })
})

describe('hookPlacement', () => {
  const layout = hookLayout(RESOLVED_BASE)
  const canvas = { w: 1080, h: 1920 }
  const image = { w: 300, h: 90 }

  it('centre horizontalement pour alignment: center, verticalement pour position: center', () => {
    const { x, y } = hookPlacement(image, canvas, { position: 'center', alignment: 'center' }, layout)
    expect(x).toBe(Math.round((canvas.w - image.w) / 2))
    expect(y).toBe(Math.round((canvas.h - image.h) / 2))
  })

  it('colle à gauche/droite et haut/bas, à la marge près', () => {
    const marginX = Math.round(canvas.w * layout.marginXFraction)
    const { x: leftX } = hookPlacement(image, canvas, { position: 'top', alignment: 'left' }, layout)
    expect(leftX).toBe(marginX)
    const { x: rightX } = hookPlacement(image, canvas, { position: 'top', alignment: 'right' }, layout)
    expect(rightX).toBe(canvas.w - marginX - image.w)
  })

  it('ne rend jamais une coordonnée négative, même pour une image plus large que le canevas', () => {
    const tooWide = { w: 2000, h: 90 }
    const { x } = hookPlacement(tooWide, canvas, { position: 'top', alignment: 'right' }, layout)
    expect(x).toBeGreaterThanOrEqual(0)
  })

  it("ne déborde jamais par la droite ou par le bas — bornage à une seule extrémité relevé par Copilot (PR #117, passe 3)", () => {
    // Une image plafonnée à `canvas.w`/`canvas.h` par `renderHookImage` peut
    // quand même déborder si `hookPlacement` ne borne que `Math.max(0, …)` :
    // en alignement `left`, `x` reste à la marge, donc `x + image.w` dépasse
    // le bord droit dès que `image.w` approche `canvas.w`.
    const asWideAsCanvas = { w: canvas.w, h: 90 }
    const { x } = hookPlacement(asWideAsCanvas, canvas, { position: 'top', alignment: 'left' }, layout)
    expect(x + asWideAsCanvas.w).toBeLessThanOrEqual(canvas.w)

    const asTallAsCanvas = { w: 300, h: canvas.h }
    const { y } = hookPlacement(asTallAsCanvas, canvas, { position: 'bottom', alignment: 'center' }, layout)
    expect(y + asTallAsCanvas.h).toBeLessThanOrEqual(canvas.h)
    expect(y).toBeGreaterThanOrEqual(0)
  })

  it("la marge basse suit la HAUTEUR du canevas, pas sa largeur — protection contre le chrome de TikTok/Reels, mesurée comme celle des sous-titres (relevé par Aristarque sur la PR #117)", () => {
    // Un canevas dont la largeur et la hauteur divergent nettement rend les
    // deux hypothèses (marge sur `w` vs marge sur `h`) numériquement
    // distinguables — un carré ne les distinguerait pas.
    const tallCanvas = { w: 1080, h: 1920 }
    const { y } = hookPlacement(image, tallCanvas, { position: 'bottom', alignment: 'center' }, layout)
    const marginOnHeight = Math.round(tallCanvas.h * layout.marginYFraction)
    const marginOnWidth = Math.round(tallCanvas.w * layout.marginYFraction)
    expect(marginOnHeight).not.toBe(marginOnWidth)
    expect(y).toBe(tallCanvas.h - marginOnHeight - image.h)
  })

  it("la marge haute, elle, suit la LARGEUR du canevas — seule `bottom` protège une zone de chrome", () => {
    const tallCanvas = { w: 1080, h: 1920 }
    const { y } = hookPlacement(image, tallCanvas, { position: 'top', alignment: 'center' }, layout)
    const marginOnWidth = Math.round(tallCanvas.w * layout.marginYFraction)
    expect(y).toBe(marginOnWidth)
  })
})

describe('HOOK_DEFAULTS', () => {
  /**
   * **Le défaut qui décide de la vignette.** Instagram fabrique l'image du fil
   * avec la première frame du fichier ; un fondu d'entrée y laisse le hook à
   * opacité nulle, donc l'accroche manque à la seule image qu'on voit avant de
   * cliquer. Ce test existe pour qu'on ne remette pas `fade` par défaut sans
   * lire cette phrase — le réglage lui-même reste disponible par clip.
   */
  it("n'ouvre sur aucun fondu d'entrée : le hook est plein dès la frame 0", () => {
    expect(hookFadeMsFor(HOOK_DEFAULTS.enter, 'enter', HOOK_DEFAULTS.durationMs)).toBe(0)
  })

  it('garde en revanche le fondu de sortie, qui ne se joue sur aucune vignette', () => {
    expect(hookFadeMsFor(HOOK_DEFAULTS.exit, 'exit', HOOK_DEFAULTS.durationMs)).toBeGreaterThan(0)
  })
})
