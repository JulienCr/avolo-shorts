import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * File-based lock generalised to N slots, extracted from the publication
 * scheduler (`src/server/publication/scheduler.ts`) for reuse as a
 * cross-process semaphore (GPU/CPU/network tokens, next PR). `slots: 1`
 * behaves identically to the original single-slot publication lock.
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

/**
 * @throws if `o.slots` is not a positive safe integer — a caller-controlled
 * value with no compile-time guard, since `SlotOptions` is exported for
 * reuse.
 */
function validSlotCount(o: SlotOptions): number {
  if (!Number.isSafeInteger(o.slots) || o.slots < 1) {
    throw new RangeError(`slots must be a positive integer, got ${o.slots}`)
  }
  return o.slots
}

/**
 * @throws if `o.name` is not a single path component — it is interpolated
 * into a filename under `o.lockDir`, and a value like `../x` would escape it.
 */
function validName(o: SlotOptions): string {
  if (o.name.length === 0 || o.name !== path.basename(o.name)) {
    throw new RangeError(`name must be a single path component, got ${JSON.stringify(o.name)}`)
  }
  return o.name
}

function lockPath(o: SlotOptions, slot: number): string {
  return path.join(o.lockDir, lockFilename(validName(o), slot, o.slots))
}

function reclaimGuardPath(o: SlotOptions, slot: number): string {
  return path.join(o.lockDir, reclaimFilename(validName(o), slot, o.slots))
}

function tryCreateLock(file: string, payload: LockPayload): boolean {
  let fd: number
  try {
    fd = fs.openSync(file, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  // Deleting on a write or close failure is safe: `wx` already proved
  // nobody else could have created this file in the meantime.
  try {
    fs.writeSync(fd, JSON.stringify(payload))
    fs.closeSync(fd)
  } catch (error) {
    try {
      fs.closeSync(fd)
    } catch {
      // Already closed by the successful call above, or genuinely
      // unclosable: nothing left to release, don't mask the original error.
    }
    fs.rmSync(file, { force: true })
    throw error
  }
  return true
}

function readLock(file: string): LockPayload | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as LockPayload
  } catch {
    return null
  }
}

/**
 * Reads a lock's age from its own payload, falling back to the file's mtime.
 * @returns the timestamp the holder recorded, or the file's mtime if the
 * payload is missing/incomplete (a process killed between `openSync` and the
 * write must not look freshly-held on every read).
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
 * Probes whether a pid is still alive.
 * @returns `true` on `EPERM` (process exists, owned by someone else) as
 * well as on success — an ambiguous signal defaults to "alive" rather than
 * risking a reclaim on a false negative.
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
 * Evicts a stale lock and recreates it fresh. Must only be called under the
 * per-slot reclaim guard (see `acquireOneSlot`), so this rename-then-create
 * pair is never racing another caller.
 */
function reclaimStaleLock(o: SlotOptions, file: string, owner: string, payload: LockPayload, holderPid: number | undefined): boolean {
  const evicted = `${file}.${owner}.evicted`
  try {
    fs.renameSync(file, evicted)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Holder released in the meantime: nothing to evict, create directly.
    return tryCreateLock(file, payload)
  }
  console.warn(`Verrou « ${o.name} » périmé (posé il y a plus de ${o.staleMs}ms, pid ${holderPid ?? '?'} mort) : repris.`)
  fs.rmSync(evicted, { force: true })
  return tryCreateLock(file, payload)
}

/**
 * Tries to acquire one slot, reclaiming it if stale. The eviction sequence
 * is not interchangeable with a simpler delete-then-create or a bare
 * `renameSync`, and a live pid always outranks age. Full demonstration:
 * "Reprendre un verrou périmé" in `docs/lessons.md`.
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
    // Another process is already reclaiming this same stale lock, or holds
    // its own recent reclaim guard: back off rather than race it.
    const guardSince = lockFileSince(guard, now)
    if (now - guardSince < RECLAIM_GUARD_STALE_MS) return { acquired: false, since: lockFileSince(file, now) }
    // The reclaim guard itself is stale: its holder died mid-reclaim, which
    // only spans a handful of syscalls, so age alone suffices here.
    fs.rmSync(guard, { force: true })
    if (!tryCreateLock(guard, guardPayload)) return { acquired: false, since: lockFileSince(file, now) }
  }
  try {
    // Re-checked under the reclaim guard, not just before: state observed
    // outside may have changed while waiting for `wx`.
    const stillSince = lockFileSince(file, now)
    if (now - stillSince < o.staleMs) return { acquired: false, since: stillSince }
    const holder = readLock(file)
    if (holder !== null && isAlive(holder.pid)) {
      console.warn(`Verrou « ${o.name} » vieux de plus de ${o.staleMs}ms mais pid ${holder.pid} toujours vivant : pas repris.`)
      return { acquired: false, since: stillSince }
    }
    if (reclaimStaleLock(o, file, owner, payload, holder?.pid)) return { acquired: true, owner }
    // Unreachable in principle under the reclaim guard; back off rather
    // than overwrite if it happens anyway.
    return { acquired: false, since: lockFileSince(file, now) }
  } finally {
    fs.rmSync(guard, { force: true })
  }
}

/** Tries every slot in order; `null` when all are held. Never waits. */
export function acquireSlot(o: SlotOptions, now: number, isAlive: (pid: number) => boolean): SlotHandle | null {
  const slots = validSlotCount(o)
  for (let slot = 0; slot < slots; slot++) {
    const result = acquireOneSlot(o, slot, now, isAlive)
    if (result.acquired) return { slot, owner: result.owner }
  }
  return null
}

/**
 * @returns the timestamp a slot has been held since, for a caller reporting
 * why `acquireSlot` failed: the holder's recorded `since`, the file's mtime
 * when the payload is missing or incomplete, or `now` when the file is gone.
 */
export function lockSince(o: SlotOptions, slot: number, now: number): number {
  return lockFileSince(lockPath(o, slot), now)
}

/**
 * Removes only a lock this caller placed: a stale holder waking up after
 * being reclaimed must not delete the fresh lock that replaced it.
 */
export function releaseSlot(o: SlotOptions, handle: SlotHandle): void {
  const file = lockPath(o, handle.slot)
  if (readLock(file)?.owner === handle.owner) fs.rmSync(file, { force: true })
}

/**
 * Deletes slot files whose pid is dead, coordinated through the same
 * per-slot reclaim guard `acquireOneSlot` uses so a concurrent reclaim
 * cannot have its fresh lock swept away.
 * @returns how many slots were freed. A slot behind an abandoned guard is
 * skipped rather than freed on this pass — see issue #308.
 */
export function sweepDeadSlots(o: SlotOptions, isAlive: (pid: number) => boolean): number {
  const slots = validSlotCount(o)
  let freed = 0
  for (let slot = 0; slot < slots; slot++) {
    const file = lockPath(o, slot)
    const holder = readLock(file)
    if (holder === null || isAlive(holder.pid)) continue

    const guard = reclaimGuardPath(o, slot)
    if (!tryCreateLock(guard, { pid: process.pid, since: Date.now(), owner: holder.owner })) continue
    try {
      if (readLock(file)?.owner === holder.owner) {
        fs.rmSync(file, { force: true })
        freed++
      }
    } finally {
      fs.rmSync(guard, { force: true })
    }
  }
  return freed
}
