/**
 * The LLM usages `providerModelFor` resolves against `AiSettings`.
 *
 * `'selection'` and `'correction'` each back a graph step (`candidates`,
 * `correction`). `'hook'` has callers (`src/server/steps/hook.ts`) but no
 * graph step; it is kept so `AiSettings` stays exhaustive over the three.
 */
export type LlmUsage = 'selection' | 'correction' | 'hook'
