import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HOOK_DEFAULTS, hookLayout, type ResolvedHook } from '@/core/hook'
import { renderHookImage } from '@/server/hook-image'

/**
 * Le rasteriseur (`src/server/hook-image.ts`) est le cœur du changement de
 * la PR #117 et n'avait aucun test automatisé — relevé par Aristarque en
 * review. Ce fichier ne verrouille pas des pixels (aucun test ne le fait
 * pour un rendu texte, voir la doc de la PR), mais les propriétés
 * structurelles qui, elles, se vérifient : les dimensions produites, et le
 * plafond qui empêche la boîte de dépasser le canevas.
 *
 * `fontsDir` pointe sur le vrai `fonts/` du dépôt : `@napi-rs/canvas` mesure
 * alors avec la vraie police Anton plutôt qu'un repli système imprévisible,
 * ce qui rend les largeurs mesurées reproductibles.
 */
const FONTS_DIR = path.join(process.cwd(), 'fonts')

function resolved(overrides: Partial<ResolvedHook> = {}): ResolvedHook {
  return { ...HOOK_DEFAULTS, text: 'ÇA TOURNE', badge: '', ...overrides }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('renderHookImage', () => {
  describe('le badge, composé dans le même PNG', () => {
    /**
     * **Le garde-fou de non-régression de tout ce chantier.** Sans badge, le
     * composite doit rendre exactement ce que rendait le rasteriseur d'avant :
     * mêmes dimensions, même position. Si ce test tombe, c'est que la
     * composition a changé le cas nominal, qui est aussi le cas courant.
     */
    it('un hook sans badge rend exactement la boîte d’avant', () => {
      const noBadge = renderHookImage(resolved({ badge: '' }), { w: 1080, h: 1920 }, FONTS_DIR)
      const blank = renderHookImage(resolved({ badge: '   ' }), { w: 1080, h: 1920 }, FONTS_DIR)
      expect(noBadge).not.toBeNull()
      if (noBadge === null || blank === null) return
      // Un badge fait de blancs est un badge absent : c'est `trim()` qui
      // tranche, du même geste que `hookIsBurned` pour l'accroche.
      expect(blank.width).toBe(noBadge.width)
      expect(blank.height).toBe(noBadge.height)
    })

    it('la pastille ajoute de la hauteur, moins son chevauchement', () => {
      const noBadge = renderHookImage(resolved({ badge: '' }), { w: 1080, h: 1920 }, FONTS_DIR)
      const withBadge = renderHookImage(resolved({ badge: 'DÉFI 10' }), { w: 1080, h: 1920 }, FONTS_DIR)
      expect(noBadge).not.toBeNull()
      expect(withBadge).not.toBeNull()
      if (noBadge === null || withBadge === null) return
      expect(withBadge.height).toBeGreaterThan(noBadge.height)
      // Et pas de la hauteur pleine de la pastille : le chevauchement en
      // reprend une part.
      const layout = hookLayout(resolved({ badge: 'DÉFI 10' }))
      const badgeHeight = 1080 * layout.badgeHeightFraction
      expect(withBadge.height - noBadge.height).toBeLessThan(badgeHeight)
    })

    it('le composite prend la largeur du plus large des deux', () => {
      // Une accroche d’un mot court, un badge de trois mots : c'est la
      // pastille qui décide de la largeur, cas que le carton seul n'atteint
      // jamais.
      const hook = resolved({ text: 'OUI', badge: 'UN DEUX TROIS' })
      const image = renderHookImage(hook, { w: 1080, h: 1920 }, FONTS_DIR)
      const card = renderHookImage(resolved({ text: 'OUI', badge: '' }), { w: 1080, h: 1920 }, FONTS_DIR)
      expect(image).not.toBeNull()
      expect(card).not.toBeNull()
      if (image === null || card === null) return
      expect(image.width).toBeGreaterThan(card.width)
    })

    /**
     * **La seule assertion de pixel de ce fichier, et elle est structurelle.**
     * Elle ne vérifie aucun rendu de texte : elle vérifie l'ORDRE de dessin.
     * La pastille mord sur le carton, donc elle doit être peinte APRÈS lui ;
     * peinte avant, le fond opaque du carton en effacerait la partie basse.
     * C'est le seul défaut de cette composition qui produirait une image
     * plausible et fausse — donc le seul qu'un test de dimensions ne verrait
     * pas passer.
     */
    it('dans la zone de chevauchement, c’est la pastille qu’on voit, pas le carton', async () => {
      const hook = resolved({
        text: 'ENCORE UN PROCÈS',
        badge: 'DÉFI 10',
        alignment: 'center',
        backgroundColor: '#FFFFFF',
        badgeBackground: '#E5007D',
      })
      const image = renderHookImage(hook, { w: 1080, h: 1920 }, FONTS_DIR)
      expect(image).not.toBeNull()
      if (image === null) return

      const layout = hookLayout(hook)
      const badgeHeight = Math.round(1080 * layout.badgeHeightFraction)
      const overlap = Math.round(1080 * layout.badgeOverlapFraction)
      expect(overlap).toBeGreaterThan(1)

      // Un point au milieu de la bande de chevauchement, sur l'axe vertical
      // de la pastille — donc à l'intérieur des deux boîtes à la fois.
      const y = badgeHeight - Math.floor(overlap / 2)
      const surface = createCanvas(image.width, image.height)
      const ctx = surface.getContext('2d')
      ctx.drawImage(await loadImage(image.buffer), 0, 0)
      const [r, g, b] = ctx.getImageData(Math.round(image.width / 2), y, 1, 1).data
      expect([r, g, b]).toEqual([0xe5, 0x00, 0x7d])
    })

    it('un badge démesuré ne fait jamais déborder le composite du canevas', () => {
      const hook = resolved({
        text: 'MOT',
        badge: 'X'.repeat(120),
        sizePermille: 250,
      })
      const image = renderHookImage(hook, { w: 1080, h: 200 }, FONTS_DIR)
      expect(image).not.toBeNull()
      if (image === null) return
      expect(image.width).toBeLessThanOrEqual(1080)
      expect(image.height).toBeLessThanOrEqual(200)
      expect(image.x).toBeGreaterThanOrEqual(0)
      expect(image.y).toBeGreaterThanOrEqual(0)
      expect(image.x + image.width).toBeLessThanOrEqual(1080)
      expect(image.y + image.height).toBeLessThanOrEqual(200)
    })

    /**
     * En alignement `left`, le bord gauche du CARTON doit coïncider avec
     * celui du composite — même quand la pastille est plus large que lui,
     * cas où un placement naïf collerait le carton au bord de la pastille et
     * le décalerait de la marge de sécurité que `hookPlacement` pose.
     */
    it.each(['left', 'right'] as const)(
      'en alignement %s, le carton touche le bord du composite même sous une pastille plus large',
      (alignment) => {
        const hook = resolved({ text: 'OUI', badge: 'UN DEUX TROIS', alignment })
        const image = renderHookImage(hook, { w: 1080, h: 1920 }, FONTS_DIR)
        expect(image).not.toBeNull()
        if (image === null) return
        const marginX = Math.round(1080 * hookLayout(hook).marginXFraction)
        const expected = alignment === 'left' ? marginX : 1080 - marginX - image.width
        expect(image.x).toBe(expected)
      },
    )
  })

  it('rend null quand le hook est désactivé ou son texte est vide — pas de PNG à incruster', () => {
    expect(renderHookImage(resolved({ enabled: false }), { w: 1080, h: 1920 }, FONTS_DIR)).toBeNull()
    expect(renderHookImage(resolved({ text: '' }), { w: 1080, h: 1920 }, FONTS_DIR)).toBeNull()
  })

  it('produit un PNG dont les dimensions restent dans le canevas et paires (chrominance yuv420p)', () => {
    const image = renderHookImage(resolved(), { w: 1080, h: 1920 }, FONTS_DIR)
    expect(image).not.toBeNull()
    if (image === null) return
    expect(image.width).toBeGreaterThan(0)
    expect(image.height).toBeGreaterThan(0)
    expect(image.width % 2).toBe(0)
    expect(image.height % 2).toBe(0)
    expect(image.width).toBeLessThanOrEqual(1080)
    expect(image.height).toBeLessThanOrEqual(1920)
    // La position posée par `hookPlacement` (fonction pure partagée, testée
    // par ailleurs) reste dans le canevas.
    expect(image.x).toBeGreaterThanOrEqual(0)
    expect(image.y).toBeGreaterThanOrEqual(0)
    expect(image.x + image.width).toBeLessThanOrEqual(1080)
    expect(image.y + image.height).toBeLessThanOrEqual(1920)
  })

  it('un texte qui s’enroule sur beaucoup de lignes ne produit jamais une boîte plus haute que le canevas', () => {
    // Miroir du cas « mot insécable » ci-dessous, sur l'axe vertical cette
    // fois : plusieurs mots courts wrappent sur de nombreuses lignes, et une
    // grande taille de police peut alors faire dépasser `canvas.h` — relevé
    // par Copilot sur la PR #117, passe 3 (seul `boxWidth` était plafonné).
    const hook = resolved({
      text: Array.from({ length: 40 }, () => 'MOT').join(' '),
      sizePermille: 250,
    })
    const image = renderHookImage(hook, { w: 1080, h: 200 }, FONTS_DIR)
    expect(image).not.toBeNull()
    if (image === null) return
    expect(image.height).toBeLessThanOrEqual(200)
    expect(image.y).toBeGreaterThanOrEqual(0)
    expect(image.y + image.height).toBeLessThanOrEqual(200)
  })

  it('le même hook produit le même bandeau (largeur/hauteur en pixels) sur deux canevas de même largeur', () => {
    // Le critère d'acceptation 2 de la PR #117, au niveau du rasteriseur :
    // natif 1:1 (1080×1080) et variante 9:16 (1080×1920) partagent la même
    // largeur, donc `hookLayout` leur donne les mêmes fractions et la boîte
    // doit sortir identique en pixels — indépendamment de la hauteur.
    const hook = resolved({ text: 'LES ALÉAS DU BÂTIMENT' })
    const native = renderHookImage(hook, { w: 1080, h: 1080 }, FONTS_DIR)
    const variant = renderHookImage(hook, { w: 1080, h: 1920 }, FONTS_DIR)
    expect(native).not.toBeNull()
    expect(variant).not.toBeNull()
    if (native === null || variant === null) return
    expect(variant.width).toBe(native.width)
    expect(variant.height).toBe(native.height)
  })

  it('un mot insécable très long ne produit jamais une boîte plus large que le canevas', () => {
    // Reproduit le cas relevé par Copilot sur la PR #117 : `hookText` peut
    // venir d'un `PATCH` manuel jusqu'à 280 caractères, non passé par
    // `normalizeHookText`, et `sizePermille` peut monter à 250 (25 % de la
    // largeur) — un seul mot sans espace peut alors mesurer plusieurs fois
    // la largeur du canevas si rien ne le borne.
    const hook = resolved({
      text: 'X'.repeat(200),
      sizePermille: 250,
    })
    const image = renderHookImage(hook, { w: 1080, h: 1080 }, FONTS_DIR)
    expect(image).not.toBeNull()
    if (image === null) return
    expect(image.width).toBeLessThanOrEqual(1080)
    expect(image.x).toBeGreaterThanOrEqual(0)
  })

  it("ne réenregistre la police que si son contenu change, pas à chaque rendu — relevé par Copilot sur la PR #117", () => {
    // Un dossier dédié à ce test : le cache de `ensureFontRegistered` est un
    // état de module, partagé entre tous les tests de ce fichier — un
    // dossier neuf par test garde chaque cas indépendant.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-font-'))
    const real = fs.readFileSync(path.join(FONTS_DIR, 'Anton-Regular.ttf'))
    fs.writeFileSync(path.join(dir, 'Anton-Regular.ttf'), real)

    const spy = vi.spyOn(GlobalFonts, 'registerFromPath')
    const removeSpy = vi.spyOn(GlobalFonts, 'remove')

    renderHookImage(resolved(), { w: 1080, h: 1080 }, dir)
    expect(spy).toHaveBeenCalledTimes(1)
    // Rien à retirer au tout premier enregistrement — pas d'ancienne clé.
    expect(removeSpy).not.toHaveBeenCalled()
    const firstKey = spy.mock.results[0]?.value as unknown

    // Même contenu, même dossier : pas de second appel.
    renderHookImage(resolved(), { w: 1080, h: 1080 }, dir)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(removeSpy).not.toHaveBeenCalled()

    // Le contenu change (même chemin) : l'ancien `FontKey` doit être retiré
    // et la police réenregistrée — sinon un remplacement de police que
    // l'empreinte déclare pourtant à jour ne se voit jamais dans le PNG.
    // Vérifié à la clé précise, pas seulement au décompte d'appels : un
    // `GlobalFonts.remove()` retiré du code laisserait ce test vert si on ne
    // vérifiait que `spy` (relevé par Aristarque, PR #117, passe 4).
    fs.writeFileSync(path.join(dir, 'Anton-Regular.ttf'), Buffer.concat([real, Buffer.from('x')]))
    renderHookImage(resolved(), { w: 1080, h: 1080 }, dir)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(removeSpy).toHaveBeenCalledExactlyOnceWith(firstKey)
  })
})
