import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StopRequestedError } from '@/server/ffmpeg'
import { createScheduler, sweepSchedulerSlots, type Scheduler } from '@/server/scheduler'

/**
 * Verifies the in-process priority semaphore (queue order, cancellation,
 * `Hold` idempotency) and its composition with the cross-process slot files
 * (`src/server/lockfile.ts`): local token first, file slot second, never the
 * reverse.
 */

// A macrotask (`setImmediate`), not a bare `Promise.resolve()`: an unbounded
// poll loop driven by a pure microtask can starve Node's timer queue, which
// is what would let a genuinely hanging test survive vitest's own timeout.
function immediateSleep(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function hangingSleep(_ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal?.addEventListener('abort', () => resolve(), { once: true })
  })
}

function inProcessScheduler(capacities: Partial<Record<'gpu' | 'cpu' | 'net', number>> = { gpu: 1 }): Scheduler {
  return createScheduler({
    capacities: { gpu: 0, cpu: 0, net: 0, ...capacities },
    lockDir: null,
    sleep: immediateSleep,
  })
}

describe('acquire / Hold — le jeton local', () => {
  it('avec gpu: 1, un second acquire n’attend pas moins que la fin du premier Hold', async () => {
    const sched = inProcessScheduler({ gpu: 1 })
    const hold1 = await sched.acquire('gpu', 10)

    let secondGranted = false
    const second = sched.acquire('gpu', 10).then((hold) => {
      secondGranted = true
      return hold
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(secondGranted).toBe(false)

    hold1()
    const hold2 = await second
    expect(secondGranted).toBe(true)
    hold2()
  })

  it('ordre de priorite : 80, 20, 40 mis en file sont accordes 20, 40, 80', async () => {
    const sched = inProcessScheduler({ gpu: 1 })
    const hold1 = await sched.acquire('gpu', 10)

    const order: number[] = []
    const waiters = [80, 20, 40].map((priority) =>
      sched.acquire('gpu', priority).then((hold) => {
        order.push(priority)
        return hold
      }),
    )
    await Promise.resolve()

    hold1()
    const hold2 = await waiters[1]
    hold2()
    const hold3 = await waiters[2]
    hold3()
    const hold4 = await waiters[0]
    hold4()

    expect(order).toEqual([20, 40, 80])
  })

  it('FIFO au sein d’une meme priorite : trois attendants a 20 sont accordes dans l’ordre d’arrivee', async () => {
    const sched = inProcessScheduler({ gpu: 1 })
    const hold1 = await sched.acquire('gpu', 10)

    const order: number[] = []
    const waiters = [1, 2, 3].map((id) =>
      sched.acquire('gpu', 20).then((hold) => {
        order.push(id)
        return hold
      }),
    )
    await Promise.resolve()

    hold1()
    for (const waiter of waiters) {
      const hold = await waiter
      hold()
    }

    expect(order).toEqual([1, 2, 3])
  })

  it('un Hold est relache meme si l’appelant leve : le suivant est accorde', async () => {
    const sched = inProcessScheduler({ gpu: 1 })
    const hold1 = await sched.acquire('gpu', 10)

    let secondGranted = false
    const second = sched.acquire('gpu', 10).then(() => {
      secondGranted = true
    })

    expect(() => {
      try {
        throw new Error('boum')
      } finally {
        hold1()
      }
    }).toThrow('boum')

    await second
    expect(secondGranted).toBe(true)
  })

  it('appeler un Hold deux fois n’inflate pas le compteur de permis', async () => {
    const sched = inProcessScheduler({ gpu: 1 })
    const hold1 = await sched.acquire('gpu', 10)
    hold1()
    hold1()

    const hold2 = await sched.acquire('gpu', 10)

    let thirdGranted = false
    void sched.acquire('gpu', 10).then(() => {
      thirdGranted = true
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(thirdGranted).toBe(false)
    hold2()
  })
})

describe('acquire — annulation', () => {
  it('un signal deja aborted rejette et ne consomme pas de permis', async () => {
    const sched = inProcessScheduler({ gpu: 1 })
    const controller = new AbortController()
    controller.abort()

    await expect(sched.acquire('gpu', 10, controller.signal)).rejects.toThrow(StopRequestedError)

    const hold = await sched.acquire('gpu', 10)
    hold()
  })

  it('annuler en file rejette avec StopRequestedError plutot que de bloquer indefiniment', async () => {
    const sched = inProcessScheduler({ gpu: 1 })
    const hold1 = await sched.acquire('gpu', 10)
    const controller = new AbortController()

    const waiting = sched.acquire('gpu', 10, controller.signal)
    await Promise.resolve()
    controller.abort()

    const outcome = await Promise.race([
      waiting.then(() => 'resolved' as const, () => 'rejected' as const),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 200)),
    ])

    expect(outcome).toBe('rejected')
    await expect(waiting).rejects.toThrow(StopRequestedError)
    hold1()
  })

  it('annuler en file retire l’attendant : le permis va au suivant, pas a l’aborte', async () => {
    const sched = inProcessScheduler({ gpu: 1 })
    const hold1 = await sched.acquire('gpu', 10)
    const controller = new AbortController()

    const aborted = sched.acquire('gpu', 10, controller.signal)
    let nextGranted = false
    const next = sched.acquire('gpu', 20).then((hold) => {
      nextGranted = true
      return hold
    })
    await Promise.resolve()

    controller.abort()
    await expect(aborted).rejects.toThrow(StopRequestedError)

    // Removed immediately, not only at the next `release`: otherwise the
    // queue would stay inflated with a ghost until the next release.
    expect(sched.snapshot()).toContainEqual({ resource: 'gpu', held: 1, waiting: 1 })

    hold1()
    const holdNext = await next
    expect(nextGranted).toBe(true)
    holdNext()
  })

  it('annuler en file ne laisse aucun listener sur le signal', async () => {
    const sched = inProcessScheduler({ gpu: 1 })
    const hold1 = await sched.acquire('gpu', 10)

    let added = 0
    let removed = 0
    const signal = {
      aborted: false,
      addEventListener(_type: string, listener: () => void) {
        added++
        this._listener = listener
      },
      removeEventListener() {
        removed++
      },
      dispatch() {
        this.aborted = true
        this._listener?.()
      },
      _listener: undefined as (() => void) | undefined,
    }

    for (let i = 0; i < 3; i++) {
      const waiting = sched.acquire('gpu', 10, signal as unknown as AbortSignal)
      await Promise.resolve()
      signal.dispatch()
      await expect(waiting).rejects.toThrow(StopRequestedError)
      signal.aborted = false
      signal._listener = undefined
    }

    expect(added).toBe(3)
    expect(removed).toBe(3)
    hold1()
  })

  it('un token accorde dans le meme tick qu’un abort est transmis, pas perdu', async () => {
    const sched = inProcessScheduler({ gpu: 1 })
    const hold1 = await sched.acquire('gpu', 10)
    const controller = new AbortController()

    const aborted = sched.acquire('gpu', 10, controller.signal)
    let nextGranted = false
    const next = sched.acquire('gpu', 20).then((hold) => {
      nextGranted = true
      return hold
    })
    await Promise.resolve()

    controller.abort()
    hold1()

    await expect(aborted).rejects.toThrow(StopRequestedError)
    const holdNext = await next
    expect(nextGranted).toBe(true)
    holdNext()
  })

  it('annuler entre le jeton local et le creneau fichier relache le jeton local : le suivant est accorde', async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-scheduler-'))
    try {
      // Fast (microtask) polling on both sides: nothing here depends on a
      // real delay, only on the order of cancellation vs. release.
      const sched = createScheduler({ capacities: { gpu: 1, cpu: 0, net: 0 }, lockDir, sleep: immediateSleep })
      const lockFile = path.join(lockDir, '.resource-gpu.lock')
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, since: Date.now(), owner: 'outsider' }))

      const controller = new AbortController()
      const first = sched.acquire('gpu', 10, controller.signal)

      let secondGranted = false
      const second = sched.acquire('gpu', 20).then((hold) => {
        secondGranted = true
        return hold
      })

      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(secondGranted).toBe(false)

      controller.abort()
      await expect(first).rejects.toThrow(StopRequestedError)

      // The outsider releases the file: `second`, which got the local
      // token when `first` was aborted, can now complete.
      fs.rmSync(lockFile, { force: true })
      const hold2 = await second
      expect(secondGranted).toBe(true)
      hold2()
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true })
    }
  })
})

