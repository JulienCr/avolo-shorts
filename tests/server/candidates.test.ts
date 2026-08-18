import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import type { GenerateContentResponse } from '@google/genai'
import { openDb, upsertProject, getClips, putClip } from '@/server/db'
import { candidatesPath, sidecarDir } from '@/server/paths'
import {
  appelerGemini,
  GeminiBlockedError,
  leverSiBloquée,
  lireTranscript,
  runCandidates,
  type AppelGemini,
  type ModeGemini,
} from '@/server/steps/candidates'
import type { Clip } from '@/core/edl'
import { clipDuration } from '@/core/edl'

/**
 * L'étape de repérage, **sans jamais appeler Gemini** : la couture `appel` reçoit
 * des réponses figées. Ce qui se vérifie ici est ce que le réseau apporte de
 * risque — la politique de relance, le refus de contenu qu'on ne réessaie
 * jamais, la lecture d'un transcript venu du disque — et l'enchaînement complet
 * jusqu'à la base.
 */

const SOURCE = '2025-06-15-cqlp.mp4'
const ID = '2025-06-15-cqlp'

/** Une réponse minimale : seul `text` est lu, le reste du SDK ne sert pas ici. */
function réponse(text: string, reste: Partial<GenerateContentResponse> = {}) {
  return { text, ...reste } as unknown as GenerateContentResponse
}

describe('leverSiBloquée', () => {
  it('lève quand le prompt lui-même a été bloqué', () => {
    expect(() =>
      leverSiBloquée(réponse('', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } as never)),
    ).toThrow(GeminiBlockedError)
  })

  it.each(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'])(
    'lève quand la génération s’est arrêtée en « %s »',
    (raison) => {
      expect(() =>
        leverSiBloquée(réponse('', { candidates: [{ finishReason: raison }] } as never)),
      ).toThrow(GeminiBlockedError)
    },
  )

  it('laisse passer une génération normale', () => {
    expect(() =>
      leverSiBloquée(réponse('{}', { candidates: [{ finishReason: 'STOP' }] } as never)),
    ).not.toThrow()
  })
})

describe('appelerGemini', () => {
  /** Les attentes réellement demandées, pour vérifier l'échelle sans dormir. */
  let attentes: number[]
  const sleep = async (ms: number) => {
    attentes.push(ms)
  }

  beforeEach(() => {
    attentes = []
  })

  it('rend l’objet analysé', async () => {
    const appel: AppelGemini = async () => réponse('{"windows": []}')
    expect(await appelerGemini(appel, 'p', 'score', sleep)).toEqual({ windows: [] })
    expect(attentes).toEqual([])
  })

  it('réessaie une erreur passagère et rend le succès suivant', async () => {
    let essais = 0
    const appel: AppelGemini = async () => {
      essais += 1
      if (essais === 1) throw new Error('503 UNAVAILABLE: model overloaded')
      return réponse('{"windows": []}')
    }
    expect(await appelerGemini(appel, 'p', 'score', sleep)).toEqual({ windows: [] })
    expect(essais).toBe(2)
    expect(attentes).toEqual([5000])
  })

  it('réessaie un corps vide, que le service rend en 200', async () => {
    let essais = 0
    const appel: AppelGemini = async () => {
      essais += 1
      return essais < 3 ? réponse('') : réponse('{"shorts": []}')
    }
    expect(await appelerGemini(appel, 'p', 'detail', sleep)).toEqual({ shorts: [] })
    expect(attentes).toEqual([5000, 10000])
  })

  it('s’arrête à trois tentatives, l’attente doublant à chaque fois', async () => {
    let essais = 0
    const appel: AppelGemini = async () => {
      essais += 1
      throw new Error('429 RESOURCE_EXHAUSTED')
    }
    await expect(appelerGemini(appel, 'p', 'score', sleep)).rejects.toThrow('429')
    expect(essais).toBe(3)
    expect(attentes).toEqual([5000, 10000])
  })

  it('ne réessaie jamais une réponse bloquée par le filtre de sécurité', async () => {
    let essais = 0
    const appel: AppelGemini = async () => {
      essais += 1
      return réponse('', { candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] } as never)
    }
    await expect(appelerGemini(appel, 'p', 'score', sleep)).rejects.toThrow(GeminiBlockedError)
    // Le refus est déterministe : relancer ne fait que brûler du quota et cacher
    // à l'utilisateur la vraie raison.
    expect(essais).toBe(1)
    expect(attentes).toEqual([])
  })

  it('ne réessaie pas une erreur qui n’a rien de passager', async () => {
    let essais = 0
    const appel: AppelGemini = async () => {
      essais += 1
      throw new Error('API key not valid')
    }
    await expect(appelerGemini(appel, 'p', 'score', sleep)).rejects.toThrow('API key')
    expect(essais).toBe(1)
  })
})

