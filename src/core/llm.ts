/**
 * **Les trois usages, mais un seul branché.** `LlmUsage` porte les trois noms
 * pour que `providerModelFor` reste exhaustif sur `AiSettings` — en retirer
 * un casserait le type-check si `correction` ou `hook` cessait d'exister —,
 * mais `src/server/steps/candidates.ts` n'appelle cette couche que pour
 * `'selection'`. La correction du transcript et la génération du hook sont
 * des livraisons ultérieures qui liront ce même registre pour le leur.
 */
export type LlmUsage = 'selection' | 'correction' | 'hook'
