import { parseJsonResponse } from '@/core/gemini/parse'
import { redactKeys } from '@/core/errors'
import { StopRequestedError } from '@/server/ffmpeg'
import type { LlmCall, LlmMode, LlmResponse } from '@/server/llm/types'

/**
 * La politique de relance commune aux trois fournisseurs : refus de contenu
 * jamais réessayé, pannes réessayées avec un escalier, délai de quota
 * respecté. Extraite de `src/server/steps/candidates.ts` — `callGemini` y
 * devient `callWithRetry` ici, sans changer de comportement
 * (`tests/server/candidates.test.ts` passe sans modification).
 */

/** Refus déterministe du filtre de contenu : ne jamais réessayer la même charge. */
export class GeminiBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeminiBlockedError'
  }
}

/** Fins de génération qui ne sont pas un refus. `MAX_TOKENS` n'est pas ici : voir `leverIfBlocked`. */
const ENDS_WITHOUT_REJECTION = new Set([
  '',
  'FINISH_REASON_UNSPECIFIED',
  'STOP',
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
])

/**
 * Fins de génération qui sont un refus de contenu nommé.
 * `CONTENT_FILTER` est celui d'OpenAI (`src/server/llm/openai.ts`,
 * `toFinishReason`) ; Ollama n'en a pas.
 */
const CONTENT_REJECTION = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
  'MODEL_ARMOR',
  'CONTENT_FILTER',
])

/** Marqueurs d'erreur passagère : pannes, surcharges, réponses inexploitables. */
const MARKERS_TRANSIENT = [
  '429',
  '500',
  '502',
  '503',
  '504',
  'unavailable',
  'resource_exhausted',
  'internal',
  'overloaded',
  'deadline',
  'econnreset',
  'etimedout',
  'fetch failed',
  'empty response body',
  'did not contain a json object',
  'did not contain a "shorts" array',
  'ne porte pas de tableau "corrections"',
  'failed to parse gemini json response',
  'truncated (max_tokens)',
  'operation was aborted',
  'aborted due to timeout',
]

/**
 * Erreurs qui ne se reconnaissent qu'à leur nom : `AbortSignal.timeout`
 * (`@google/genai@2.17.1`) rend « This operation was aborted », sans code.
 */
const NAMES_TRANSIENT = new Set(['AbortError', 'TimeoutError'])

/**
 * Lève quand l'API n'a pas rendu une réponse complète.
 * @param response La réponse normalisée d'un des trois fournisseurs.
 * @throws {GeminiBlockedError} si le fournisseur a bloqué le contenu ou la
 * réponse — jamais réessayé.
 * @throws {Error} pour `MAX_TOKENS` (troncature, réessayée) ou toute autre
 * fin anormale non nommée.
 */
export function leverIfBlocked(response: LlmResponse): void {
  const reason = response.promptFeedback?.blockReason
  if (reason) {
    throw new GeminiBlockedError(
      `Le fournisseur a bloqué le contenu de cette vidéo (${String(reason)}). Les règles d'usage du fournisseur refusent ce matériel : il ne peut pas être analysé.`,
    )
  }
  for (const candidate of response.candidates ?? []) {
    const fin = String(candidate.finishReason ?? '').toUpperCase()
    if (fin === 'MAX_TOKENS') {
      throw new Error('Provider response was truncated (MAX_TOKENS): the answer is incomplete.')
    }
    if (ENDS_WITHOUT_REJECTION.has(fin)) continue
    if (CONTENT_REJECTION.has(fin)) {
      throw new GeminiBlockedError(
        `Le fournisseur a bloqué sa réponse pour cette vidéo (${fin}). Les règles d'usage du fournisseur refusent ce matériel : il ne peut pas être analysé.`,
      )
    }
    throw new Error(
      `Le fournisseur a interrompu sa génération (${fin}) : ce n'est pas une fin normale et rien ne dit qu'un nouvel essai ferait mieux.`,
    )
  }
}

/** Vaut la peine d'être réessayé — voir `MARKERS_TRANSIENT` et `NAMES_TRANSIENT`. */
export function isTransient(error: unknown): boolean {
  if (error instanceof Error && NAMES_TRANSIENT.has(error.name)) return true
  const bottom = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return MARKERS_TRANSIENT.some((marker) => bottom.includes(marker))
}

/** Au-delà, on renonce plutôt que d'attendre un quota qui ne se libère pas assez vite. */
const WAIT_QUOTA_MAX_MS = 90_000

