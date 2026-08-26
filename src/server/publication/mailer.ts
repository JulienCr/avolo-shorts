import { isReference, type Environment } from '@/server/secrets'

/**
 * L'alerte de l'ordonnanceur (spec §5.5), par Resend plutôt que par le SMTP
 * du serveur dédié — sa pile appartient à YunoHost — ou le mot de passe
 * d'application Gmail du coffre — un compte personnel ne devient pas une
 * dépendance d'infrastructure. `Mailer` est l'interface que `scheduler.ts`
 * appelle ; `createResendMailer` est la seule implémentation.
 */
export type Mailer = (subject: string, body: string) => Promise<void>

export const ALERT_RECIPIENT = 'julien@avolo.fr'

const ENDPOINT = 'https://api.resend.com/emails'
const TIMEOUT_MS = 10_000

/**
 * `undefined` pour une clé absente ou encore à l'état d'adresse 1Password —
 * jamais une levée, à la différence de `requiredEnv` dans `upload-post.ts` :
 * perdre l'alerte est acceptable, perdre la publication à cause d'elle ne
 * l'est pas (spec §5.5).
 */
function resendApiKey(env: Environment): string | undefined {
  const value = env.RESEND_API_KEY
  if (value === undefined || value === '' || isReference(value)) return undefined
  return value
}

/**
 * `env` et `fetchImpl` capturés une fois, comme `createUploadPostAdapter` —
 * les tests injectent un `fetch` qui ne touche jamais le réseau.
 */
export function createResendMailer(env: Environment = process.env, fetchImpl: typeof fetch = fetch): Mailer {
  return async (subject, body) => {
    const apiKey = resendApiKey(env)
    if (apiKey === undefined) {
      console.error(`RESEND_API_KEY absente ou non résolue : alerte perdue — ${subject}`)
      return
    }
    const from = env.RESEND_FROM ?? 'avolo-shorts@avolo.fr'
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ from, to: ALERT_RECIPIENT, subject, text: body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) console.error(`Resend a refusé l'alerte (${response.status}) : ${await response.text()}`)
    } catch (error) {
      // Un mail perdu se voit dans les journaux de la tâche planifiée ; une
      // publication annulée pour ça ne se voit nulle part (spec §5.5).
      console.error(`Envoi de l'alerte à Resend en échec : ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
