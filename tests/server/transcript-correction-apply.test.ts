import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '@/server/db'
import { applySettings, closeDb, getDb, upsertProject } from '@/server/db'
import { placeSidecar } from '@/server/paths'
import * as run from '@/server/run'
import { applyTranscriptCorrections, readCorrectionLog } from '@/server/steps/transcript-correction'

/**
 * `applyTranscriptCorrections` — le chemin que l'étape `correction` du
 * graphe appelle (`src/server/run.ts`) : propose, ordonne, écrit, journalise.
 * `proposeTranscriptCorrections` (le cœur, sans écriture) est déjà couvert
 * par `transcript-correction-propose.test.ts` ; `correctTranscript` (la
 * garde phonétique, l'atomicité) par `transcript-correction.test.ts`.
 *
 * **Ollama, pas Gemini** — même raison que les fichiers voisins : pas de clé
 * à fournir, une adresse fixe pour ne pas résoudre la passerelle WSL.
 */

const SOURCE = '2026-03-08-caro-mdlm.mp4'
const ID = '2026-03-08-caro-mdlm'

let root: string
let project: Project

function writeTranscript(words: string[]): void {
  const placement = placeSidecar(SOURCE, ID)
  fs.writeFileSync(
    placement.transcript,
    JSON.stringify({
      language: 'fr',
      segments: [
        {
          start: 0,
          end: words.length,
          text: words.join(' '),
          words: words.map((word, i) => ({ word, start: i, end: i + 1 })),
        },
      ],
    }),
  )
}

function readTranscriptWords(): string[] {
  const placement = placeSidecar(SOURCE, ID)
  const raw = JSON.parse(fs.readFileSync(placement.transcript, 'utf8')) as {
    segments: { words: { word: string }[] }[]
  }
  return raw.segments[0].words.map((w) => w.word)
}

