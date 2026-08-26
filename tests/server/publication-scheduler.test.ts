import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Clip } from '@/core/edl'
import { PLATFORMS, type Platform } from '@/core/publication'
import {
  closeDb,
  getDb,
  getPublications,
  putClip,
  schedulePublications,
  upsertProject,
} from '@/server/db'
import type { PlatformOutcome, PublicationAdapter, PublicationJob } from '@/server/publication/adapter'
import { forgetAll } from '@/server/publication/registry'
import { runOnePass, type SchedulerDeps } from '@/server/publication/scheduler'
import type { Artifact, OptionsArtifact } from '@/server/ffmpeg'
import type { Probe } from '@/server/ffprobe'
import { renderClip } from '@/server/steps/render'

/**
 * `runOnePass` de bout en bout : verrou de fichier, réessais et courriel
 * d'alerte, avec un vrai clip rendu (comme `publish-route.test.ts`) et un
 * connecteur, une horloge et une boîte mail entièrement injectés.
 */

vi.mock('@/server/ffmpeg', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/ffmpeg')>()
  return {
    ...original,
    produceArtifact: async (o: OptionsArtifact): Promise<Artifact> => {
      o.args(`${o.dst}.partiel`)
      fs.mkdirSync(path.dirname(o.dst), { recursive: true })
      fs.writeFileSync(o.dst, 'un MP4 pour de faux')
      return { path: o.dst, skipped: false }
    },
  }
})

vi.mock('@/server/ffprobe', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/ffprobe')>()
  return {
    ...original,
    probe: async (): Promise<Probe> => ({ durationSec: 20, width: 1080, height: 1080, fps: 30 }),
  }
})

let fakeAdapter: PublicationAdapter
let resolveAdapter: (platform: Platform) => PublicationAdapter | undefined = () => fakeAdapter

vi.mock('@/server/publication', () => ({
  adapterFor: (platform: Platform) => resolveAdapter(platform),
}))

function adapterAlwaysPublishing(publish: PublicationAdapter['publish']): PublicationAdapter {
  return {
    id: 'upload-post',
    platforms: PLATFORMS,
    availability: async () => {
      throw new Error('non utilisé par ces tests')
    },
    publish,
    poll: async () => {
      throw new Error('non utilisé par ces tests')
    },
  }
}

const SOURCE = '2025-06-15-cqlp.mp4'
const PROJECT_ID = '2025-06-15-cqlp'
const CLIP_ID = 'clip_0001'

let root: string
let lockDir: string
const envStart = { ...process.env }

function baseClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: CLIP_ID,
    projectId: PROJECT_ID,
    segments: [{ start: 10, end: 30 }],
    ratio: '1:1',
    cropX: 0.5,
    captions: false,
    branding: false,
    title: 'La chute',
    description: 'Une impro qui part en vrille',
    status: 'kept',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
    ...overrides,
  }
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-scheduler-'))
  lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-scheduler-lock-'))
  process.env.REPLAY_DIR = path.join(root, 'replay')
  process.env.STAGE_DIR = path.join(root, 'stage')
  process.env.PROJECTS_DIR = path.join(root, 'projects')
  process.env.FFMPEG_ENCODER = 'x264'
  fs.mkdirSync(process.env.REPLAY_DIR, { recursive: true })
  fs.mkdirSync(process.env.STAGE_DIR, { recursive: true })
  fs.writeFileSync(path.join(process.env.REPLAY_DIR, SOURCE), 'pas vraiment une vidéo')
  fs.writeFileSync(path.join(process.env.STAGE_DIR, SOURCE), 'pas vraiment une vidéo')

  upsertProject(getDb(), {
    id: PROJECT_ID,
    sourcePath: path.join(process.env.REPLAY_DIR, SOURCE),
    stagedPath: path.join(process.env.STAGE_DIR, SOURCE),
    durationSec: 5936,
    sizeBytes: 1,
    mtimeMs: 1,
    createdAt: 1,
  })

  putClip(getDb(), baseClip())
  await renderClip(CLIP_ID, { db: getDb() })

  fakeAdapter = adapterAlwaysPublishing(async (_job, platforms) => {
    const outcomes = {} as Record<Platform, PlatformOutcome>
    for (const platform of platforms) outcomes[platform] = { status: 'published', remoteId: 'p1', remoteUrl: 'https://example.test/p1' }
    return outcomes
  })
  resolveAdapter = () => fakeAdapter
})

afterEach(() => {
  forgetAll()
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(lockDir, { recursive: true, force: true })
  process.env = { ...envStart }
})

function deps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    db: getDb(),
    now: () => Date.now(),
    sleep: async () => {},
    sendMail: vi.fn(async () => {}),
    lockDir,
    ...overrides,
  }
}

