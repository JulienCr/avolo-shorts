/**
 * La répartition d'un carton en lignes — calculée une fois, à partir du texte
 * entier, jamais rejouée par libass au rendu.
 *
 * C'est le remède à l'instabilité visuelle du karaoké : `renderAss` réémet le
 * carton entier à chaque mot actif (`\fscx` anime sa largeur de 90 % à 108 %
 * sur 110 ms), et laisser `WrapStyle: 0` recalculer la coupure à chaque image
 * la fait sauter d'une ligne à deux ou trois selon l'instant capturé. Ce
 * module calcule cette coupure une seule fois par carton, sur le texte final
 * (déjà mis en majuscules et échappé par l'appelant), et `renderAss` grave le
 * résultat en `\N` explicites, identiques d'un événement à l'autre.
 *
 * **Pur par construction** : `measure` est injecté plutôt qu'implémenté ici,
 * ce qui laisse le module dans `src/core` sans jamais importer `@napi-rs/canvas`
 * — voir `src/server/caption-measure.ts` pour l'implémentation réelle, sur le
 * modèle déjà posé par `wrapLines` dans `src/server/hook-image.ts`.
 */

/** La largeur d'un texte, dans l'unité où `maxWidth` est exprimé. */
export type Measure = (text: string) => number

/**
 * Les coupures de ligne d'un carton, une décision par mot.
 *
 * @param words Le texte déjà affiché de chaque mot du carton, dans l'ordre —
 *   c'est-à-dire après majuscules et échappement ASS, puisque c'est cette
 *   forme que `measure` doit mesurer pour correspondre à ce que libass trace.
 * @param measure Injecté : la largeur réelle du texte candidat, dans la même
 *   unité que `maxWidth`.
 * @param maxWidth La largeur disponible, dans l'unité de `measure`.
 * @returns `breakAfter[i]` vaut `true` quand une ligne se termine après le mot
 *   `i` — jamais pour le dernier mot. Glouton, et **ne coupe jamais un mot
 *   seul** : un mot dont measure({mot}) dépasse déjà `maxWidth` reste seul sur
 *   sa ligne plutôt que d'être tranché, la même règle que `wrapLines` tient
 *   pour le hook.
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
