import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Clip } from '@/core/edl'
import { PLATFORMS, type Platform } from '@/core/publication'
import {
  applySettings,
  closeDb,
  getDb,
  getPublications,
  putClip,
  schedulePublications,
  unschedulePublications,
  upsertProject,
  upsertPublication,
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
  // Mutation, jamais réassignation : `process.env = { ... }` casse en silence
  // `process.loadEnvFile` pour le reste du process (tests/scripts/dev-common.
  // test.ts, relevé en revue).
  for (const name of Object.keys(process.env)) {
    if (!(name in envStart)) delete process.env[name]
  }
  Object.assign(process.env, envStart)
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

describe('runOnePass — le drapeau autoPublish', () => {
  it('drapeau à `false` : `disabled`, aucun verrou pris', async () => {
    applySettings(getDb(), { publication: { autoPublish: false } })
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())

    const outcome = await runOnePass(deps())

    expect(outcome).toEqual({ kind: 'disabled' })
    expect(fs.existsSync(path.join(lockDir, '.publish-scheduled.lock'))).toBe(false)
  })

  it('drapeau à `false` et échéance due : rien n’est publié', async () => {
    applySettings(getDb(), { publication: { autoPublish: false } })
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())

    await runOnePass(deps())

    const rows = getPublications(getDb(), CLIP_ID)
    expect(rows.every((r) => r.status === 'planned')).toBe(true)
  })

  it('drapeau à `false` en `--dry-run` : `disabled` aussi, pas de fuite de l’échéance', async () => {
    applySettings(getDb(), { publication: { autoPublish: false } })
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())

    const outcome = await runOnePass(deps(), { dryRun: true })

    expect(outcome).toEqual({ kind: 'disabled' })
  })

  it('drapeau à `true` (défaut) : le comportement existant tourne sans changement', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())

    const outcome = await runOnePass(deps())

    expect(outcome.kind).toBe('done')
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

  it('un verrou de plus de trente minutes dont le pid est mort est repris, avec un avertissement', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())
    const lockFile = path.join(lockDir, '.publish-scheduled.lock')
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, since: Date.now() - 31 * 60 * 1000 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const outcome = await runOnePass(deps({ pidAlive: () => false }))

    expect(outcome.kind).toBe('done')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('un verrou de plus de trente minutes dont le pid est encore vivant n’est pas repris', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())
    const lockFile = path.join(lockDir, '.publish-scheduled.lock')
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 424242, since: Date.now() - 31 * 60 * 1000 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // L'âge seul ne suffit pas (relevé en revue) : une passe encore vivante
    // ne doit pas se faire voler son verrou par le réveil suivant.
    const outcome = await runOnePass(deps({ pidAlive: () => true }))

    expect(outcome.kind).toBe('locked')
    expect(warn).toHaveBeenCalled()
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8'))).toMatchObject({ pid: 424242 })
    warn.mockRestore()
  })

  it('deux reprises concurrentes du même verrou périmé ne produisent qu’un seul propriétaire', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())
    const lockFile = path.join(lockDir, '.publish-scheduled.lock')
    const guardFile = path.join(lockDir, '.publish-scheduled.reclaim')
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, since: Date.now() - 31 * 60 * 1000, owner: 'ancien' }))
    // Un autre processus a déjà entamé sa propre reprise : son verrou de
    // reprise est posé, frais — on simule la course sans avoir à lancer un
    // second processûs réel, puisque `acquireLock` est entièrement synchrone
    // et que la garde est le seul point qui décide.
    fs.writeFileSync(guardFile, JSON.stringify({ pid: 555555, since: Date.now(), owner: 'concurrent' }))

    const outcome = await runOnePass(deps({ pidAlive: () => false }))

    expect(outcome.kind).toBe('locked')
    // Ni le verrou de reprise d'autrui...
    expect(JSON.parse(fs.readFileSync(guardFile, 'utf8'))).toMatchObject({ owner: 'concurrent' })
    // ...ni le verrou principal périmé, qu'on n'a pas le droit de reprendre
    // pendant qu'un autre le tient déjà.
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8'))).toMatchObject({ owner: 'ancien' })
  })

  it('un verrou de reprise périmé (titulaire mort en plein milieu) est repris sur son seul âge', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())
    const lockFile = path.join(lockDir, '.publish-scheduled.lock')
    const guardFile = path.join(lockDir, '.publish-scheduled.reclaim')
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, since: Date.now() - 31 * 60 * 1000, owner: 'ancien' }))
    // Le précédent repreneur est mort avant de relever son propre verrou de
    // reprise : celui-ci est vieux de plus d'une minute, donc périmé lui
    // aussi — sur l'âge seul, aucun pid à vérifier pour cette garde-là.
    fs.writeFileSync(guardFile, JSON.stringify({ pid: 888888, since: Date.now() - 2 * 60 * 1000, owner: 'mort-en-reprise' }))

    const outcome = await runOnePass(deps({ pidAlive: () => false }))

    expect(outcome.kind).toBe('done')
    expect(fs.existsSync(guardFile)).toBe(false)
  })

  it('un échec d’écriture après la création exclusive ne laisse pas un verrou fantôme', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())
    const lockFile = path.join(lockDir, '.publish-scheduled.lock')
    const writeSync = vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    })

    await expect(runOnePass(deps())).rejects.toThrow('ENOSPC')

    // Le fichier créé par le `wx` qui a réussi ne doit pas survivre à
    // l'échec de l'écriture qui suit : sinon chaque réveil suivant le voit
    // et attend trente minutes pour rien.
    expect(fs.existsSync(lockFile)).toBe(false)
    writeSync.mockRestore()
  })

  it('un verrou au JSON incomplet vieillit sur l’horodatage du fichier, pas sur l’instant de lecture', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())
    const lockFile = path.join(lockDir, '.publish-scheduled.lock')
    // Un processus tué entre `openSync` et l'écriture laisse un fichier vide
    // ou tronqué : `since` ne doit pas se recalculer sur `now` à chaque
    // lecture, sinon le verrou paraît frais indéfiniment.
    fs.writeFileSync(lockFile, '')
    const old = new Date(Date.now() - 31 * 60 * 1000)
    fs.utimesSync(lockFile, old, old)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const outcome = await runOnePass(deps())

    expect(outcome.kind).toBe('done')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('le relâchement ne supprime que le verrou qu’on a posé soi-même', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())
    const lockFile = path.join(lockDir, '.publish-scheduled.lock')
    const publish = vi.fn(async (_job: PublicationJob, platforms: readonly Platform[]) => {
      const outcomes = {} as Record<Platform, PlatformOutcome>
      for (const platform of platforms) outcomes[platform] = { status: 'failed', error: 'Panne simulée' }
      return outcomes
    })
    fakeAdapter = adapterAlwaysPublishing(publish)
    const foreignLock = { pid: 424242, since: Date.now(), owner: 'un-autre-processus' }
    const sleep = vi.fn(async () => {
      // Un autre processus reprend le verrou pendant notre attente entre deux
      // essais : le nôtre ne doit relâcher que ce qu'il a posé lui-même.
      fs.writeFileSync(lockFile, JSON.stringify(foreignLock))
    })

    await runOnePass(deps({ sleep }))

    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8'))).toEqual(foreignLock)
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
    // Une plateforme à la fois (spec §5.4) : huit appels — quatre au premier
    // essai, deux à chacun des deux suivants, qui ne reciblent que les échecs
    // — jamais un appel qui en groupe plusieurs.
    expect(publish).toHaveBeenCalledTimes(8)
    expect(publish.mock.calls.every((call) => (call[1] as readonly Platform[]).length === 1)).toBe(true)
    const platformsCalled = publish.mock.calls.map((call) => (call[1] as readonly Platform[])[0])
    expect([...platformsCalled.slice(0, 4)].sort()).toEqual([...PLATFORMS].sort())
    expect([...platformsCalled.slice(4, 6)].sort()).toEqual(['facebook', 'instagram'])
    expect([...platformsCalled.slice(6, 8)].sort()).toEqual(['facebook', 'instagram'])

    expect(mails).toHaveLength(1)
    expect(mails[0]?.subject).toContain('La chute')
    expect(mails[0]?.body).toContain('instagram')
    expect(mails[0]?.body).toContain('Panne simulée')
  })

  it('un titre YouTube manquant isole son échec sans marquer les autres plateformes', async () => {
    putClip(getDb(), baseClip({ title: '' }))
    await renderClip(CLIP_ID, { db: getDb() })
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())
    const sendMail = vi.fn(async () => {})

    const outcome = await runOnePass(deps({ sendMail }))

    expect(outcome.kind).toBe('abandoned')
    if (outcome.kind !== 'abandoned') throw new Error('unreachable')
    expect(outcome.statuses.youtube).toBe('failed')
    expect(outcome.statuses.instagram).toBe('published')
    expect(outcome.statuses.facebook).toBe('published')
    expect(outcome.statuses.tiktok).toBe('published')
    expect(sendMail).toHaveBeenCalledTimes(1)
  })
})

