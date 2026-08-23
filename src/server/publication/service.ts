import { createHash } from 'node:crypto'
import fs from 'node:fs'

import type Database from 'better-sqlite3'

import type { Clip } from '@/core/edl'
import { clipDuration } from '@/core/edl'
import {
  canTargetPlatform,
  clipEligibilityFromStatus,
  platformEligibility,
  platformFile,
  platformTexts,
  type Platform,
  type PublicationRecord,
} from '@/core/publication'
import { RENDER_NATIVE } from '@/core/render-flags'
import { getPublications, upsertPublication, type PublicationRow } from '@/server/db'
import { isAAbsence } from '@/server/bytes'
import { clipFraming } from '@/server/clip-framing'
import { messageSafe } from '@/server/errors'
import { requestInvalid } from '@/server/http'
import { wait } from '@/server/llm/retry'
import type { PlatformOutcome, PublicationAdapter, PublicationJob } from '@/server/publication/adapter'
import { PublicationAlreadyPublishedError } from '@/server/publication/errors'
import { reserve, release } from '@/server/publication/registry'
import { deliveryToDay } from '@/server/renders'
import { pathsRender } from '@/server/steps/render'

/**
 * L'orchestration de `POST /api/clips/:id/publish` : ce que la route délègue
 * pour rester lisible, et ce que les tests appellent sans passer par un
 * `Request` Next.js.
 *
 * **Séquence** (spec §6.4) : valider en pur, réserver, poser les lignes
 * `in_progress` et rendre — tout cela sans un seul `await`, comme `launch()`
 * dans `run.ts` — puis lancer l'envoi **détaché** : le résultat s'écrit dans
 * `publications` quand il arrive, la requête HTTP n'attend pas dessus.
 */

function toRecord(row: PublicationRow | undefined): PublicationRecord | undefined {
  if (row === undefined) return undefined
  return { status: row.status, remoteUrl: row.remoteUrl, publishedFingerprint: row.publishedFingerprint }
}

/**
 * L'empreinte du rendu actuel, ou `null` — absente et illisible se confondent,
 * comme `lireFingerprint` (`src/server/steps/render.ts`) : les deux disent
 * « rien ne certifie ce que le fichier décrit ».
 */
function currentFingerprint(fingerprintPath: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(fingerprintPath)).digest('hex')
  } catch (error) {
    if (isAAbsence(error)) return null
    throw error
  }
}

/**
 * La plateforme dont `platformTexts` fournit les textes du job.
 *
 * **Limite connue et documentée** : une requête Upload Post porte un seul
 * `title`/`description` pour toutes les plateformes visées (spec publication,
 * table A.4 du contrat de cette PR) — YouTube en a besoin sous une forme
 * différente des trois autres (titre et description séparés, contre une
 * légende unique). Mélanger YouTube et une autre plateforme dans le même
 * lancement fait donc gagner la forme YouTube pour toutes. Aujourd'hui le
 * compte Upload Post ne connecte que YouTube (aucune bascule Instagram/
 * Facebook/TikTok possible), donc le cas ne se présente pas encore ; le jour
 * où il se présentera, la solution est de scinder le lancement en deux appels
 * — un job par forme de texte —, pas de complexifier `PublicationJob`.
 */
function representativePlatform(platforms: readonly Platform[]): Platform {
  return platforms.includes('youtube') ? 'youtube' : (platforms[0] as Platform)
}

