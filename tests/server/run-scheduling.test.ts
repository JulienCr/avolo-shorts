import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CAPACITIES } from '@/core/resources'
import { applySettings, openDb, upsertProject } from '@/server/db'
import { launch, lireStatus, progression, progressionAll, stopRun, wait, type Steps } from '@/server/run'
import { candidatesPath } from '@/server/paths'
import { createScheduler, type Scheduler, type Hold } from '@/server/scheduler'
import { snapshotEnv } from '../helpers/env'

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
const restoreEnv = snapshotEnv()

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
  restoreEnv()
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

/**
 * PR E : `execute()` walks the plan as the DAG it describes, not as a flat
 * list. `correction`/`candidates` on one side and `proxy`/`analysis` on the
 * other have no edge between them, so a network step from one chain can run
 * alongside the local step the other chain holds — never two local steps at
 * once (`isLocal`, `src/core/resources.ts`).
 */
describe('un projet, deux chaînes du graphe', () => {
  /** Poses `correction.json` next to the transcript `createProjectFixture` already wrote. */
  function writeCorrection(id: string): void {
    const folder = path.join(root, 'projects', id, `${id}.avolo`)
    fs.writeFileSync(path.join(folder, 'correction.json'), '{"entries":[]}')
  }

  it('n’admet qu’une étape locale à la fois, même quand deux sont prêtes', async () => {
    createProjectFixture(A)
    const gateTranscript = deferred()

    await launch(A, ['transcript', 'proxy'], {
      db,
      scheduler: testScheduler,
      steps: {
        ...stepsTranscript(A, gateTranscript.promise),
        buildProxy: async () => {
          calls.push(`${A}:proxy:start`)
          const file = path.join(root, 'projects', A, 'proxy.mp4')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, '')
          calls.push(`${A}:proxy:done`)
          return { path: file, skipped: false }
        },
      },
    })
    await pollUntil(() => calls.includes(`${A}:transcript:start`))
    // No edge from `proxy` to `transcript`: it is ready from the start, but
    // both are local — `priorityFor` (transcript: 20, proxy: 80) decides
    // which one holds the only slot.
    expect(calls).not.toContain(`${A}:proxy:start`)

    gateTranscript.resolve()
    await wait(A)
    expect(calls).toEqual([
      `${A}:transcript:start`,
      `${A}:transcript:done`,
      `${A}:proxy:start`,
      `${A}:proxy:done`,
    ])
  })

  it('le placeholder posé au lancement ne fait pas croire que proxy tourne déjà', async () => {
    createProjectFixture(A, { audio: false })
    const gateAudio = deferred()
    const gateProxy = deferred()

    // `plan` is `['proxy', 'audio']` (target order), but `priorityFor` admits
    // `audio` first: the launch-time placeholder, keyed on `plan[0]`
    // (`proxy`), must not linger as a second, never-started entry.
    await launch(A, ['proxy', 'audio'], {
      db,
      scheduler: testScheduler,
      steps: {
        extractAudio: async () => {
          calls.push(`${A}:audio:start`)
          await gateAudio.promise
          const file = path.join(root, 'projects', A, 'audio.wav')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, '')
          return { path: file, skipped: false }
        },
        buildProxy: async () => {
          calls.push(`${A}:proxy:start`)
          await gateProxy.promise
          const file = path.join(root, 'projects', A, 'proxy.mp4')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, '')
          return { path: file, skipped: false }
        },
      },
    })

    await pollUntil(() => calls.includes(`${A}:audio:start`))
    expect(progressionAll(A).map((p) => p.step)).toEqual(['audio'])

    gateAudio.resolve()
    await pollUntil(() => calls.includes(`${A}:proxy:start`))
    expect(progressionAll(A).map((p) => p.step)).toEqual(['proxy'])

    gateProxy.resolve()
    await wait(A)
  })

  it('le règlement d’une étape publie tout de suite, sans attendre le tic d’une sœur', async () => {
    createProjectFixture(A, { transcript: true })
    writeCorrection(A)
    const gateProxy = deferred()

    await launch(A, ['candidates', 'proxy'], {
      db,
      scheduler: testScheduler,
      steps: {
        buildProxy: async () => {
          calls.push(`${A}:proxy:start`)
          await gateProxy.promise
          const file = path.join(root, 'projects', A, 'proxy.mp4')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, '')
          return { path: file, skipped: false }
        },
        // No `onProgress` call at all: if `status.json` only updates on a
        // progress tick, it never sees `candidates` settle.
        runCandidates: async () => {
          calls.push(`${A}:candidates:start`)
          calls.push(`${A}:candidates:done`)
          return []
        },
      },
    })

    await pollUntil(() => calls.includes(`${A}:candidates:done`))
    await pollUntil(() => lireStatus(A)?.running?.step === 'proxy')
    expect(lireStatus(A)?.running?.step).toBe('proxy')

    gateProxy.resolve()
    await wait(A)
  })

  it('correction sur le réseau tourne pendant que proxy encode encore', async () => {
    createProjectFixture(A, { transcript: true })
    const gateProxy = deferred()
    const gateCorrection = deferred()

    await launch(A, ['correction', 'proxy'], {
      db,
      scheduler: testScheduler,
      steps: {
        buildProxy: async () => {
          calls.push(`${A}:proxy:start`)
          await gateProxy.promise
          const file = path.join(root, 'projects', A, 'proxy.mp4')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, '')
          calls.push(`${A}:proxy:done`)
          return { path: file, skipped: false }
        },
        applyTranscriptCorrections: async () => {
          calls.push(`${A}:correction:start`)
          await gateCorrection.promise
          calls.push(`${A}:correction:done`)
          return { entries: [], applied: 0, failed: 0, rejected: {} }
        },
      },
    })

    // A recorded overlap, never a timing measurement: both started before
    // either finished. `correction` (priority 30) is admitted before `proxy`
    // (80), but never blocks it — it is a network step.
    await pollUntil(() => calls.includes(`${A}:correction:start`))
    await pollUntil(() => calls.includes(`${A}:proxy:start`))
    expect(calls).toEqual([`${A}:correction:start`, `${A}:proxy:start`])

    gateCorrection.resolve()
    await pollUntil(() => calls.includes(`${A}:correction:done`))
    expect(calls).not.toContain(`${A}:proxy:done`)

    gateProxy.resolve()
    await wait(A)
    expect(calls).toEqual([
      `${A}:correction:start`,
      `${A}:proxy:start`,
      `${A}:correction:done`,
      `${A}:proxy:done`,
    ])
  })

  it('une panne sur une branche laisse l’autre finir, et l’erreur remontée est celle de la branche qui a cassé', async () => {
    createProjectFixture(A)
    const gateProxy = deferred()

    await launch(A, ['candidates', 'proxy', 'analysis'], {
      db,
      scheduler: testScheduler,
      steps: {
        transcribe: async () => {
          calls.push(`${A}:transcript:start`)
          throw new Error('panne simulée de la transcription')
        },
        buildProxy: async () => {
          calls.push(`${A}:proxy:start`)
          await gateProxy.promise
          const file = path.join(root, 'projects', A, 'proxy.mp4')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, '')
          calls.push(`${A}:proxy:done`)
          return { path: file, skipped: false }
        },
        runAnalysis: async () => {
          calls.push(`${A}:analysis:start`)
          const file = path.join(root, 'projects', A, 'analysis.json')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, '')
          return { path: file, skipped: false }
        },
        applyTranscriptCorrections: async () => {
          calls.push(`${A}:correction:start`)
          return { entries: [], applied: 0, failed: 0, rejected: {} }
        },
        runCandidates: async () => {
          calls.push(`${A}:candidates:start`)
          return []
        },
      },
    })

    await pollUntil(() => calls.includes(`${A}:proxy:start`))
    gateProxy.resolve()
    await wait(A).catch(() => {})

    // `proxy` finished and `analysis` followed, despite the transcript
    // failure. `correction` and `candidates` never started: their dependency
    // (`transcript`) never reaches `done`.
    expect(calls).toEqual([
      `${A}:transcript:start`,
      `${A}:proxy:start`,
      `${A}:proxy:done`,
      `${A}:analysis:start`,
    ])
    expect(lireStatus(A)?.error).toContain('panne simulée de la transcription')
    expect(lireStatus(A)?.stopped).toBe(false)
  })

  it('un échec de candidates ne perturbe pas le proxy en cours, et se lit comme un échec (pas un arrêt)', async () => {
    createProjectFixture(A, { transcript: true })
    writeCorrection(A)
    const gateProxy = deferred()

    await launch(A, ['candidates', 'proxy'], {
      db,
      scheduler: testScheduler,
      steps: {
        runCandidates: async () => {
          calls.push(`${A}:candidates:start`)
          throw new Error('panne simulée du repérage')
        },
        buildProxy: async () => {
          calls.push(`${A}:proxy:start`)
          await gateProxy.promise
          const file = path.join(root, 'projects', A, 'proxy.mp4')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, '')
          calls.push(`${A}:proxy:done`)
          return { path: file, skipped: false }
        },
      },
    })

    await pollUntil(() => calls.includes(`${A}:candidates:start`) && calls.includes(`${A}:proxy:start`))
    gateProxy.resolve()
    await wait(A).catch(() => {})

    // `proxy` finished normally, with no idea `candidates` broke next to it.
    expect(calls).toContain(`${A}:proxy:done`)
    // `failed`/`running` (candidates) are never published as such, but they
    // read through `error`/`stopped`: a real failure writes `error`, a
    // requested stop would write `stopped` with no `error`.
    const status = lireStatus(A)
    expect(status?.error).toContain('panne simulée du repérage')
    expect(status?.stopped).toBe(false)
  })

  it('draine les deux branches avant de conclure, sur un arrêt demandé', async () => {
    createProjectFixture(A, { transcript: true })
    writeCorrection(A)
    const gateProxy = deferred()
    const gateCandidates = deferred()

    await launch(A, ['candidates', 'proxy'], {
      db,
      scheduler: testScheduler,
      steps: {
        buildProxy: async () => {
          calls.push(`${A}:proxy:start`)
          await gateProxy.promise
          calls.push(`${A}:proxy:done`)
          const file = path.join(root, 'projects', A, 'proxy.mp4')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, '')
          return { path: file, skipped: false }
        },
        runCandidates: async () => {
          calls.push(`${A}:candidates:start`)
          await gateCandidates.promise
          calls.push(`${A}:candidates:done`)
          return []
        },
      },
    })

    await pollUntil(() => calls.includes(`${A}:proxy:start`) && calls.includes(`${A}:candidates:start`))
    expect(stopRun(A)).toBe(true)

    // `proxy` releases on its own: `candidates` still holds the work, so the
    // table must not have emptied yet — the drain is under test, not which
    // of the two lands first.
    gateProxy.resolve()
    await pollUntil(() => calls.includes(`${A}:proxy:done`))
    expect(progression(A)).not.toBeNull()
    expect(lireStatus(A)?.stopped).not.toBe(true)

    gateCandidates.resolve()
    await wait(A)
    expect(progression(A)).toBeNull()
    expect(lireStatus(A)?.stopped).toBe(true)
  })

  it('advance() attribue le progrès à la bonne étape, et runningAll porte les deux étapes en cours', async () => {
    createProjectFixture(A, { transcript: true })
    writeCorrection(A)
    const gateProxy = deferred()
    const gateCandidates = deferred()

    await launch(A, ['candidates', 'proxy'], {
      db,
      scheduler: testScheduler,
      steps: {
        buildProxy: async (o) => {
          calls.push(`${A}:proxy:start`)
          o.onProgress?.({ seconds: 30, fraction: 0.5 })
          await gateProxy.promise
          const file = path.join(root, 'projects', A, 'proxy.mp4')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, '')
          return { path: file, skipped: false }
        },
        runCandidates: async () => {
          calls.push(`${A}:candidates:start`)
          await gateCandidates.promise
          return []
        },
      },
    })

    await pollUntil(() => calls.includes(`${A}:proxy:start`) && calls.includes(`${A}:candidates:start`))
    await pollUntil(() => (progressionAll(A).find((p) => p.step === 'proxy')?.progress ?? 0) > 0)

    const all = progressionAll(A)
    expect(all.map((p) => p.step)).toEqual(['candidates', 'proxy'])
    expect(all.find((p) => p.step === 'proxy')?.progress).toBeGreaterThan(0)
    // `candidates` never reports a fraction: its entry stays at zero,
    // `proxy`'s advance never reached it.
    expect(all.find((p) => p.step === 'candidates')?.progress).toBe(0)
    // `running` stays the leader (highest priority): candidates (40) < proxy (80).
    expect(progression(A)?.step).toBe('candidates')

    gateCandidates.resolve()
    gateProxy.resolve()
    await wait(A)
  })

  it('un jeton dont la libération lève ne fait pas conclure execute() pendant qu’un frère tourne', async () => {
    createProjectFixture(A, { transcript: true })
    writeCorrection(A)
    const gateCandidates = deferred()

    // `hold()` can throw (a failed `releaseSlot`) without losing the local
    // token — see `tests/server/scheduler.test.ts`. `runStep`'s `finally`
    // must absorb it, or the promise it returns rejects and wins
    // `Promise.race` while `candidates` is still gated below.
    const throwing: Scheduler = {
      ...testScheduler,
      acquire: async (resource, priority, signal, onQueued) => {
        const hold = await testScheduler.acquire(resource, priority, signal, onQueued)
        if (resource !== 'cpu') return hold
        return (() => {
          hold()
          throw new Error('boom: échec simulé de releaseSlot')
        }) as Hold
      },
    }

    await launch(A, ['candidates', 'proxy'], {
      db,
      scheduler: throwing,
      steps: {
        buildProxy: async () => {
          calls.push(`${A}:proxy:start`)
          calls.push(`${A}:proxy:done`)
          const file = path.join(root, 'projects', A, 'proxy.mp4')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, '')
          return { path: file, skipped: false }
        },
        runCandidates: async () => {
          calls.push(`${A}:candidates:start`)
          await gateCandidates.promise
          calls.push(`${A}:candidates:done`)
          return []
        },
      },
    })

    await pollUntil(() => calls.includes(`${A}:proxy:done`) && calls.includes(`${A}:candidates:start`))
    expect(progression(A)).not.toBeNull()

    gateCandidates.resolve()
    await wait(A)
    expect(calls).toContain(`${A}:candidates:done`)
  })

  it('une panne déjà enregistrée survit à un arrêt demandé après coup', async () => {
    createProjectFixture(A, { transcript: true })
    writeCorrection(A)
    const gateProxy = deferred()

    await launch(A, ['candidates', 'proxy'], {
      db,
      scheduler: testScheduler,
      steps: {
        runCandidates: async () => {
          calls.push(`${A}:candidates:start`)
          throw new Error('panne simulée du repérage')
        },
        buildProxy: async () => {
          calls.push(`${A}:proxy:start`)
          await gateProxy.promise
          calls.push(`${A}:proxy:done`)
          const file = path.join(root, 'projects', A, 'proxy.mp4')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, '')
          return { path: file, skipped: false }
        },
      },
    })

    await pollUntil(() => calls.includes(`${A}:candidates:start`) && calls.includes(`${A}:proxy:start`))
    // `candidates` throws synchronously: wait for the pump's own bookkeeping
    // to have recorded its failure before stopping, so the race under test
    // (a stop landing after a failure, not concurrently with it) is real.
    await pollUntil(() => progressionAll(A).length === 1 && progressionAll(A)[0]?.step === 'proxy')
    expect(stopRun(A)).toBe(true)

    gateProxy.resolve()
    await wait(A).catch(() => {})
    const status = lireStatus(A)
    expect(status?.error).toContain('panne simulée du repérage')
    expect(status?.stopped).toBe(false)
  })
})
