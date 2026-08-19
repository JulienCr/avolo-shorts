import type { JsonSchema, LlmCall, LlmClientOptions, LlmResponse } from '@/server/llm/types'

/**
 * Le client OpenAI, par l'API REST plutôt que par un SDK : aucun n'était une
 * dépendance du projet, et l'API Chat Completions tient en un `fetch` — même
 * geste que `résoudreSecrets` fait pour `op`, la même préférence pour peu de
 * dépendances (`CLAUDE.md`, « pas de Docker ici »).
 *
 * **Le schéma part tel quel.** `JsonSchema` (`@/server/llm/types`) utilise déjà
 * le vocabulaire du JSON Schema — `object`, `array`, `string`, `integer`,
 * `number`, `boolean` — donc rien à convertir, contrairement à Gemini dont
 * l'énumération `Type` a sa propre forme.
 *
 * **`strict: false`.** Le mode strict d'OpenAI impose `additionalProperties:
 * false` sur chaque objet et la présence de **tous** les champs dans
 * `required` (y compris les facultatifs, portés autrement en `anyOf` avec
 * `null`) — une contrainte qui ne colle pas à `SCHÉMA_DÉTAIL`, où
 * `predicted_score` peut manquer. Le mode permissif accepte le même schéma que
 * Gemini sans le retoucher, au prix d'un contrat plus faible : `parseDetailResponse`
 * et `parseScoreResponse` restent seuls responsables de refuser une réponse qui
 * ne le respecte pas, exactement comme pour Gemini aujourd'hui.
 */

const ENDPOINT = 'https://api.openai.com/v1/chat/completions'

/**
 * Les raisons de fin qu'OpenAI nomme, traduites vers le vocabulaire que
 * `leverSiBloquée` (`src/server/steps/candidates.ts`) reconnaît déjà.
 *
 * **`length` devient `MAX_TOKENS`** : `leverSiBloquée` classe cette fin comme
 * une troncature à réessayer, jamais comme une fin normale — c'est le même
 * traitement que pour Gemini, où une troncature de sortie structurée ne parse
 * en général pas.
 *
 * **`content_filter` devient `CONTENT_FILTER`**, une raison ajoutée à
 * `REFUS_DE_CONTENU` : c'est le filtre de contenu d'OpenAI, l'équivalent de
 * `SAFETY` côté Gemini, et il doit déclencher la même récupération — recouper
 * la charge plutôt qu'abandonner l'émission entière (voir `récupérer` dans
 * `candidates.ts`).
 *
 * Les autres raisons (`stop`, `tool_calls`, `function_call`) passent en
 * majuscules : `tool_calls` et `function_call` ne peuvent pas se produire ici,
 * cette étape ne déclare aucun outil, et s'ils arrivaient quand même
 * `leverSiBloquée` les traiterait comme une fin anormale non nommée — un
 * défaut de ce côté, pas un refus de contenu, exactement le traitement voulu.
 */
export function toFinishReason(raw: string | null | undefined): string {
  if (raw === 'length') return 'MAX_TOKENS'
  if (raw === 'content_filter') return 'CONTENT_FILTER'
  return (raw ?? '').toUpperCase()
}

type OpenAiChoice = {
  finish_reason?: string | null
  message?: { content?: string | null; rejection?: string | null }
}

type OpenAiResponse = { choices?: OpenAiChoice[] }

/**
 * Traduit la réponse REST vers la forme commune que `appelerGemini` consomme.
 *
 * **Un refus structuré (`message.refusal`) l'emporte sur `finish_reason`.**
 * OpenAI peut renvoyer `finish_reason: "stop"` avec un refus dans
 * `message.refusal` plutôt que dans `content` — un modèle qui explique en
 * langage naturel pourquoi il n'a rien produit. Sans ce contrôle, la réponse
 * passerait pour réussie et `parseJsonResponse` échouerait sur du texte libre,
 * classé passager par erreur plutôt que reconnu comme un refus définitif.
 */
export function toLlmResponse(data: OpenAiResponse): LlmResponse {
  const choice = data.choices?.[0]
  if (choice?.message?.rejection != null && choice.message.rejection !== '') {
    return { candidates: [{ finishReason: 'CONTENT_FILTER' }] }
  }
  return {
    text: choice?.message?.content ?? undefined,
    candidates: [{ finishReason: toFinishReason(choice?.finish_reason) }],
  }
}

function requestBody(model: string, prompt: string, schema: JsonSchema, temperature: number, maxOutputTokens: number) {
  return {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_completion_tokens: maxOutputTokens,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'result', schema, strict: false },
    },
  }
}

export function createOpenAiCall(options: LlmClientOptions): LlmCall {
  return async (prompt, mode) => {
    const { schema, temperature, maxOutputTokens } = options.config(mode)
    // **Le délai est fini, comme pour Gemini** (voir `DÉLAI_APPEL_MS` dans
    // `candidates.ts`) : sans lui, un appel qui n'aboutit ni ne casse
    // n'atteindrait jamais la politique de relance.
    const signals = [AbortSignal.timeout(options.timeoutMs)]
    if (options.signal !== undefined) signals.push(options.signal)

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey ?? ''}`,
      },
      body: JSON.stringify(requestBody(options.model, prompt, schema, temperature, maxOutputTokens)),
      signal: AbortSignal.any(signals),
    })

    if (!response.ok) {
      // Le code HTTP entre dans le message : c'est ce qu'`estPassagère`
      // (`candidates.ts`) reconnaît pour décider une relance — même
      // convention que le SDK Gemini, qui écrit le code dans son message
      // d'exception plutôt que de l'exposer autrement.
      const body = await response.text().catch(() => '')
      throw new Error(`OpenAI a répondu ${response.status} ${response.statusText} : ${body.slice(0, 500)}`)
    }

    const data = (await response.json()) as OpenAiResponse
    return toLlmResponse(data)
  }
}
