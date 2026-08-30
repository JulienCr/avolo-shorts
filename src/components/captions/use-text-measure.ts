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
 * `src/server/caption-measure.ts`, pour que les deux moteurs prennent les
 * mêmes décisions gloutonnes de retour à la ligne.
 *
 * Hors d'un environnement qui rend un vrai `<canvas>` (jsdom, sous les
 * tests) : `getContext('2d')` y rend `null`, et la mesure se replie sur `0`
 * — jamais de coupure, le même comportement que `NO_WRAP` des tests d'`ass`.
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
 * `useSyncExternalStore`, pas un `useState`+effet : serveur et hydratation
 * lisent `getServerSnapshot` (toujours vrai), React ne relit le vrai statut
 * qu'une fois monté — sans `setState` synchrone en effet
 * (`react-hooks/set-state-in-effect`). Sans `document.fonts` (jsdom),
 * `getSnapshot` rend vrai d'emblée : rien n'y détecte la course.
 */
export function useFontReady(fontFamily: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof document === 'undefined' || document.fonts === undefined) return () => {}
      let cancelled = false
      document.fonts
        .load(probeFont(fontFamily))
        .then(() => {
          if (!cancelled) onStoreChange()
        })
        .catch(() => {})
      return () => {
        cancelled = true
      }
    },
    [fontFamily],
  )
  const getSnapshot = useCallback(() => fontIsReady(fontFamily), [fontFamily])
  const getServerSnapshot = () => true

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
