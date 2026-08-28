import { createCanvas } from '@napi-rs/canvas'

import type { Measure } from '@/core/captions/wrap'
import { ensureFontRegistered } from './hook-image'

/**
 * L'implémentation réelle de `Measure`, injectée dans `renderAss` — `src/core`
 * ne peut pas importer `@napi-rs/canvas` (`tests/core/purete.test.ts`).
 *
 * @param fontsDir Le dossier contenant `Anton-Regular.ttf`, comme `hook-image.ts`.
 * @param fontFamily La famille écrite dans `Style:` (`fontName`,
 *   `@/core/captions/ass`) — pas nécessairement Anton.
 * @param fontSizePx La taille en unités `PlayResY` que `captionUnits` écrit
 *   dans `Fontsize`.
 */
export function createCaptionMeasure(fontsDir: string, fontFamily: string, fontSizePx: number): Measure {
  ensureFontRegistered(fontsDir)
  const ctx = createCanvas(1, 1).getContext('2d')
  // `bold` : la ligne `Style:` de `renderAss` écrit toujours `Bold=1`, et Anton
  // Bold n'a pas la même largeur qu'Anton normal à la frontière de `maxWidth`.
  ctx.font = `bold ${fontSizePx}px ${fontFamily}`
  return (text: string) => ctx.measureText(text).width
}
