/**
 * Le formatage des messages d'erreur de publication, **pur** — sous la même
 * frontière de pureté que le reste de `src/core/` (`eslint.config.mjs`).
 *
 * Partagé entre le courriel d'abandon (`src/server/publication/scheduler.ts`)
 * et l'écran de planning : les deux lisent la même colonne `error`, il ne
 * doit pas exister deux façons de la rendre lisible.
 */

/**
 * Ré-indente le suffixe JSON d'une erreur Meta (cas `MetaFileRefusedError`,
 * `src/server/publication/meta.ts:124-126` : un préfixe en français suivi
 * d'un blob JSON, jamais du JSON pur) — le préfixe reste tel quel.
 */
export function formatErrorDetail(error: string): string {
  const jsonStart = error.indexOf('{')
  if (jsonStart === -1) return error
  try {
    const pretty = JSON.stringify(JSON.parse(error.slice(jsonStart)), null, 2)
    return error.slice(0, jsonStart) + pretty
  } catch {
    return error
  }
}
