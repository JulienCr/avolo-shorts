'use client'

import { useEffect, useState } from 'react'

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
 * avant, pour ne jamais mesurer avec la police de repli du système en
 * silence (CLAUDE.md, échec silencieux proscrit). Re-rend au chargement.
 *
 * **Hors d'un navigateur qui expose `document.fonts`** (tests jsdom, moteurs
 * anciens), rend vrai immédiatement : rien n'y permet de détecter la course,
 * donc bloquer indéfiniment casserait le calque plutôt que de le dégrader.
 */
export function useFontReady(fontFamily: string): boolean {
  const [ready, setReady] = useState(() => fontIsReady(fontFamily))

  useEffect(() => {
    if (ready) return
    if (typeof document === 'undefined' || document.fonts === undefined) return
    let cancelled = false
    document.fonts
      .load(probeFont(fontFamily))
      .then(() => {
        if (!cancelled) setReady(fontIsReady(fontFamily))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [fontFamily, ready])

  return ready
}
