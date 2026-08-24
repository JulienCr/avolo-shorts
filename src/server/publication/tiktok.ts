import fsp from 'node:fs/promises'

import { defaultPlatformAvailability, type Platform, type PlatformAvailability } from '@/core/publication'
import { messageSafe } from '@/server/errors'
import type { PlatformOutcome, PublicationAdapter, PublicationJob } from '@/server/publication/adapter'
import {
  TikTokAccountMisconfiguredError,
  TikTokFileRefusedError,
  TikTokRateLimitError,
  TikTokTokenExpiredError,
} from '@/server/publication/errors'
import { ensureFreshTikTokToken, readTikTokTokens } from '@/server/publication/tiktok-tokens'
import { isReference, type Environment } from '@/server/secrets'

/**
 * Le connecteur TikTok direct — dépôt en brouillon (`video.upload`), jamais
 * `video.publish` qui force `SELF_ONLY` sur une app non auditée (spec §2.3,
 * corrigée le 24 août 2026 : la boucle locale `127.0.0.1` est acceptée, PKCE
 * est obligatoire). Un dépôt réussi rend `submitted`, jamais `published` — le
 * brouillon attend un geste dans l'app.
 *
 * **Jamais vérifié contre le vrai réseau** : `scripts/dev-connect-tiktok.ts`
 * a besoin d'un humain devant un navigateur, que cette PR ne peut pas fournir.
 * Testé partout contre un `fetch` injecté, comme `meta.ts`.
 */

const API_BASE = 'https://open.tiktokapis.com/v2'
/** Bornes du morceau TikTok (spec §2.3), exportées pour les tests de `planChunks`. */
export const MIN_CHUNK_SIZE = 5 * 1024 * 1024
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024

export type ChunkPlan = { chunkSize: number; chunkCount: number; lastChunkSize: number }

/**
 * Le découpage TikTok (5-64 Mo par morceau, spec §2.3). `chunkSize` est la
 * valeur déclarée à `init` pour tous les morceaux sauf le dernier, qui absorbe
 * le reste plutôt que d'en produire un sous les 5 Mo minimum — TikTok accepte
 * que ce dernier morceau dépasse `chunkSize` en pratique, seule la valeur
 * déclarée doit rester dans les bornes.
 */
export function planChunks(fileSize: number): ChunkPlan {
  if (fileSize <= 0) throw new TikTokFileRefusedError(`Fichier vide ou illisible (${fileSize} octets).`)
  if (fileSize <= MAX_CHUNK_SIZE) return { chunkSize: fileSize, chunkCount: 1, lastChunkSize: fileSize }
  const wholeChunks = Math.floor(fileSize / MAX_CHUNK_SIZE)
  const remainder = fileSize % MAX_CHUNK_SIZE
  if (remainder === 0) return { chunkSize: MAX_CHUNK_SIZE, chunkCount: wholeChunks, lastChunkSize: MAX_CHUNK_SIZE }
  if (remainder < MIN_CHUNK_SIZE) {
    if (wholeChunks < 2) {
      // Un seul morceau plein ne laisse personne dans qui fondre le reste, et
      // le déclarer tel quel dépasserait `chunk_size` au-delà de son maximum
      // (contrairement au dernier morceau d'un plan à plusieurs, où seule la
      // taille réellement envoyée peut dépasser la valeur déclarée). On coupe
      // donc en deux parts égales, toutes deux dans les bornes 5-64 Mo.
      const chunkSize = Math.ceil(fileSize / 2)
      return { chunkSize, chunkCount: 2, lastChunkSize: fileSize - chunkSize }
    }
    return { chunkSize: MAX_CHUNK_SIZE, chunkCount: wholeChunks, lastChunkSize: MAX_CHUNK_SIZE + remainder }
  }
  return { chunkSize: MAX_CHUNK_SIZE, chunkCount: wholeChunks + 1, lastChunkSize: remainder }
}

function chunkRanges(plan: ChunkPlan): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  for (let i = 0; i < plan.chunkCount; i++) {
    const start = i * plan.chunkSize
    const size = i === plan.chunkCount - 1 ? plan.lastChunkSize : plan.chunkSize
    ranges.push({ start, end: start + size - 1 })
  }
  return ranges
}

type TikTokErrorBody = { code?: string; message?: string; log_id?: string }
type TikTokEnvelope<T> = { data?: T; error?: TikTokErrorBody }

