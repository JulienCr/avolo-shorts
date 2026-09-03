import type Database from 'better-sqlite3'

import {
  PLATFORM_LABELS,
  PLATFORMS,
  PUBLICATION_STATUS_LABELS,
  platformTexts,
  type DescriptionFooterOptions,
  type Platform,
  type PublicationStatus,
} from '@/core/publication'
import { formatErrorDetail } from '@/core/publication-errors'
import { effectiveSettings, getClip, getPublications, nextDueSchedule, upsertPublication } from '@/server/db'
import { messageSafe } from '@/server/errors'
import { acquireSlot, lockSince, pidAlive, releaseSlot, type SlotOptions } from '@/server/lockfile'
import { adapterFor } from '@/server/publication'
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
  /**
   * Sonde si le pid d'un verrou périmé tient toujours — injectable pour les
   * tests, `process.kill(pid, 0)` par défaut (`pidAlive` de `@/server/lockfile`).
   */
  pidAlive?: (pid: number) => boolean
}

export type DueSummary = { clipId: string; title: string; scheduledAt: number; platforms: readonly Platform[] }

export type SchedulerOutcome =
  | { kind: 'idle' }
  | { kind: 'locked'; since: number }
  | { kind: 'disabled' }
  | { kind: 'dry-run'; due: DueSummary | null }
  | { kind: 'done'; clipId: string; attempts: number; statuses: Record<Platform, PublicationStatus> }
  | { kind: 'abandoned'; clipId: string; attempts: number; statuses: Record<Platform, PublicationStatus> }

const ATTEMPTS = 3
const STALE_LOCK_MS = 30 * 60 * 1000

/** Options du verrou d'ordonnancement : un seul emplacement, sur `lockDir` (spec §5.4). */
function lockOptions(lockDir: string): SlotOptions {
  return { lockDir, name: 'publish-scheduled', slots: 1, staleMs: STALE_LOCK_MS }
}

/**
 * Les plateformes qui n'ont ni réussi ni été déposées — ce qu'un essai doit
 * encore cibler.
 *
 * **Une ligne absente n'est pas encore à faire, elle ne l'est plus.**
 * `schedulePublications` écrit les quatre lignes `planned` d'un coup, donc
 * une échéance due en a toujours une par plateforme ; en voir une manquer
 * ici ne peut venir que d'une déprogrammation (`unschedulePublications`
 * supprime les lignes `planned`) survenue entre deux essais de cette même
 * passe — relue à chaque tour de boucle, pas seulement au premier. La
 * traiter comme « à faire » republierait après que l'humain a annulé
 * (relevé en revue).
 */
function outstandingPlatforms(db: Database.Database, clipId: string, scheduledAt: number): Platform[] {
  const byPlatform = new Map(getPublications(db, clipId).map((r) => [r.platform, r]))
  return PLATFORMS.filter((p) => {
    const row = byPlatform.get(p)
    // `scheduledAt` filtre les lignes de cette échéance, jamais celles d'un
    // essai manuel resté `failed`/`in_progress` (`scheduledAt: null`) que
    // `schedulePublications` laisse intact — sa clause `WHERE status =
    // 'planned'` ne le réécrit pas. Sans ce filtre, l'ordonnanceur retargette
    // un envoi manuel encore en vol, jusqu'à le doubler (relevé en revue).
    return (
      row !== undefined &&
      row.scheduledAt === scheduledAt &&
      (row.status === 'planned' || row.status === 'failed' || row.status === 'in_progress')
    )
  })
}

/**
 * `launchPublish` peut lever avant d'écrire quoi que ce soit — fichier
 * disparu, titre YouTube manquant : un échec permanent, pas un aléa réseau
 * (déjà écrit `failed` par `service.ts` lui-même). Sans ceci, la ligne
 * resterait `planned` et `nextDueSchedule` la reprendrait indéfiniment.
 *
 * `now` reçu en paramètre, pas `Date.now()` : c'est `deps.now()` partout
 * ailleurs dans ce module, et un test qui injecte une horloge factice pour
 * `runOnePass` veut des horodatages déterministes sur les lignes que celle-ci
 * écrit aussi (relevé en revue).
 */