function upsertFrom(previous: PublicationRow | undefined, patch: Partial<PublicationRow> & { clipId: string; platform: Platform }): PublicationRow {
  const now = Date.now()
  return {
    clipId: patch.clipId,
    platform: patch.platform,
    status: patch.status ?? previous?.status ?? 'in_progress',
    remoteId: patch.remoteId !== undefined ? patch.remoteId : (previous?.remoteId ?? null),
    remoteUrl: patch.remoteUrl !== undefined ? patch.remoteUrl : (previous?.remoteUrl ?? null),
    requestId: patch.requestId !== undefined ? patch.requestId : (previous?.requestId ?? null),
    error: patch.error !== undefined ? patch.error : null,
    publishedFingerprint:
      patch.publishedFingerprint !== undefined ? patch.publishedFingerprint : (previous?.publishedFingerprint ?? null),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
}

function applyOutcomes(
  db: Database.Database,
  clipId: string,
  platforms: readonly Platform[],
  outcomes: Record<Platform, PlatformOutcome>,
  fingerprint: string | null,
): void {
  const existing = getPublications(db, clipId)
  for (const platform of platforms) {
    const previous = existing.find((r) => r.platform === platform)
    const outcome = outcomes[platform]
    if (outcome.status === 'in_progress') {
      upsertPublication(db, upsertFrom(previous, { clipId, platform, status: 'in_progress', requestId: outcome.requestId }))
    } else if (outcome.status === 'failed') {
      upsertPublication(db, upsertFrom(previous, { clipId, platform, status: 'failed', error: outcome.error }))
    } else {
      upsertPublication(
        db,
        upsertFrom(previous, {
          clipId,
          platform,
          status: outcome.status,
          remoteId: outcome.remoteId,
          remoteUrl: outcome.remoteUrl,
          // L'empreinte n'est posée qu'à `published` : un dépôt TikTok
          // `submitted` n'est pas en ligne, il ne certifie donc rien.
          publishedFingerprint: outcome.status === 'published' ? fingerprint : (previous?.publishedFingerprint ?? null),
        }),
      )
    }
  }
}

/**
 * Combien de fois sonder un envoi resté `in_progress` avant d'abandonner, et à
 * quel intervalle — `async_upload=true` est de règle (voir `upload-post.ts`),
 * donc la réponse immédiate de `/api/upload` ne porte le plus souvent qu'un
 * `request_id` : sans ce sondage, la ligne reste `in_progress` pour toujours,
 * nul ne la relit jamais (aucun autre appelant de `adapter.poll` dans le
 * dépôt).
 */
const SETTLE_ATTEMPTS = 5
const SETTLE_INTERVAL_MS = 3_000

/**
 * Relit les plateformes encore `in_progress` jusqu'à un état terminal, ou
 * jusqu'à épuiser `SETTLE_ATTEMPTS`. Groupe par `requestId` : un envoi porte
 * en général un seul identifiant partagé par toutes ses plateformes, mais
 * rien ne l'impose.
 */
async function settleAsync(
  adapter: PublicationAdapter,
  platforms: readonly Platform[],
  outcomes: Record<Platform, PlatformOutcome>,
  sleep: (ms: number) => Promise<void>,
): Promise<Record<Platform, PlatformOutcome>> {
  let current = outcomes
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    const pending = platforms.filter((platform) => current[platform].status === 'in_progress')
    if (pending.length === 0) return current

    await sleep(SETTLE_INTERVAL_MS)

    const byRequestId = new Map<string, Platform[]>()
    for (const platform of pending) {
      const outcome = current[platform]
      if (outcome.status !== 'in_progress') continue
      const group = byRequestId.get(outcome.requestId) ?? []
      group.push(platform)
      byRequestId.set(outcome.requestId, group)
    }

    const next = { ...current }
    for (const [requestId, group] of byRequestId) {
      const polled = await adapter.poll(requestId, group)
      for (const platform of group) next[platform] = polled[platform]
    }
    current = next
  }
  return current
}

async function runDetached(
  db: Database.Database,
  adapter: PublicationAdapter,
  clip: Clip,
  platforms: readonly Platform[],
  job: PublicationJob,
  fingerprint: string | null,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  try {
    const published = await adapter.publish(job, platforms)
    const outcomes = await settleAsync(adapter, platforms, published, sleep)
    applyOutcomes(db, clip.id, platforms, outcomes, fingerprint)
  } catch (error) {
    const message = messageSafe(error)
    const existing = getPublications(db, clip.id)
    for (const platform of platforms) {
      const previous = existing.find((r) => r.platform === platform)
      upsertPublication(db, upsertFrom(previous, { clipId: clip.id, platform, status: 'failed', error: message }))
    }
  } finally {
    release(clip.id, platforms)
  }
}

