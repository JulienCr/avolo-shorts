import fsp from 'node:fs/promises'

import { defaultPlatformAvailability, type Platform, type PlatformAvailability } from '@/core/publication'
import type { PlatformOutcome, PublicationAdapter, PublicationJob } from '@/server/publication/adapter'
import {
  MetaAccountMisconfiguredError,
  MetaAssetPermissionError,
  MetaContainerTimeoutError,
  MetaFileRefusedError,
  MetaRateLimitError,
  MetaTokenExpiredError,
} from '@/server/publication/errors'
import {
  ensureFreshInstagramToken,
  GRAPH_BASE,
  readMetaTokens,
  type MetaTokenFile,
} from '@/server/publication/meta-tokens'
import { isReference, type Environment } from '@/server/secrets'
import { wait } from '@/server/llm/retry'
import { messageSafe } from '@/server/errors'

/**
 * Le connecteur Meta direct — Instagram Reels et Facebook Page Reels par
 * l'API Graph, sans passer par Upload Post (issue #146) : un appel par
 * plateforme, un échec sur l'une n'annule jamais la réussite de l'autre.
 *
 * Chemin Facebook Login exclusivement (pas Instagram Login) — voir
 * `docs/lessons.md`, « Ce que Meta ne dit pas quand on publie un reel ».
 *
 * **Facebook Page Reels vérifié pour de vrai le 23 août 2026** (issue #146,
 * vidéo `1078358324628287`) : dépôt, appairage et lien public confirmés.
 * Testé partout ailleurs contre un `fetch` injecté.
 */

const UPLOAD_BASE = 'https://rupload.facebook.com'

/** `rupload.facebook.com` rend des 400 transitoires — mesuré, pas supposé (issue #146). */
const UPLOAD_RETRY_ATTEMPTS = 3

const CONTAINER_POLL_ATTEMPTS = 30
const CONTAINER_POLL_INTERVAL_MS = 2_000

type GraphError = { message?: string; code?: number; error_subcode?: number }
type GraphErrorBody = { error?: GraphError }

/**
 * Traduit un code Graph API en l'une des erreurs nommées de la spec §8,
 * plutôt que de laisser passer le message de Meta tel quel — voir
 * `MetaAssetPermissionError` pour le cas qui compte le plus.
 */
async function requireOkMeta<T>(response: Response): Promise<T> {
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!response.ok) {
    const error = (parsed as GraphErrorBody | null)?.error
    const message = error?.message ?? (text === '' ? response.statusText : text)
    if (error?.error_subcode === 2207085) throw new MetaAssetPermissionError(message)
    if (error?.code === 190) throw new MetaTokenExpiredError(message)
    if (error?.code === 4 || error?.code === 17 || error?.code === 32 || error?.code === 613) {
      throw new MetaRateLimitError(message)
    }
    if (response.status === 400) throw new MetaAccountMisconfiguredError(message)
    throw new Error(`Meta a répondu ${response.status} : ${message}`)
  }
  if (parsed === null) throw new Error('Meta a répondu un corps illisible.')
  return parsed as T
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

/**
 * Téléverse un tampon vers `rupload.facebook.com`, en réessayant sur un
 * échec HTTP plutôt que d'abandonner à la première — un même fichier, sur le
 * même conteneur, avec les mêmes en-têtes, a échoué puis réussi à la reprise
 * (issue #146). Pas de délai entre tentatives : le 400 mesuré était
 * transitoire à l'échelle de l'appel suivant, pas d'un quota.
 */
