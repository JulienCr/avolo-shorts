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

export type ClaimPkceResult =
  | { ok: true; verifier: string }
  | { ok: false; reason: 'none' }
  | { ok: false; reason: 'mismatch' }

/**
 * Lit, vérifie `state` et consomme le vérifieur en une seule lecture — plutôt
 * que `peek` puis `load` séparés, dont l'écart pouvait laisser un second
 * lancement réécrire le fichier entre les deux et faire consommer un
 * vérifieur dont le `state` n'a jamais été revérifié. Un échange raté détruit
 * quand même le fichier une fois `state` validé : comportement existant, pas
 * une régression de cette extraction.
 */
export async function claimPendingPkce(expectedState: string): Promise<ClaimPkceResult> {
  let raw: string
  try {
    raw = await fsp.readFile(pkceFilePath(), 'utf8')
  } catch {
    return { ok: false, reason: 'none' }
  }
  const record = JSON.parse(raw) as { verifier: string; state: string }
  if (record.state !== expectedState) {
    return { ok: false, reason: 'mismatch' }
  }
  await fsp.unlink(pkceFilePath()).catch(() => {})
  return { ok: true, verifier: record.verifier }
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
 * testable sans monter de composant React. **`state` se vérifie et le
 * vérifieur se consomme en une seule lecture** (`claimPendingPkce`) — issue
 * #161 : le vérifier avant de le consommer évite qu'un lien rejoué ou un
 * CSRF grille le seul jeton valide, et la lecture unique évite qu'un second
 * lancement réécrive le fichier entre la vérification et la consommation.
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
  const claim = await claimPendingPkce(params.state)
  if (!claim.ok) {
    return {
      ok: false,
      reason:
        claim.reason === 'none'
          ? 'Aucun pairage en attente. Relancer pnpm tsx scripts/dev-connect-tiktok.ts.'
          : "Le state renvoyé par TikTok ne correspond pas à celui attendu.",
    }
  }
  const { verifier } = claim
  try {
    const tokens = await exchangeTikTokCode(params.clientKey, params.clientSecret, params.code, verifier)
    await pairAndPersistTikTok(tokens)
    return { ok: true, openId: tokens.openId }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
