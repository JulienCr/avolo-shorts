import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CAPACITIES } from '@/core/resources'
import { applySettings, openDb, upsertProject } from '@/server/db'
import { launch, lireStatus, progression, stopRun, wait, type Steps } from '@/server/run'
import { candidatesPath } from '@/server/paths'
import { createScheduler, type Scheduler } from '@/server/scheduler'

/**
 * The resource scheduler, wired into the runner (PR D): two projects
 * contending on `gpu` no longer run at the same time.
 *
 * **No video, no real GPU.** Steps are witnesses driven by promises opened
 * by hand — the same discipline as `tests/server/run.test.ts` — and the
 * scheduler runs in memory only (`lockDir: null`), never against a real
 * lock file.
 */

const A = 'show-a'
const B = 'show-b'
const C = 'show-c'

let root: string
let db: Database.Database
let calls: string[]
let testScheduler: Scheduler
let openGates: Array<() => void>

/**
 * A promise opened from the outside, to drive a step by hand.
 *
 * @remarks Registers its `resolve` in `openGates` so `afterEach` can release
 * it even if the test failed an assertion before calling it — otherwise
 * `stopRun`/`wait` below hangs on a witness still awaiting this gate, and a
 * real assertion failure is masked by an opaque timeout.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  openGates.push(resolve)
  return { promise, resolve }
}

/** A minimal project: source, known duration, and its audio already there by default. */
function createProjectFixture(id: string, o: { audio?: boolean; transcript?: boolean } = {}): void {
  const source = path.join(root, 'replays', `${id}.mp4`)
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, '')
  if (o.audio !== false) {
    const audio = path.join(root, 'projects', id, 'audio.wav')
    fs.mkdirSync(path.dirname(audio), { recursive: true })
    fs.writeFileSync(audio, '')
  }
  if (o.transcript === true) {
    const folder = path.join(root, 'projects', id, `${id}.avolo`)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'transcript.json'), '{"segments":[]}')
  }
  upsertProject(db, {
    id,
    sourcePath: source,
    stagedPath: null,
    durationSec: 60,
    sizeBytes: 0,
    mtimeMs: 0,
    createdAt: 0,
  })
}

/** `transcribe`, driven by `gate`: pushes `id:transcript:start`, waits, writes, pushes `:done`. */
function stepsTranscript(id: string, gate: Promise<void>): Partial<Steps> {
  return {
    transcribe: async () => {
      calls.push(`${id}:transcript:start`)
      await gate
      const file = path.join(root, 'projects', id, `${id}.avolo`, 'transcript.json')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, '{"segments":[]}')
      calls.push(`${id}:transcript:done`)
      return { path: file, skipped: false, fallback: true }
    },
  }
}

/** Polls until `predicate` is true — never a fixed delay. */
async function pollUntil(predicate: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(predicate()).toBe(true)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-scheduling-'))
  process.env.REPLAY_DIR = path.join(root, 'replays')
  process.env.STAGE_DIR = path.join(root, 'stage')
  process.env.PROJECTS_DIR = path.join(root, 'projects')
  fs.mkdirSync(process.env.REPLAY_DIR, { recursive: true })
  db = openDb(':memory:')
  // Not relevant here: only step scheduling is under test, not ingestion.
  applySettings(db, { ingestion: { copySourceLocally: false } })
  calls = []
  openGates = []
  testScheduler = createScheduler({ capacities: CAPACITIES, lockDir: null })
})