/**
 * Le délai que le fournisseur demande dans un 429, en millisecondes.
 * @param message Le message d'erreur brut du fournisseur.
 * @returns Le délai lu dans `"retryDelay":"54s"`, ou `null` s'il est absent
 * — sans lui l'escalier (5 s puis 10 s) est trop court pour un quota par
 * minute. Rendu tel quel, sans plafond : le plafond est une décision de
 * `callWithRetry` (`WAIT_QUOTA_MAX_MS`), pas un fait du fournisseur.
 */
export function quotaDelay(message: string): number | null {
  const found = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message)
  if (found === null) return null
  return Math.ceil(Number(found[1]) * 1000)
}

/** Le `sleep` par défaut d'un appel — aussi le défaut de `runCandidates` (`candidates.ts`). */
export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** Trois tentatives, l'attente double à chaque échec : 5 s puis 10 s. */
const ATTEMPTS = 3

/**
 * Un appel, avec sa politique de relance et son analyse.
 * @param call Le client du fournisseur, construit par `createCallFromSettings`.
 * @param prompt Le texte envoyé au modèle.
 * @param mode Le mode d'appel.
 * @param options.sleep Injectable pour les tests.
 * @param options.analyze Transforme la réponse brute ; fait partie de la
 * boucle de relance, pas un geste séparé de l'appelant — une enveloppe
 * cassée doit être réessayée, pas analysée après coup en « zéro résultat ».
 * @param options.signal Contrôlé ici et pas seulement passé au client : un
 * abandon ressort en `AbortError`, qu'`isTransient` classerait sinon comme
 * passager.
 * @param options.label Le nom de l'opération dans `StopRequestedError`.
 * Par défaut « le repérage », premier appelant.
 */
export async function callWithRetry<T = unknown>(
  call: LlmCall,
  prompt: string,
  mode: LlmMode,
  options: {
    sleep?: (ms: number) => Promise<void>
    analyze?: (raw: unknown) => T
    signal?: AbortSignal
    label?: string
  } = {},
): Promise<T> {
  const sleep = options.sleep ?? wait
  const analyze = options.analyze ?? ((raw: unknown) => raw as T)
  const label = options.label ?? 'le repérage'
  const isAborted = (): boolean => options.signal?.aborted === true

  // Contrôler le signal aux deux bouts de la boucle ne suffit pas : entre
  // les deux il y a un `sleep` qui peut monter à `WAIT_QUOTA_MAX_MS`, sans
  // quoi l'exécution restait « en cours » après un arrêt demandé.
  const waitOrStop = async (ms: number): Promise<void> => {
    const signal = options.signal
    if (signal === undefined) {
      await sleep(ms)
      return
    }
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([
        sleep(ms),
        new Promise<void>((resolve) => {
          onAbort = () => resolve()
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      // Sans ce retrait, chaque tentative laisse un écouteur de plus sur le
      // signal de l'exécution, qui vit aussi longtemps qu'elle.
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }
  for (let attempt = 1; ; attempt += 1) {
    if (isAborted()) throw new StopRequestedError(label)
    try {
      const response = await call(prompt, mode)
      leverIfBlocked(response)
      return analyze(parseJsonResponse(response.text ?? ''))
    } catch (error) {
      if (error instanceof GeminiBlockedError) throw error
      // Contrôlé avant `isTransient`, qui classerait un arrêt demandé comme
      // passager par son nom d'`AbortError`.
      if (isAborted()) throw new StopRequestedError(label)
      const message = error instanceof Error ? error.message : String(error)
      if (attempt >= ATTEMPTS || !isTransient(error)) throw error
      const quota = quotaDelay(message)
      if (quota !== null && quota > WAIT_QUOTA_MAX_MS) {
        throw new Error(
          `Le fournisseur refuse la requête pour dépassement de quota et demande d'attendre ${Math.round(quota / 1000)} s, ` +
            `soit plus que les ${WAIT_QUOTA_MAX_MS / 1000} s que cette étape accepte d'attendre. ` +
            `Arrêt plutôt que relance avant le délai demandé (${label}).`,
        )
      }
      // Le délai demandé l'emporte quand il est plus long que l'escalier —
      // sur un quota par minute, 5 s puis 10 s repart toujours trop tôt.
      const patience = Math.max(5000 * 2 ** (attempt - 1), quota ?? 0)
      console.warn(
        `Fournisseur, erreur passagère (essai ${attempt}/${ATTEMPTS}), nouvelle tentative dans ${patience / 1000} s : ${redactKeys(message).slice(0, 150)}`,
      )
      await waitOrStop(patience)
    }
  }
}