async function uploadToRupload(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  // `Buffer<ArrayBuffer>`, pas le `Buffer<ArrayBufferLike>` par défaut du type
  // nu : c'est ce que `fsp.readFile` rend réellement, et le type large ne
  // satisfait plus `BlobPart` depuis la dernière mise à jour d'`@types/node`.
  buffer: Buffer<ArrayBuffer>,
): Promise<void> {
  let lastDetail = ''
  for (let attempt = 1; attempt <= UPLOAD_RETRY_ATTEMPTS; attempt++) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${token}`,
        offset: '0',
        file_size: String(buffer.byteLength),
      },
      body: new Blob([buffer]),
    })
    if (response.ok) return
    lastDetail = await response.text()
    // `401`/`429` sont des signaux non ambigus, indépendants du corps (jamais
    // observé au format Graph JSON sur `rupload`, contrairement au 400
    // transitoire mesuré — issue #146) : les réessayer immédiatement épuiserait
    // un débit déjà atteint au lieu de le signaler.
    if (response.status === 401) throw new MetaTokenExpiredError(`rupload a répondu 401 : ${lastDetail}`)
    if (response.status === 429) throw new MetaRateLimitError(`rupload a répondu 429 : ${lastDetail}`)
  }
  throw new MetaFileRefusedError(
    `rupload a refusé le fichier après ${UPLOAD_RETRY_ATTEMPTS} tentatives : ${lastDetail}`,
  )
}

async function waitForContainerFinished(
  fetchImpl: typeof fetch,
  token: string,
  containerId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < CONTAINER_POLL_ATTEMPTS; attempt++) {
    const response = await fetchImpl(
      `${GRAPH_BASE}/${containerId}?fields=status_code&access_token=${encodeURIComponent(token)}`,
    )
    const body = await requireOkMeta<{ status_code?: string }>(response)
    if (body.status_code === 'FINISHED') return
    if (body.status_code === 'ERROR' || body.status_code === 'EXPIRED') {
      throw new MetaFileRefusedError(`Le conteneur Instagram a échoué (status_code=${body.status_code}).`)
    }
    await sleep(CONTAINER_POLL_INTERVAL_MS)
  }
  throw new MetaContainerTimeoutError(containerId)
}

/**
 * Le protocole mesuré le 23 août 2026 (issue #146), publié pour de vrai sur
 * `@cie.avolo` : dépôt du conteneur, téléversement binaire, sondage jusqu'à
 * `FINISHED`, puis publication. Ne rend jamais `in_progress` : tout se règle
 * avant que la promesse ne se résolve.
 */
async function publishInstagram(
  env: Environment,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  job: PublicationJob,
): Promise<PlatformOutcome> {
  const tokens = await ensureFreshInstagramToken(env, fetchImpl)

  const createResponse = await fetchImpl(`${GRAPH_BASE}/${tokens.instagramUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      media_type: 'REELS',
      upload_type: 'resumable',
      caption: job.description,
      share_to_feed: 'true',
      access_token: tokens.instagramAccessToken,
    }),
  })
  const { id: containerId } = await requireOkMeta<{ id: string }>(createResponse)

  const buffer = await fsp.readFile(job.videoPath)
  await uploadToRupload(
    fetchImpl,
    `${UPLOAD_BASE}/ig-api-upload/v23.0/${containerId}`,
    tokens.instagramAccessToken,
    buffer,
  )

  await waitForContainerFinished(fetchImpl, tokens.instagramAccessToken, containerId, sleep)

  const publishResponse = await fetchImpl(`${GRAPH_BASE}/${tokens.instagramUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: containerId, access_token: tokens.instagramAccessToken }),
  })
  const { id: mediaId } = await requireOkMeta<{ id: string }>(publishResponse)

  // `media_publish` rend l'identifiant du média, pas le shortcode de son URL
  // publique (`DcY8KVBCml7` sur le reel réellement publié le 23 août 2026,
  // sans rapport visible avec l'identifiant numérique) : `permalink` est le
  // champ qui porte la vraie adresse. À ce stade le reel est déjà en ligne :
  // une erreur transitoire sur cette lecture auxiliaire ne doit pas renvoyer
  // `failed` (une relance republierait un doublon), donc `remoteUrl: null`
  // plutôt qu'une exception qui remonte au `catch` de `publish()`.
  let permalink: string | null = null
  try {
    const permalinkResponse = await fetchImpl(
      `${GRAPH_BASE}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(tokens.instagramAccessToken)}`,
    )
    permalink = (await requireOkMeta<{ permalink: string }>(permalinkResponse)).permalink
  } catch {
    // Le contrat `PublicationAdapter` autorise `remoteUrl: null` sur `published`.
  }
  return { status: 'published', remoteId: mediaId, remoteUrl: permalink }
}

/**
 * `finish` confirme seulement que la publication a été lancée, pas que le
 * reel est en ligne (trouvaille de revue sur cette PR) : l'exemple officiel
 * Meta sonde ensuite `/{videoId}?fields=status` et n'annonce la réussite
 * qu'une fois `publishing_phase.status === 'complete'`. Même forme que
 * `waitForContainerFinished` côté Instagram.
 */
/** Les erreurs Meta nommées, dont le sens est déjà tranché : jamais transitoires. */
function isMetaTerminalError(error: unknown): boolean {
  return (
    error instanceof MetaAssetPermissionError ||
    error instanceof MetaTokenExpiredError ||
    error instanceof MetaRateLimitError ||
    error instanceof MetaAccountMisconfiguredError
  )
}

async function waitForFacebookPublished(
  fetchImpl: typeof fetch,
  pageToken: string,
  videoId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < CONTAINER_POLL_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(
        `${GRAPH_BASE}/${videoId}?fields=status&access_token=${encodeURIComponent(pageToken)}`,
      )
      const body = await requireOkMeta<{ status?: { publishing_phase?: { status?: string } } }>(response)
      const phase = body.status?.publishing_phase?.status
      if (phase === 'complete') return
      if (phase === 'error') {
        throw new MetaFileRefusedError(`Le traitement du reel Facebook ${videoId} a échoué (publishing_phase.status=error).`)
      }
    } catch (error) {
      // Un état distant inconnu (glitch réseau, 5xx isolé) ne doit pas se
      // traduire en `failed` : `finish` a déjà réussi, et une relance sur un
      // `failed` prématuré republierait un doublon (trouvaille de revue sur
      // cette PR). Seules les erreurs nommées ci-dessus, et `error` explicite
      // sur `publishing_phase`, concluent avant le budget de sondage.
      if (error instanceof MetaFileRefusedError || isMetaTerminalError(error)) throw error
    }
    await sleep(CONTAINER_POLL_INTERVAL_MS)
  }
  throw new MetaFileRefusedError(
    `Le reel Facebook ${videoId} n'a pas atteint publishing_phase.status=complete avant l'abandon du sondage.`,
  )
}

/**
 * Spec §2.2, vérifié contre le réseau (voir le docbloc du fichier) : trois
 * phases sur `/{page-id}/video_reels`, binaire vers `rupload` comme pour
 * Instagram. `video_state=PUBLISHED` publie directement, sans brouillon.
 */
async function publishFacebook(
  env: Environment,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  job: PublicationJob,
): Promise<PlatformOutcome> {
  const pageId = requiredEnv(env, 'META_PAGE_ID')
  const pageToken = requiredEnv(env, 'META_PAGE_TOKEN')

  const startResponse = await fetchImpl(`${GRAPH_BASE}/${pageId}/video_reels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ upload_phase: 'start', access_token: pageToken }),
  })
  const { video_id: videoId } = await requireOkMeta<{ video_id: string }>(startResponse)

  const buffer = await fsp.readFile(job.videoPath)
  await uploadToRupload(fetchImpl, `${UPLOAD_BASE}/video-upload/v23.0/${videoId}`, pageToken, buffer)

  const finishResponse = await fetchImpl(`${GRAPH_BASE}/${pageId}/video_reels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      upload_phase: 'finish',
      video_id: videoId,
      video_state: 'PUBLISHED',
      description: job.description,
      access_token: pageToken,
    }),
  })
  await requireOkMeta<{ success?: boolean }>(finishResponse)
  await waitForFacebookPublished(fetchImpl, pageToken, videoId, sleep)

  // Best-effort, même raisonnement qu'`publishInstagram` : le reel est déjà
  // en ligne une fois le sondage `waitForFacebookPublished` réglé sur
  // `complete` (`finish` ne fait que lancer la publication), une erreur
  // transitoire ici ne doit jamais retomber en `failed` (issue #146,
  // trouvaille de revue PR #148).
  let remoteUrl: string | null = null
  try {
    const permalinkResponse = await fetchImpl(
      `${GRAPH_BASE}/${videoId}?fields=permalink_url&access_token=${encodeURIComponent(pageToken)}`,
    )
    const { permalink_url: permalinkUrl } = await requireOkMeta<{ permalink_url?: string }>(permalinkResponse)
    if (typeof permalinkUrl === 'string' && permalinkUrl !== '') {
      remoteUrl = new URL(permalinkUrl, 'https://www.facebook.com').toString()
    }
  } catch {
    // Le contrat `PublicationAdapter` autorise `remoteUrl: null` sur `published`.
  }
  return { status: 'published', remoteId: videoId, remoteUrl }
}

/**
 * Un appel par plateforme, jamais groupé. **Un échec Facebook ne doit pas
 * annuler une réussite Instagram** (spec §6.4) : chaque séquence est
 * capturée séparément plutôt que de laisser une exception traverser
 * `Promise.all`, ce qui ferait échouer les deux platform outcomes à la fois
 * côté `service.ts`.
 */
async function publish(
  env: Environment,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  job: PublicationJob,
  platforms: readonly Platform[],
): Promise<Record<Platform, PlatformOutcome>> {
  const outcomes = {} as Record<Platform, PlatformOutcome>
  await Promise.all(
    platforms.map(async (platform) => {
      try {
        outcomes[platform] =
          platform === 'instagram'
            ? await publishInstagram(env, fetchImpl, sleep, job)
            : await publishFacebook(env, fetchImpl, sleep, job)
      } catch (error) {
        outcomes[platform] = { status: 'failed', error: messageSafe(error) }
      }
    }),
  )
  return outcomes
}

/**
 * Jamais appelée en pratique : `publish` ci-dessus règle chaque plateforme
 * jusqu'à un état terminal avant de rendre, donc `service.ts` ne voit jamais
 * `in_progress` pour Meta. Gardée pour respecter `PublicationAdapter`.
 */
async function poll(
  _requestId: string,
  platforms: readonly Platform[],
): Promise<Record<Platform, PlatformOutcome>> {
  const outcomes = {} as Record<Platform, PlatformOutcome>
  for (const platform of platforms) {
    outcomes[platform] = { status: 'failed', error: 'Le connecteur Meta ne sonde jamais : publish() a déjà réglé l’état.' }
  }
  return outcomes
}

async function checkInstagram(env: Environment, fetchImpl: typeof fetch): Promise<PlatformAvailability> {
  let tokens: MetaTokenFile
  try {
    tokens = await ensureFreshInstagramToken(env, fetchImpl)
  } catch {
    return { available: false, reason: 'unavailable' }
  }
  try {
    const response = await fetchImpl(
      `${GRAPH_BASE}/${tokens.instagramUserId}?fields=id&access_token=${encodeURIComponent(tokens.instagramAccessToken)}`,
    )
    await requireOkMeta(response)
    return { available: true }
  } catch {
    return { available: false, reason: 'unavailable' }
  }
}

async function checkFacebook(env: Environment, fetchImpl: typeof fetch): Promise<PlatformAvailability> {
  const pageId = env.META_PAGE_ID
  const pageToken = env.META_PAGE_TOKEN
  if (pageId === undefined || pageId === '' || pageToken === undefined || pageToken === '') {
    return { available: false, reason: 'not_configured' }
  }
  // Un `op://…` encore non résolu répondrait 400 chez Meta et ressortirait en
  // `unavailable` — vrai mais trompeur, la cause est la résolution du
  // démarrage défaite, pas une panne. `not_configured` la nomme mieux.
  if (isReference(pageToken)) return { available: false, reason: 'not_configured' }
  try {
    const response = await fetchImpl(`${GRAPH_BASE}/${pageId}?fields=id&access_token=${encodeURIComponent(pageToken)}`)
    await requireOkMeta(response)
    return { available: true }
  } catch {
    return { available: false, reason: 'unavailable' }
  }
}

