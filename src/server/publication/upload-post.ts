import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  defaultPlatformAvailability,
  PLATFORMS,
  type Platform,
  type PlatformAvailability,
} from '@/core/publication'
import type { PlatformOutcome, PublicationAdapter, PublicationJob } from '@/server/publication/adapter'
import {
  UploadPostAccountMisconfiguredError,
  UploadPostFileRefusedError,
  UploadPostRateLimitError,
  UploadPostTokenExpiredError,
} from '@/server/publication/errors'
import type { Environment } from '@/server/secrets'

/**
 * Le connecteur Upload Post — un seul connecteur pour les quatre plateformes,
 * plutôt qu'un accès direct par plateforme (`docs/superpowers/specs/
 * 2026-08-18-publication-reseaux-design.md`, §3 et §5, corrigées le 23 août
 * 2026). Julien est abonné, la clé et le profil sont branchés : c'est le
 * transport qui existe aujourd'hui pour les quatre réseaux.
 *
 * **Instagram et Facebook passent par ici aussi**, faute d'un `meta.ts` direct
 * — non pas parce que Meta l'exigerait, mais parce que le lot 0 de la
 * conception générale (app Meta, Instagram Tester, Page rattachée) n'est pas
 * fait et qu'aucun code ne peut le remplacer. `meta.ts` reste un connecteur en
 * attente derrière `PublicationAdapter`, sans rien à changer côté route le
 * jour où il s'écrit.
 *
 * **YouTube : câblé, et volontairement pas garanti.** Le verrouillage en privé
 * d'une vidéo envoyée par un projet API non audité (spec §2.4) est une
 * propriété du **projet appelant**, pas de la plateforme — et le projet qui
 * appelle ici est celui d'Upload Post, déjà audité pour son propre compte,
 * pas un projet que ce dépôt aurait créé. Leur API expose
 * `privacyStatus: public|unlisted|private`, ce qu'un projet non audité ne
 * peut pas offrir : c'est la raison d'y croire. **Mais personne n'a encore
 * regardé sortir une vraie vidéo publique par ce chemin** — la vérification
 * manuelle du dev-publish est ce qui tranche, pas ce commentaire.
 *
 * **TikTok se dépose toujours en `MEDIA_UPLOAD`, jamais en `DIRECT_POST`.**
 * Leurs propres docs le recommandent pour l'organique, et c'est de toute
 * façon le seul mode dont le résultat n'est pas verrouillé en privé tant que
 * l'app appelante — celle d'Upload Post, ici encore — n'a pas son propre audit
 * TikTok. Un dépôt réussi est donc `submitted`, jamais `published` : la vidéo
 * attend un geste dans l'app, elle n'est pas en ligne.
 */

const BASE_URL = 'https://api.upload-post.com'

type UsageFigures = { count: number; limit: number }

type RawPlatformResult = {
  success: boolean
  url?: string | null
  post_id?: string | null
  error?: string
}

type RawUploadResponse = {
  request_id?: string
  results?: Record<string, RawPlatformResult>
  usage?: UsageFigures
}

function isUsage(value: unknown): value is UsageFigures {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { count?: unknown }).count === 'number' &&
    typeof (value as { limit?: unknown }).limit === 'number'
  )
}

/** Le message d'erreur qu'un corps de réponse porte, débarrassé de ce qui n'apprend rien. */
async function bodyDetail(
  response: Response,
): Promise<{ message: string; usage: UsageFigures | null; parsed: RawUploadResponse | null }> {
  const text = await response.text()
  try {
    const parsed = JSON.parse(text) as RawUploadResponse & { message?: unknown; error?: unknown }
    const usage = isUsage(parsed.usage) ? parsed.usage : null
    const message =
      typeof parsed.message === 'string'
        ? parsed.message
        : typeof parsed.error === 'string'
          ? parsed.error
          : text
    return { message, usage, parsed }
  } catch {
    return { message: text === '' ? response.statusText : text, usage: null, parsed: null }
  }
}

/**
 * Lève l'une des quatre erreurs nommées de la spec §8 sur les codes qui les
 * distinguent, ou une erreur générique pour tout le reste.
 */
async function requireOk(response: Response): Promise<RawUploadResponse> {
  const { message, usage, parsed } = await bodyDetail(response)
  if (response.status === 401) throw new UploadPostTokenExpiredError(message)
  if (response.status === 429) throw new UploadPostRateLimitError(usage)
  if (response.status === 422) throw new UploadPostFileRefusedError(message)
  if (response.status === 400) throw new UploadPostAccountMisconfiguredError(message)
  if (!response.ok) throw new Error(`Upload Post a répondu ${response.status} : ${message}`)
  if (parsed === null) throw new Error(`Upload Post a répondu un corps illisible : ${message}`)
  return parsed
}