describe('runOnePass — passe normale', () => {
  it('idle sans échéance due', async () => {
    const outcome = await runOnePass(deps())
    expect(outcome).toEqual({ kind: 'idle' })
  })

  it('publie les quatre plateformes et rend `done` sans courriel', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())
    const sendMail = vi.fn(async () => {})
    const outcome = await runOnePass(deps({ sendMail }))

    expect(outcome.kind).toBe('done')
    if (outcome.kind !== 'done') throw new Error('unreachable')
    expect(outcome.attempts).toBe(1)
    expect(PLATFORMS.every((p) => outcome.statuses[p] === 'published')).toBe(true)
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('une échéance vieille de deux jours part et ne déclenche aucun courriel', async () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000
    schedulePublications(getDb(), [CLIP_ID], twoDaysAgo, Date.now())
    const sendMail = vi.fn(async () => {})
    const outcome = await runOnePass(deps({ sendMail }))

    expect(outcome.kind).toBe('done')
    expect(sendMail).not.toHaveBeenCalled()
  })
})

describe('runOnePass — le verrou', () => {
  it('deux passes lancées ensemble : la seconde est `locked` et ne publie rien', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())

    // `runOnePass` pose le verrou avant tout `await` : appeler les deux sans
    // attendre entre les deux suffit à garantir l'ordre, sans connecteur
    // spécial pour retenir la première passe en vol.
    const shared = deps()
    const first = runOnePass(shared)
    const second = runOnePass(shared)
    const outcomes = await Promise.all([first, second])

    expect(outcomes.some((o) => o.kind === 'locked')).toBe(true)
    expect(outcomes.some((o) => o.kind === 'done')).toBe(true)
  })

  it('un verrou de plus de trente minutes est repris, avec un avertissement', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())
    const lockFile = path.join(lockDir, '.publish-scheduled.lock')
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, since: Date.now() - 31 * 60 * 1000 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const outcome = await runOnePass(deps())

    expect(outcome.kind).toBe('done')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('runOnePass — les réessais', () => {
  it('trois essais, l’échelle 5 s puis 10 s, le deuxième essai ne vise que les échecs, un seul courriel', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())
    const publish = vi.fn(async (_job: PublicationJob, platforms: readonly Platform[]) => {
      const outcomes = {} as Record<Platform, PlatformOutcome>
      for (const platform of platforms) {
        outcomes[platform] =
          platform === 'instagram' || platform === 'facebook'
            ? { status: 'failed', error: 'Panne simulée' }
            : { status: 'published', remoteId: 'p1', remoteUrl: 'https://example.test/p1' }
      }
      return outcomes
    })
    fakeAdapter = adapterAlwaysPublishing(publish)

    const delays: number[] = []
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms)
    })
    const mails: Array<{ subject: string; body: string }> = []
    const sendMail = vi.fn(async (subject: string, body: string) => {
      mails.push({ subject, body })
    })
    const outcome = await runOnePass(deps({ sleep, sendMail }))

    expect(outcome.kind).toBe('abandoned')
    if (outcome.kind !== 'abandoned') throw new Error('unreachable')
    expect(outcome.attempts).toBe(3)
    expect(outcome.statuses.instagram).toBe('failed')
    expect(outcome.statuses.facebook).toBe('failed')
    expect(outcome.statuses.tiktok).toBe('published')
    expect(outcome.statuses.youtube).toBe('published')

    expect(delays).toEqual([5000, 10000])
    expect(publish).toHaveBeenCalledTimes(3)
    expect(new Set(publish.mock.calls[0]?.[1])).toEqual(new Set(['instagram', 'facebook', 'tiktok', 'youtube']))
    expect(publish.mock.calls[1]?.[1]).toEqual(['instagram', 'facebook'])
    expect(publish.mock.calls[2]?.[1]).toEqual(['instagram', 'facebook'])

    expect(mails).toHaveLength(1)
    expect(mails[0]?.subject).toContain('La chute')
    expect(mails[0]?.body).toContain('instagram')
    expect(mails[0]?.body).toContain('Panne simulée')
  })
})

describe('runOnePass — --dry-run', () => {
  it('ne pose pas de verrou, n’écrit aucune ligne, n’envoie aucun courriel, et affiche le clip et ses plateformes', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())
    const before = getPublications(getDb(), CLIP_ID)
    const sendMail = vi.fn(async () => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const outcome = await runOnePass(deps({ sendMail }), { dryRun: true })

    expect(outcome).toEqual({ kind: 'idle' })
    expect(sendMail).not.toHaveBeenCalled()
    expect(getPublications(getDb(), CLIP_ID)).toEqual(before)
    expect(fs.existsSync(path.join(lockDir, '.publish-scheduled.lock'))).toBe(false)

    const printed = log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(printed).toContain(CLIP_ID)
    for (const platform of PLATFORMS) expect(printed).toContain(platform)
    log.mockRestore()
  })
})
