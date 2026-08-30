'use client'

import { useCallback, useSyncExternalStore } from 'react'

import type { Measure } from '@/core/captions/wrap'

/**
 * La mesure côté navigateur — un `<canvas>` détaché, jamais le littéral
 * `'Anton'` : la famille vient toujours de `hookFont.style.fontFamily`
 * (`@/components/clip/hook-font`), le nom que `next/font/local` génère.
 * Sert `CaptionOverlay` et `HookOverlay` — une seule mesure, deux calques.
 *
 * `src/core` ne peut importer aucun DOM (`tests/core/purete.test.ts`), d'où
 * ce module hors de `src/core` bien qu'il implémente `Measure`.
 */

/**
 * `fontFamily` à `fontSizePx` — la même chaîne `ctx.font` que
 * `src/server/caption-measure.ts`, mêmes décisions gloutonnes de coupure.
 *
 * **Vérifié contre `@napi-rs/canvas`** (le serveur), 60 chaînes réelles à
 * 18 px : écart maximal 0,005 px, `bold` inerte des deux côtés — `docs/lessons.md`.
 *
 * Hors d'un `<canvas>` réel (jsdom) : `getContext('2d')` y rend `null`, la
 * mesure se replie sur `0` — jamais de coupure, comme `NO_WRAP` dans `ass`.
 */
export function createDomMeasure(
  fontFamily: string,
  fontSizePx: number,
  options: { bold?: boolean } = {},
): Measure {
  if (typeof document === 'undefined') return () => 0
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  // `ctx === null` (jsdom sans `canvas` npm) ou un mock d'un autre test
  // sans `measureText` (`vi.spyOn(HTMLCanvasElement.prototype, 'getContext')`)
  // se replient sur `0`, jamais de coupure.
  if (ctx === null || typeof ctx.measureText !== 'function') return () => 0
  ctx.font = `${options.bold === true ? 'bold ' : ''}${fontSizePx}px ${fontFamily}`
  return (text: string) => ctx.measureText(text).width
}

function probeFont(fontFamily: string): string {
  return `16px ${fontFamily}`
}

/** Un seul avertissement par famille — un échec de police ne rejoue pas à chaque montage. */
const warnedFamilies = new Set<string>()

function warnFontUnavailable(fontFamily: string, reason: string): void {
  if (warnedFamilies.has(fontFamily)) return
  warnedFamilies.add(fontFamily)
  console.warn(`useFontReady: « ${fontFamily} » ${reason} — calque masqué, pas de géométrie de repli.`)
}

function fontIsReady(fontFamily: string): boolean {
  if (typeof document === 'undefined' || document.fonts === undefined) return true
  try {
    return document.fonts.check(probeFont(fontFamily))
  } catch {
    return true
  }
}

/**
 * Vrai une fois `fontFamily` confirmée chargée par `document.fonts` — jamais
 * avant, pour ne jamais mesurer avec la police de repli en silence.
 *
 * `useSyncExternalStore`, pas `useState`+effet : serveur et hydratation
 * lisent `getServerSnapshot`, **toujours faux** (pas de `document`, comme
 * `createDomMeasure`). React ne relit le vrai statut qu'une fois monté, sans
 * `setState` synchrone en effet (`react-hooks/set-state-in-effect`). Sans
 * `document.fonts` (jsdom), `getSnapshot` rend vrai d'emblée.
 */
export function useFontReady(fontFamily: string): boolean {
  // **Pas de repli temporisé qui dessinerait une géométrie de repli** :
  // masquer le calque en échouant est le comportement voulu par cette PR,
  // l'avertissement sert à le rendre observable, pas à le contourner.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof document === 'undefined' || document.fonts === undefined) return () => {}
      let cancelled = false
      document.fonts
        .load(probeFont(fontFamily))
        .then(() => {
          if (cancelled) return
          if (!fontIsReady(fontFamily)) {
            warnFontUnavailable(fontFamily, "a chargé sans passer `document.fonts.check()`")
          }
          onStoreChange()
        })
        .catch(() => {
          if (!cancelled) warnFontUnavailable(fontFamily, "n'a pas pu charger")
        })
      return () => {
        cancelled = true
      }
    },
    [fontFamily],
  )
  const getSnapshot = useCallback(() => fontIsReady(fontFamily), [fontFamily])
  const getServerSnapshot = () => false

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