function requiredEnv(env: Environment, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new UploadPostAccountMisconfiguredError(`${name} n'est pas définie.`)
  }
  return value
}

/**
 * `submitted`, jamais `published`, pour un dépôt TikTok réussi : c'est le
 * point qui compte de toute la spec (§2.4, §8) — un brouillon dans la boîte de
 * réception de l'app n'est pas en ligne. Les trois autres réussites sont
 * `published`, avec leur URL.
 */
function outcomeFor(platform: Platform, result: RawPlatformResult | undefined, requestId: string): PlatformOutcome {
  if (result === undefined) return { status: 'in_progress', requestId }
  if (!result.success) {
    return { status: 'failed', error: result.error ?? 'Échec sans message chez Upload Post.' }
  }
  const remoteId = result.post_id ?? null
  const remoteUrl = result.url ?? null
  if (platform === 'tiktok') return { status: 'submitted', remoteId, remoteUrl }
  return { status: 'published', remoteId, remoteUrl }
}

/** Les paramètres propres à chaque plateforme (table A.4 du contrat de cette PR). */
function applyPlatformParams(form: FormData, platform: Platform): void {
  switch (platform) {
    case 'instagram':
      form.append('media_type', 'REELS')
      form.append('share_to_feed', 'true')
      return
    case 'tiktok':
      form.append('post_mode', 'MEDIA_UPLOAD')
      return
    case 'youtube':
      form.append('privacyStatus', 'public')
      form.append('categoryId', '22')
      return
    case 'facebook':
      form.append('facebook_media_type', 'REELS')
      form.append('video_state', 'PUBLISHED')
      return
  }
}

