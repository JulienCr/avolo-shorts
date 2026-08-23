import type { LlmProvider } from '@/lib/api'

/**
 * Le contrat commun aux trois fournisseurs de modèles de langage — Gemini,
 * OpenAI, Ollama.
 *
 * **Ce fichier ne connaît aucun des trois.** `src/server/llm/gemini.ts`,
 * `openai.ts` et `ollama.ts` implémentent chacun ce contrat contre son SDK ou
 * son API REST ; `src/server/llm/registry.ts` choisit lequel construire
 * d'après les réglages. Rien ici n'appelle le réseau, ce qui n'est pas une
 * contrainte de pureté — ce module vit dans `src/server/`, pas `src/core/` —
 * mais une façon de garder la forme du contrat lisible sans la noyer dans trois
 * implémentations.
 */

export type { LlmProvider }

/**
 * Le mode d'appel, un par usage (`LlmUsage`, `@/server/llm/registry`).
 * **Défini ici, réexporté sous le nom `ModeGemini`** par
 * `src/server/steps/candidates.ts`, qui l'utilisait avant que cette couche
 * existe et dont la couture de test — `tests/server/candidates.test.ts`,
 * environ 1800 lignes — s'y accroche par ce nom. Le renommer aurait coûté une
 * réécriture de ce fichier entier pour un gain nul : c'est un alias de type,
 * il ne coûte rien à l'exécution.
 */
export type LlmMode = 'score' | 'detail' | 'hook' | 'correction'

/**
 * Un schéma JSON minimal, commun aux trois fournisseurs.
 *
 * **Un sous-ensemble volontaire** — juste assez pour décrire les deux schémas
 * du repérage (`SCHEMA_NOTATION`, `SCHEMA_DETAIL` dans `candidates.ts`) : un
 * objet, un tableau, une chaîne, un entier. Chaque fournisseur le convertit
 * ensuite vers ce qu'il attend réellement — l'énumération `Type` de Gemini, le
 * JSON Schema nu qu'OpenAI et Ollama exercent tous deux nativement.
 */
export type JsonSchema =
  | { type: 'object'; properties: Record<string, JsonSchema>; required?: readonly string[] }
  | { type: 'array'; items: JsonSchema }
  | { type: 'string' }
  | { type: 'integer' }
  | { type: 'number' }
  | { type: 'boolean' }

/** Ce qu'un appel structuré demande, indépendamment du fournisseur. */
export type LlmCallConfig = {
  schema: JsonSchema
  temperature: number
  maxOutputTokens: number
}

/**
 * Ce qu'une réponse porte, dans la forme la plus large que les trois
 * fournisseurs savent remplir.
 *
 * **Volontairement la forme du SDK Gemini, élargie.** C'est celle que
 * `leverIfBlocked`, `callGemini` et le reste de la politique de relance de
 * `src/server/steps/candidates.ts` consomment déjà — voir la décision au
 * point d'appel de `clientByDefault` (renommé `createCallFromSettings`) : les
 * relances, le backoff et la détection du filtre de sécurité restent
 * **communs aux trois fournisseurs**, portés par cette forme normalisée,
 * plutôt que réécrits une fois par fournisseur.
 *
 * `GenerateContentResponse` (`@google/genai`) s'assigne structurellement à ce
 * type sans conversion : c'est ce qui a évité de réécrire les réponses
 * figées de `tests/server/candidates.test.ts`. `openai.ts` et `ollama.ts`,
 * eux, **construisent** cette forme depuis leur réponse REST — voir leurs
 * fonctions `toLlmResponse`.
 */
export type LlmResponse = {
  text?: string
  promptFeedback?: { blockReason?: string }
  candidates?: { finishReason?: string }[]
}

/**
 * Un appel au modèle. Le contrat qu'`CallGemini`
 * (`src/server/steps/candidates.ts`) réexporte comme alias, pour ne rien
 * casser de la couture de test existante — voir `LlmMode` ci-dessus pour la
 * même raison.
 */
export type LlmCall = (prompt: string, mode: LlmMode) => Promise<LlmResponse>

/**
 * Ce dont un client de fournisseur a besoin pour construire un `LlmCall`.
 *
 * `config` reste une fonction plutôt qu'un objet : les deux passes du
 * repérage (`score`, `detail`) n'ont ni le même schéma ni la même
 * température, et c'est `configuration(mode)` dans `candidates.ts` qui le
 * décide — un domaine du repérage, pas de cette couche.
 */
export type LlmClientOptions = {
  model: string
  apiKey?: string
  baseUrl?: string
  signal?: AbortSignal
  /** Le délai au-delà duquel un appel est abandonné, en millisecondes. */
  timeoutMs: number
  config: (mode: LlmMode) => LlmCallConfig
}