function markFailed(db: Database.Database, clipId: string, platforms: readonly Platform[], message: string, now: number): void {
  const existing = new Map(getPublications(db, clipId).map((r) => [r.platform, r]))
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

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  published: { bg: '#e6f4ea', fg: '#1e7e34' },
  submitted: { bg: '#e6f4ea', fg: '#1e7e34' },
  failed: { bg: '#fce8e6', fg: '#c5221f' },
}
const DEFAULT_STATUS_COLOR = { bg: '#f1f3f4', fg: '#5f6368' }

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function platformRowHtml(platform: Platform, status: PublicationStatus, error: string | null | undefined): string {
  const { bg, fg } = STATUS_COLORS[status] ?? DEFAULT_STATUS_COLOR
  const detail =
    error != null && error !== ''
      ? `<pre style="margin:0;white-space:pre-wrap;font-family:monospace;font-size:12px;color:#3c4043">${escapeHtml(formatErrorDetail(error))}</pre>`
      : ''
  return `<tr>
    <td style="padding:6px 12px;border-bottom:1px solid #e0e0e0">${escapeHtml(PLATFORM_LABELS[platform])}</td>
    <td style="padding:6px 12px;border-bottom:1px solid #e0e0e0">
      <span style="display:inline-block;padding:2px 8px;border-radius:12px;background:${bg};color:${fg};font-size:12px">${escapeHtml(PUBLICATION_STATUS_LABELS[status])}</span>
    </td>
    <td style="padding:6px 12px;border-bottom:1px solid #e0e0e0">${detail}</td>
  </tr>`
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
  const deadline = new Date(scheduledAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })
  const rows = PLATFORMS.map((p) => {
    const row = byPlatform.get(p)
    return platformRowHtml(p, row?.status ?? 'planned', row?.error)
  }).join('')
  const html = `<div style="font-family:sans-serif;color:#202124">
    <p><strong>Clip :</strong> ${escapeHtml(label)} (${escapeHtml(clipId)})</p>
    <p><strong>Échéance :</strong> ${escapeHtml(deadline)}</p>
    <table style="border-collapse:collapse;width:100%;max-width:640px">
      <thead>
        <tr>
          <th style="text-align:left;padding:6px 12px;border-bottom:2px solid #202124">Plateforme</th>
          <th style="text-align:left;padding:6px 12px;border-bottom:2px solid #202124">Statut</th>
          <th style="text-align:left;padding:6px 12px;border-bottom:2px solid #202124">Détail</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`
  await sendMail(
    `Publication en échec : ${label}`,
    [`Clip : ${label} (${clipId})`, `Échéance : ${deadline}`, 'Plateformes :', ...lines].join('\n'),
    html,
  )
}

/**
 * Le dépôt TikTok arrive sans texte (`tiktok.ts`, `initUpload`) — ce courriel
 * porte la légende pour qu'un humain la colle dans l'app. Texte utilisateur,
 * donc échappée dans le HTML, dans un `<pre>` pour garder la ligne vide titre/description.
 */
async function notifyTikTokDraft(
  sendMail: Mailer,
  clipId: string,
  clipTitle: string,
  scheduledAt: number,
  caption: string,
): Promise<void> {
  const label = clipTitle === '' ? clipId : clipTitle
  const deadline = new Date(scheduledAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })
  const notice = 'Le brouillon TikTok arrive sans texte (l’API de dépôt ne porte aucun champ légende) : à coller dans l’app.'
  const html = `<div style="font-family:sans-serif;color:#202124">
    <p><strong>Clip :</strong> ${escapeHtml(label)} (${escapeHtml(clipId)})</p>
    <p><strong>Échéance :</strong> ${escapeHtml(deadline)}</p>
    <p>${escapeHtml(notice)}</p>
    <pre style="margin:0;white-space:pre-wrap;font-family:inherit;font-size:14px">${escapeHtml(caption)}</pre>
  </div>`
  await sendMail(
    `Brouillon TikTok déposé : ${label}`,
    [`Clip : ${label} (${clipId})`, `Échéance : ${deadline}`, notice, '', caption].join('\n'),
    html,
  )
}

/**
 * Publie une échéance due, avec ses réessais. Le retour reflète toujours
 * l'état réel de la base — un essai qui laisse une ligne `in_progress`
 * honnêtement non résolue (`service.ts`) n'est jamais réécrit en `failed` :
 * aucun état de reprise ne s'ajoute au-delà de ce que `publications` porte déjà.
 */