const TOKEN_ERROR_CODES = ['access_token_invalid', 'access_token_expired']
const RATE_LIMIT_CODES = ['rate_limit_exceeded', 'spam_risk_too_many_posts']
// `spam_risk_user_banned_from_posting` n'est pas un débit atteint : le compte
// est interdit de publication, attendre la fenêtre de 24 h ne le lèvera pas.
const ACCOUNT_ERROR_CODES = ['spam_risk_user_banned_from_posting']
const FILE_ERROR_CODES = [
  'file_format_check_failed',
  'duration_check_failed',
  'frame_rate_check_failed',
  'picture_size_check_failed',
  'video_pull_failed',
]

/**
 * Traduit l'enveloppe `{data, error: {code, message}}` du reste de l'API v2 en
 * l'une des erreurs nommées — TikTok peut rendre `200` avec un `error.code`
 * différent de `ok`, donc le code HTTP seul ne suffit pas à décider du succès.
 */
async function requireOkTikTok<T>(response: Response): Promise<T> {
  const text = await response.text()
  let parsed: TikTokEnvelope<T> | null = null
  try {
    parsed = text === '' ? null : (JSON.parse(text) as TikTokEnvelope<T>)
  } catch {
    parsed = null
  }
  const error = parsed?.error
  const failed = !response.ok || (error?.code !== undefined && error.code !== 'ok')
  if (failed) {
    const message = error?.message ?? (text === '' ? response.statusText : text)
    const code = error?.code
    if (response.status === 401 || (code !== undefined && TOKEN_ERROR_CODES.includes(code))) {
      throw new TikTokTokenExpiredError(message)
    }
    if (response.status === 429 || (code !== undefined && RATE_LIMIT_CODES.includes(code))) {
      throw new TikTokRateLimitError(message)
    }
    if (code !== undefined && FILE_ERROR_CODES.includes(code)) {
      throw new TikTokFileRefusedError(message)
    }
    if (
      response.status === 400 ||
      code === 'invalid_params' ||
      code === 'scope_not_authorized' ||
      (code !== undefined && ACCOUNT_ERROR_CODES.includes(code))
    ) {
      throw new TikTokAccountMisconfiguredError(message)
    }
    throw new Error(`TikTok a répondu ${response.status}${code === undefined ? '' : ` (${code})`} : ${message}`)
  }
  if (parsed?.data === undefined) throw new Error('TikTok a répondu un corps illisible.')
  return parsed.data
}

type InitResponse = { publish_id: string; upload_url: string }

async function initUpload(
  fetchImpl: typeof fetch,
  accessToken: string,
  fileSize: number,
  plan: ChunkPlan,
): Promise<InitResponse> {
  const response = await fetchImpl(`${API_BASE}/post/publish/inbox/video/init/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: fileSize,
        chunk_size: plan.chunkSize,
        total_chunk_count: plan.chunkCount,
      },
    }),
  })
  return requireOkTikTok<InitResponse>(response)
}

/** Nombre de tentatives sur un 5xx transitoire du point d'envoi — même borne que `UPLOAD_RETRY_ATTEMPTS` côté Meta. */
const CHUNK_RETRY_ATTEMPTS = 3

/** `Content-Type: video/mp4` : le pipeline ne rend que du mp4 (`src/server/steps/render.ts`). */
async function uploadChunks(
  fetchImpl: typeof fetch,
  uploadUrl: string,
  buffer: Buffer<ArrayBuffer>,
  plan: ChunkPlan,
): Promise<void> {
  for (const { start, end } of chunkRanges(plan)) {
    const chunk = buffer.subarray(start, end + 1)
    let lastDetail = ''
    let lastStatus = 0
    for (let attempt = 1; attempt <= CHUNK_RETRY_ATTEMPTS; attempt++) {
      const response = await fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${start}-${end}/${buffer.byteLength}`,
          'Content-Type': 'video/mp4',
        },
        body: new Blob([chunk]),
      })
      if (response.ok) {
        lastDetail = ''
        break
      }
      lastDetail = await response.text()
      lastStatus = response.status
      // 401/429 sont des signaux non ambigus sur ce point de terminaison
      // binaire, indépendants du corps (même raisonnement que `uploadToRupload`
      // côté Meta) : un jeton qui expire pendant un envoi long doit rester
      // classé comme jeton expiré, pas comme fichier refusé.
      if (response.status === 401) throw new TikTokTokenExpiredError(`TikTok a répondu 401 sur le morceau ${start}-${end} : ${lastDetail}`)
      if (response.status === 429) throw new TikTokRateLimitError(`TikTok a répondu 429 sur le morceau ${start}-${end} : ${lastDetail}`)
      // Un 5xx est transitoire (guide de transfert TikTok : rejouer le même
      // Content-Range) ; tout le reste est un refus définitif du morceau.
      if (response.status < 500) {
        throw new TikTokFileRefusedError(`TikTok a refusé le morceau ${start}-${end} : ${lastDetail}`)
      }
    }
    if (lastDetail !== '') {
      throw new TikTokFileRefusedError(
        `TikTok a refusé le morceau ${start}-${end} après ${CHUNK_RETRY_ATTEMPTS} tentatives (${lastStatus}) : ${lastDetail}`,
      )
    }
  }
}