describe("l'étape de repérage", () => {
  let racine: string
  let replay: string
  let projets: string
  let db: BetterSqlite3.Database
  const envDépart = { ...process.env }

  /** Un transcript court, mais assez long pour construire plusieurs fenêtres. */
  const TRANSCRIPT = {
    language: 'fr',
    segments: Array.from({ length: 40 }, (_, i) => ({
      start: i * 6,
      end: i * 6 + 3.5,
      text: `phrase numéro ${i}`,
      words: `phrase numéro ${i}`.split(' ').map((mot, j) => ({
        word: mot,
        start: i * 6 + j * 0.45,
        end: i * 6 + j * 0.45 + 0.35,
      })),
    })),
  }

  beforeEach(() => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-candidats-'))
    replay = path.join(racine, 'Replay')
    projets = path.join(racine, 'projects')
    for (const d of [replay, projets]) fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(replay, SOURCE), 'pas vraiment une vidéo')
    process.env.REPLAY_DIR = replay
    process.env.STAGE_DIR = path.join(racine, 'stage')
    process.env.PROJECTS_DIR = projets

    const sidecar = sidecarDir(SOURCE)
    fs.mkdirSync(sidecar, { recursive: true })
    fs.writeFileSync(path.join(sidecar, 'transcript.json'), JSON.stringify(TRANSCRIPT))

    db = openDb(':memory:')
    upsertProject(db, {
      id: ID,
      sourcePath: path.join(replay, SOURCE),
      stagedPath: null,
      durationSec: 240,
      sizeBytes: null,
      mtimeMs: null,
      createdAt: 0,
    })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(racine, { recursive: true, force: true })
    process.env = { ...envDépart }
  })

  /**
   * Un modèle qui note tout pareil et rend deux clips, dont un de 91 secondes.
   * Les prompts reçus sont capturés : c'est la seule façon de vérifier que les
   * cibles de nombre de clips ont été calculées **avant** la fusion.
   */
  function modèle(prompts: { mode: ModeGemini; prompt: string }[]): AppelGemini {
    return async (prompt, mode) => {
      prompts.push({ mode, prompt })
      if (mode === 'score') {
        const ids = [...prompt.matchAll(/"id":"(window_\d+)"/g)].map((m) => m[1])
        return réponse(
          JSON.stringify({
            windows: ids.map((id, i) => ({ id, start: 0, end: 90, score: 90 - i, reason: 'ok' })),
          }),
        )
      }
      return réponse(
        JSON.stringify({
          shorts: [
            {
              start: 12.0,
              end: 103.2,
              source_window_id: 'window_001',
              predicted_score: 88,
              video_description_for_tiktok: 'une vanne longue #impro',
              video_description_for_instagram: 'une vanne longue #impro',
              video_title_for_youtube_short: 'La vanne qui ne s’arrête pas',
              viral_hook_text: 'Il tient bon',
            },
            {
              start: 150.0,
              end: 175.2,
              source_window_id: 'window_002',
              predicted_score: 61,
              video_description_for_tiktok: 'plus court #impro',
              video_description_for_instagram: 'plus court #impro',
              video_title_for_youtube_short: 'La sortie de piste',
              viral_hook_text: 'Et là, silence',
            },
          ],
        }),
      )
    }
  }

  it('enchaîne les deux passes et écrit les candidats en base', async () => {
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    const clips = await runCandidates(ID, { db, appel: modèle(prompts), sleep: async () => {} })

    expect(clips).toHaveLength(2)
    expect(getClips(db, ID)).toHaveLength(2)
    expect(clips.every((c) => c.status === 'candidate' && c.pass === 1)).toBe(true)
    // La délimitation rend un segment ; le raccourcissement par le milieu vient
    // après, à la main.
    expect(clips.every((c) => c.segments.length === 1)).toBe(true)
    // Et rien ne plafonne la durée.
    expect(clips.some((c) => clipDuration(c.segments) > 60)).toBe(true)
  })

  it('note par lots de 8, puis détaille en un seul appel', async () => {
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    await runCandidates(ID, { db, appel: modèle(prompts), sleep: async () => {} })
    expect(prompts.filter((p) => p.mode === 'detail')).toHaveLength(1)
    expect(prompts.filter((p) => p.mode === 'score').length).toBeGreaterThan(0)
    for (const { prompt } of prompts.filter((p) => p.mode === 'score')) {
      expect([...prompt.matchAll(/"id":"window_\d+"/g)].length).toBeLessThanOrEqual(8)
    }
  })

  it('calcule les cibles de nombre de clips avant la fusion des fenêtres', async () => {
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    await runCandidates(ID, { db, appel: modèle(prompts), sleep: async () => {} })
    const détail = prompts.find((p) => p.mode === 'detail')!.prompt

    // Le transcript fait 40 phrases sur 240 s : `buildWindows` en tire quatre
    // fenêtres, `shortlistSize` les garde toutes (son plancher est de 10), et la
    // fusion les ramène à un seul bloc contigu — elles se chevauchent toutes.
    const blocs = [...détail.matchAll(/"id":"window_\d+"/g)].length
    expect(blocs).toBe(1)

    const [, min, max] = /return (\d+) to (\d+) clips/.exec(détail)!
    // `clipCountTargets(4)` vaut [4, 8] ; `clipCountTargets(1)` vaudrait [2, 4].
    // Fusionner remanie la charge utile, cela ne sélectionne pas moins de
    // matière : le plancher repose sur une mesure de rétention et n'a pas à
    // bouger parce que deux fenêtres se trouvent voisines.
    expect([Number(min), Number(max)]).toEqual([4, 8])
  })

  it('la passe suivante ne ressuscite pas un clip écarté', async () => {
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    const premiers = await runCandidates(ID, { db, appel: modèle(prompts), sleep: async () => {} })
    const écarté: Clip = { ...premiers[0], status: 'discarded' }
    putClip(db, écarté)

    const seconds = await runCandidates(ID, { db, appel: modèle(prompts), sleep: async () => {} })
    const revenu = seconds.filter((c) => c.id === écarté.id)
    expect(revenu).toHaveLength(1)
    expect(revenu[0].status).toBe('discarded')
    // Les identifiants dérivent des bornes : la même proposition retombe sur le
    // même identifiant, ce qui est exactement ce qui rend la garantie opérante.
    expect(seconds.map((c) => c.id).sort()).toEqual(premiers.map((c) => c.id).sort())
    expect(seconds.find((c) => c.status === 'candidate')?.pass).toBe(2)
  })

  it('écrit `candidates.json`, que le graphe regarde', async () => {
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    await runCandidates(ID, { db, appel: modèle(prompts), sleep: async () => {} })
    const écrit: unknown = JSON.parse(fs.readFileSync(candidatesPath(ID), 'utf8'))
    expect(Array.isArray(écrit)).toBe(true)
    expect((écrit as Clip[])[0].projectId).toBe(ID)
  })

  it('refuse de repérer un projet dont la durée n’est pas connue', async () => {
    upsertProject(db, {
      id: ID,
      sourcePath: path.join(replay, SOURCE),
      stagedPath: null,
      durationSec: null,
      sizeBytes: null,
      mtimeMs: null,
      createdAt: 0,
    })
    await expect(runCandidates(ID, { db, appel: modèle([]) })).rejects.toThrow(/durée/)
  })

  describe('lireTranscript', () => {
    it('écarte un mot sans horodatage plutôt que de jeter le transcript', () => {
      const fichier = path.join(racine, 'partiel.json')
      fs.writeFileSync(
        fichier,
        JSON.stringify({
          segments: [
            {
              start: 0,
              end: 2,
              text: 'trois euros',
              words: [{ word: 'trois' }, { word: 'euros', start: 1, end: 2 }],
            },
          ],
        }),
      )
      const lu = lireTranscript(fichier)
      // WhisperX laisse des mots non alignés — chiffres, ponctuation. Ils ne
      // servent qu'à `snapToWords`, qui cherche des frontières : un mot sans
      // frontière n'en est pas une.
      expect(lu.segments[0].words).toEqual([{ word: 'euros', start: 1, end: 2 }])
      expect(lu.language).toBe('unknown')
    })

    it('lève sur un fichier qui n’a pas la forme d’un transcript', () => {
      const fichier = path.join(racine, 'faux.json')
      fs.writeFileSync(fichier, JSON.stringify({ texte: 'bonjour' }))
      expect(() => lireTranscript(fichier)).toThrow(/illisible/)
    })
  })
})