async function processDueClip(deps: SchedulerDeps, clipId: string, scheduledAt: number): Promise<SchedulerOutcome> {
  const { db, now, sleep, sendMail } = deps
  const clip = getClip(db, clipId)
  if (clip === undefined) {
    // Sans ceci, les lignes restent `planned` : `nextDueSchedule` reprendrait
    // indéfiniment cette même échéance, empêchant les suivantes de jamais
    // passer (relevé en revue).
    markFailed(db, clipId, outstandingPlatforms(db, clipId, scheduledAt), `Clip programmé introuvable : ${clipId}.`, now())
    console.error(`Clip programmé introuvable : ${clipId}.`)
    await notifyAbandoned(sendMail, db, clipId, clipId, scheduledAt)
    return { kind: 'abandoned', clipId, attempts: 0, statuses: statusesFor(db, clipId) }
  }

  // Capturé avant le premier essai : une ligne TikTok déjà `submitted` d'une
  // passe antérieure ne doit pas redéclencher ce courriel à chaque échéance
  // suivante du même clip.
  const tiktokWasOutstanding = outstandingPlatforms(db, clipId, scheduledAt).includes('tiktok')

  let attempts = 0
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const targets = outstandingPlatforms(db, clipId, scheduledAt)
    if (targets.length === 0) break
    attempts = attempt

    // Une plateforme après l'autre, jamais groupées (spec §5.4) : un seul
    // `launchPublish` sur plusieurs cibles les lance en parallèle
    // (`groupByAdapter` + `Promise.all` dans `service.ts`, et `meta.ts` fait
    // de même pour Instagram/Facebook), ce que §5.4 écarte explicitement, et
    // une validation en échec pour l'une (YouTube sans titre) marquait à tort
    // les autres (relevé en revue).
    for (const platform of targets) {
      // Revérifié plateforme par plateforme, pas seulement au sommet de
      // l'essai : une déprogrammation peut arriver pendant qu'une autre
      // plateforme de la même échéance est encore en train de téléverser —
      // `targets` capturé avant la boucle ne le verrait pas (relevé en revue).
      if (!outstandingPlatforms(db, clipId, scheduledAt).includes(platform)) continue
      try {
        const { settled } = launchPublish({ db, clip, platforms: [platform], force: false, ignoreStaleRender: true, sleep })
        await settled
      } catch (error) {
        markFailed(db, clipId, [platform], messageSafe(error), now())
      }
    }

    if (outstandingPlatforms(db, clipId, scheduledAt).length === 0) break
    if (attempt < ATTEMPTS) await sleep(5000 * 2 ** (attempt - 1))
  }

  const statuses = statusesFor(db, clipId)
  // `outstandingPlatforms`, pas `statuses !== published/submitted` : ce
  // dernier lit une ligne absente comme `planned` (le défaut de
  // `statusesFor`, utile pour l'affichage), donc une plateforme
  // déprogrammée pendant la passe déclenchait un abandon, un courriel et
  // un code de sortie 1 — alors que l'annulation avait réussi (relevé en
  // revue).
  const outstanding = outstandingPlatforms(db, clipId, scheduledAt)

  // Indépendant du verdict `done` / `abandoned` : un dépôt TikTok réussi
  // mérite son courriel même si une autre plateforme de la même échéance a
  // été abandonnée à côté. Réservé au connecteur direct (`tiktok`) : Upload
  // Post envoie déjà `job.description` comme légende (relevé en revue).
  if (tiktokWasOutstanding && statuses.tiktok === 'submitted' && adapterFor('tiktok')?.id === 'tiktok') {
    const footerOptions: DescriptionFooterOptions = { footer: effectiveSettings(db).publication.descriptionFooter }
    await notifyTikTokDraft(
      sendMail,
      clipId,
      clip.title,
      scheduledAt,
      platformTexts(clip, 'tiktok', footerOptions).description,
    )
  }

  if (outstanding.length === 0) return { kind: 'done', clipId, attempts, statuses }

  await notifyAbandoned(sendMail, db, clipId, clip.title, scheduledAt)
  return { kind: 'abandoned', clipId, attempts, statuses }
}

/** Ce que `--dry-run` rendrait public : lecture seule, aucune écriture, aucune impression. */
function dueSummary(db: Database.Database, clipId: string, scheduledAt: number): DueSummary {
  const clip = getClip(db, clipId)
  return { clipId, title: clip?.title ?? '', scheduledAt, platforms: outstandingPlatforms(db, clipId, scheduledAt) }
}

/**
 * Une passe : verrou, échéance due, publication en série, relâche. `dryRun`
 * ne prend aucun verrou, n'écrit aucune ligne, n'envoie aucun courriel et
 * n'imprime rien — l'appelant (le script) décide seul de ce qu'il affiche.
 */
export async function runOnePass(deps: SchedulerDeps, options?: { dryRun?: boolean }): Promise<SchedulerOutcome> {
  const { db, now, lockDir, pidAlive: isAlive = pidAlive } = deps

  // Lu avant le verrou et avant `nextDueSchedule` : ce drapeau arrête la
  // tâche planifiée, pas un humain devant l'écran — `POST /api/clips/:id/
  // publish` appelle `launchPublish` directement et ne passe jamais ici.
  if (!effectiveSettings(db).publication.autoPublish) return { kind: 'disabled' }

  if (options?.dryRun === true) {
    const due = nextDueSchedule(db, now())
    return { kind: 'dry-run', due: due === undefined ? null : dueSummary(db, due.clipId, due.scheduledAt) }
  }

  // La présentation de `locked` appartient au script (comme `dry-run`,
  // spec §6, correction) : imprimer ici doublerait la ligne que `describe`
  // écrit déjà, dans un autre libellé.
  const lockOpts = lockOptions(lockDir)
  const currentNow = now()
  const handle = acquireSlot(lockOpts, currentNow, isAlive)
  if (handle === null) return { kind: 'locked', since: lockSince(lockOpts, 0, currentNow) }

  try {
    const due = nextDueSchedule(db, now())
    if (due === undefined) return { kind: 'idle' }
    return await processDueClip(deps, due.clipId, due.scheduledAt)
  } finally {
    releaseSlot(lockOpts, handle)
  }
}