/**
 * Le protocole spec §2.3 : dépôt en boîte de réception, jamais publication
 * directe. `submitted` est le seul état terminal possible ici — un dépôt
 * réussi n'est jamais `published`, il attend un geste dans l'app.
 */
async function publishTikTok(
  env: Environment,
  fetchImpl: typeof fetch,
  job: PublicationJob,
): Promise<PlatformOutcome> {
  const tokens = await ensureFreshTikTokToken(env, fetchImpl)
  const buffer = await fsp.readFile(job.videoPath)
  const plan = planChunks(buffer.byteLength)
  const { publish_id: publishId, upload_url: uploadUrl } = await initUpload(
    fetchImpl,
    tokens.accessToken,
    buffer.byteLength,
    plan,
  )
  await uploadChunks(fetchImpl, uploadUrl, buffer, plan)
  return { status: 'submitted', remoteId: publishId, remoteUrl: null }
}

/** Une seule plateforme possible (`tiktok`), même forme que `meta.ts` pour rester homogène. */
async function publish(
  env: Environment,
  fetchImpl: typeof fetch,
  job: PublicationJob,
  platforms: readonly Platform[],
): Promise<Record<Platform, PlatformOutcome>> {
  const outcomes = {} as Record<Platform, PlatformOutcome>
  await Promise.all(
    platforms.map(async (platform) => {
      try {
        outcomes[platform] = await publishTikTok(env, fetchImpl, job)
      } catch (error) {
        outcomes[platform] = { status: 'failed', error: messageSafe(error) }
      }
    }),
  )
  return outcomes
}

/** Jamais appelée en pratique : `publish` règle l'état terminal avant de rendre. */
async function poll(
  _requestId: string,
  platforms: readonly Platform[],
): Promise<Record<Platform, PlatformOutcome>> {
  const outcomes = {} as Record<Platform, PlatformOutcome>
  for (const platform of platforms) {
    outcomes[platform] = { status: 'failed', error: 'Le connecteur TikTok ne sonde jamais : publish() a déjà réglé l’état.' }
  }
  return outcomes
}

/**
 * `not_configured`, sans réseau, tant que la clé/secret d'app ou le jeton
 * appairé manquent — le seul cas que le critère d'acceptation borne. Une fois
 * les deux présents, un appel léger confirme que le jeton fonctionne encore.
 */
async function checkTikTok(env: Environment, fetchImpl: typeof fetch): Promise<PlatformAvailability> {
  try {
    const tokens = await ensureFreshTikTokToken(env, fetchImpl)
    const response = await fetchImpl(`${API_BASE}/user/info/?fields=open_id`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    })
    await requireOkTikTok(response)
    return { available: true }
  } catch {
    return { available: false, reason: 'unavailable' }
  }
}

async function availability(
  env: Environment,
  fetchImpl: typeof fetch,
): Promise<Record<Platform, PlatformAvailability>> {
  const result = defaultPlatformAvailability()
  // Une référence 1Password non résolue (`op://…`) répondrait `invalid_params`
  // chez TikTok et ressortirait en `unavailable` — vrai mais trompeur, la
  // cause est la résolution du démarrage défaite, pas une panne. Même
  // distinction que `checkFacebook` (`meta.ts`).
  const clientConfigured =
    env.TIKTOK_CLIENT_KEY !== undefined &&
    env.TIKTOK_CLIENT_KEY !== '' &&
    !isReference(env.TIKTOK_CLIENT_KEY) &&
    env.TIKTOK_CLIENT_SECRET !== undefined &&
    env.TIKTOK_CLIENT_SECRET !== '' &&
    !isReference(env.TIKTOK_CLIENT_SECRET)
  if (!clientConfigured) return result
  const tokens = await readTikTokTokens()
  if (tokens === null) return result
  result.tiktok = await checkTikTok(env, fetchImpl)
  return result
}

/** Construit le connecteur. `env` et `fetchImpl` capturés une fois, comme `createMetaAdapter`. */
export function createTikTokAdapter(
  env: Environment = process.env,
  fetchImpl: typeof fetch = fetch,
): PublicationAdapter {
  return {
    id: 'tiktok',
    platforms: ['tiktok'],
    availability: (checkedEnv) => availability(checkedEnv, fetchImpl),
    publish: (job, platforms) => publish(env, fetchImpl, job, platforms),
    poll,
  }
}