describe('acquire — onQueued', () => {
  it('ne se declenche pas quand la ressource est libre', async () => {
    const sched = inProcessScheduler({ gpu: 1 })
    const onQueued = vi.fn()

    const hold = await sched.acquire('gpu', 10, undefined, onQueued)

    expect(onQueued).not.toHaveBeenCalled()
    hold()
  })

  it('se declenche une fois quand la ressource est tenue ailleurs', async () => {
    const sched = inProcessScheduler({ gpu: 1 })
    const hold1 = await sched.acquire('gpu', 10)
    const onQueued = vi.fn()

    const waiting = sched.acquire('gpu', 10, undefined, onQueued)
    await Promise.resolve()

    expect(onQueued).toHaveBeenCalledTimes(1)

    hold1()
    const hold2 = await waiting
    expect(onQueued).toHaveBeenCalledTimes(1)
    hold2()
  })

  it('se declenche une seule fois meme si le jeton local puis le creneau fichier bloquent tous deux', async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-scheduler-'))
    try {
      const sched = createScheduler({ capacities: { gpu: 1, cpu: 0, net: 0 }, lockDir, sleep: immediateSleep })
      const lockFile = path.join(lockDir, '.resource-gpu.lock')
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, since: Date.now(), owner: 'outsider' }))

      const controller = new AbortController()
      const first = sched.acquire('gpu', 10, controller.signal)

      const onQueued = vi.fn()
      const second = sched.acquire('gpu', 20, undefined, onQueued)
      await Promise.resolve()
      expect(onQueued).toHaveBeenCalledTimes(1)

      controller.abort()
      await expect(first).rejects.toThrow(StopRequestedError)

      // `second` gets the local token and finds the file still busy:
      // announce() must not fire again for this second block.
      await Promise.resolve()
      await Promise.resolve()
      expect(onQueued).toHaveBeenCalledTimes(1)

      fs.rmSync(lockFile, { force: true })
      const hold2 = await second
      hold2()
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true })
    }
  })
})

