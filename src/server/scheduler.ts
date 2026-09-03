import { CAPACITIES, type Resource } from '@/core/resources'
import { StopRequestedError } from '@/server/ffmpeg'
import { acquireSlot, pidAlive, releaseSlot, sweepDeadSlots, type SlotHandle, type SlotOptions } from '@/server/lockfile'
import { projectsDir } from '@/server/paths'

/** A granted reservation: release it in a `finally`. Idempotent. */
export type Hold = () => void

export type Scheduler = {
  acquire(resource: Resource, priority: number, signal?: AbortSignal, onQueued?: () => void): Promise<Hold>
  snapshot(): ReadonlyArray<{ resource: Resource; held: number; waiting: number }>
  /** Releases everything this process holds. For shutdown. */
  releaseAll(): void
}

type Waiter = {
  seq: number
  priority: number
  resolve: () => void
  aborted: boolean
}

type ResourceState = {
  capacity: number
  /**
   * Local permits not currently held.
   * @remarks `free > 0` implies `queue` is empty: `release` drains it
   * synchronously, with no `await` between checking `free` and granting the
   * next waiter. An `await` inserted there would break this silently.
   */
  free: number
  queue: Waiter[]
  fileOptions: SlotOptions | null
  heldFiles: Set<SlotHandle>
}

const STALE_MS = 120_000
const POLL_MS = 500
const RESOURCES: readonly Resource[] = ['gpu', 'cpu', 'net']

function resourceSlotOptions(resource: Resource, lockDir: string, slots: number): SlotOptions {
  return { lockDir, name: `resource-${resource}`, slots, staleMs: STALE_MS }
}

function compareWaiters(a: Waiter, b: Waiter): number {
  return a.priority - b.priority || a.seq - b.seq
}

function insertSorted(queue: Waiter[], waiter: Waiter): void {
  let i = queue.length
  while (i > 0 && compareWaiters(queue[i - 1], waiter) > 0) i--
  queue.splice(i, 0, waiter)
}

function removeWaiter(queue: Waiter[], waiter: Waiter): boolean {
  const i = queue.indexOf(waiter)
  if (i === -1) return false
  queue.splice(i, 1)
  return true
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let onAbort: (() => void) | undefined
    const timer = setTimeout(() => {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal !== undefined) {
      onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      // Closes the same window as `waitForTurn`: a signal aborted between
      // the caller's own check and this listener would otherwise wait out
      // the full `ms` instead of returning immediately.
      if (signal.aborted) onAbort()
    }
  })
}