export type LaunchPublishInput = {
  db: Database.Database
  adapter: PublicationAdapter
  clip: Clip
  platforms: readonly Platform[]
  force: boolean
  /** Le délai entre deux sondages d'un envoi resté `in_progress` — les tests y passent un délai nul. */
  sleep?: (ms: number) => Promise<void>
}

export type LaunchPublishResult = {
  /** Les lignes `in_progress` qui viennent d'être posées — la réponse immédiate de la route. */
  rows: PublicationRow[]
  /** Résolue quand l'envoi détaché a fini d'écrire son résultat. La route ne l'attend jamais ; les tests, si. */
  settled: Promise<void>
}

/**
 * Lance une publication et rend l'état des lignes créées **avant** que
 * l'envoi n'ait commencé à progresser (spec §6.4).
 *
 * Toute la validation est synchrone — pas un seul `await` avant `reserve` —,
 * ce qui ferme la même course que `launch()` dans `run.ts` : deux requêtes
 * simultanées ne peuvent pas lire « libre » toutes les deux avant que l'une
 * n'ait posé sa réservation.
 */
export function launchPublish(input: LaunchPublishInput): LaunchPublishResult {
  const { db, adapter, clip, platforms, force, sleep = wait } = input

  const exportEligibility = clipEligibilityFromStatus(clip.status)
  if (!exportEligibility.eligible) throw requestInvalid(exportEligibility.reason)

  const framing = clipFraming(clip)
  if (!deliveryToDay(clip, framing)) {
    throw requestInvalid('Le rendu de ce clip est périmé ou absent : exporter avant de publier.')
  }

  const paths = pathsRender(clip.projectId, clip.id, framing.ratio, RENDER_NATIVE)
  const videoPath = platformFile({ mp4: paths.mp4, variant9x16: paths.variant9x16 })
  if (videoPath === null) throw requestInvalid('Aucun fichier à envoyer : exporter avant de publier.')

  let stat: fs.Stats
  try {
    stat = fs.statSync(videoPath)
  } catch (error) {
    // `pathsRender` dit ce que le rendu *devrait* produire, pas ce qui existe
    // encore : un MP4 supprimé après coup laisse `deliveryToDay` valider sur
    // l'empreinte seule (`src/server/renders.ts`). Une absence de fichier est
    // le même refus 400 que « exporter avant de publier », pas un défaut du
    // serveur ; toute autre erreur d'E/S remonte telle quelle.
    if (isAAbsence(error)) throw requestInvalid('Aucun fichier à envoyer : exporter avant de publier.')
    throw error
  }
  const eligibility = platformEligibility(clipDuration(clip.segments), stat.size)
  if (!eligibility.eligible) throw requestInvalid(eligibility.reason)

  const fingerprint = currentFingerprint(paths.fingerprint)
  if (fingerprint === null) {
    throw new Error(`Empreinte introuvable pour ${clip.id} alors que le rendu semblait à jour.`)
  }

  const existing = getPublications(db, clip.id)
  const byPlatform = new Map(existing.map((r) => [r.platform, r]))
  for (const platform of platforms) {
    if (!canTargetPlatform(toRecord(byPlatform.get(platform)), force)) {
      throw new PublicationAlreadyPublishedError(platform)
    }
  }

  // Rien d'asynchrone au-dessus de cette ligne : voir le docbloc du module.
  reserve(clip.id, platforms)

  for (const platform of platforms) {
    upsertPublication(db, upsertFrom(byPlatform.get(platform), { clipId: clip.id, platform, status: 'in_progress' }))
  }
  const rows = getPublications(db, clip.id).filter((r) => platforms.includes(r.platform))

  const texts = platformTexts(clip, representativePlatform(platforms))
  const job: PublicationJob = { clipId: clip.id, videoPath, fingerprint, force, ...texts }
  const settled = runDetached(db, adapter, clip, platforms, job, fingerprint, sleep)
  settled.catch(() => {
    // Les échecs sont déjà écrits dans `publications` par `runDetached` ; ce
    // `catch` n'existe que pour qu'une promesse dont personne n'attend le
    // résultat ne fasse pas remonter un rejet non géré.
  })

  return { rows, settled }
}
