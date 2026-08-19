import { GoogleGenAI, Type, type Schema } from '@google/genai'

import type { JsonSchema, LlmCall, LlmClientOptions } from '@/server/llm/types'

/**
 * Le client Gemini : ce que `clientByDefault` faisait seul dans
 * `candidates.ts` avant que la couture se généralise.
 *
 * **Le signal va au SDK**, qui le passe à `fetch` : la requête en vol est
 * vraiment coupée, on ne se contente pas de cesser d'en attendre la réponse.
 * Propriété vérifiée en vrai par la PR #71 (voir `candidates.ts`), et
 * préservée ici à l'identique.
 */

/** Convertit le schéma générique vers la forme que l'API Gemini attend. */
export function toGeminiSchema(schema: JsonSchema): Schema {
  switch (schema.type) {
    case 'object':
      return {
        type: Type.OBJECT,
        properties: Object.fromEntries(
          Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]),
        ),
        required: schema.required ? [...schema.required] : undefined,
      }
    case 'array':
      return { type: Type.ARRAY, items: toGeminiSchema(schema.items) }
    case 'string':
      return { type: Type.STRING }
    case 'integer':
      return { type: Type.INTEGER }
    case 'number':
      return { type: Type.NUMBER }
    case 'boolean':
      return { type: Type.BOOLEAN }
  }
}

export function createGeminiCall(options: LlmClientOptions): LlmCall {
  const ai = new GoogleGenAI({ apiKey: options.apiKey, httpOptions: { timeout: options.timeoutMs } })
  return (prompt, mode) => {
    const { schema, temperature, maxOutputTokens } = options.config(mode)
    return ai.models.generateContent({
      model: options.model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(schema),
        temperature,
        candidateCount: 1,
        maxOutputTokens,
        abortSignal: options.signal,
      },
    })
  }
}