afterEach(async () => {
  for (const resolve of openGates) resolve()
  for (const id of [A, B, C]) stopRun(id)
  await Promise.all([A, B, C].map((id) => wait(id)))
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('deux projets, un programmateur commun', () => {
  it('B n’avance pas tant que A tient le gpu, et démarre à sa libération', async () => {
    createProjectFixture(A)
    createProjectFixture(B)
    const gateA = deferred()

    await launch(A, ['transcript'], { db, scheduler: testScheduler, steps: stepsTranscript(A, gateA.promise) })
    await pollUntil(() => calls.includes(`${A}:transcript:start`))

    await launch(B, ['transcript'], { db, scheduler: testScheduler, steps: stepsTranscript(B, Promise.resolve()) })
    await pollUntil(() => progression(B)?.waiting?.resource === 'gpu')
    expect(calls).not.toContain(`${B}:transcript:start`)

    gateA.resolve()
    await wait(A)
    await wait(B)

    expect(calls).toEqual([
      `${A}:transcript:start`,
      `${A}:transcript:done`,
      `${B}:transcript:start`,
      `${B}:transcript:done`,
    ])
  })

  it('progression(B) porte l’attente, puis son extinction à l’octroi', async () => {
    createProjectFixture(A)
    createProjectFixture(B)
    const gateA = deferred()
    const gateB = deferred()

    await launch(A, ['transcript'], { db, scheduler: testScheduler, steps: stepsTranscript(A, gateA.promise) })
    await pollUntil(() => calls.includes(`${A}:transcript:start`))

    await launch(B, ['transcript'], { db, scheduler: testScheduler, steps: stepsTranscript(B, gateB.promise) })
    await pollUntil(() => progression(B)?.waiting !== null)
    expect(progression(B)?.waiting?.resource).toBe('gpu')
    expect(progression(B)?.waiting?.waitedMs).toBeGreaterThanOrEqual(0)

    gateA.resolve()
    await pollUntil(() => calls.includes(`${B}:transcript:start`))
    expect(progression(B)?.waiting).toBeNull()

    gateB.resolve()
    await wait(A)
    await wait(B)
  })

  it('status.json porte l’attente au repérage, sans attendre la temporisation d’écriture', async () => {
    createProjectFixture(A)
    createProjectFixture(B)
    const gateA = deferred()
    const gateB = deferred()

    await launch(A, ['transcript'], { db, scheduler: testScheduler, steps: stepsTranscript(A, gateA.promise) })
    await pollUntil(() => calls.includes(`${A}:transcript:start`))

    await launch(B, ['transcript'], { db, scheduler: testScheduler, steps: stepsTranscript(B, gateB.promise) })
    await pollUntil(() => lireStatus(B)?.running?.waiting !== null)
    expect(lireStatus(B)?.running?.waiting?.resource).toBe('gpu')

    gateA.resolve()
    await pollUntil(() => lireStatus(B)?.running?.waiting === null)
    expect(lireStatus(B)?.running?.step).toBe('transcript')

    gateB.resolve()
    await wait(A)
    await wait(B)
  })

  it('stopRun sur une exécution en file l’arrête sans jamais acquérir, et le jeton passe au suivant', async () => {
    createProjectFixture(A)
    createProjectFixture(B)
    createProjectFixture(C)
    const gateA = deferred()
    const gateC = deferred()

    await launch(A, ['transcript'], { db, scheduler: testScheduler, steps: stepsTranscript(A, gateA.promise) })
    await pollUntil(() => calls.includes(`${A}:transcript:start`))

    await launch(B, ['transcript'], { db, scheduler: testScheduler, steps: stepsTranscript(B, Promise.resolve()) })
    await pollUntil(() => progression(B)?.waiting !== null)

    await launch(C, ['transcript'], { db, scheduler: testScheduler, steps: stepsTranscript(C, gateC.promise) })
    await pollUntil(() => progression(C)?.waiting !== null)

    expect(stopRun(B)).toBe(true)
    await wait(B)
    expect(progression(B)).toBeNull()
    expect(calls).not.toContain(`${B}:transcript:start`)
    expect(lireStatus(B)?.stopped).toBe(true)

    // A alone still holds the token: B never took it.
    expect(testScheduler.snapshot().find((s) => s.resource === 'gpu')).toMatchObject({ held: 1 })

    gateA.resolve()
    await pollUntil(() => calls.includes(`${C}:transcript:start`))
    gateC.resolve()
    await wait(A)
    await wait(C)
  })

  it('une étape qui échoue avec le jeton en main le relâche : le suivant est servi', async () => {
    createProjectFixture(A)
    createProjectFixture(B)
    const gateA = deferred()
    const stepsThrowing: Partial<Steps> = {
      transcribe: async () => {
        calls.push(`${A}:transcript:start`)
        await gateA.promise
        throw new Error('échec simulé de la transcription')
      },
    }

    await launch(A, ['transcript'], { db, scheduler: testScheduler, steps: stepsThrowing })
    await pollUntil(() => calls.includes(`${A}:transcript:start`))

    await launch(B, ['transcript'], { db, scheduler: testScheduler, steps: stepsTranscript(B, Promise.resolve()) })
    await pollUntil(() => progression(B)?.waiting !== null)

    gateA.resolve()
    await wait(A).catch(() => {})
    expect(lireStatus(A)?.error).toContain('échec simulé')

    await pollUntil(() => calls.includes(`${B}:transcript:start`))
    await wait(B)
    expect(calls).toContain(`${B}:transcript:done`)
  })
})

describe('`audio` ne réserve rien', () => {
  it('un jeton cpu tenu par un autre projet ne bloque pas `audio`', async () => {
    createProjectFixture(A)
    createProjectFixture(B, { audio: false })
    const gateA = deferred()

    await launch(A, ['proxy'], {
      db,
      scheduler: testScheduler,
      steps: {
        buildProxy: async () => {
          calls.push(`${A}:proxy:start`)
          await gateA.promise
          const file = path.join(root, 'projects', A, 'proxy.mp4')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, '')
          return { path: file, skipped: false }
        },
      },
    })
    await pollUntil(() => calls.includes(`${A}:proxy:start`))
    expect(testScheduler.snapshot().find((s) => s.resource === 'cpu')).toMatchObject({ held: 1 })

    await launch(B, ['audio'], {
      db,
      scheduler: testScheduler,
      steps: {
        extractAudio: async () => {
          calls.push(`${B}:audio:start`)
          const file = path.join(root, 'projects', B, 'audio.wav')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, '')
          calls.push(`${B}:audio:done`)
          return { path: file, skipped: false }
        },
      },
    })
    await wait(B)
    expect(calls).toEqual([`${A}:proxy:start`, `${B}:audio:start`, `${B}:audio:done`])

    gateA.resolve()
    await wait(A)
  })
})

