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
async function résoudrePasserelle(): Promise<string> {
  const { stdout } = await execFileP('ip', ['route', 'show', 'default'])
  const trouvée = /default via (\S+)/.exec(stdout)
  if (trouvée === null) {
    throw new Error(
      "Impossible de résoudre la passerelle WSL vers Ollama : « ip route show default » " +
        "n'a rien rendu d'exploitable. Régler l'URL du serveur Ollama à la main dans les réglages.",
    )
  }
  return trouvée[1]
}

/**
 * L'adresse du serveur, résolue **une fois** puis mémorisée pour tout le
 * `LlmCall` qui la referme — pas à chaque appel : un repérage en fait des
 * dizaines, et la passerelle ne change pas en cours de route.
 */
function résolveurDAdresse(configurée: string | undefined): () => Promise<string> {
  let mémo: Promise<string> | null = null
  return () => {
    const propre = configurée?.trim()
    if (propre !== undefined && propre !== '') return Promise.resolve(propre.replace(/\/+$/, ''))
    mémo ??= résoudrePasserelle().then((ip) => `http://${ip}:11434`)
    return mémo
  }
}

/**
 * Les raisons de fin qu'Ollama nomme (`done_reason`), traduites vers le
 * vocabulaire que `leverSiBloquée` reconnaît. Un modèle local n'a pas de
 * filtre de contenu fournisseur : rien ici ne produit `CONTENT_FILTER`.
 */
export function versRaisonDeFin(brut: string | null | undefined): string {
  if (brut === 'length') return 'MAX_TOKENS'
  return (brut ?? '').toUpperCase()
}

type RéponseOllama = { message?: { content?: string }; done_reason?: string | null }

export function versLlmResponse(données: RéponseOllama): LlmResponse {
  return {
    text: données.message?.content,
    candidates: [{ finishReason: versRaisonDeFin(données.done_reason) }],
  }
}

export function créerAppelOllama(options: LlmClientOptions): LlmCall {
  const résoudreAdresse = résolveurDAdresse(options.baseUrl)

  return async (prompt, mode) => {
    const { schema, temperature, maxOutputTokens } = options.config(mode)
    const base = await résoudreAdresse()

    const signaux = [AbortSignal.timeout(options.timeoutMs)]
    if (options.signal !== undefined) signaux.push(options.signal)

    const réponse = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'user', content: prompt }],
        format: schema,
        stream: false,
        options: { temperature, num_predict: maxOutputTokens },
      }),
      signal: AbortSignal.any(signaux),
    })

    if (!réponse.ok) {
      const corps = await réponse.text().catch(() => '')
      throw new Error(`Ollama a répondu ${réponse.status} ${réponse.statusText} : ${corps.slice(0, 500)}`)
    }

    const données = (await réponse.json()) as RéponseOllama
    return versLlmResponse(données)
  }
}