describe('runOnePass — clip disparu', () => {
  it('marque les plateformes en échec plutôt que de reprendre indéfiniment la même échéance', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())
    // `publications.clipId` porte `ON DELETE CASCADE` : supprimer le clip
    // efface aussi ses lignes, donc ce cas ne survient normalement pas. On
    // désactive la contrainte le temps de fabriquer la défense en profondeur
    // que ce test vérifie — une base incohérente pour une autre raison ne
    // doit pas non plus bloquer les échéances suivantes indéfiniment.
    getDb().pragma('foreign_keys = OFF')
    getDb().prepare('DELETE FROM clips WHERE id = ?').run(CLIP_ID)
    getDb().pragma('foreign_keys = ON')
    const sendMail = vi.fn(async () => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const outcome = await runOnePass(deps({ sendMail }))

    expect(outcome.kind).toBe('abandoned')
    expect(sendMail).toHaveBeenCalledTimes(1)
    expect(
      PLATFORMS.every((p) => getPublications(getDb(), CLIP_ID).find((r) => r.platform === p)?.status === 'failed'),
    ).toBe(true)

    // La ligne n'est plus `planned` : la passe suivante ne la reprend pas.
    const second = await runOnePass(deps({ sendMail }))
    expect(second.kind).toBe('idle')

    error.mockRestore()
  })
})

