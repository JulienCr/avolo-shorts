import { createHash, randomBytes } from 'node:crypto'

/**
 * PKCE — obligatoire pour cette app TikTok, et absent de la spec avant cette
 * PR : sans `code_challenge` + `code_challenge_method=S256`, l'autorisation
 * rend `error=param_error&errCode=10007&error_type=code_challenge` (mesuré le
 * 24 août 2026). Extrait de `tiktok.ts` pour rester testable sans exécuter le
 * script de pairage, qui a des effets de bord dès l'import (spec §2.3).
 */
export type PkcePair = { verifier: string; challenge: string }

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createPkcePair(): PkcePair {
  const verifier = base64url(randomBytes(32))
  // TikTok s'écarte de la RFC 7636 : « hashing the code verifier using hex
  // encoding of SHA256 » (login-kit-desktop). Un challenge en base64url passe
  // l'autorisation, dont la forme n'est pas vérifiée, et fait échouer l'échange.
  const challenge = createHash('sha256').update(verifier).digest('hex')
  return { verifier, challenge }
}

const AUTHORIZE_BASE = 'https://www.tiktok.com/v2/auth/authorize/'

/**
 * L'URL d'autorisation TikTok. La boucle locale est acceptée pour cette app
 * (mesuré le 24 août 2026, spec §2.3 corrigée par cette PR) : `redirectUri`
 * peut être `http://127.0.0.1:…` sans page à héberger ni domaine vérifié.
 */
export function authorizationUrl(options: {
  clientKey: string
  redirectUri: string
  scope: string
  state: string
  challenge: string
}): string {
  const params = new URLSearchParams({
    client_key: options.clientKey,
    redirect_uri: options.redirectUri,
    scope: options.scope,
    response_type: 'code',
    state: options.state,
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
  })
  return `${AUTHORIZE_BASE}?${params.toString()}`
}
