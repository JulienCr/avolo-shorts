import { createCanvas } from '@napi-rs/canvas'

import type { Measure } from '@/core/captions/wrap'
import { ensureFontRegistered } from './hook-image'

/**
 * L'implémentation réelle de `Measure`, injectée dans `renderAss` — la mesure
 * elle-même reste hors de `src/core`, qui ne peut pas importer `@napi-rs/canvas`
 * (`tests/core/purete.test.ts`).
 *
 * Réutilise l'enregistrement de police de `hook-image.ts` plutôt que de tenir
 * un second registre : les deux rasterisent avec la même police Anton, et deux
 * trackers indépendants sur le `GlobalFonts` global de `@napi-rs/canvas`
 * pourraient s'annuler l'un l'autre à l'enregistrement.
 *
 * @param fontsDir Le dossier contenant `Anton-Regular.ttf`, comme `hook-image.ts`.
 * @param fontFamily La famille à mesurer — celle qu'écrit `Style:` dans le
 *   fichier ASS (`fontName`, `@/core/captions/ass`), pas nécessairement Anton :
 *   un preset personnalisé change la police des deux côtés à la fois.
 * @param fontSizePx La taille en unités `PlayResY`, celle que `captionUnits`
 *   écrit dans `Fontsize` — mesurer à une autre taille mesurerait autre chose
 *   que ce que libass va tracer.
 */
export function createCaptionMeasure(fontsDir: string, fontFamily: string, fontSizePx: number): Measure {
  ensureFontRegistered(fontsDir)
  const ctx = createCanvas(1, 1).getContext('2d')
  ctx.font = `${fontSizePx}px ${fontFamily}`
  return (text: string) => ctx.measureText(text).width
}