describe('la correction sur Ollama contend avec le transcript', () => {
  it('sur Ollama, elle attend le gpu que `transcript` occupe', async () => {
    createProjectFixture(A)
    createProjectFixture(B, { transcript: true })
    applySettings(db, { ai: { correctionProvider: 'ollama' } })
    const gateA = deferred()

    await launch(A, ['transcript'], { db, scheduler: testScheduler, steps: stepsTranscript(A, gateA.promise) })
    await pollUntil(() => calls.includes(`${A}:transcript:start`))

    await launch(B, ['correction'], {
      db,
      scheduler: testScheduler,
      steps: {
        applyTranscriptCorrections: async () => {
          calls.push(`${B}:correction:start`)
          return { entries: [], applied: 0, failed: 0, rejected: {} }
        },
      },
    })
    await pollUntil(() => progression(B)?.waiting?.resource === 'gpu')
    expect(calls).not.toContain(`${B}:correction:start`)

    gateA.resolve()
    await wait(A)
    await wait(B)
    expect(calls).toContain(`${B}:correction:start`)
  })

  it('sur le réseau, elle ne contend pas avec `transcript` sur le gpu', async () => {
    createProjectFixture(A)
    createProjectFixture(C, { transcript: true })
    // Default provider, not Ollama: `correction` reserves `net`, not `gpu`.
    const gateA = deferred()

    await launch(A, ['transcript'], { db, scheduler: testScheduler, steps: stepsTranscript(A, gateA.promise) })
    await pollUntil(() => calls.includes(`${A}:transcript:start`))

    await launch(C, ['correction'], {
      db,
      scheduler: testScheduler,
      steps: {
        applyTranscriptCorrections: async () => {
          calls.push(`${C}:correction:start`)
          return { entries: [], applied: 0, failed: 0, rejected: {} }
        },
      },
    })
    await wait(C)
    expect(calls).toContain(`${C}:correction:start`)

    gateA.resolve()
    await wait(A)
  })

  it('un basculement vers Ollama en cours d’exécution reclasse `correction` sur le gpu', async () => {
    createProjectFixture(A)
    createProjectFixture(B)
    const gateA = deferred()
    const gateB = deferred()

    // Network provider at launch: under the old frozen classification,
    // `correction` would stay on `net` even after the switch below.
    await launch(B, ['correction'], {
      db,
      scheduler: testScheduler,
      steps: {
        transcribe: stepsTranscript(B, gateB.promise).transcribe,
        applyTranscriptCorrections: async () => {
          calls.push(`${B}:correction:start`)
          return { entries: [], applied: 0, failed: 0, rejected: {} }
        },
      },
    })
    await pollUntil(() => calls.includes(`${B}:transcript:start`))

    await launch(A, ['transcript'], { db, scheduler: testScheduler, steps: stepsTranscript(A, gateA.promise) })
    await pollUntil(() => progression(A)?.waiting?.resource === 'gpu')

    // Switched while B still holds the gpu for its transcript — so before
    // the `correction` step runs.
    applySettings(db, { ai: { correctionProvider: 'ollama' } })

    gateB.resolve()
    // A was queued before B released the gpu: it gets it first, so B's
    // `correction` must in turn wait for it.
    await pollUntil(() => progression(B)?.step === 'correction' && progression(B)?.waiting?.resource === 'gpu')
    expect(calls).not.toContain(`${B}:correction:start`)

    gateA.resolve()
    await wait(A)
    await wait(B)
    expect(calls).toContain(`${B}:correction:start`)
  })
})

describe('`renders` reste hors du programmateur', () => {
  it('n’attend pas le gpu déjà tenu par un autre projet avant d’échouer', async () => {
    createProjectFixture(A)
    createProjectFixture(B)
    fs.writeFileSync(candidatesPath(B), '[]')
    const gateA = deferred()

    await launch(A, ['transcript'], { db, scheduler: testScheduler, steps: stepsTranscript(A, gateA.promise) })
    await pollUntil(() => calls.includes(`${A}:transcript:start`))

    await launch(B, ['renders'], { db, scheduler: testScheduler, steps: {} })
    await wait(B).catch(() => {})

    expect(progression(B)).toBeNull()
    expect(lireStatus(B)?.error).toContain('Le rendu ne se lance pas')
    expect(testScheduler.snapshot().find((s) => s.resource === 'gpu')).toMatchObject({ held: 1, waiting: 0 })

    gateA.resolve()
    await wait(A)
  })
})