export function createScheduler(deps: {
  capacities: Record<Resource, number>
  /** `null`: in-process only, for tests. */
  lockDir: string | null
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  pidAlive?: (pid: number) => boolean
}): Scheduler {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const isAlive = deps.pidAlive ?? pidAlive
  let nextSeq = 0

  const states = new Map<Resource, ResourceState>()
  for (const resource of Object.keys(deps.capacities) as Resource[]) {
    const capacity = deps.capacities[resource]
    states.set(resource, {
      capacity,
      free: capacity,
      queue: [],
      fileOptions: deps.lockDir === null ? null : resourceSlotOptions(resource, deps.lockDir, capacity),
      heldFiles: new Set(),
    })
  }

  function getState(resource: Resource): ResourceState {
    const state = states.get(resource)
    if (state === undefined) throw new RangeError(`unconfigured resource: ${resource}`)
    return state
  }

  function releaseLocalToken(state: ResourceState): void {
    state.free++
    while (state.free > 0 && state.queue.length > 0) {
      const waiter = state.queue.shift()
      if (waiter === undefined || waiter.aborted) continue
      state.free--
      waiter.resolve()
    }
  }

  async function waitForTurn(state: ResourceState, priority: number, signal: AbortSignal | undefined, announce: () => void): Promise<void> {
    if (state.free > 0) {
      state.free--
      return
    }
    const waiter: Waiter = { seq: nextSeq++, priority, resolve: () => {}, aborted: false }
    const gate = new Promise<void>((resolve) => {
      waiter.resolve = resolve
    })
    let onAbort: (() => void) | undefined
    try {
      insertSorted(state.queue, waiter)
      announce()
      if (signal !== undefined) {
        onAbort = () => {
          // `releaseLocalToken` may have granted this waiter its token in
          // the same tick, before `await gate` resumed: too late to cancel,
          // and marking it aborted now would leak the token to no one.
          if (!removeWaiter(state.queue, waiter)) return
          waiter.aborted = true
          waiter.resolve()
        }
        signal.addEventListener('abort', onAbort, { once: true })
        // Closes the window between the insert above and this listener:
        // an abort landing in between would otherwise leave the waiter
        // queued forever, waiting on a listener that was never attached.
        if (signal.aborted) onAbort()
      }
      await gate
      if (waiter.aborted) throw new StopRequestedError(`attente de la ressource`)
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    }
  }

  async function acquireFileSlot(state: ResourceState, signal: AbortSignal | undefined, announce: () => void): Promise<SlotHandle> {
    for (;;) {
      if (signal?.aborted === true) throw new StopRequestedError(`attente de la ressource`)
      const handle = acquireSlot(state.fileOptions as SlotOptions, now(), isAlive)
      if (handle !== null) return handle
      announce()
      await sleep(POLL_MS, signal)
    }
  }

  function makeHold(state: ResourceState, handle: SlotHandle | null): Hold {
    let released = false
    return () => {
      if (released) return
      released = true
      if (handle !== null) {
        releaseSlot(state.fileOptions as SlotOptions, handle)
        state.heldFiles.delete(handle)
      }
      releaseLocalToken(state)
    }
  }

  async function acquire(resource: Resource, priority: number, signal?: AbortSignal, onQueued?: () => void): Promise<Hold> {
    if (signal?.aborted === true) throw new StopRequestedError(`attente de la ressource`)
    const state = getState(resource)
    let announced = false
    const announce = (): void => {
      if (announced) return
      announced = true
      if (onQueued === undefined) return
      try {
        onQueued()
      } catch (cause) {
        console.warn(`Le rappel onQueued de « ${resource} » a échoué :`, cause)
      }
    }

    await waitForTurn(state, priority, signal, announce)
    try {
      const handle = state.fileOptions === null ? null : await acquireFileSlot(state, signal, announce)
      if (handle !== null) state.heldFiles.add(handle)
      return makeHold(state, handle)
    } catch (cause) {
      releaseLocalToken(state)
      throw cause
    }
  }

  function snapshot(): ReadonlyArray<{ resource: Resource; held: number; waiting: number }> {
    return [...states.entries()].map(([resource, state]) => ({
      resource,
      held: state.capacity - state.free,
      waiting: state.queue.length,
    }))
  }

  function releaseAll(): void {
    for (const state of states.values()) {
      if (state.fileOptions === null) continue
      for (const handle of state.heldFiles) {
        try {
          releaseSlot(state.fileOptions, handle)
        } catch (cause) {
          // A slot release failing here must not stop the others, and must
          // not escape into a `process.on('exit' | 'SIGINT' | 'SIGTERM')`
          // handler, where it would cut a sibling listener's cleanup short.
          console.error(`Libération du créneau « ${handle.slot} » :`, cause)
        }
      }
      state.heldFiles.clear()
    }
  }

  return { acquire, snapshot, releaseAll }
}

let instance: Scheduler | null = null

/** This process's instance, on `projectsDir()`. Tests create their own. */
export function scheduler(): Scheduler {
  if (instance === null) instance = createScheduler({ capacities: CAPACITIES, lockDir: projectsDir() })
  return instance
}

/**
 * Clears slots whose pid is dead. Meant for startup.
 * @param isAlive - Injectable for tests; defaults to the real `pidAlive`.
 * @returns How many slots were freed.
 */
export function sweepSchedulerSlots(lockDir: string, isAlive: (pid: number) => boolean = pidAlive): number {
  let freed = 0
  for (const resource of RESOURCES) {
    freed += sweepDeadSlots(resourceSlotOptions(resource, lockDir, CAPACITIES[resource]), isAlive)
  }
  return freed
}
