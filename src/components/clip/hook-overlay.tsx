'use client'

import { useMemo } from 'react'

import { createDomMeasure, useFontReady } from '@/components/captions/use-text-measure'
import { hookFont } from '@/components/clip/hook-font'
import { outputSize } from '@/core/framing'
import {
  hookGeometry,
  hookIsBurned,
  hookLayout,
  hookRgba,
  type HookMeasure,
  type ResolvedHook,
} from '@/core/hook'

/**
 * Le canevas de référence du calque : le 9:16 complet, celui que
 * `renderHookImage` reçoit pour toute sortie qui n'est pas le natif 16:9 —
 * voir la doc de `HookLayout` (`@/core/hook`) sur pourquoi la géométrie du
 * hook suit `canvas.w` et non le ratio réellement affiché.
 */
const CANVAS = outputSize('9:16')

/**
 * Le calque de preview du hook, dans l'aperçu 9:16 (`output-preview.tsx`).
 *
 * **La boîte vient de `hookGeometry` (`@/core/hook`)** — la même fonction
 * que `renderHookImage`, mesurée par un `<canvas>` du navigateur plutôt que
 * composée par un `inline-block` : largeur, hauteur, position et retour à
 * la ligne sont posés explicitement en `cqw`, jamais `cqh` — sans
 * conséquence, `CANVAS` partage l'aspect exact de la boîte porteuse.
 *
 * **`data-hook="card"`/`"badge"`** servent les tests. **L'empilement suit
 * l'ordre du DOM, sans `zIndex`** : la pastille, frère suivant du carton
 * dans le JSX, le recouvre déjà par défaut — même ordre que le rasteriseur.
 */
export function HookOverlay({ hook }: { hook: ResolvedHook }) {
  const family = hookFont.style.fontFamily
  const ready = useFontReady(family)
  const measure: HookMeasure = useMemo(
    () => (fontSizePx: number) => createDomMeasure(family, fontSizePx),
    [family],
  )
  const burned = hookIsBurned(hook)
  const geometry = useMemo(
    () => (burned ? hookGeometry(hook, CANVAS, measure) : null),
    [burned, hook, measure],
  )

  // Rien à incruster (désactivé, texte vide — voir `hookIsBurned`), ou la
  // police n'est pas encore confirmée chargée : jamais de calque mesuré sur
  // une police de repli en silence (`useFontReady`).
  if (!burned || !ready || geometry === null) return null

  const layout = hookLayout(hook)

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex flex-col"
      style={{
        justifyContent:
          hook.position === 'top' ? 'flex-start' : hook.position === 'bottom' ? 'flex-end' : 'center',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: '100%',
          display: 'flex',
          justifyContent:
            hook.alignment === 'left' ? 'flex-start' : hook.alignment === 'right' ? 'flex-end' : 'center',
          paddingLeft: cqw(layout.marginXFraction),
          paddingRight: cqw(layout.marginXFraction),
          paddingTop: hook.position === 'top' ? cqw(layout.marginYFraction) : undefined,
          paddingBottom: hook.position === 'bottom' ? cqh(layout.marginYFraction) : undefined,
        }}
      >
        <div
          style={{
            position: 'relative',
            width: cqwPx(geometry.compositeWidth),
            height: cqwPx(geometry.compositeHeight),
          }}
        >
          <div
            data-hook="card"
            className={hookFont.className}
            style={{
              position: 'absolute',
              left: cqwPx(geometry.cardX),
              top: cqwPx(geometry.cardTop),
              width: cqwPx(geometry.cardWidth),
              height: cqwPx(geometry.cardHeightDrawn),
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              overflow: 'hidden',
              color: hook.textColor,
              backgroundColor: hookRgba(hook.backgroundColor, hook.backgroundOpacity),
              borderRadius: cqw(layout.radiusFraction),
              paddingLeft: cqwPx(geometry.paddingXPx),
              paddingRight: cqwPx(geometry.paddingXPx),
              fontSize: cqwPx(geometry.fontSizePx),
              lineHeight: cqwPx(geometry.lineHeightPx),
              textAlign: hook.alignment,
              whiteSpace: 'pre',
            }}
          >
            {geometry.lines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
          {geometry.hasBadge && (
            <div
              data-hook="badge"
              className={hookFont.className}
              style={{
                position: 'absolute',
                left: cqwPx(geometry.badgeX),
                top: 0,
                width: cqwPx(geometry.badgeWidth),
                height: cqwPx(geometry.badgeHeight),
                display: 'flex',
                alignItems: 'center',
                justifyContent:
                  hook.alignment === 'left'
                    ? 'flex-start'
                    : hook.alignment === 'right'
                      ? 'flex-end'
                      : 'center',
                overflow: 'hidden',
                color: hook.badgeColor,
                // Nu, jamais `hookRgba` — `backgroundOpacity` est le réglage
                // du carton, pas de la pastille.
                backgroundColor: hook.badgeBackground,
                borderRadius: cqw(layout.badgeRadiusFraction),
                paddingLeft: cqwPx(geometry.badgePaddingXPx),
                paddingRight: cqwPx(geometry.badgePaddingXPx),
                fontSize: cqwPx(geometry.badgeFontSizePx),
                whiteSpace: 'nowrap',
              }}
            >
              {geometry.badgeText}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** `u`, une fraction (0 à 1) de la largeur du conteneur, en `cqw`. */
function cqw(fraction: number): string {
  return `calc(${fraction * 100}cqw)`
}

/** Un compte de pixels de `CANVAS`, en `cqw` — voir la doc de tête du fichier. */
function cqwPx(px: number): string {
  return cqw(px / CANVAS.w)
}

/**
 * `u`, une fraction (0 à 1) de la HAUTEUR du conteneur, en `cqh` — la seule
 * fraction de `hookLayout` qui suit la hauteur plutôt que la largeur :
 * `marginYFraction` en position `bottom`. Voir la doc de
 * `HOOK_MARGIN_BOTTOM_FRACTION` dans `@/core/hook`.
 */
function cqh(fraction: number): string {
  return `calc(${fraction * 100}cqh)`
}
