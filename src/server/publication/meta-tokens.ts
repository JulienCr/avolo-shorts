import fsp from 'node:fs/promises'
import path from 'node:path'

import { projectsDir } from '@/server/paths'
import { MetaAccountMisconfiguredError, MetaTokenExpiredError } from '@/server/publication/errors'
import { isReference, type Environment } from '@/server/secrets'

/**
 * Ce qui tourne côté Meta et ne peut donc pas vivre dans 1Password (lecture
 * seule ici) : le jeton Facebook Login, 60 jours, rafraîchissable (spec §7).
 * L'identifiant du compte Instagram est rangé avec lui plutôt que dans
 * `.env`, puisque `scripts/dev-connect-meta.ts` les obtient dans le même
 * appel.
 *
 * Le jeton de Page Facebook n'est pas ici : il n'expire pas, donc il vit en
 * 1Password (`META_PAGE_TOKEN`).
 */
export type MetaTokenFile = {
  instagramUserId: string
  instagramAccessToken: string
  /** Époque Unix en millisecondes. */
  instagramTokenExpiresAt: number
}

function tokenFilePath(): string {
  return path.join(projectsDir(), 'meta-tokens.json')
}

function isMetaTokenFile(value: unknown): value is MetaTokenFile {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<MetaTokenFile>
  return (
    typeof candidate.instagramUserId === 'string' &&
    typeof candidate.instagramAccessToken === 'string' &&
    typeof candidate.instagramTokenExpiresAt === 'number'
  )
}

/** `null` : jamais appairé, ou fichier corrompu — les deux se traitent comme « à réappairer ». */
export async function readMetaTokens(): Promise<MetaTokenFile | null> {
  let raw: string
  try {
    raw = await fsp.readFile(tokenFilePath(), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return isMetaTokenFile(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** `scripts/dev-connect-meta.ts` l'appelle à l'appairage ; `refreshInstagramToken` après. */
export async function writeMetaTokens(tokens: MetaTokenFile): Promise<void> {
  const file = tokenFilePath()
  await fsp.mkdir(path.dirname(file), { recursive: true })
  // `0o600` forcé explicitement : `writeFile` applique le mode par défaut
  // `0o666` filtré par l'umask du processus, qui peut laisser ce jeton
  // longue durée lisible par d'autres comptes locaux. `mode` seul ne suffit
  // pas sur un fichier déjà existant — `writeFile` ne le rétablit pas — d'où
  // le `chmod` séparé qui s'applique dans les deux cas.
  await fsp.writeFile(file, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fsp.chmod(file, 0o600)
}

function requiredEnv(env: Environment, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new MetaAccountMisconfiguredError(`${name} n'est pas définie.`)
  }
  if (isReference(value)) {
    throw new MetaAccountMisconfiguredError(
      `${name} vaut encore une adresse 1Password (op://…) : la résolution du démarrage a été défaite. Relancer le serveur.`,
    )
  }
  return value
}

const GRAPH_VERSION = 'v23.0'
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

type ExchangeResponse = { access_token?: string; expires_in?: number; error?: { message?: string } }

/**
 * Échange le jeton courant contre un jeton longue durée frais — `fb_exchange_token`
 * accepte aussi bien un jeton court qu'un jeton déjà longue durée, ce qui est
 * précisément ce que « rafraîchir au démarrage » (spec §7) demande de faire
 * sans savoir combien de jours il reste.
 *
 * **Persiste ce que Meta rend, jamais une supposition.** `expires_in` varie
 * d'un appel à l'autre ; le fichier porte la valeur reçue, pas une constante
 * de 60 jours codée en dur.
 */
export async function refreshInstagramToken(
  env: Environment,
  fetchImpl: typeof fetch,
): Promise<MetaTokenFile> {
  const current = await readMetaTokens()
  if (current === null) {
    throw new MetaAccountMisconfiguredError(
      'Aucun jeton Instagram enregistré. Lancer pnpm tsx scripts/dev-connect-meta.ts.',
    )
  }
  const appId = requiredEnv(env, 'META_APP_ID')
  const appSecret = requiredEnv(env, 'META_APP_SECRET')
  const url =
    `${GRAPH_BASE}/oauth/access_token?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}` +
    `&fb_exchange_token=${encodeURIComponent(current.instagramAccessToken)}`
  const response = await fetchImpl(url)
  const body = (await response.json().catch(() => null)) as ExchangeResponse | null
  if (!response.ok || body?.access_token === undefined || body.expires_in === undefined) {
    throw new MetaTokenExpiredError(body?.error?.message ?? `Meta a répondu ${response.status} à l'échange de jeton.`)
  }
  const refreshed: MetaTokenFile = {
    ...current,
    instagramAccessToken: body.access_token,
    instagramTokenExpiresAt: Date.now() + body.expires_in * 1000,
  }
  await writeMetaTokens(refreshed)
  return refreshed
}

let cachedTokens: Promise<MetaTokenFile> | null = null

/**
 * Le jeton Instagram, rafraîchi une seule fois par processus — pas à chaque
 * publication, ce que « au démarrage » (spec §7) demande. Les appels
 * concurrents pendant le premier rafraîchissement attendent la même promesse.
 */
export function ensureFreshInstagramToken(env: Environment, fetchImpl: typeof fetch): Promise<MetaTokenFile> {
  cachedTokens ??= refreshInstagramToken(env, fetchImpl).catch((error: unknown) => {
    cachedTokens = null
    throw error
  })
  return cachedTokens
}

/** Pour les tests, qui changent de jeton d'un cas à l'autre. */
export function forgetTokenCache(): void {
  cachedTokens = null
}
