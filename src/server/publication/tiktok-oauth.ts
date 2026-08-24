import fsp from 'node:fs/promises'
import path from 'node:path'

import { projectsDir } from '@/server/paths'
import { OAUTH_TOKEN_ENDPOINT, writeTikTokTokens, type OAuthTokenResponse } from '@/server/publication/tiktok-tokens'

/**
 * L'échange PKCE et sa persistance, partagés entre `scripts/dev-connect-tiktok.ts`
 * (le pairage manuel avec copier-coller du code) et `GET /tiktok/oauth-callback`
 * (le même flux, sans l'étape manuelle). Les deux appellent `projectsDir()`,
 * lue à l'appel plutôt qu'au chargement du module, donc les deux résolvent le
 * même `.tiktok-pkce.json`.
 */

/**
 * `http://localhost:4005/tiktok/oauth-callback` est la forme enregistrée sur
 * la console TikTok pour cette app, vérifiée par un pairage réel de bout en
 * bout (24 août 2026). Un `redirect_uri` non enregistré fait échouer
 * l'autorisation, rapportée comme une erreur `client_key` plutôt que
 * `redirect_uri` (mesuré le même soir) — donc toute variante non vérifiée
 * (host, slash final) est à traiter comme potentiellement différente pour
 * TikTok, pas à « nettoyer » vers une forme qui paraît équivalente.
 */
export function tiktokRedirectUri(): string {
  return process.env.TIKTOK_REDIRECT_URI ?? 'http://localhost:4005/tiktok/oauth-callback'
}

function pkceFilePath(): string {
  return path.join(projectsDir(), '.tiktok-pkce.json')
}

export async function persistPkce(verifier: string, state: string): Promise<void> {
  await fsp.mkdir(projectsDir(), { recursive: true })
  await fsp.writeFile(pkceFilePath(), JSON.stringify({ verifier, state }), { encoding: 'utf8', mode: 0o600 })
}

/**
 * Consomme le vérifieur en attente. Un échange raté détruit donc le fichier :
 * comportement existant, pas une régression de cette extraction — l'appelant
 * doit vérifier `state` **avant** d'appeler ceci, sans quoi un lien rejoué ou
 * un CSRF grille le seul vérifieur valide.
 */
export async function loadAndForgetPkce(): Promise<{ verifier: string; state: string }> {
  let raw: string
  try {
    raw = await fsp.readFile(pkceFilePath(), 'utf8')
  } catch {
    throw new Error(
      'Aucun vérifieur PKCE en attente. Relancer pnpm tsx scripts/dev-connect-tiktok.ts sans --code pour en obtenir un.',
    )
  }
  await fsp.unlink(pkceFilePath()).catch(() => {})
  return JSON.parse(raw) as { verifier: string; state: string }
}

/** Sans consommer le fichier — pour vérifier `state` avant d'engager l'échange. */
export async function peekPendingState(): Promise<string | null> {
  try {
    const raw = await fsp.readFile(pkceFilePath(), 'utf8')
    return (JSON.parse(raw) as { verifier: string; state: string }).state
  } catch {
    return null
  }
}

export type ExchangedTokens = {
  openId: string
  accessToken: string
  refreshToken: string
  expiresIn: number
  refreshExpiresIn: number
}

export async function exchangeTikTokCode(
  clientKey: string,
  clientSecret: string,
  code: string,
  verifier: string,
): Promise<ExchangedTokens> {
  const response = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: tiktokRedirectUri(),
      code_verifier: verifier,
    }),
  })
  const body = (await response.json().catch(() => null)) as OAuthTokenResponse | null
  if (
    !response.ok ||
    body?.access_token === undefined ||
    body.refresh_token === undefined ||
    body.expires_in === undefined ||
    body.refresh_expires_in === undefined
  ) {
    throw new Error(
      `TikTok a répondu ${response.status} à l'échange de code : ${body?.error_description ?? body?.error ?? 'corps illisible'}.`,
    )
  }
  return {
    openId: body.open_id ?? '',
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
    refreshExpiresIn: body.refresh_expires_in,
  }
}

export async function pairAndPersistTikTok(tokens: ExchangedTokens): Promise<void> {
  await writeTikTokTokens({
    openId: tokens.openId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: Date.now() + tokens.expiresIn * 1000,
    refreshTokenExpiresAt: Date.now() + tokens.refreshExpiresIn * 1000,
  })
}

export type TikTokCallbackResult = { ok: true; openId: string } | { ok: false; reason: string }

/**
 * La logique de `GET /tiktok/oauth-callback`, séparée du rendu pour rester
 * testable sans monter de composant React. **`state` se vérifie avant tout
 * appel à `loadAndForgetPkce`** — issue #161 : le vérifieur est consommé à la
 * lecture, et le consommer avant d'avoir authentifié la redirection grillerait
 * le seul jeton valide sur un lien rejoué ou un CSRF.
 */
export async function completeTikTokCallback(params: {
  code: string | undefined
  state: string | undefined
  tiktokError: string | undefined
  clientKey: string
  clientSecret: string
}): Promise<TikTokCallbackResult> {
  if (params.tiktokError !== undefined) {
    return { ok: false, reason: params.tiktokError }
  }
  if (params.code === undefined || params.state === undefined) {
    return { ok: false, reason: "Paramètres manquants dans l'URL de retour : code et state sont attendus." }
  }
  const pendingState = await peekPendingState()
  if (pendingState === null) {
    return {
      ok: false,
      reason: 'Aucun pairage en attente. Relancer pnpm tsx scripts/dev-connect-tiktok.ts.',
    }
  }
  if (pendingState !== params.state) {
    return { ok: false, reason: "Le state renvoyé par TikTok ne correspond pas à celui attendu." }
  }
  const { verifier } = await loadAndForgetPkce()
  try {
    const tokens = await exchangeTikTokCode(params.clientKey, params.clientSecret, params.code, verifier)
    await pairAndPersistTikTok(tokens)
    return { ok: true, openId: tokens.openId }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
