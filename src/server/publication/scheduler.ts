import fs from 'node:fs'
import path from 'node:path'

import type Database from 'better-sqlite3'

import { PLATFORMS, type Platform, type PublicationStatus } from '@/core/publication'
import { getClip, getPublications, nextDueSchedule, upsertPublication } from '@/server/db'
import { messageSafe } from '@/server/errors'
import { launchPublish } from '@/server/publication/service'
import type { Mailer } from '@/server/publication/mailer'

/**
 * L'ordonnanceur (spec §5.4-§5.5) : une passe prend l'échéance due la plus
 * ancienne, publie ses quatre plateformes en série, réessaie jusqu'à trois
 * fois, et alerte par courriel sur abandon. Le script (`scripts/publish-
 * scheduled.ts`) n'est qu'un habillage CLI autour de `runOnePass` — toute la
 * décision vit ici, testable sans réseau, sans horloge et sans boîte mail.
 */
export type SchedulerDeps = {
  db: Database.Database
  now: () => number
  sleep: (ms: number) => Promise<void>
  sendMail: Mailer
  lockDir: string
}

export type DueSummary = { clipId: string; title: string; scheduledAt: number; platforms: readonly Platform[] }

export type SchedulerOutcome =
  | { kind: 'idle' }
  | { kind: 'locked'; since: number }
  | { kind: 'dry-run'; due: DueSummary | null }
  | { kind: 'done'; clipId: string; attempts: number; statuses: Record<Platform, PublicationStatus> }
  | { kind: 'abandoned'; clipId: string; attempts: number; statuses: Record<Platform, PublicationStatus> }

const ATTEMPTS = 3
const STALE_LOCK_MS = 30 * 60 * 1000
const LOCK_FILENAME = '.publish-scheduled.lock'

type LockPayload = { pid: number; since: number }

function lockPath(lockDir: string): string {
  return path.join(lockDir, LOCK_FILENAME)
}

/**
 * Prise atomique (`wx` : échoue si le fichier existe déjà), donc deux passes
 * concurrentes ne peuvent pas croire toutes les deux l'avoir posée. Un verrou
 * de plus de trente minutes est repris — un verrou périmé qui bloque tout en
 * silence est exactement l'échec que `CLAUDE.md` proscrit.
 */
function acquireLock(lockDir: string, now: number): { acquired: true } | { acquired: false; since: number } {
  const file = lockPath(lockDir)
  const payload: LockPayload = { pid: process.pid, since: now }
  try {
    const fd = fs.openSync(file, 'wx')
    fs.writeSync(fd, JSON.stringify(payload))
    fs.closeSync(fd)
    return { acquired: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = readLock(file)
    const since = existing?.since ?? now
    if (now - since < STALE_LOCK_MS) return { acquired: false, since }
    console.warn(`Verrou de publication périmé (posé il y a plus de 30 min, pid ${existing?.pid ?? '?'}) : repris.`)
    fs.writeFileSync(file, JSON.stringify(payload))
    return { acquired: true }
  }
}

function readLock(file: string): LockPayload | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as LockPayload
  } catch {
    return null
  }
}

function releaseLock(lockDir: string): void {
  fs.rmSync(lockPath(lockDir), { force: true })
}

/** Les plateformes qui n'ont ni réussi ni été déposées — ce qu'un essai doit encore cibler. */
function outstandingPlatforms(db: Database.Database, clipId: string): Platform[] {
  const byPlatform = new Map(getPublications(db, clipId).map((r) => [r.platform, r.status]))
  return PLATFORMS.filter((p) => {
    const status = byPlatform.get(p)
    return status !== 'published' && status !== 'submitted'
  })
}

/**
 * `launchPublish` peut lever avant d'écrire quoi que ce soit — fichier
 * disparu, titre YouTube manquant : un échec permanent, pas un aléa réseau
 * (déjà écrit `failed` par `service.ts` lui-même). Sans ceci, la ligne
 * resterait `planned` et `nextDueSchedule` la reprendrait indéfiniment.
 */
function markFailed(db: Database.Database, clipId: string, platforms: readonly Platform[], message: string): void {
  const existing = new Map(getPublications(db, clipId).map((r) => [r.platform, r]))
  const now = Date.now()
  for (const platform of platforms) {
    const previous = existing.get(platform)
    upsertPublication(db, {
      clipId,
      platform,
      status: 'failed',
      remoteId: previous?.remoteId ?? null,
      remoteUrl: previous?.remoteUrl ?? null,
      requestId: previous?.requestId ?? null,
      error: message,
      publishedFingerprint: previous?.publishedFingerprint ?? null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      scheduledAt: previous?.scheduledAt ?? null,
    })
  }
}

