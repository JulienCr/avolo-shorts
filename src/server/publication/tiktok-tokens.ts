import fsp from 'node:fs/promises'
import path from 'node:path'

import { isAAbsence } from '@/server/bytes'
import { projectsDir } from '@/server/paths'
import { TikTokAccountMisconfiguredError, TikTokTokenExpiredError } from '@/server/publication/errors'
import { isReference, type Environment } from '@/server/secrets'

/**
 * Ce qui tourne côté TikTok et ne peut donc pas vivre dans 1Password (lecture
 * seule) : l'accès (24 h) et le rafraîchissement (365 jours), tous deux
 * renouvelés à chaque rafraîchissement — contrairement à Meta, TikTok n'a pas
 * de jeton perpétuel. `scripts/dev-connect-tiktok.ts` écrit ce fichier une
 * première fois.
 */
export type TikTokTokenFile = {
  openId: string
  accessToken: string
  refreshToken: string
  /** Époque Unix en millisecondes. */
  accessTokenExpiresAt: number
  /** Époque Unix en millisecondes. */
  refreshTokenExpiresAt: number
}

function tokenFilePath(): string {
  return path.join(projectsDir(), 'tiktok-tokens.json')
}

function isTikTokTokenFile(value: unknown): value is TikTokTokenFile {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<TikTokTokenFile>
  return (
    typeof candidate.openId === 'string' &&
    typeof candidate.accessToken === 'string' &&
    typeof candidate.refreshToken === 'string' &&
    typeof candidate.accessTokenExpiresAt === 'number' &&
    typeof candidate.refreshTokenExpiresAt === 'number'
  )
}

/**
 * `null` : jamais appairé, ou fichier corrompu — les deux se traitent comme
 * « à réappairer ». Seule l'absence du fichier le prouve, même distinction que
 * `readMetaTokens`.
 */
export async function readTikTokTokens(): Promise<TikTokTokenFile | null> {
  let raw: string
  try {
    raw = await fsp.readFile(tokenFilePath(), 'utf8')
  } catch (error) {
    if (isAAbsence(error)) return null
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return isTikTokTokenFile(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Écriture atomique et `0600`, même discipline que `writeMetaTokens`. */
export async function writeTikTokTokens(tokens: TikTokTokenFile): Promise<void> {
  const file = tokenFilePath()
  const dir = path.dirname(file)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.tiktok-tokens.json.${process.pid}.tmp`)
  await fsp.writeFile(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(tmp, file)
}

function requiredEnv(env: Environment, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new TikTokAccountMisconfiguredError(`${name} n'est pas définie.`)
  }
  if (isReference(value)) {
    throw new TikTokAccountMisconfiguredError(
      `${name} vaut encore une adresse 1Password (op://…) : la résolution du démarrage a été défaite. Relancer le serveur.`,
    )
  }
  return value
}

export const OAUTH_TOKEN_ENDPOINT = 'https://open.tiktokapis.com/v2/oauth/token/'

/**
 * La forme plate de `POST /v2/oauth/token/` — un `error` **chaîne**, pas
 * l'enveloppe `{data, error: {code, message}}` du reste de l'API v2 (mesuré
 * le 24 août 2026, doc officielle du point de terminaison).
 */
export type OAuthTokenResponse = {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  refresh_expires_in?: number
  open_id?: string
  error?: string
  error_description?: string
}

/**
 * Échange le jeton de rafraîchissement contre un jeton d'accès **et** un
 * nouveau jeton de rafraîchissement — TikTok rend les deux à chaque appel, et
 * persiste ce qu'il rend plutôt que de supposer une durée stable (spec §7).
 */
export async function refreshTikTokToken(env: Environment, fetchImpl: typeof fetch): Promise<TikTokTokenFile> {
  const current = await readTikTokTokens()
  if (current === null) {
    throw new TikTokAccountMisconfiguredError(
      'Aucun jeton TikTok enregistré. Lancer pnpm tsx scripts/dev-connect-tiktok.ts.',
    )
  }
  const clientKey = requiredEnv(env, 'TIKTOK_CLIENT_KEY')
  const clientSecret = requiredEnv(env, 'TIKTOK_CLIENT_SECRET')
  const response = await fetchImpl(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
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
    throw new TikTokTokenExpiredError(
      body?.error_description ?? body?.error ?? `TikTok a répondu ${response.status} au rafraîchissement.`,
    )
  }
  const refreshed: TikTokTokenFile = {
    openId: body.open_id ?? current.openId,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accessTokenExpiresAt: Date.now() + body.expires_in * 1000,
    refreshTokenExpiresAt: Date.now() + body.refresh_expires_in * 1000,
  }
  await writeTikTokTokens(refreshed)
  return refreshed
}

/** Rafraîchir en avance de cette marge évite qu'un appel long débute avec un jeton sur le point d'expirer. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

let cachedTokens: Promise<TikTokTokenFile> | null = null

async function loadFreshTikTokToken(env: Environment, fetchImpl: typeof fetch): Promise<TikTokTokenFile> {
  const current = await readTikTokTokens()
  if (current === null) {
    throw new TikTokAccountMisconfiguredError(
      'Aucun jeton TikTok enregistré. Lancer pnpm tsx scripts/dev-connect-tiktok.ts.',
    )
  }
  if (current.accessTokenExpiresAt - REFRESH_MARGIN_MS > Date.now()) return current
  return refreshTikTokToken(env, fetchImpl)
}

/** Le jeton TikTok, rafraîchi une seule fois par processus. Même forme que `ensureFreshInstagramToken`. */
export function ensureFreshTikTokToken(env: Environment, fetchImpl: typeof fetch): Promise<TikTokTokenFile> {
  cachedTokens ??= loadFreshTikTokToken(env, fetchImpl).catch((error: unknown) => {
    cachedTokens = null
    throw error
  })
  return cachedTokens
}

/** Pour les tests, qui changent de jeton d'un cas à l'autre. */
export function forgetTikTokTokenCache(): void {
  cachedTokens = null
}