describe('acquire — composition avec le creneau fichier', () => {
  let lockDir: string

  beforeEach(() => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-scheduler-'))
  })

  afterEach(() => {
    fs.rmSync(lockDir, { recursive: true, force: true })
  })

  it('deux ordonnanceurs sur le meme lockDir avec gpu: 1 ne tiennent jamais tous les deux', async () => {
    const pidAlive = (pid: number): boolean => pid === process.pid
    const a = createScheduler({ capacities: { gpu: 1, cpu: 0, net: 0 }, lockDir, sleep: immediateSleep, pidAlive })
    const b = createScheduler({ capacities: { gpu: 1, cpu: 0, net: 0 }, lockDir, sleep: immediateSleep, pidAlive })

    const holdA = await a.acquire('gpu', 10)

    let bGranted = false
    const waitingB = b.acquire('gpu', 10).then((hold) => {
      bGranted = true
      return hold
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(bGranted).toBe(false)

    holdA()
    const holdB = await waitingB
    expect(bGranted).toBe(true)
    holdB()
  })

  it('un creneau dont le pid est mort est repris apres staleMs ; un pid vivant ne l’est jamais', async () => {
    let clock = 1_000_000
    const now = (): number => clock

    const staleFile = path.join(lockDir, '.resource-gpu.lock')
    fs.writeFileSync(staleFile, JSON.stringify({ pid: 999_999, since: clock, owner: 'dead' }))
    clock += 120_001

    const deadPidSched = createScheduler({ capacities: { gpu: 1, cpu: 0, net: 0 }, lockDir, now, sleep: immediateSleep, pidAlive: () => false })
    const hold = await deadPidSched.acquire('gpu', 10)
    hold()

    const liveFile = path.join(lockDir, '.resource-cpu.lock')
    fs.writeFileSync(liveFile, JSON.stringify({ pid: process.pid, since: clock, owner: 'alive' }))
    clock += 10 * 24 * 60 * 60 * 1000

    const livePidSched = createScheduler({ capacities: { gpu: 0, cpu: 1, net: 0 }, lockDir, now, sleep: hangingSleep, pidAlive: () => true })
    const controller = new AbortController()
    const waiting = livePidSched.acquire('cpu', 10, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()

    await expect(waiting).rejects.toThrow(StopRequestedError)
  })
})

describe('releaseAll', () => {
  it('libere ce que ce processus tient sur le fichier : un autre ordonnanceur peut aussitot l’acquerir', async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-scheduler-release-all-'))
    try {
      const pidAlive = (pid: number): boolean => pid === process.pid
      const a = createScheduler({ capacities: { gpu: 1, cpu: 0, net: 0 }, lockDir, sleep: immediateSleep, pidAlive })
      const b = createScheduler({ capacities: { gpu: 1, cpu: 0, net: 0 }, lockDir, sleep: immediateSleep, pidAlive })

      await a.acquire('gpu', 10)
      a.releaseAll()

      const holdB = await b.acquire('gpu', 10)
      expect(b.snapshot()).toContainEqual({ resource: 'gpu', held: 1, waiting: 0 })
      holdB()
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true })
    }
  })
})

describe('sweepSchedulerSlots', () => {
  let lockDir: string

  beforeEach(() => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-scheduler-sweep-'))
  })

  afterEach(() => {
    fs.rmSync(lockDir, { recursive: true, force: true })
  })

  it('libere les creneaux a pid mort et laisse intacts ceux a pid vivant', () => {
    const deadFile = path.join(lockDir, '.resource-gpu.lock')
    const aliveFile = path.join(lockDir, '.resource-cpu.lock')
    fs.writeFileSync(deadFile, JSON.stringify({ pid: 999_999, since: Date.now(), owner: 'dead' }))
    fs.writeFileSync(aliveFile, JSON.stringify({ pid: process.pid, since: Date.now(), owner: 'alive' }))

    const freed = sweepSchedulerSlots(lockDir, (pid) => pid === process.pid)

    expect(freed).toBe(1)
    expect(fs.existsSync(deadFile)).toBe(false)
    expect(fs.existsSync(aliveFile)).toBe(true)
  })
})