// Un `op://…` non résolu compte comme non configuré, même raisonnement que
// `checkFacebook` : autrement l'appel Meta échouerait en 400, lu à tort
// comme une panne réseau plutôt qu'une résolution de démarrage défaite.
function isMetaAppConfigured(env: Environment): boolean {
  return (
    env.META_APP_ID !== undefined &&
    env.META_APP_ID !== '' &&
    !isReference(env.META_APP_ID) &&
    env.META_APP_SECRET !== undefined &&
    env.META_APP_SECRET !== '' &&
    !isReference(env.META_APP_SECRET)
  )
}

/**
 * `not_configured` sans réseau quand rien n'est branché (spec `adapter.ts`) :
 * pas de jeton persisté pour Instagram, pas de `META_PAGE_ID`/`META_PAGE_TOKEN`
 * pour Facebook. `META_APP_ID`/`META_APP_SECRET` sont aussi la condition
 * d'appairage : présents sans jeton persisté, l'appairage seul manque
 * (`not_paired`) — un jeton système (system-user) n'en a pas besoin pour
 * fonctionner une fois posé, mais reste posé par `dev-connect-meta.ts` avec
 * l'app déjà déclarée (`meta-tokens.ts`).
 */
async function availability(
  env: Environment,
  fetchImpl: typeof fetch,
): Promise<Record<Platform, PlatformAvailability>> {
  const result = defaultPlatformAvailability()

  const tokens = await readMetaTokens()
  const appConfigured = isMetaAppConfigured(env)
  // Un jeton système (expiry `null`) se vérifie sans identifiants d'app ; un
  // jeton rafraîchissable en a besoin, et leur absence est `not_configured`,
  // pas `unavailable` — sinon un serveur mal configuré se lit comme une panne
  // réseau transitoire.
  if (tokens !== null) {
    result.instagram =
      tokens.instagramTokenExpiresAt !== null && !appConfigured
        ? { available: false, reason: 'not_configured' }
        : await checkInstagram(env, fetchImpl)
  } else if (appConfigured) {
    result.instagram = { available: false, reason: 'not_paired' }
  }

  if (env.META_PAGE_ID !== undefined && env.META_PAGE_ID !== '') {
    result.facebook = await checkFacebook(env, fetchImpl)
  }

  return result
}

/**
 * Construit le connecteur. `env` et `fetchImpl` capturés une fois, comme
 * `createUploadPostAdapter` — les tests injectent un `fetch` qui ne touche
 * jamais le réseau.
 */
export function createMetaAdapter(
  env: Environment = process.env,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = wait,
): PublicationAdapter {
  return {
    id: 'meta',
    platforms: ['instagram', 'facebook'],
    availability: (checkedEnv) => availability(checkedEnv, fetchImpl),
    publish: (job, platforms) => publish(env, fetchImpl, sleep, job, platforms),
    poll,
  }
}