function statusesFor(db: Database.Database, clipId: string): Record<Platform, PublicationStatus> {
  const byPlatform = new Map(getPublications(db, clipId).map((r) => [r.platform, r.status]))
  const result = {} as Record<Platform, PublicationStatus>
  for (const p of PLATFORMS) result[p] = byPlatform.get(p) ?? 'planned'
  return result
}

/** Le courriel d'abandon (spec §5.5) : le clip, l'échéance, chaque plateforme et son erreur. */
async function notifyAbandoned(
  sendMail: Mailer,
  db: Database.Database,
  clipId: string,
  clipTitle: string,
  scheduledAt: number,
): Promise<void> {
  const byPlatform = new Map(getPublications(db, clipId).map((r) => [r.platform, r]))
  const lines = PLATFORMS.map((p) => {
    const row = byPlatform.get(p)
    const error = row?.error ? ` — ${row.error}` : ''
    return `  ${p} : ${row?.status ?? 'planned'}${error}`
  })
  const label = clipTitle === '' ? clipId : clipTitle
  await sendMail(
    `Publication en échec : ${label}`,
    [
      `Clip : ${label} (${clipId})`,
      `Échéance : ${new Date(scheduledAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`,
      'Plateformes :',
      ...lines,
    ].join('\n'),
  )
}

/**
 * Publie une échéance due, avec ses réessais. Le retour reflète toujours
 * l'état réel de la base — un essai qui laisse une ligne `in_progress`
 * honnêtement non résolue (`service.ts`) n'est jamais réécrit en `failed` :
 * aucun état de reprise ne s'ajoute au-delà de ce que `publications` porte déjà.
 */
async function processDueClip(deps: SchedulerDeps, clipId: string, scheduledAt: number): Promise<SchedulerOutcome> {
  const { db, sleep, sendMail } = deps
  const clip = getClip(db, clipId)
  if (clip === undefined) {
    console.error(`Clip programmé introuvable : ${clipId}.`)
    await notifyAbandoned(sendMail, db, clipId, clipId, scheduledAt)
    return { kind: 'abandoned', clipId, attempts: 0, statuses: statusesFor(db, clipId) }
  }

  let attempts = 0
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const targets = outstandingPlatforms(db, clipId)
    if (targets.length === 0) break
    attempts = attempt

    try {
      const { settled } = launchPublish({ db, clip, platforms: targets, force: false, ignoreStaleRender: true, sleep })
      await settled
    } catch (error) {
      markFailed(db, clipId, targets, messageSafe(error))
    }

    if (outstandingPlatforms(db, clipId).length === 0) break
    if (attempt < ATTEMPTS) await sleep(5000 * 2 ** (attempt - 1))
  }

  const statuses = statusesFor(db, clipId)
  const outstanding = PLATFORMS.filter((p) => statuses[p] !== 'published' && statuses[p] !== 'submitted')
  if (outstanding.length === 0) return { kind: 'done', clipId, attempts, statuses }

  await notifyAbandoned(sendMail, db, clipId, clip.title, scheduledAt)
  return { kind: 'abandoned', clipId, attempts, statuses }
}

/** Ce que `--dry-run` rendrait public : lecture seule, aucune écriture, aucune impression. */
function dueSummary(db: Database.Database, clipId: string, scheduledAt: number): DueSummary {
  const clip = getClip(db, clipId)
  return { clipId, title: clip?.title ?? '', scheduledAt, platforms: outstandingPlatforms(db, clipId) }
}

/**
 * Une passe : verrou, échéance due, publication en série, relâche. `dryRun`
 * ne prend aucun verrou, n'écrit aucune ligne, n'envoie aucun courriel et
 * n'imprime rien — l'appelant (le script) décide seul de ce qu'il affiche.
 */
export async function runOnePass(deps: SchedulerDeps, options?: { dryRun?: boolean }): Promise<SchedulerOutcome> {
  const { db, now, lockDir } = deps

  if (options?.dryRun === true) {
    const due = nextDueSchedule(db, now())
    return { kind: 'dry-run', due: due === undefined ? null : dueSummary(db, due.clipId, due.scheduledAt) }
  }

  // La présentation de `locked` appartient au script (comme `dry-run`,
  // spec §6, correction) : imprimer ici doublerait la ligne que `describe`
  // écrit déjà, dans un autre libellé.
  const lock = acquireLock(lockDir, now())
  if (!lock.acquired) return { kind: 'locked', since: lock.since }

  try {
    const due = nextDueSchedule(db, now())
    if (due === undefined) return { kind: 'idle' }
    return await processDueClip(deps, due.clipId, due.scheduledAt)
  } finally {
    releaseLock(lockDir)
  }
}
