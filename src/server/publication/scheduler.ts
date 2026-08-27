import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type Database from 'better-sqlite3'

import { PLATFORMS, type Platform, type PublicationStatus } from '@/core/publication'
import { effectiveSettings, getClip, getPublications, nextDueSchedule, upsertPublication } from '@/server/db'
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
  /**
   * Sonde si le pid d'un verrou périmé tient toujours — injectable pour les
   * tests, `process.kill(pid, 0)` par défaut (`pidAlive` ci-dessous).
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
const RECLAIM_GUARD_STALE_MS = 60 * 1000
const LOCK_FILENAME = '.publish-scheduled.lock'
const RECLAIM_GUARD_FILENAME = '.publish-scheduled.reclaim'

type LockPayload = { pid: number; since: number; owner: string }

function lockPath(lockDir: string): string {
  return path.join(lockDir, LOCK_FILENAME)
}

function reclaimGuardPath(lockDir: string): string {
  return path.join(lockDir, RECLAIM_GUARD_FILENAME)
}

function tryCreateLock(file: string, payload: LockPayload): boolean {
  let fd: number
  try {
    fd = fs.openSync(file, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  // `wx` a réussi : le fichier est à nous, sans conteste. Si l'écriture ou
  // la fermeture lève ensuite (disque plein, E/S), le laisser en place
  // ferait paraître le verrou pris pendant trente minutes sans qu'aucune
  // passe ne publie — le supprimer avant de relever est sûr, puisque
  // personne d'autre n'a pu le créer entretemps (relevé en revue).
  try {
    fs.writeSync(fd, JSON.stringify(payload))
    fs.closeSync(fd)
    return true
  } catch (error) {
    fs.rmSync(file, { force: true })
    throw error
  }
}

function readLock(file: string): LockPayload | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as LockPayload
  } catch {
    return null
  }
}

/**
 * L'instant posé par le titulaire, ou l'horodatage du fichier si le JSON est
 * incomplet — un processus tué entre `openSync` et l'écriture ne doit pas
 * laisser un verrou qui paraît frais à chaque lecture : `now` changerait à
 * chaque appel, l'horodatage du fichier non (relevé en revue).
 */
function lockSince(file: string, now: number): number {
  const existing = readLock(file)
  if (existing !== null) return existing.since
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return now
  }
}

/**
 * `process.kill(pid, 0)` n'envoie aucun signal, il sonde seulement
 * l'existence du processus. `EPERM` dit qu'il existe mais appartient à un
 * autre utilisateur — l'information est ambiguë, et le défaut prudent face à
 * une ambiguïté est de le croire vivant plutôt que de risquer une reprise
 * sur un faux mort (décision de l'orchestrateur, pas une déduction locale).
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Reprend le verrou principal : le renomme vers un nom à soi puis en
 * recrée un frais par `wx`. Appelé **seulement** sous le verrou de reprise
 * (`acquireLock`), donc jamais par deux processus à la fois — c'est ce
 * qui rend ce couple non-atomique sûr, l'exclusivité vient d'ailleurs.
 */
function reclaimStaleLock(file: string, owner: string, payload: LockPayload, holderPid: number | undefined): boolean {
  const evicted = `${file}.${owner}.evicted`
  try {
    fs.renameSync(file, evicted)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Le titulaire a relâché entretemps : rien à reprendre, on recrée direct.
    return tryCreateLock(file, payload)
  }
  console.warn(`Verrou de publication périmé (posé il y a plus de 30 min, pid ${holderPid ?? '?'} mort) : repris.`)
  fs.rmSync(evicted, { force: true })
  return tryCreateLock(file, payload)
}

