/**
 * La répartition d'un carton en lignes, calculée une fois pour toutes plutôt
 * que rejouée par libass à chaque image.
 *
 * Pur par construction : `measure` est injecté, ce qui laisse ce module dans
 * `src/core` sans jamais importer `@napi-rs/canvas` — voir
 * `src/server/caption-measure.ts` pour l'implémentation réelle.
 */

/** La largeur d'un texte, dans l'unité où `maxWidth` est exprimé. */
export type Measure = (text: string) => number

/**
 * Les coupures de ligne d'un carton, une décision par mot.
 *
 * @param words Le texte déjà affiché (majuscules et échappement ASS déjà
 *   appliqués) — la forme que `measure` doit mesurer.
 * @param measure Injecté, dans l'unité de `maxWidth`.
 * @param maxWidth La largeur disponible.
 * @returns `breakAfter[i]` : une ligne se termine après le mot `i`. Ne coupe
 *   jamais un mot seul, même plus large que `maxWidth`.
 */
export function wrapCard(words: readonly string[], measure: Measure, maxWidth: number): boolean[] {
  const breakAfter = words.map(() => false)
  if (words.length === 0) return breakAfter

  let lineStart = 0
  for (let i = 1; i < words.length; i++) {
    const candidate = words.slice(lineStart, i + 1).join(' ')
    if (measure(candidate) <= maxWidth || lineStart === i) continue
    breakAfter[i - 1] = true
    lineStart = i
  }
  return breakAfter
}
