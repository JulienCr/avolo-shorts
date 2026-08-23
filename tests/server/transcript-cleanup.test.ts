import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChildProcess } from 'node:child_process'

import * as ffmpeg from '@/server/ffmpeg'
import { placeSidecar, audioPath, projectDir } from '@/server/paths'
import { transcribe } from '@/server/steps/transcript'

/**
 * **Un module entier plutôt qu'un `spyOn`.** Node expose `spawn` en export
 * ESM figé — `vi.spyOn` refuse de le redéfinir. `vi.mock` remplace le module
 * avant tout import ; le processus qu'il rend vient de `currentProc`, posé
 * par chaque test juste avant d'appeler `transcribe`.
 */
let currentProc: ChildProcess
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: () => currentProc }
})

/**
 * `transcribe()` — ce qui arrive au `correction.json` écarté quand sa
 * suppression finale échoue (issue #141).
 *
 * **Le worker est simulé**, jamais lancé pour de vrai : ces tests n'ont ni
 * GPU ni venv à disposition, et ce qui se vérifie ici — l'ordre
 * écarter/publier/nettoyer, la tolérance du dernier maillon — ne dépend pas
 * de WhisperX.
 */

const SOURCE = '2026-03-08-caro-mdlm.mp4'
const ID = '2026-03-08-caro-mdlm'

let root: string

/** Un `ChildProcess` minimal : deux flux vides, `close(0)` sur demande. */
function fakeProc(): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess
  Object.assign(proc, { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  return proc
}

/**
 * Attend que `launchWorker` ait posé son écouteur `close`, avant de
 * l'émettre. `transcribe()` fait plusieurs `await` (sondage du montage,
 * `placeSidecar`) avant d'atteindre `spawn` : émettre trop tôt part dans le
 * vide, et le test attend indéfiniment un événement qui a déjà eu lieu.
 */
async function waitForListener(emitter: EventEmitter, event: string): Promise<void> {
  for (let i = 0; i < 200 && emitter.listenerCount(event) === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(emitter.listenerCount(event)).toBeGreaterThan(0)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-transcribe-'))
  const replay = path.join(root, 'Replay')
  const stage = path.join(root, 'stage')
  const projects = path.join(root, 'projects')
  for (const d of [replay, stage, projects]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(replay, SOURCE), 'pas vraiment une vidéo')

  process.env.REPLAY_DIR = replay
  process.env.STAGE_DIR = stage
  process.env.PROJECTS_DIR = projects
  process.env.WHISPER_PYTHON = '/usr/bin/python3'

  const worker = path.join(root, 'transcribe.py')
  fs.writeFileSync(worker, '# pas vraiment un worker')
  process.env.WHISPER_WORKER = worker

  fs.mkdirSync(projectDir(ID), { recursive: true })
  fs.writeFileSync(audioPath(ID), 'pas vraiment un wav')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('transcribe — nettoyage du correction.json écarté', () => {
  it('publie le transcript même si la suppression du correction.json écarté échoue', async () => {
    // Un journal déjà là, pour que `hadCorrection` soit vrai et que le
    // chemin d'écartement s'exerce.
    const placement = placeSidecar(SOURCE, ID)
    fs.mkdirSync(placement.dir, { recursive: true })
    fs.writeFileSync(placement.correction, JSON.stringify({ entries: [] }))

    const proc = fakeProc()
    currentProc = proc

    // **Le premier appel à `pathTemporary` nomme le fichier que le worker
    // écrirait.** Le nôtre n'en fait rien : on le crée nous-mêmes, une fois
    // ce nom connu, pour que le renommage qui publie le transcript trouve
    // quelque chose.
    let expectedOutput: string | undefined
    const realPathTemporary = ffmpeg.pathTemporary
    vi.spyOn(ffmpeg, 'pathTemporary').mockImplementation((dst, token) => {
      const p = realPathTemporary(dst, token)
      expectedOutput ??= p
      return p
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Seule la suppression du fichier écarté (`.partiel-`) échoue — celle du
    // fichier temporaire du transcript, dans le `catch` global, doit rester
    // silencieuse comme avant.
    const original = fsp.rm
    vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      if (String(target).includes('correction.partiel')) {
        throw new Error('EIO: i/o error')
      }
      return original(target, options)
    })

    const result = transcribe({ source: SOURCE, projectId: ID, audio: audioPath(ID) })
    await waitForListener(proc, 'close')
    if (expectedOutput === undefined) throw new Error('pathTemporary jamais appelé')
    fs.writeFileSync(expectedOutput, JSON.stringify({ language: 'fr', segments: [] }))
    proc.stdout?.emit('end')
    proc.stderr?.emit('end')
    proc.emit('close', 0, null)

    await expect(result).resolves.toMatchObject({ skipped: false })
    // Le transcript est bien publié — la panne de nettoyage ne l'a pas fait
    // échouer.
    expect(fs.existsSync(placement.transcript)).toBe(true)
    // Mais elle n'est pas passée inaperçue.
    expect(warn).toHaveBeenCalled()
  })
})
