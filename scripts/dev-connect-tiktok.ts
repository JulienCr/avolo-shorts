/**
 * L'appairage TikTok — OAuth avec PKCE, ou jetons collés une fois pour toutes.
 *
 *     pnpm tsx scripts/dev-connect-tiktok.ts
 *     pnpm tsx scripts/dev-connect-tiktok.ts --code=<code renvoyé par TikTok>
 *     TIKTOK_ACCESS_TOKEN=<jeton> TIKTOK_REFRESH_TOKEN=<jeton> TIKTOK_OPEN_ID=<id> \
 *       pnpm tsx scripts/dev-connect-tiktok.ts
 *
 * Les jetons ci-dessus passent par l'environnement, jamais par `argv`
 * (`/proc/<pid>/cmdline`) — même règle que `META_SYSTEM_USER_TOKEN`
 * (`dev-connect-meta.ts`). Boucle locale et PKCE : `tiktok-pkce.ts`, §2.3.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { projectsDir } from '@/server/paths'
import { authorizationUrl, createPkcePair } from '@/server/publication/tiktok-pkce'
import { OAUTH_TOKEN_ENDPOINT, writeTikTokTokens, type OAuthTokenResponse } from '@/server/publication/tiktok-tokens'
import { requireSecret } from '@/server/secrets'
import { chargerEnv, quit } from './dev-common'

/**
 * `user.info.basic` sert uniquement à `availability()` (`tiktok.ts`) pour
 * confirmer qu'un jeton persisté fonctionne encore, sans dépôt réel — au-delà
 * de `video.upload`, seule portée nommée par la spec §2.3.
 */
const SCOPES = 'user.info.basic,video.upload'

function redirectUri(): string {
  return process.env.TIKTOK_REDIRECT_URI ?? 'http://127.0.0.1:4005/tiktok/oauth-callback/'
}

function pkceFilePath(): string {
  return path.join(projectsDir(), '.tiktok-pkce.json')
}

async function persistPkce(verifier: string, state: string): Promise<void> {
  await fsp.mkdir(projectsDir(), { recursive: true })
  await fsp.writeFile(pkceFilePath(), JSON.stringify({ verifier, state }), { encoding: 'utf8', mode: 0o600 })
}

async function loadAndForgetPkce(): Promise<{ verifier: string; state: string }> {
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

type ExchangedTokens = {
  openId: string
  accessToken: string
  refreshToken: string
  expiresIn: number
  refreshExpiresIn: number
}

async function exchangeCode(
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
      redirect_uri: redirectUri(),
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

async function pairAndPersist(
  openId: string,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  refreshExpiresIn: number,
): Promise<void> {
  await writeTikTokTokens({
    openId,
    accessToken,
    refreshToken,
    accessTokenExpiresAt: Date.now() + expiresIn * 1000,
    refreshTokenExpiresAt: Date.now() + refreshExpiresIn * 1000,
  })
  console.log(`Compte ${openId}, jeton persisté dans projects/tiktok-tokens.json.`)
  console.log(`  Accès : ${Math.round(expiresIn / 3600)} h. Rafraîchissement : ${Math.round(refreshExpiresIn / 86_400)} j.`)
}

function flag(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length)
}

async function main(): Promise<number> {
  await chargerEnv()

  const pastedAccessToken = process.env.TIKTOK_ACCESS_TOKEN
  const pastedRefreshToken = process.env.TIKTOK_REFRESH_TOKEN
  if (pastedAccessToken !== undefined && pastedAccessToken !== '') {
    if (pastedRefreshToken === undefined || pastedRefreshToken === '') {
      throw new Error('TIKTOK_ACCESS_TOKEN est posé sans TIKTOK_REFRESH_TOKEN : les deux sont requis.')
    }
    const openId = process.env.TIKTOK_OPEN_ID ?? ''
    const expiresIn = Number(process.env.TIKTOK_EXPIRES_IN_SECONDS ?? 86_400)
    const refreshExpiresIn = Number(process.env.TIKTOK_REFRESH_EXPIRES_IN_SECONDS ?? 31_536_000)
    await pairAndPersist(openId, pastedAccessToken, pastedRefreshToken, expiresIn, refreshExpiresIn)
    return 0
  }

  const clientKey = requireSecret('TIKTOK_CLIENT_KEY')
  const clientSecret = requireSecret('TIKTOK_CLIENT_SECRET')
  const code = flag('code')

  if (code === undefined) {
    const { verifier, challenge } = createPkcePair()
    const state = randomUUID()
    await persistPkce(verifier, state)
    console.log('Ouvrir cette URL dans un navigateur connecté au compte TikTok qui gère @cie.avolo :\n')
    console.log(authorizationUrl({ clientKey, redirectUri: redirectUri(), scope: SCOPES, state, challenge }))
    console.log(
      `\nTikTok redirige ensuite vers ${redirectUri()}?code=...&state=${state} : recopier le code dans` +
        ' pnpm tsx scripts/dev-connect-tiktok.ts --code=<code>',
    )
    return 0
  }

  const { verifier } = await loadAndForgetPkce()
  const tokens = await exchangeCode(clientKey, clientSecret, code, verifier)
  await pairAndPersist(tokens.openId, tokens.accessToken, tokens.refreshToken, tokens.expiresIn, tokens.refreshExpiresIn)
  return 0
}

main()
  .then((code) => quit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    quit(1)
  })
