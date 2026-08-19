import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { LlmCall, LlmClientOptions, LlmResponse } from '@/server/llm/types'

const execFileP = promisify(execFile)

/**
 * Le client Ollama, par l'API REST `/api/chat`. Ollama tourne sur l'hôte
 * Windows, pas dans WSL, port 11434 (`CLAUDE.md`, « L'environnement »).
 *
 * **Aucune clé.** C'est un serveur local sans compte : `LlmClientOptions.apiKey`
 * n'est jamais lu ici, et `src/lib/api.ts` (`LlmProviderAvailability`) le sait
 * déjà — Ollama est toujours « disponible » du point de vue d'une clé.
 */

/**
 * L'adresse de la passerelle WSL, résolue par `ip route show default` —
 * **jamais codée en dur, elle change au redémarrage** (`CLAUDE.md`).
 */
async function resolveGateway(): Promise<string> {
  let stdout: string
  try {
    ;({ stdout } = await execFileP('ip', ['route', 'show', 'default']))
  } catch {
    // `execFileP` peut casser avant même de lancer `ip` (absent du `PATH`,
    // par exemple) : le message brut de Node ne dit rien d'actionnable, donc
    // on retombe sur le même message que « ip a répondu, mais rien
    // d'exploitable » plutôt que de le laisser remonter tel quel.
    throw new Error(
      "Impossible de résoudre la passerelle WSL vers Ollama : « ip route show default » " +
        "n'a rien rendu d'exploitable. Régler l'URL du serveur Ollama à la main dans les réglages.",
    )
  }
  const found = /default via (\S+)/.exec(stdout)
  if (found === null) {
    throw new Error(
      "Impossible de résoudre la passerelle WSL vers Ollama : « ip route show default » " +
        "n'a rien rendu d'exploitable. Régler l'URL du serveur Ollama à la main dans les réglages.",
    )
  }
  return found[1]
}

/**
 * L'adresse du serveur, résolue **une fois** puis mémorisée pour tout le
 * `LlmCall` qui la referme — pas à chaque appel : un repérage en fait des
 * dizaines, et la passerelle ne change pas en cours de route.
 */
function baseUrlResolver(configured: string | undefined): () => Promise<string> {
  let memo: Promise<string> | null = null
  return () => {
    const trimmed = configured?.trim()
    if (trimmed !== undefined && trimmed !== '') return Promise.resolve(trimmed.replace(/\/+$/, ''))
    memo ??= resolveGateway().then((ip) => `http://${ip}:11434`)
    return memo
  }
}

/**
 * Les raisons de fin qu'Ollama nomme (`done_reason`), traduites vers le
 * vocabulaire que `leverSiBloquée` reconnaît. Un modèle local n'a pas de
 * filtre de contenu fournisseur : rien ici ne produit `CONTENT_FILTER`.
 */
export function toFinishReason(raw: string | null | undefined): string {
  if (raw === 'length') return 'MAX_TOKENS'
  return (raw ?? '').toUpperCase()
}

type OllamaResponse = { message?: { content?: string }; done_reason?: string | null }

export function toLlmResponse(data: OllamaResponse): LlmResponse {
  return {
    text: data.message?.content,
    candidates: [{ finishReason: toFinishReason(data.done_reason) }],
  }
}

export function createOllamaCall(options: LlmClientOptions): LlmCall {
  const resolveAddress = baseUrlResolver(options.baseUrl)

  return async (prompt, mode) => {
    const { schema, temperature, maxOutputTokens } = options.config(mode)
    const base = await resolveAddress()

    const signals = [AbortSignal.timeout(options.timeoutMs)]
    if (options.signal !== undefined) signals.push(options.signal)

    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'user', content: prompt }],
        format: schema,
        stream: false,
        options: { temperature, num_predict: maxOutputTokens },
      }),
      signal: AbortSignal.any(signals),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Ollama a répondu ${response.status} ${response.statusText} : ${body.slice(0, 500)}`)
    }

    const data = (await response.json()) as OllamaResponse
    return toLlmResponse(data)
  }
}
