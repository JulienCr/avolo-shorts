/**
 * The LLM usages `providerModelFor` resolves against `AiSettings`.
 *
 * Only `'selection'` is wired to a graph step today; `'correction'` and
 * `'hook'` are kept so `AiSettings` stays exhaustive over the three.
 */
export type LlmUsage = 'selection' | 'correction' | 'hook'