/**
 * Prise atomique (`wx`) ; reprise d'un verrou périmé seulement si son pid
 * n'est plus vivant, sous un second verrou `wx` dédié à la reprise
 * (décision de l'orchestrateur, après deux tentatives insuffisantes).
 *
 * **Ni une paire suppression-puis-création, ni un simple `renameSync`, ne
 * suffisent** (relevé en revue, à trois reprises) : dans les deux cas, un
 * second processus qui a lui aussi observé le même verrou périmé peut
 * encore agir entre l'éviction du premier et sa recréation — y compris en
 * renommant le verrou **neuf** que le premier vient de reposer, puisque
 * `renameSync` ne vérifie pas ce qu'il déplace. Le verrou de reprise ferme
 * cette fenêtre : `wx` garantit qu'un seul processus l'obtient, donc un
 * seul est jamais à l'intérieur de la séquence qui évince puis recrée —
 * qui revérifie l'âge et la vivacité du pid **sous** ce verrou plutôt que
 * de faire confiance à ce qu'il a observé avant de l'obtenir.
 *
 * **L'âge seul ne suffit pas non plus** pour le verrou principal (relevé en
 * revue) : une passe qui dépasse trente minutes de bonne foi — quatre
 * fichiers de plusieurs centaines de Mio en série — verrait sinon son
 * verrou volé par le réveil suivant pendant qu'elle publie encore. Le pid
 * vivant l'emporte sur l'âge, quel qu'il soit.
 *
 * **Le verrou de reprise, lui, se contente de l'âge** — une minute suffit,
 * et rien de plus n'est nécessaire : il n'est jamais tenu à travers un
 * envoi, seulement le temps d'une poignée d'appels système, donc son seul
 * risque est un processus tué en plein milieu, pas une lenteur légitime.
 */
function acquireLock(
  lockDir: string,
  now: number,
  isAlive: (pid: number) => boolean,
): { acquired: true; owner: string } | { acquired: false; since: number } {
  const file = lockPath(lockDir)
  const owner = `${process.pid}-${randomUUID()}`
  const payload: LockPayload = { pid: process.pid, since: now, owner }

  if (tryCreateLock(file, payload)) return { acquired: true, owner }

  const since = lockSince(file, now)
  if (now - since < STALE_LOCK_MS) return { acquired: false, since }

  const guard = reclaimGuardPath(lockDir)
  const guardPayload: LockPayload = { pid: process.pid, since: now, owner }
  if (!tryCreateLock(guard, guardPayload)) {
    // Un autre processus reprend déjà ce même verrou périmé, ou tient encore
    // son propre verrou de reprise récent : on se retire plutôt que de
    // risquer la même course en parallèle du sien.
    const guardSince = lockSince(guard, now)
    if (now - guardSince < RECLAIM_GUARD_STALE_MS) return { acquired: false, since: lockSince(file, now) }
    // Le verrou de reprise lui-même est périmé — son titulaire est mort en
    // plein milieu d'une reprise, qui ne dure qu'une poignée d'appels
    // système : l'âge seul suffit à le reprendre, aucun pid à vérifier.
    fs.rmSync(guard, { force: true })
    if (!tryCreateLock(guard, guardPayload)) return { acquired: false, since: lockSince(file, now) }
  }
  try {
    // Revérifié **sous** le verrou de reprise, pas seulement avant : l'état
    // observé en dehors peut avoir changé pendant qu'on attendait `wx`.
    const stillSince = lockSince(file, now)
    if (now - stillSince < STALE_LOCK_MS) return { acquired: false, since: stillSince }
    const holder = readLock(file)
    if (holder !== null && isAlive(holder.pid)) {
      console.warn(`Verrou de publication vieux de plus de 30 min mais pid ${holder.pid} toujours vivant : pas repris.`)
      return { acquired: false, since: stillSince }
    }
    if (reclaimStaleLock(file, owner, payload, holder?.pid)) return { acquired: true, owner }
    // Impossible en principe sous le verrou de reprise — personne d'autre ne
    // devrait pouvoir reposer un verrou frais pendant qu'on le tient — mais
    // on se retire plutôt que de l'écraser si ça arrivait quand même.
    return { acquired: false, since: lockSince(file, now) }
  } finally {
    fs.rmSync(guard, { force: true })
  }
}

/**
 * Ne supprime que le verrou qu'on a posé soi-même : un titulaire périmé qui
 * se réveille après avoir été repris ne doit pas effacer le verrou frais du
 * processus qui a repris sa place (relevé en revue).
 */
function releaseLock(lockDir: string, owner: string): void {
  const file = lockPath(lockDir)
  if (readLock(file)?.owner === owner) fs.rmSync(file, { force: true })
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
  const lock = acquireLock(lockDir, now(), isAlive)
  if (!lock.acquired) return { kind: 'locked', since: lock.since }

  try {
    const due = nextDueSchedule(db, now())
    if (due === undefined) return { kind: 'idle' }
    return await processDueClip(deps, due.clipId, due.scheduledAt)
  } finally {
    releaseLock(lockDir, lock.owner)
  }
}
