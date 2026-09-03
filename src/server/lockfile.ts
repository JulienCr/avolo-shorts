import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Primitive de verrou de fichier extraite de l'ordonnanceur de publication
 * (`src/server/publication/scheduler.ts`), généralisée à N emplacements pour
 * servir de sémaphore inter-processus (jetons GPU / CPU / réseau, PR
 * suivante). Le comportement à un seul emplacement (`slots: 1`) reste
 * identique bit à bit à l'ancien verrou de publication.
 */
export type SlotOptions = { lockDir: string; name: string; slots: number; staleMs: number }
export type SlotHandle = { slot: number; owner: string }

type LockPayload = { pid: number; since: number; owner: string }

const RECLAIM_GUARD_STALE_MS = 60 * 1000

function lockFilename(name: string, slot: number, slots: number): string {
  return slots === 1 ? `.${name}.lock` : `.${name}.${slot}.lock`
}

function reclaimFilename(name: string, slot: number, slots: number): string {
  return slots === 1 ? `.${name}.reclaim` : `.${name}.${slot}.reclaim`
}

function lockPath(o: SlotOptions, slot: number): string {
  return path.join(o.lockDir, lockFilename(o.name, slot, o.slots))
}

function reclaimGuardPath(o: SlotOptions, slot: number): string {
  return path.join(o.lockDir, reclaimFilename(o.name, slot, o.slots))
}

function tryCreateLock(file: string, payload: LockPayload): boolean {
  let fd: number
  try {
    fd = fs.openSync(file, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  // `wx` a réussi : le fichier est à nous, sans conteste. Le supprimer si
  // l'écriture échoue ensuite est sûr, puisque personne d'autre n'a pu le
  // créer entretemps (relu en revue).
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
 * chaque appel, l'horodatage du fichier non (relu en revue).
 */
function lockFileSince(file: string, now: number): number {
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
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Reprend le verrou d'un emplacement : le renomme vers un nom à soi puis en
 * recrée un frais par `wx`. Appelé **seulement** sous le verrou de reprise
 * de cet emplacement, donc jamais par deux processus à la fois — c'est ce
 * qui rend ce couple non-atomique sûr, l'exclusivité vient d'ailleurs.
 */
function reclaimStaleLock(o: SlotOptions, file: string, owner: string, payload: LockPayload, holderPid: number | undefined): boolean {
  const evicted = `${file}.${owner}.evicted`
  try {
    fs.renameSync(file, evicted)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Le titulaire a relâché entretemps : rien à reprendre, on recrée direct.
    return tryCreateLock(file, payload)
  }
  console.warn(`Verrou « ${o.name} » périmé (posé il y a plus de ${o.staleMs}ms, pid ${holderPid ?? '?'} mort) : repris.`)
  fs.rmSync(evicted, { force: true })
  return tryCreateLock(file, payload)
}

/**
 * Prise atomique (`wx`) ; reprise d'un verrou périmé seulement sous un
 * second verrou `wx` dédié à la reprise, jamais par suppression-création ni
 * `renameSync` seul — les deux laissent une fenêtre où un second processus
 * agit entre l'éviction et la recréation. Un pid vivant l'emporte toujours
 * sur l'âge (`staleMs`) ; le verrou de reprise, lui, ne se fie qu'à son
 * propre âge. Démonstration complète et raisons de chaque rejet :
 * « Reprendre un verrou périmé » dans `docs/lessons.md`.
 */
function acquireOneSlot(
  o: SlotOptions,
  slot: number,
  now: number,
  isAlive: (pid: number) => boolean,
): { acquired: true; owner: string } | { acquired: false; since: number } {
  const file = lockPath(o, slot)
  const owner = `${process.pid}-${randomUUID()}`
  const payload: LockPayload = { pid: process.pid, since: now, owner }

  if (tryCreateLock(file, payload)) return { acquired: true, owner }

  const since = lockFileSince(file, now)
  if (now - since < o.staleMs) return { acquired: false, since }

  const guard = reclaimGuardPath(o, slot)
  const guardPayload: LockPayload = { pid: process.pid, since: now, owner }
  if (!tryCreateLock(guard, guardPayload)) {
    // Un autre processus reprend déjà ce même verrou périmé, ou tient encore
    // son propre verrou de reprise récent : on se retire plutôt que de
    // risquer la même course en parallèle du sien.
    const guardSince = lockFileSince(guard, now)
    if (now - guardSince < RECLAIM_GUARD_STALE_MS) return { acquired: false, since: lockFileSince(file, now) }
    // Le verrou de reprise lui-même est périmé — son titulaire est mort en
    // plein milieu d'une reprise, qui ne dure qu'une poignée d'appels
    // système : l'âge seul suffit à le reprendre, aucun pid à vérifier.
    fs.rmSync(guard, { force: true })
    if (!tryCreateLock(guard, guardPayload)) return { acquired: false, since: lockFileSince(file, now) }
  }
  try {
    // Revérifié **sous** le verrou de reprise, pas seulement avant : l'état
    // observé en dehors peut avoir changé pendant qu'on attendait `wx`.
    const stillSince = lockFileSince(file, now)
    if (now - stillSince < o.staleMs) return { acquired: false, since: stillSince }
    const holder = readLock(file)
    if (holder !== null && isAlive(holder.pid)) {
      console.warn(`Verrou « ${o.name} » vieux de plus de ${o.staleMs}ms mais pid ${holder.pid} toujours vivant : pas repris.`)
      return { acquired: false, since: stillSince }
    }
    if (reclaimStaleLock(o, file, owner, payload, holder?.pid)) return { acquired: true, owner }
    // Impossible en principe sous le verrou de reprise — personne d'autre ne
    // devrait pouvoir reposer un verrou frais pendant qu'on le tient — mais
    // on se retire plutôt que de l'écraser si ça arrivait quand même.
    return { acquired: false, since: lockFileSince(file, now) }
  } finally {
    fs.rmSync(guard, { force: true })
  }
}

/** Tries every slot in order; `null` when all are held. Never waits. */
export function acquireSlot(o: SlotOptions, now: number, isAlive: (pid: number) => boolean): SlotHandle | null {
  for (let slot = 0; slot < o.slots; slot++) {
    const result = acquireOneSlot(o, slot, now, isAlive)
    if (result.acquired) return { slot, owner: result.owner }
  }
  return null
}

/**
 * Depuis quand un emplacement est tenu (ou son horodatage disque à défaut de
 * JSON valide) — ce qu'un appelant reporte à l'utilisateur quand `acquireSlot`
 * échoue faute d'emplacement libre.
 */
export function lockSince(o: SlotOptions, slot: number, now: number): number {
  return lockFileSince(lockPath(o, slot), now)
}

/**
 * Ne supprime que le verrou qu'on a posé soi-même : un titulaire périmé qui
 * se réveille après avoir été repris ne doit pas effacer le verrou frais du
 * processus qui a repris sa place (relu en revue).
 */
export function releaseSlot(o: SlotOptions, handle: SlotHandle): void {
  const file = lockPath(o, handle.slot)
  if (readLock(file)?.owner === handle.owner) fs.rmSync(file, { force: true })
}

/** Deletes slot files whose pid is dead. Returns how many were freed. */
export function sweepDeadSlots(o: SlotOptions, isAlive: (pid: number) => boolean): number {
  let freed = 0
  for (let slot = 0; slot < o.slots; slot++) {
    const file = lockPath(o, slot)
    const holder = readLock(file)
    if (holder !== null && !isAlive(holder.pid)) {
      fs.rmSync(file, { force: true })
      freed++
    }
  }
  return freed
}