describe('runOnePass — --dry-run', () => {
  it('ne pose pas de verrou, n’écrit aucune ligne, n’envoie aucun courriel, n’imprime rien, et rend l’échéance due', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())
    const before = getPublications(getDb(), CLIP_ID)
    const sendMail = vi.fn(async () => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const outcome = await runOnePass(deps({ sendMail }), { dryRun: true })

    expect(outcome.kind).toBe('dry-run')
    if (outcome.kind !== 'dry-run') throw new Error('unreachable')
    expect(outcome.due).toEqual({
      clipId: CLIP_ID,
      title: 'La chute',
      scheduledAt: expect.any(Number),
      platforms: [...PLATFORMS],
    })
    expect(sendMail).not.toHaveBeenCalled()
    expect(getPublications(getDb(), CLIP_ID)).toEqual(before)
    expect(fs.existsSync(path.join(lockDir, '.publish-scheduled.lock'))).toBe(false)
    // `runOnePass` ne présente rien lui-même en `dryRun` : c'est au script de
    // décider quoi imprimer à partir du fait qu'il rend (spec §6, correction).
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('rend `due: null` quand rien n’est dû, sans rien imprimer non plus', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const outcome = await runOnePass(deps(), { dryRun: true })

    expect(outcome).toEqual({ kind: 'dry-run', due: null })
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })
})

describe('runOnePass — déprogrammation pendant la passe', () => {
  it('une plateforme déprogrammée pendant qu’une autre téléverse n’est pas republiée', async () => {
    schedulePublications(getDb(), [CLIP_ID], Date.now() - 1000, Date.now())
    const seen: Platform[][] = []
    const publish = vi.fn(async (_job: PublicationJob, platforms: readonly Platform[]) => {
      seen.push([...platforms])
      if (platforms[0] === 'instagram') {
        // Un humain déprogramme le clip pendant que la première plateforme
        // téléverse encore : les trois autres lignes `planned` disparaissent.
        unschedulePublications(getDb(), [CLIP_ID])
      }
      const outcomes = {} as Record<Platform, PlatformOutcome>
      for (const platform of platforms) outcomes[platform] = { status: 'published', remoteId: 'p1', remoteUrl: 'https://example.test/p1' }
      return outcomes
    })
    fakeAdapter = adapterAlwaysPublishing(publish)
    const sendMail = vi.fn(async () => {})

    const outcome = await runOnePass(deps({ sendMail }))

    expect(seen).toEqual([['instagram']])
    expect(getPublications(getDb(), CLIP_ID)).toEqual([
      expect.objectContaining({ platform: 'instagram', status: 'published' }),
    ])
    // Une annulation réussie n'est pas un abandon : pas de courriel, pas de
    // code de sortie 1 pour un humain qui a fait exactement ce qu'il voulait.
    expect(outcome.kind).toBe('done')
    expect(sendMail).not.toHaveBeenCalled()
  })
})

describe('runOnePass — contamination par un essai manuel', () => {
  it('ignore une ligne manuelle laissée en in_progress (scheduledAt: null), même pour le même clip', async () => {
    // Un envoi manuel encore en vol sur une plateforme, posé **avant** la
    // programmation : `schedulePublications` ne le réécrit pas (sa clause
    // `WHERE status = 'planned'` laisse intacte une ligne déjà `in_progress`),
    // donc son `scheduledAt` reste `null` même après.
    upsertPublication(getDb(), {
      clipId: CLIP_ID,
      platform: 'youtube',
      status: 'in_progress',
      remoteId: null,
      remoteUrl: null,
      requestId: 'manuel-en-vol',
      error: null,
      publishedFingerprint: null,
      createdAt: 1,
      updatedAt: 1,
      scheduledAt: null,
    })
    const due = Date.now() - 1000
    schedulePublications(getDb(), [CLIP_ID], due, Date.now())
    const publish = vi.fn(async (_job: PublicationJob, platforms: readonly Platform[]) => {
      const outcomes = {} as Record<Platform, PlatformOutcome>
      for (const platform of platforms) outcomes[platform] = { status: 'published', remoteId: 'p1', remoteUrl: 'https://example.test/p1' }
      return outcomes
    })
    fakeAdapter = adapterAlwaysPublishing(publish)

    const outcome = await runOnePass(deps())

    expect(outcome.kind).toBe('done')
    // youtube n'a jamais été ciblé par la passe : la ligne manuelle reste
    // intacte, sous son propre `requestId`.
    expect(getPublications(getDb(), CLIP_ID).find((r) => r.platform === 'youtube')).toMatchObject({
      status: 'in_progress',
      requestId: 'manuel-en-vol',
      scheduledAt: null,
    })
    expect(publish.mock.calls.every((call) => !(call[1] as readonly Platform[]).includes('youtube'))).toBe(true)
  })
})
