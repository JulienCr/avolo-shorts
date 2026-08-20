import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GlobalFonts } from '@napi-rs/canvas'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HOOK_DEFAULTS, type ResolvedHook } from '@/core/hook'
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
