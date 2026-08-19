import type Database from 'better-sqlite3'

import type { AiSettings, LlmProvider, LlmProviderAvailability } from '@/lib/api'
import { effectiveSettings } from '@/server/db'
import { créerAppelGemini } from '@/server/llm/gemini'
import { créerAppelOllama } from '@/server/llm/ollama'
import { créerAppelOpenAI } from '@/server/llm/openai'
import type { LlmCall, LlmCallConfig, LlmClientOptions, LlmMode } from '@/server/llm/types'
import { exigerSecret } from '@/server/secrets'

/**
 * Choisit l'implémentation d'un `LlmCall` d'après les réglages, au lieu de la
 * construire en dur — c'est tout le sens de cette PR (retour d'usage §6.1).
 *
 * **Les trois usages, mais un seul branché.** `LlmUsage` porte les trois noms
 * pour que `providerModèlePour` reste exhaustif sur `AiSettings` — en retirer
 * un casserait le type-check si `correction` ou `hook` cessait d'exister —,
 * mais `src/server/steps/candidates.ts` n'appelle cette couche que pour
 * `'selection'`. La correction du transcript et la génération du hook sont
 * des livraisons ultérieures qui liront ce même registre pour le leur.
 */
export type LlmUsage = 'selection' | 'correction' | 'hook'

/** Le fournisseur et le modèle réglés pour un usage donné. */
export function providerModèlePour(
  ai: AiSettings,
  usage: LlmUsage,
): { provider: LlmProvider; model: string } {
  switch (usage) {
    case 'selection':
      return { provider: ai.selectionProvider, model: ai.selectionModel }
    case 'correction':
      return { provider: ai.correctionProvider, model: ai.correctionModel }
    case 'hook':
      return { provider: ai.hookProvider, model: ai.hookModel }
  }
}

/**
 * Le nom de la variable d'environnement qui porte la clé d'un fournisseur, ou
 * `undefined` pour Ollama, qui n'en a pas.
 *
 * **Un seul endroit le sait**, pour que l'écran (`GET /api/llm/availability`)
 * et l'appel réel (`créerAppelDepuisRéglages`) posent exactement la même
 * question sur la même variable.
 */
export function variableDeCléPour(provider: LlmProvider): string | undefined {
  switch (provider) {
    case 'gemini':
      return 'GEMINI_API_KEY'
    case 'openai':
      return 'OPENAI_API_KEY'
    case 'ollama':
      return undefined
  }
}

/**
 * Ce que l'écran des réglages affiche pour un fournisseur : a-t-il sa clé ?
 *
 * **Ne lit jamais la valeur du secret**, seulement sa présence — `exigerSecret`
 * fait le travail et son message d'erreur, déjà pensé pour ne rien fuiter
 * (`op://…` non résolu, variable absente), devient directement `reason`.
 */
export function disponibilitéDuFournisseur(provider: LlmProvider): LlmProviderAvailability {
  const variable = variableDeCléPour(provider)
  if (variable === undefined) return { available: true, reason: null }
  try {
    exigerSecret(variable)
    return { available: true, reason: null }
  } catch (erreur) {
    return { available: false, reason: erreur instanceof Error ? erreur.message : String(erreur) }
  }
}

/** La clé d'un fournisseur, ou `undefined` pour Ollama. Lève si elle manque. */
function apiKeyPour(provider: LlmProvider): string | undefined {
  const variable = variableDeCléPour(provider)
  return variable === undefined ? undefined : exigerSecret(variable)
}

/**
 * Construit le `LlmCall` d'un fournisseur donné.
 *
 * **Un fournisseur qui ne tient pas la sortie structurée doit échouer
 * clairement.** Les trois la tiennent aujourd'hui — Gemini par son schéma
 * `Type`, OpenAI et Ollama par le JSON Schema nu qu'ils exercent tous les
 * deux nativement —, donc rien ne lève ici pour l'instant ; le point d'ancrage
 * reste ce `switch` exhaustif, que le type-check casse si un quatrième
 * fournisseur arrivait sans y être branché.
 */
export function créerAppel(provider: LlmProvider, options: LlmClientOptions): LlmCall {
  switch (provider) {
    case 'gemini':
      return créerAppelGemini(options)
    case 'openai':
      return créerAppelOpenAI(options)
    case 'ollama':
      return créerAppelOllama(options)
  }
}

/**
 * Le `LlmCall` d'un usage, choisi par les réglages persistés.
 *
 * **Lit la clé tout de suite, avant le premier appel réseau.** C'est ce qui
 * fait échouer un fournisseur sans clé au moment de démarrer le repérage,
 * plutôt que trente minutes plus tard au milieu d'un lot — le critère du
 * contrat. L'écran des réglages (`disponibilitéDuFournisseur`) le dit encore
 * plus tôt, avant même de lancer quoi que ce soit.
 *
 * `timeoutMs` et `config` restent les paramètres du domaine — `DÉLAI_APPEL_MS`
 * et `configuration(mode)` de `candidates.ts` — cette fonction ne fait que
 * choisir *qui* les exécute.
 */
export function créerAppelDepuisRéglages(
  db: Database.Database,
  usage: LlmUsage,
  params: {
    signal?: AbortSignal
    timeoutMs: number
    config: (mode: LlmMode) => LlmCallConfig
  },
): LlmCall {
  const { ai } = effectiveSettings(db)
  const { provider, model } = providerModèlePour(ai, usage)
  return créerAppel(provider, {
    model,
    apiKey: apiKeyPour(provider),
    baseUrl: provider === 'ollama' ? ai.ollamaBaseUrl : undefined,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    config: params.config,
  })
}
