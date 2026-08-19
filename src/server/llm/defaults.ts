import type { LlmProvider } from '@/lib/api'

/**
 * Le modèle par défaut, **par fournisseur**.
 *
 * **Jamais un défaut unique.** Un modèle valable chez l'un part en 404 chez
 * l'autre — c'est le piège nommé au contrat de cette livraison, mesuré
 * ailleurs dans ce dépôt sur `FFMPEG_ENCODER=auto`, qui a la même forme :
 * une seule variable ne peut pas porter un défaut qui vaille pour tout le
 * monde.
 *
 * `gemini-3.1-flash-lite` reprend `MODÈLE_PAR_DÉFAUT`, l'ancien défaut en dur
 * de `src/server/steps/candidates.ts` (avant cette PR) : le repérage se
 * comporte à l'identique tant que personne n'a touché au réglage `ai`.
 *
 * `gpt-4.1-mini` et `llama3.1` n'ont pas été mesurés sur ce dépôt — ce sont
 * des défauts raisonnables du marché au 18 août 2026, à corriger au premier
 * usage réel si l'un des deux se révèle un mauvais choix.
 */
export const DEFAULT_MODEL: Record<LlmProvider, string> = {
  gemini: 'gemini-3.1-flash-lite',
  openai: 'gpt-4.1-mini',
  ollama: 'llama3.1',
}