async function publish(
  env: Environment,
  fetchImpl: typeof fetch,
  job: PublicationJob,
  platforms: readonly Platform[],
): Promise<Record<Platform, PlatformOutcome>> {
  const apiKey = requiredEnv(env, 'UPLOAD_POST_API_KEY')
  const user = requiredEnv(env, 'UPLOAD_POST_USER')

  const buffer = await fsp.readFile(job.videoPath)
  const form = new FormData()
  form.set('user', user)
  for (const platform of platforms) form.append('platform[]', platform)
  form.set('video', new Blob([buffer]), path.basename(job.videoPath))
  form.set('title', job.title)
  form.set('description', job.description)
  form.set('async_upload', 'true')
  for (const platform of platforms) applyPlatformParams(form, platform)

  // Une clé par (clip, jeu de plateformes, empreinte) : deux appels identiques
  // — un double-clic, une relance réseau — ne déposent pas deux fois. Les
  // plateformes sont triées : leur ordre d'arrivée dans `platforms` ne doit
  // pas changer la clé.
  const idempotencyKey = `${job.clipId}:${[...platforms].sort().join('+')}:${job.fingerprint}`

  const response = await fetchImpl(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Apikey ${apiKey}`, 'Idempotency-Key': idempotencyKey },
    body: form,
  })
  const raw = await requireOk(response)
  const requestId = raw.request_id ?? idempotencyKey

  const outcomes = {} as Record<Platform, PlatformOutcome>
  for (const platform of platforms) outcomes[platform] = outcomeFor(platform, raw.results?.[platform], requestId)
  return outcomes
}

async function poll(
  env: Environment,
  fetchImpl: typeof fetch,
  requestId: string,
  platforms: readonly Platform[],
): Promise<Record<Platform, PlatformOutcome>> {
  const apiKey = requiredEnv(env, 'UPLOAD_POST_API_KEY')
  const response = await fetchImpl(
    `${BASE_URL}/api/uploadposts/status?request_id=${encodeURIComponent(requestId)}`,
    { headers: { Authorization: `Apikey ${apiKey}` } },
  )
  const raw = await requireOk(response)

  const outcomes = {} as Record<Platform, PlatformOutcome>
  for (const platform of platforms) outcomes[platform] = outcomeFor(platform, raw.results?.[platform], requestId)
  return outcomes
}

type SocialAccounts = Record<string, unknown>

/** Une valeur de `social_accounts` compte comme connectée dès qu'elle porte quelque chose. */
function isConnected(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as object).length > 0
  return true
}

/** `null` : le profil n'a pas pu être relevé — clé invalide, réseau injoignable, réponse illisible. */
async function fetchSocialAccounts(
  fetchImpl: typeof fetch,
  apiKey: string,
  user: string,
): Promise<SocialAccounts | null> {
  let response: Response
  try {
    response = await fetchImpl(`${BASE_URL}/api/uploadposts/users`, {
      headers: { Authorization: `Apikey ${apiKey}` },
    })
  } catch {
    return null
  }
  if (!response.ok) return null
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return null
  }
  const profiles: unknown = Array.isArray(body) ? body : (body as { profiles?: unknown })?.profiles
  if (!Array.isArray(profiles)) return null
  const profile = profiles.find((p) => (p as { username?: unknown })?.username === user) as
    | { social_accounts?: unknown }
    | undefined
  if (profile === undefined) return null
  const accounts = profile.social_accounts
  return typeof accounts === 'object' && accounts !== null ? (accounts as SocialAccounts) : {}
}

function allPlatforms(entry: PlatformAvailability): Record<Platform, PlatformAvailability> {
  return { instagram: entry, facebook: entry, tiktok: entry, youtube: entry }
}

type CachedAvailability = {
  value: Record<Platform, PlatformAvailability>
  expire: number
  inFlight?: Promise<Record<Platform, PlatformAvailability>>
}

/**
 * Un relevé par (clé, profil), dans la forme du cache sidecar de `run.ts`
 * (`sidecars`, `src/server/run.ts:214`) : une entrée porte soit une valeur
 * encore valide, soit la sonde en vol qui la remplacera. Ce fichier ne peut pas
 * importer `run.ts`, tenu par la PR #143 — la forme est reprise, pas la table.
 */
const availabilityCache = new Map<string, CachedAvailability>()

/**
 * Assez court pour qu'un compte fraîchement connecté sur upload-post.com
 * apparaisse dans la minute, assez long pour qu'une page qui interroge
 * l'écran de publication plusieurs fois ne relance pas un aller-retour à
 * chaque fois.
 */
const TTL_AVAILABILITY_MS = 60_000

/** Vide le cache — pour les tests, qui changent d'environnement d'un cas à l'autre. */
export function forgetAvailabilityCache(): void {
  availabilityCache.clear()
}

async function probeAvailability(
  fetchImpl: typeof fetch,
  apiKey: string,
  user: string,
): Promise<Record<Platform, PlatformAvailability>> {
  const accounts = await fetchSocialAccounts(fetchImpl, apiKey, user)
  if (accounts === null) return allPlatforms({ available: false, reason: 'unavailable' })
  const result = {} as Record<Platform, PlatformAvailability>
  for (const platform of PLATFORMS) {
    result[platform] = isConnected(accounts[platform])
      ? { available: true }
      : { available: false, reason: 'not_configured' }
  }
  return result
}

async function availability(
  env: Environment,
  fetchImpl: typeof fetch,
): Promise<Record<Platform, PlatformAvailability>> {
  const apiKey = env.UPLOAD_POST_API_KEY
  const user = env.UPLOAD_POST_USER
  // Sans clé ni profil, rien à interroger : l'état honnête est celui du
  // dépôt avant tout connecteur, et aucun appel réseau n'a de raison de partir.
  if (apiKey === undefined || apiKey === '' || user === undefined || user === '') {
    return defaultPlatformAvailability()
  }

  const key = `${apiKey}\0${user}`
  const cached = availabilityCache.get(key)
  if (cached !== undefined) {
    if (cached.inFlight !== undefined) return cached.inFlight
    if (cached.expire > Date.now()) return cached.value
  }

  const work = probeAvailability(fetchImpl, apiKey, user).then((value) => {
    availabilityCache.set(key, { value, expire: Date.now() + TTL_AVAILABILITY_MS })
    return value
  })
  availabilityCache.set(key, {
    value: cached?.value ?? allPlatforms({ available: false, reason: 'unavailable' }),
    expire: 0,
    inFlight: work,
  })
  return work
}

/**
 * Construit le connecteur. `env` et `fetchImpl` sont capturés une fois — les
 * tests injectent un `fetch` qui ne touche jamais le réseau, comme
 * `resolveSecrets` injecte son lecteur (`src/server/secrets.ts`).
 */
export function createUploadPostAdapter(
  env: Environment = process.env,
  fetchImpl: typeof fetch = fetch,
): PublicationAdapter {
  return {
    platforms: PLATFORMS,
    availability: (checkedEnv) => availability(checkedEnv, fetchImpl),
    publish: (job, platforms) => publish(env, fetchImpl, job, platforms),
    poll: (requestId, platforms) => poll(env, fetchImpl, requestId, platforms),
  }
}
