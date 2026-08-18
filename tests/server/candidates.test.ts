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
  caviarder,
  GeminiBlockedError,
  leverSiBloquée,
  lireTranscript,
  runCandidates,
  type AppelGemini,
  type ModeGemini,
} from '@/server/steps/candidates'
import { parseDetailResponse } from '@/core/gemini/parse'
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

  // Les refus nommés : ceux dont on peut dire à l'utilisateur que le
  // fournisseur a refusé son matériel. La liste d'openshorts s'arrêtait aux cinq
  // premiers et manquait déjà `MODEL_ARMOR` et les trois variantes image.
  // (relevé par Aristarque)
  it.each([
    'SAFETY',
    'PROHIBITED_CONTENT',
    'BLOCKLIST',
    'SPII',
    'RECITATION',
    'IMAGE_SAFETY',
    'IMAGE_PROHIBITED_CONTENT',
    'IMAGE_RECITATION',
    'MODEL_ARMOR',
  ])('annonce un refus de contenu sur « %s »', (raison) => {
    expect(() =>
      leverSiBloquée(réponse('', { candidates: [{ finishReason: raison }] } as never)),
    ).toThrow(GeminiBlockedError)
  })

  it.each(['STOP', 'FINISH_REASON_UNSPECIFIED'])('laisse passer une fin normale « %s »', (raison) => {
    expect(() =>
      leverSiBloquée(réponse('{}', { candidates: [{ finishReason: raison }] } as never)),
    ).not.toThrow()
  })

  // `OTHER` est un fourre-tout, pas un signal de politique : annoncer « le
  // fournisseur refuse ce matériel » y serait faux. La fin est quand même
  // anormale, donc elle échoue — mais sans accuser la vidéo. (relevé par Copilot)
  it.each(['OTHER', 'LANGUAGE', 'UNE_RAISON_QUI_NEXISTE_PAS_ENCORE'])(
    '« %s » échoue sans se faire passer pour un refus de contenu',
    (raison) => {
      const anormale = () =>
        leverSiBloquée(réponse('', { candidates: [{ finishReason: raison }] } as never))
      expect(anormale).toThrow(new RegExp(raison))
      expect(anormale).not.toThrow(GeminiBlockedError)
    },
  )

  it('une troncature est une panne, pas un refus — donc elle se réessaie', () => {
    // Une sortie structurée coupée en plein tableau ne parse en général pas,
    // mais si le JSON se refermait quand même, un lot partiel remplaçait la
    // passe précédente sans un mot. (relevé par Copilot)
    const tronquée = () =>
      leverSiBloquée(réponse('{}', { candidates: [{ finishReason: 'MAX_TOKENS' }] } as never))
    expect(tronquée).toThrow(/MAX_TOKENS/)
    expect(tronquée).not.toThrow(GeminiBlockedError)
  })

  it('laisse passer une réponse qui ne renseigne aucune raison', () => {
    expect(() => leverSiBloquée(réponse('{}', { candidates: [{}] } as never))).not.toThrow()
    expect(() => leverSiBloquée(réponse('{}'))).not.toThrow()
  })

  // Un défaut de notre côté — cette étape ne déclare aucun outil — ne doit pas
  // porter un message qui accuse la vidéo.
  it('un arrêt sur appel d’outil n’est pas un refus de contenu', () => {
    expect(() =>
      leverSiBloquée(
        réponse('{}', { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] } as never),
      ),
    ).not.toThrow()
  })
})