function ollamaResponse(corrections: unknown[]): Response {
  return new Response(JSON.stringify({ message: { content: JSON.stringify({ corrections }) } }), {
    status: 200,
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-apply-'))
  const replay = path.join(root, 'Replay')
  const stage = path.join(root, 'stage')
  const projects = path.join(root, 'projects')
  for (const d of [replay, stage, projects]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(replay, SOURCE), 'pas vraiment une vidéo')

  process.env.REPLAY_DIR = replay
  process.env.STAGE_DIR = stage
  process.env.PROJECTS_DIR = projects

  project = {
    id: ID,
    sourcePath: SOURCE,
    stagedPath: path.join(stage, SOURCE),
    durationSec: 100,
    sizeBytes: 1,
    mtimeMs: 0,
    createdAt: 0,
  } as Project
  upsertProject(getDb(), project)

  applySettings(getDb(), { ai: { correctionProvider: 'ollama', ollamaBaseUrl: 'http://127.0.0.1:11434' } })
})

afterEach(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('applyTranscriptCorrections', () => {
  // Le piège principal du contrat de cette PR : l'exécution en cours, ici,
  // est la nôtre — `progression()` répondrait « oui » si on la lui posait,
  // et la fonction ne la lui pose jamais.
  it('n’échoue pas quand une exécution est en cours sur ce projet', async () => {
    const words = ['bonjour', 'a', 'tous']
    writeTranscript(words)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ollamaResponse([{ i: 1, w: 'à' }])))
    vi.spyOn(run, 'progression').mockReturnValue({ step: 'correction', progress: 0 })

    const outcome = await applyTranscriptCorrections(project, getDb())
    expect(outcome.applied).toBe(1)
  })

  it('écrit le transcript et le journal, rightmost-first au sein d’une phrase', async () => {
    // Deux substitutions dans la même phrase : une fusion à droite (2 mots ->
    // 1) et une substitution simple à gauche. Si la fusion s'écrivait en
    // premier — de gauche à droite — l'index de la seconde deviendrait faux.
    const words = ['a', 'deux', 'mots', 'la']
    writeTranscript(words)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        ollamaResponse([
          { i: 0, w: 'à' },
          { i: 1, merge: 2, w: 'deuxmots' },
        ]),
      ),
    )

    const outcome = await applyTranscriptCorrections(project, getDb())
    expect(outcome.applied).toBe(2)
    expect(readTranscriptWords()).toEqual(['à', 'deuxmots', 'la'])

    const log = await readCorrectionLog(project)
    expect(log.entries).toHaveLength(2)
    expect(log.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lineId: 'l0', from: 0, expected: ['a'], replacement: 'à' }),
        expect.objectContaining({
          lineId: 'l0',
          from: 1,
          expected: ['deux', 'mots'],
          replacement: 'deuxmots',
        }),
      ]),
    )
  })

  it('accumule avec le journal existant plutôt que de le remplacer', async () => {
    const words = ['a', 'deux']
    writeTranscript(words)
    const placement = placeSidecar(SOURCE, ID)
    fs.writeFileSync(
      placement.correction,
      JSON.stringify({
        entries: [{ id: '4', lineId: 'l1', from: 0, expected: ['ancien'], replacement: 'x', timecode: 0 }],
      }),
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ollamaResponse([{ i: 0, w: 'à' }])))

    await applyTranscriptCorrections(project, getDb())

    const log = await readCorrectionLog(project)
    // L'entrée d'une passe précédente, sur une autre phrase, reste là.
    expect(log.entries.some((e) => e.id === '4' && e.lineId === 'l1')).toBe(true)
    // La nouvelle s'ajoute, avec un identifiant qui ne recouvre pas l'ancien.
    const added = log.entries.find((e) => e.lineId === 'l0')
    expect(added).toMatchObject({ expected: ['a'], replacement: 'à' })
    expect(added?.id).not.toBe('4')
  })

  it('repart d’un journal vide quand une retranscription vient de tourner', async () => {
    const words = ['a', 'deux']
    writeTranscript(words)
    const placement = placeSidecar(SOURCE, ID)
    fs.writeFileSync(
      placement.correction,
      JSON.stringify({
        entries: [{ id: '4', lineId: 'l1', from: 0, expected: ['ancien'], replacement: 'x', timecode: 0 }],
      }),
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ollamaResponse([{ i: 0, w: 'à' }])))

    await applyTranscriptCorrections(project, getDb(), { freshTranscript: true })

    const log = await readCorrectionLog(project)
    // L'entrée de l'ancien journal — sur une phrase que la retranscription a
    // pu entièrement recomposer — n'a plus de sens et ne survit pas.
    expect(log.entries.some((e) => e.id === '4')).toBe(false)
    expect(log.entries).toHaveLength(1)
  })

  it('lève quand le transcript est absent, plutôt que d’avaler en silence', async () => {
    await expect(applyTranscriptCorrections(project, getDb())).rejects.toThrow()
  })

  it('ne réutilise jamais un identifiant entre deux journaux (#139)', async () => {
    // **Le scénario de l'issue.** Un compteur qui repart de `1` à chaque
    // `freshTranscript` produirait le même `id` sur deux retranscriptions
    // successives — exactement ce qu'un onglet resté ouvert sur l'ancien
    // historique pourrait envoyer à `POST .../correction/undo` après la
    // seconde. Deux passes, chacune avec un seul mot à corriger, chacune un
    // journal reparti à vide : leurs deux entrées ne doivent jamais porter le
    // même identifiant.
    writeTranscript(['a'])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ollamaResponse([{ i: 0, w: 'à' }])))
    await applyTranscriptCorrections(project, getDb(), { freshTranscript: true })
    const first = (await readCorrectionLog(project)).entries[0]

    writeTranscript(['a'])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ollamaResponse([{ i: 0, w: 'à' }])))
    await applyTranscriptCorrections(project, getDb(), { freshTranscript: true })
    const second = (await readCorrectionLog(project)).entries[0]

    expect(first.id).not.toBe(second.id)
  })
})