describe('caviarder', () => {
  // Vérifié sur `@google/genai@2.17.1` : la clé passe par l'en-tête
  // `x-goog-api-key`, jamais par l'URL. C'est une ceinture par-dessus des
  // bretelles — le dépôt est public, ses journaux se recopient dans des
  // rapports, et la version du SDK bougera. (relevé par Aristarque)
  it.each([
    ['https://x.googleapis.com/v1?key=AIzaSySECRET', 'AIzaSySECRET'],
    ['GET /v1beta/models?alt=json&api_key=AIzaSySECRET&x=1', 'AIzaSySECRET'],
    ['?apikey=AIzaSySECRET', 'AIzaSySECRET'],
  ])('retire la clé de « %s »', (message, secret) => {
    const propre = caviarder(message)
    expect(propre).not.toContain(secret)
    expect(propre).toContain('[caviardé]')
  })

  it('laisse un message ordinaire intact', () => {
    expect(caviarder('503 UNAVAILABLE: model overloaded')).toBe('503 UNAVAILABLE: model overloaded')
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
    expect(await appelerGemini(appel, 'p', 'score', { sleep })).toEqual({ windows: [] })
    expect(attentes).toEqual([])
  })

  it('réessaie une erreur passagère et rend le succès suivant', async () => {
    let essais = 0
    const appel: AppelGemini = async () => {
      essais += 1
      if (essais === 1) throw new Error('503 UNAVAILABLE: model overloaded')
      return réponse('{"windows": []}')
    }
    expect(await appelerGemini(appel, 'p', 'score', { sleep })).toEqual({ windows: [] })
    expect(essais).toBe(2)
    expect(attentes).toEqual([5000])
  })

  it('réessaie un corps vide, que le service rend en 200', async () => {
    let essais = 0
    const appel: AppelGemini = async () => {
      essais += 1
      return essais < 3 ? réponse('') : réponse('{"shorts": []}')
    }
    expect(await appelerGemini(appel, 'p', 'detail', { sleep })).toEqual({ shorts: [] })
    expect(attentes).toEqual([5000, 10000])
  })

  it('s’arrête à trois tentatives, l’attente doublant à chaque fois', async () => {
    let essais = 0
    const appel: AppelGemini = async () => {
      essais += 1
      throw new Error('429 RESOURCE_EXHAUSTED')
    }
    await expect(appelerGemini(appel, 'p', 'score', { sleep })).rejects.toThrow('429')
    expect(essais).toBe(3)
    expect(attentes).toEqual([5000, 10000])
  })

  it('ne réessaie jamais une réponse bloquée par le filtre de sécurité', async () => {
    let essais = 0
    const appel: AppelGemini = async () => {
      essais += 1
      return réponse('', { candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] } as never)
    }
    await expect(appelerGemini(appel, 'p', 'score', { sleep })).rejects.toThrow(GeminiBlockedError)
    // Le refus est déterministe : relancer ne fait que brûler du quota et cacher
    // à l'utilisateur la vraie raison.
    expect(essais).toBe(1)
    expect(attentes).toEqual([])
  })

  // Les passerelles et les délais sont aussi passagers que le 503, et les
  // coupures réseau brutes n'ont pas de code du tout : les unes échouaient au
  // premier essai (relevé par Copilot), les autres n'étaient pas reconnues
  // (relevé par Aristarque).
  it.each([
    '502 Bad Gateway',
    '504 DEADLINE_EXCEEDED',
    'Deadline exceeded',
    'fetch failed',
    'read ECONNRESET',
    'connect ETIMEDOUT 142.250.1.1:443',
  ])('réessaie « %s »', async (message) => {
    let essais = 0
    const appel: AppelGemini = async () => {
      essais += 1
      if (essais === 1) throw new Error(message)
      return réponse('{"windows": []}')
    }
    expect(await appelerGemini(appel, 'p', 'score', { sleep })).toEqual({ windows: [] })
    expect(essais).toBe(2)
  })

  it('réessaie une réponse de détail sans tableau `shorts`', async () => {
    // Sinon elle passait pour une passe réussie et effaçait les propositions
    // non traitées. (relevé par Copilot)
    let essais = 0
    const appel: AppelGemini = async () => {
      essais += 1
      return essais === 1 ? réponse('{"clips": []}') : réponse('{"shorts": []}')
    }
    // L'analyse passe par `analyser`, donc **dans** la boucle : analysée après
    // coup, l'enveloppe cassée ressortirait en « zéro clip ».
    const clips = await appelerGemini(appel, 'p', 'detail', {
      sleep,
      analyser: (brut) =>
        parseDetailResponse(brut, {
          words: [],
          videoDuration: 100,
          projectId: 'p',
          blocks: [{ id: 'w', start: 0, end: 100, text: '', segFrom: 0, segTo: -1 }],
        }),
    })
    expect(clips).toEqual([])
    expect(essais).toBe(2)
  })

  it('réessaie une réponse tronquée', async () => {
    let essais = 0
    const appel: AppelGemini = async () => {
      essais += 1
      return essais === 1
        ? réponse('{"windows": [', { candidates: [{ finishReason: 'MAX_TOKENS' }] } as never)
        : réponse('{"windows": []}')
    }
    expect(await appelerGemini(appel, 'p', 'score', { sleep })).toEqual({ windows: [] })
    expect(essais).toBe(2)
  })

  it('ne réessaie pas une erreur qui n’a rien de passager', async () => {
    let essais = 0
    const appel: AppelGemini = async () => {
      essais += 1
      throw new Error('API key not valid')
    }
    await expect(appelerGemini(appel, 'p', 'score', { sleep })).rejects.toThrow('API key')
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

  it('une réponse de détail cassée n’efface rien et n’écrit pas l’artefact', async () => {
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    const premiers = await runCandidates(ID, { db, appel: modèle(prompts), sleep: async () => {} })
    expect(premiers).toHaveLength(2)

    // Un modèle qui note normalement mais rend une enveloppe sans `shorts`.
    const cassé: AppelGemini = async (prompt, mode) => {
      if (mode === 'score') return modèle([])(prompt, mode)
      return réponse('{"clips": []}')
    }
    await expect(runCandidates(ID, { db, appel: cassé, sleep: async () => {} })).rejects.toThrow(
      /shorts/,
    )
    // Les propositions de la passe précédente sont toujours là, et l'artefact
    // n'a pas été réécrit sur un vide qui ferait sauter l'étape.
    expect(getClips(db, ID)).toHaveLength(2)
    const écrit: Clip[] = JSON.parse(fs.readFileSync(candidatesPath(ID), 'utf8'))
    expect(écrit).toHaveLength(2)
  })

  it('une écriture d’artefact impossible ne laisse pas de marqueur de succès', async () => {
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    await runCandidates(ID, { db, appel: modèle(prompts), sleep: async () => {} })
    expect(fs.existsSync(candidatesPath(ID))).toBe(true)

    // On fait échouer l'écriture du provisoire — un dossier occupe son nom —
    // pour atteindre l'état que Copilot décrit : la base a changé, le fichier
    // n'a pas pu être écrit. Le marqueur ne doit pas survivre à ça, sinon le
    // graphe compte l'exécution comme terminée et l'artefact décrit l'état
    // d'avant. Le nom du provisoire est un détail interne, et c'est le prix à
    // payer pour éprouver l'ordre des trois gestes.
    const provisoire = `${candidatesPath(ID)}.${process.pid}.tmp`
    fs.mkdirSync(provisoire, { recursive: true })
    try {
      await expect(
        runCandidates(ID, { db, appel: modèle(prompts), sleep: async () => {} }),
      ).rejects.toThrow()
      expect(fs.existsSync(candidatesPath(ID))).toBe(false)
    } finally {
      fs.rmSync(provisoire, { recursive: true, force: true })
    }
  })

  it('ne laisse pas de fichier provisoire derrière elle', async () => {
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    await runCandidates(ID, { db, appel: modèle(prompts), sleep: async () => {} })
    const restes = fs.readdirSync(path.join(projets, ID)).filter((f) => f.endsWith('.tmp'))
    expect(restes).toEqual([])
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

    // Le chemin porte l'arborescence du montage Google Drive, et l'erreur peut
    // finir dans le corps d'une réponse HTTP — `resolveSource` a posé la règle.
    // Les trois chemins d'échec sont couverts : fichier absent, JSON cassé,
    // forme invalide. Le premier contournait la rédaction, parce qu'`ENOENT`
    // écrit le chemin dans son propre message.
    // (relevé par Aristarque, complété par Copilot)
    it.each([
      ['absent', undefined],
      ['cassé', '{ pas du json'],
      ['hors forme', '{"texte": "bonjour"}'],
    ])('ne laisse pas fuiter le chemin du sidecar — fichier %s', (nom, contenu) => {
      const fichier = path.join(racine, `sidecar-secret-${nom}.json`)
      if (contenu !== undefined) fs.writeFileSync(fichier, contenu)
      try {
        lireTranscript(fichier)
        expect.unreachable('lireTranscript aurait dû lever')
      } catch (erreur) {
        expect((erreur as Error).message).toMatch(/illisible dans le sidecar/)
        expect((erreur as Error).message).not.toContain(fichier)
        expect((erreur as Error).message).not.toContain(racine)
      }
    })
  })
})
