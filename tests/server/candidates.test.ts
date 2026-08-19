import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import type { GenerateContentResponse } from '@google/genai'
import { openDb, upsertProject, getClips, putClip, setSetting } from '@/server/db'
import { wait, launch, lireStatus } from '@/server/run'
import { candidatesPath, sidecarDir } from '@/server/paths'
import {
  callGemini,
  redact,
  quotaDelay,
  lastSummary,
  estTransient,
  GeminiBlockedError,
  leverIfBlocked,
  lireTranscript,
  partCovered,
  runCandidates,
  type CallGemini,
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
function response(text: string, remaining: Partial<GenerateContentResponse> = {}) {
  return { text, ...remaining } as unknown as GenerateContentResponse
}

describe('leverSiBloquée', () => {
  it('lève quand le prompt lui-même a été bloqué', () => {
    expect(() =>
      leverIfBlocked(response('', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } as never)),
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
  ])('annonce un refus de contenu sur « %s »', (reason) => {
    expect(() =>
      leverIfBlocked(response('', { candidates: [{ finishReason: reason }] } as never)),
    ).toThrow(GeminiBlockedError)
  })

  it.each(['STOP', 'FINISH_REASON_UNSPECIFIED'])('laisse passer une fin normale « %s »', (reason) => {
    expect(() =>
      leverIfBlocked(response('{}', { candidates: [{ finishReason: reason }] } as never)),
    ).not.toThrow()
  })

  // `OTHER` est un fourre-tout, pas un signal de politique : annoncer « le
  // fournisseur refuse ce matériel » y serait faux. La fin est quand même
  // anormale, donc elle échoue — mais sans accuser la vidéo. (relevé par Copilot)
  it.each(['OTHER', 'LANGUAGE', 'UNE_RAISON_QUI_NEXISTE_PAS_ENCORE'])(
    '« %s » échoue sans se faire passer pour un refus de contenu',
    (reason) => {
      const abnormal = () =>
        leverIfBlocked(response('', { candidates: [{ finishReason: reason }] } as never))
      expect(abnormal).toThrow(new RegExp(reason))
      expect(abnormal).not.toThrow(GeminiBlockedError)
    },
  )

  it('une troncature est une panne, pas un refus — donc elle se réessaie', () => {
    // Une sortie structurée coupée en plein tableau ne parse en général pas,
    // mais si le JSON se refermait quand même, un lot partiel remplaçait la
    // passe précédente sans un mot. (relevé par Copilot)
    const truncated = () =>
      leverIfBlocked(response('{}', { candidates: [{ finishReason: 'MAX_TOKENS' }] } as never))
    expect(truncated).toThrow(/MAX_TOKENS/)
    expect(truncated).not.toThrow(GeminiBlockedError)
  })

  it('laisse passer une réponse qui ne renseigne aucune raison', () => {
    expect(() => leverIfBlocked(response('{}', { candidates: [{}] } as never))).not.toThrow()
    expect(() => leverIfBlocked(response('{}'))).not.toThrow()
  })

  // Un défaut de notre côté — cette étape ne déclare aucun outil — ne doit pas
  // porter un message qui accuse la vidéo.
  it('un arrêt sur appel d’outil n’est pas un refus de contenu', () => {
    expect(() =>
      leverIfBlocked(
        response('{}', { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] } as never),
      ),
    ).not.toThrow()
  })
})

describe('délaiDeQuota', () => {
  it('lit le délai que Google demande dans un 429', () => {
    expect(
      quotaDelay('{"error":{"details":[{"@type":"…RetryInfo","retryDelay":"54s"}]}}'),
    ).toBe(54_000)
  })

  it('arrondit à la milliseconde supérieure', () => {
    expect(quotaDelay('"retryDelay":"53.9s"')).toBe(53_900)
  })

  // Le délai demandé est un fait, pas une décision : la fonction le rend tel
  // quel, et `appelerGemini` décide ce qu'on accepte d'attendre. Les mêler
  // faisait rendre un délai raccourci qu'on relançait ensuite comme s'il
  // suffisait. (relevé par Copilot)
  it('rend le délai demandé sans le plafonner', () => {
    expect(quotaDelay('"retryDelay":"3600s"')).toBe(3_600_000)
  })

  it('rend null quand le message n’en porte pas', () => {
    expect(quotaDelay('429 RESOURCE_EXHAUSTED')).toBeNull()
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
    const clean = redact(message)
    expect(clean).not.toContain(secret)
    expect(clean).toContain('[caviardé]')
  })

  it('laisse un message ordinaire intact', () => {
    expect(redact('503 UNAVAILABLE: model overloaded')).toBe('503 UNAVAILABLE: model overloaded')
  })
})

describe('appelerGemini', () => {
  /** Les attentes réellement demandées, pour vérifier l'échelle sans dormir. */
  let waits: number[]
  const sleep = async (ms: number) => {
    waits.push(ms)
  }

  beforeEach(() => {
    waits = []
  })

  it('rend l’objet analysé', async () => {
    const call: CallGemini = async () => response('{"windows": []}')
    expect(await callGemini(call, 'p', 'score', { sleep })).toEqual({ windows: [] })
    expect(waits).toEqual([])
  })

  /**
   * **Un arrêt demandé ne se réessaie pas.** L'abandon d'une requête ressort en
   * `AbortError`, que `NOMS_PASSAGERS` classe — à raison — parmi les erreurs à
   * réessayer : sans ce contrôle, un arrêt relançait trois fois en dormant cinq
   * puis dix secondes entre deux, c'est-à-dire l'exact contraire de ce qu'on
   * venait de demander.
   */
  it('refuse de réessayer quand l’arrêt est demandé', async () => {
    const controller = new AbortController()
    let attempts = 0
    const call: CallGemini = async () => {
      attempts += 1
      controller.abort()
      const error = new Error('This operation was aborted')
      error.name = 'AbortError'
      throw error
    }
    await expect(
      callGemini(call, 'p', 'score', { sleep, signal: controller.signal }),
    ).rejects.toThrow(/Arrêt demandé/)
    expect(attempts).toBe(1)
    expect(waits).toEqual([])
  })

  it('ne part même pas quand l’arrêt est déjà demandé', async () => {
    const controller = new AbortController()
    controller.abort()
    const call: CallGemini = async () => {
      throw new Error("l'appel ne devait pas partir")
    }
    await expect(
      callGemini(call, 'p', 'score', { sleep, signal: controller.signal }),
    ).rejects.toThrow(/Arrêt demandé/)
  })

  /**
   * **L'attente entre deux tentatives se laisse couper.** Contrôler le signal aux
   * deux bouts de la boucle ne suffisait pas : entre les deux il y a un `sleep`
   * qui monte à dix secondes, et jusqu'à quatre-vingt-dix quand le fournisseur
   * réclame un délai. Pendant tout ce temps l'exécution restait dans `enCours` et
   * l'écran annonçait une analyse en cours après le clic sur « Arrêter ».
   * (relevé par Copilot)
   */
  it('coupe l’attente entre deux tentatives au lieu de la subir', async () => {
    const controller = new AbortController()
    // Un `sleep` qui ne se règle jamais : c'est le pire cas, et il reproduit
    // exactement une attente de quatre-vingt-dix secondes.
    const never = () => new Promise<void>(() => {})
    const call: CallGemini = async () => {
      throw new Error('503 UNAVAILABLE: model overloaded')
    }

    const promise = callGemini(call, 'p', 'score', {
      sleep: never,
      signal: controller.signal,
    })
    // Laisser la première tentative échouer et entrer dans l'attente.
    await new Promise((r) => setTimeout(r, 5))
    controller.abort()

    await expect(promise).rejects.toThrow(/Arrêt demandé/)
  })

  it('réessaie une erreur passagère et rend le succès suivant', async () => {
    let attempts = 0
    const call: CallGemini = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('503 UNAVAILABLE: model overloaded')
      return response('{"windows": []}')
    }
    expect(await callGemini(call, 'p', 'score', { sleep })).toEqual({ windows: [] })
    expect(attempts).toBe(2)
    expect(waits).toEqual([5000])
  })

  it('réessaie un corps vide, que le service rend en 200', async () => {
    let attempts = 0
    const call: CallGemini = async () => {
      attempts += 1
      return attempts < 3 ? response('') : response('{"shorts": []}')
    }
    expect(await callGemini(call, 'p', 'detail', { sleep })).toEqual({ shorts: [] })
    expect(waits).toEqual([5000, 10000])
  })

  it('s’arrête à trois tentatives, l’attente doublant à chaque fois', async () => {
    let attempts = 0
    const call: CallGemini = async () => {
      attempts += 1
      throw new Error('429 RESOURCE_EXHAUSTED')
    }
    await expect(callGemini(call, 'p', 'score', { sleep })).rejects.toThrow('429')
    expect(attempts).toBe(3)
    expect(waits).toEqual([5000, 10000])
  })

  /**
   * Le quota par minute, et pourquoi l'escalier ne suffisait pas.
   *
   * Le palier gratuit de `gemini-3.1-flash-lite` plafonne à quinze requêtes par
   * minute, et la récupération des lots refusés triple le nombre d'appels. Le
   * corps du 429 dit combien attendre ; l'escalier de 5 s puis 10 s repartait
   * bien avant, épuisait ses trois tentatives et faisait échouer le repérage sur
   * une limite qui se lève toute seule.
   */
  it('attend le délai qu’un 429 demande, quand il est plus long que l’escalier', async () => {
    let attempts = 0
    const call: CallGemini = async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error(
          '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"54s"}]}}',
        )
      }
      return response('{"windows": []}')
    }
    expect(await callGemini(call, 'p', 'score', { sleep })).toEqual({ windows: [] })
    expect(waits).toEqual([54_000])
  })

  /**
   * Une attente trop longue ne se raccourcit pas : on renonce.
   *
   * La première version plafonnait l'attente à 90 s puis relançait quand même :
   * la requête repartait très avant la fin du quota, échouait, et le repérage
   * brûlait ses trois essais et trois minutes pour arriver au même endroit.
   *
   * Le message dit le délai demandé et ce qu'on accepte d'attendre, sans
   * nommer la limite : `retryDelay` est un délai minimal recommandé, dont on ne
   * peut déduire ni « journalier », ni « horaire ». (relevé par Copilot)
   */
  it('renonce tout de suite quand le quota demande plus que ce qu’on attend', async () => {
    let attempts = 0
    const call: CallGemini = async () => {
      attempts += 1
      throw new Error('{"error":{"code":429,"details":[{"retryDelay":"3600s"}]}}')
    }
    const error = await callGemini(call, 'p', 'score', { sleep }).then(
      () => null,
      (cause: unknown) => cause as Error,
    )
    expect(error!.message).toMatch(/demande d'attendre 3600 s/)
    expect(error!.message).toMatch(/90 s que cette étape accepte d'attendre/)
    // Rien n'est diagnostiqué : le délai ne dit pas de quelle limite il s'agit.
    expect(error!.message).not.toMatch(/journalier|horaire/)
    // Un seul essai, et pas la moindre attente : ni relance avant l'heure, ni
    // trois minutes immobilisées pour rien.
    expect(attempts).toBe(1)
    expect(waits).toEqual([])
  })

  it('ne réessaie jamais une réponse bloquée par le filtre de sécurité', async () => {
    let attempts = 0
    const call: CallGemini = async () => {
      attempts += 1
      return response('', { candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] } as never)
    }
    await expect(callGemini(call, 'p', 'score', { sleep })).rejects.toThrow(GeminiBlockedError)
    // Le refus est déterministe : relancer ne fait que brûler du quota et cacher
    // à l'utilisateur la vraie raison.
    expect(attempts).toBe(1)
    expect(waits).toEqual([])
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
    let attempts = 0
    const call: CallGemini = async () => {
      attempts += 1
      if (attempts === 1) throw new Error(message)
      return response('{"windows": []}')
    }
    expect(await callGemini(call, 'p', 'score', { sleep })).toEqual({ windows: [] })
    expect(attempts).toBe(2)
  })

  it('réessaie une réponse de détail sans tableau `shorts`', async () => {
    // Sinon elle passait pour une passe réussie et effaçait les propositions
    // non traitées. (relevé par Copilot)
    let attempts = 0
    const call: CallGemini = async () => {
      attempts += 1
      return attempts === 1 ? response('{"clips": []}') : response('{"shorts": []}')
    }
    // L'analyse passe par `analyser`, donc **dans** la boucle : analysée après
    // coup, l'enveloppe cassée ressortirait en « zéro clip ».
    const clips = await callGemini(call, 'p', 'detail', {
      sleep,
      analyze: (raw) =>
        parseDetailResponse(raw, {
          words: [],
          videoDuration: 100,
          projectId: 'p',
          blocks: [{ id: 'w', start: 0, end: 100, text: '', segFrom: 0, segTo: -1 }],
        }),
    })
    expect(clips).toEqual([])
    expect(attempts).toBe(2)
  })

  // Le délai d'appel s'applique par `AbortSignal.timeout`, dont l'exception ne
  // porte aucun code — juste « This operation was aborted ». Le délai qu'on
  // venait d'ajouter pour ENTRER dans la relance en sortait donc au premier
  // essai. Rien n'expose de signal d'annulation à l'appelant, donc un abandon ne
  // peut venir que du délai. (relevé par Copilot)
  it('réessaie un appel abandonné par le délai', async () => {
    const abandonment = (name: string) => {
      const e = new Error('This operation was aborted')
      e.name = name
      return e
    }
    for (const name of ['AbortError', 'TimeoutError']) {
      expect(estTransient(abandonment(name))).toBe(true)
    }
    // Et par le message seul, si un jour le nom se perd en route.
    expect(estTransient(new Error('The operation was aborted due to timeout'))).toBe(true)
  })

  it('réessaie une réponse tronquée', async () => {
    let attempts = 0
    const call: CallGemini = async () => {
      attempts += 1
      return attempts === 1
        ? response('{"windows": [', { candidates: [{ finishReason: 'MAX_TOKENS' }] } as never)
        : response('{"windows": []}')
    }
    expect(await callGemini(call, 'p', 'score', { sleep })).toEqual({ windows: [] })
    expect(attempts).toBe(2)
  })

  it('ne réessaie pas une erreur qui n’a rien de passager', async () => {
    let attempts = 0
    const call: CallGemini = async () => {
      attempts += 1
      throw new Error('API key not valid')
    }
    await expect(callGemini(call, 'p', 'score', { sleep })).rejects.toThrow('API key')
    expect(attempts).toBe(1)
  })
})

describe("l'étape de repérage", () => {
  let root: string
  let replay: string
  let projects: string
  let db: BetterSqlite3.Database
  const envStart = { ...process.env }

  /** Un transcript court, mais assez long pour construire plusieurs fenêtres. */
  const TRANSCRIPT = {
    language: 'fr',
    segments: Array.from({ length: 40 }, (_, i) => ({
      start: i * 6,
      end: i * 6 + 3.5,
      text: `phrase numéro ${i}`,
      words: `phrase numéro ${i}`.split(' ').map((word, j) => ({
        word: word,
        start: i * 6 + j * 0.45,
        end: i * 6 + j * 0.45 + 0.35,
      })),
    })),
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-candidats-'))
    replay = path.join(root, 'Replay')
    projects = path.join(root, 'projects')
    for (const d of [replay, projects]) fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(replay, SOURCE), 'pas vraiment une vidéo')
    process.env.REPLAY_DIR = replay
    process.env.STAGE_DIR = path.join(root, 'stage')
    process.env.PROJECTS_DIR = projects

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
    fs.rmSync(root, { recursive: true, force: true })
    process.env = { ...envStart }
  })

  /**
   * Un modèle qui note tout pareil et rend deux clips, dont un de 91 secondes.
   * Les prompts reçus sont capturés : c'est la seule façon de vérifier que les
   * cibles de nombre de clips ont été calculées **avant** la fusion.
   */
  function template(prompts: { mode: ModeGemini; prompt: string }[]): CallGemini {
    return async (prompt, mode) => {
      prompts.push({ mode, prompt })
      if (mode === 'score') {
        const ids = [...prompt.matchAll(/"id":"(window_\d+)"/g)].map((m) => m[1])
        return response(
          JSON.stringify({
            windows: ids.map((id, i) => ({ id, start: 0, end: 90, score: 90 - i, reason: 'ok' })),
          }),
        )
      }
      return response(
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
    const clips = await runCandidates(ID, { db, call: template(prompts), sleep: async () => {} })

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
    await runCandidates(ID, { db, call: template(prompts), sleep: async () => {} })
    expect(prompts.filter((p) => p.mode === 'detail')).toHaveLength(1)
    expect(prompts.filter((p) => p.mode === 'score').length).toBeGreaterThan(0)
    for (const { prompt } of prompts.filter((p) => p.mode === 'score')) {
      expect([...prompt.matchAll(/"id":"window_\d+"/g)].length).toBeLessThanOrEqual(8)
    }
  })

  it('calcule les cibles sur la durée de parole, que la fusion ne touche pas', async () => {
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    await runCandidates(ID, { db, call: template(prompts), sleep: async () => {} })
    const detail = prompts.find((p) => p.mode === 'detail')!.prompt

    // Le transcript fait 40 phrases sur 240 s : `buildWindows` en tire quatre
    // fenêtres, la présélection les garde toutes (son plancher est de 10), et la
    // fusion les ramène à un seul bloc contigu — elles se chevauchent toutes.
    const blocks = [...detail.matchAll(/"id":"window_\d+"/g)].length
    expect(blocks).toBe(1)

    const [, min, max] = /return (\d+) to (\d+) clips/.exec(detail)!
    // 40 segments de 3,5 s : 140 s de parole, et non les 239 s que sépare le
    // premier mot du dernier. Le prorata n'en tire aucun clip, `minimumClips` en
    // voudrait six, et les deux créneaux de 90 s tranchent à deux. Fusionner
    // remanie la charge utile, cela ne sélectionne pas moins de matière — et
    // depuis que la cible se calcule sur la parole, la fusion ne peut plus
    // l'atteindre du tout, ce qui rend l'ancienne inversion impossible plutôt
    // que seulement évitée.
    expect([Number(min), Number(max)]).toEqual([2, 4])
  })

  /**
   * `PATCH /api/clips/:id` reste ouverte pendant qu'une exécution de fond
   * tourne, et la passe de détail dure. Une décision prise **pendant** l'appel
   * réseau doit survivre : lire les clips avant cet appel puis fusionner sur cet
   * instantané traiterait le clip décidé comme un candidat, et `replaceClips`
   * effacerait la décision. C'est la garantie « une nouvelle passe n'écrase
   * jamais un travail humain » (spec §5). (relevé par Codex et Copilot)
   */
  it('ne perd pas une décision humaine prise pendant la passe de détail', async () => {
    // Passe 1 : deux candidats.
    await runCandidates(ID, { db, call: template([]), sleep: async () => {} })
    const [first] = getClips(db, ID)
    expect(first.status).toBe('candidate')

    // Passe 2 : quelqu'un garde le premier clip pendant que le détail tourne.
    const during: CallGemini = async (prompt, mode) => {
      if (mode === 'detail') putClip(db, { ...first, status: 'kept', title: 'gardé à la main' })
      return template([])(prompt, mode)
    }
    await runCandidates(ID, { db, call: during, sleep: async () => {} })

    const after = getClips(db, ID).find((c) => c.id === first.id)
    expect(after?.status).toBe('kept')
    expect(after?.title).toBe('gardé à la main')
  })

  /**
   * Le plafond absolu doit survivre au trajet jusqu'au prompt. Il se perdait
   * dans la passe de détail, sans même de découpe : un `Math.max(min + 1, …)`
   * relevait la borne haute d'un cran après que `clipCountTargets` l'eut posée.
   * (relevé par Copilot)
   */
  it('ne relève pas la borne haute que maximumClips vient de poser', async () => {
    setSetting(db, 'maximumClips', 2)
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    await runCandidates(ID, { db, call: template(prompts), sleep: async () => {} })

    const detail = prompts.find((p) => p.mode === 'detail')!.prompt
    const [, min, max] = /return (\d+) to (\d+) clips/.exec(detail)!
    expect([Number(min), Number(max)]).toEqual([2, 2])
  })

  it('la passe suivante ne ressuscite pas un clip écarté', async () => {
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    const first = await runCandidates(ID, { db, call: template(prompts), sleep: async () => {} })
    const discarded: Clip = { ...first[0], status: 'discarded' }
    putClip(db, discarded)

    const seconds = await runCandidates(ID, { db, call: template(prompts), sleep: async () => {} })
    const returned = seconds.filter((c) => c.id === discarded.id)
    expect(returned).toHaveLength(1)
    expect(returned[0].status).toBe('discarded')
    // Les identifiants dérivent des bornes : la même proposition retombe sur le
    // même identifiant, ce qui est exactement ce qui rend la garantie opérante.
    expect(seconds.map((c) => c.id).sort()).toEqual(first.map((c) => c.id).sort())
    expect(seconds.find((c) => c.status === 'candidate')?.pass).toBe(2)
  })

  it('écrit `candidates.json`, que le graphe regarde', async () => {
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    await runCandidates(ID, { db, call: template(prompts), sleep: async () => {} })
    const written: unknown = JSON.parse(fs.readFileSync(candidatesPath(ID), 'utf8'))
    expect(Array.isArray(written)).toBe(true)
    expect((written as Clip[])[0].projectId).toBe(ID)
  })

  it('une réponse de détail cassée n’efface rien et n’écrit pas l’artefact', async () => {
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    const first = await runCandidates(ID, { db, call: template(prompts), sleep: async () => {} })
    expect(first).toHaveLength(2)

    // Un modèle qui note normalement mais rend une enveloppe sans `shorts`.
    const broken: CallGemini = async (prompt, mode) => {
      if (mode === 'score') return template([])(prompt, mode)
      return response('{"clips": []}')
    }
    await expect(runCandidates(ID, { db, call: broken, sleep: async () => {} })).rejects.toThrow(
      /shorts/,
    )
    // Les propositions de la passe précédente sont toujours là, et l'artefact
    // n'a pas été réécrit sur un vide qui ferait sauter l'étape.
    expect(getClips(db, ID)).toHaveLength(2)
    const written: Clip[] = JSON.parse(fs.readFileSync(candidatesPath(ID), 'utf8'))
    expect(written).toHaveLength(2)
  })

  it('une écriture d’artefact impossible ne laisse pas de marqueur de succès', async () => {
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    await runCandidates(ID, { db, call: template(prompts), sleep: async () => {} })
    expect(fs.existsSync(candidatesPath(ID))).toBe(true)

    // On fait échouer l'écriture du provisoire — un dossier occupe son nom —
    // pour atteindre l'état que Copilot décrit : la base a changé, le fichier
    // n'a pas pu être écrit. Le marqueur ne doit pas survivre à ça, sinon le
    // graphe compte l'exécution comme terminée et l'artefact décrit l'état
    // d'avant. Le nom du provisoire est un détail interne, et c'est le prix à
    // payer pour éprouver l'ordre des trois gestes.
    const provisional = `${candidatesPath(ID)}.${process.pid}.tmp`
    fs.mkdirSync(provisional, { recursive: true })
    try {
      await expect(
        runCandidates(ID, { db, call: template(prompts), sleep: async () => {} }),
      ).rejects.toThrow()
      expect(fs.existsSync(candidatesPath(ID))).toBe(false)
    } finally {
      fs.rmSync(provisional, { recursive: true, force: true })
    }
  })

  it('ne laisse pas de fichier provisoire derrière elle', async () => {
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    await runCandidates(ID, { db, call: template(prompts), sleep: async () => {} })
    const remaining = fs.readdirSync(path.join(projects, ID)).filter((f) => f.endsWith('.tmp'))
    expect(remaining).toEqual([])
  })

  /**
   * Un lot de notation refusé n'est pas une vidéo refusée.
   *
   * Mesuré sur `2025-06-15-cqlp` le 18 août 2026 : sur 83 fenêtres, un seul lot
   * de 8 revient `PROHIBITED_CONTENT` de façon reproductible, et les 75 autres
   * fenêtres passent. Faire remonter ce refus rendait l'émission entière
   * inanalysable — quarante minutes de transcription pour rien.
   */
  it('poursuit la notation quand un lot est refusé par le filtre', async () => {
    // Une fenêtre par lot : le transcript de ce test en produit une poignée, et
    // il en faut plusieurs pour qu'il y ait un « reste » à poursuivre.
    process.env.SCORE_BATCH = '1'
    const prompts: { mode: ModeGemini; prompt: string }[] = []
    const normal = template(prompts)
    let batches = 0
    const aBatchRejected: CallGemini = async (prompt, mode) => {
      if (mode === 'score' && ++batches === 2) {
        return response('', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } as never)
      }
      return normal(prompt, mode)
    }

    const clips = await runCandidates(ID, { db, call: aBatchRejected, sleep: async () => {} })
    expect(clips).toHaveLength(2)
    // Le lot refusé n'a pas été réessayé : il l'est une fois, pas trois.
    expect(prompts.filter((p) => p.mode === 'score')).toHaveLength(batches - 1)
  })

  it('mais un refus sur **tous** les lots reste un refus de la vidéo', async () => {
    // Un lot par fenêtre : chacune est donc bel et bien soumise seule, et le
    // verdict porte sur un essai réellement fait.
    process.env.SCORE_BATCH = '1'
    const allRejected: CallGemini = async () =>
      response('', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } as never)
    await expect(
      runCandidates(ID, { db, call: allRejected, sleep: async () => {} }),
    ).rejects.toThrow(/jusqu'à la fenêtre seule/)
  })

  /**
   * Le message ne doit affirmer que ce qui a été essayé.
   *
   * Le budget peut s'épuiser avant qu'une seule fenêtre ait été soumise seule —
   * 11 lots de 8 tous refusés dépensent 22 appels sur les demi-lots et 11 sur
   * les quarts, et la descente s'arrête là. Dire alors « jusqu'à la fenêtre
   * seule » serait affirmer un essai qu'on n'a pas fait, c'est-à-dire commettre
   * d'un étage plus haut la faute que cette PR corrige. Le test précédent ne
   * contrôlait pas le libellé, donc l'inexactitude passait.
   * (relevé par Copilot, Codex et Aristarque)
   */
  it('n’affirme pas la fenêtre seule quand le budget s’est épuisé avant', async () => {
    process.env.SCORE_BATCH = '4'
    const allRejected: CallGemini = async () =>
      response('', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } as never)
    const failure = runCandidates(ID, { db, call: allRejected, sleep: async () => {} })

    const error = await failure.then(
      () => null,
      (cause: unknown) => cause as Error,
    )
    expect(error).toBeInstanceOf(GeminiBlockedError)
    expect(error!.message).toMatch(/budget de récupération \(3 appel\(s\)\)/)
    // L'accord suit le compte : une seule fenêtre essayée seule, donc singulier.
    expect(error!.message).toMatch(/1 sur 4 l'a été/)
    expect(error!.message).not.toMatch(/jusqu'à la fenêtre seule/)
    // Ce qui reste vrai malgré tout : la perte est chiffrée, pas avalée.
    const summary = lastSummary(ID)!
    expect(summary.noted).toBe(0)
    expect(summary.neverNoted).toHaveLength(summary.windows)
  })

  /**
   * Le raccord annoncé par `dernierBilan` et resté ouvert une itération : la
   * perte du repérage n'allait pas plus loin que le journal du serveur. Sur
   * `2025-06-15-cqlp`, quatre lots sur onze reviennent `PROHIBITED_CONTENT` —
   * un tiers du matériau écarté sans être jugé, et Julien triait vingt-cinq
   * cartes en croyant regarder ce que l'émission a de mieux.
   */
  describe('le raccord avec status.json', () => {
    it('fait remonter le décompte de la passe dans le statut', async () => {
      process.env.SCORE_BATCH = '2'
      await launch(ID, ['candidates'], {
        db,
        steps: {
          runCandidates: (id) =>
            runCandidates(id, { db, call: template([]), sleep: async () => {} }),
        },
      })
      await wait(ID)

      expect(lireStatus(ID)?.selectionReport).toEqual({
        windows: 4,
        scored: 4,
        rejectedBatches: 0,
        answeredBatches: 2,
        coverage: 1,
        partial: false,
      })
    })

    /**
     * **Le bilan décrit une notation tentée.** Une passe que le filtre arrête
     * laisse un décompte à zéro, et c'est exactement le moment où l'écran doit
     * le dire — mais en le marquant partiel, faute de quoi « 0 fenêtre notée »
     * passerait pour un résultat.
     */
    it('marque partielle une passe que le filtre a arrêtée', async () => {
      process.env.SCORE_BATCH = '4'
      const allRejected: CallGemini = async () =>
        response('', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } as never)
      await launch(ID, ['candidates'], {
        db,
        steps: {
          runCandidates: (id) => runCandidates(id, { db, call: allRejected, sleep: async () => {} }),
        },
      })
      await wait(ID).catch(() => {})

      const status = lireStatus(ID)
      expect(status?.error).toMatch(/refusé/)
      expect(status?.selectionReport).toMatchObject({ scored: 0, coverage: 0, partial: true })
    })

    /**
     * **Le sort du repérage, pas celui de l'exécution.** Une création vise
     * `['candidates', 'proxy', 'analysis']` : le repérage finit en trente
     * secondes, et ce qui suit peut échouer sans rien lui retirer. Déduire
     * `partiel` de l'`error` de l'exécution marquait un bilan complet comme
     * partiel — définitivement, puisque l'échec reste écrit.
     * (relevé par Codex et Copilot)
     */
    it('ne marque pas partiel un repérage réussi sous une exécution qui échoue', async () => {
      process.env.SCORE_BATCH = '2'
      await launch(ID, ['candidates', 'proxy'], {
        db,
        steps: {
          // La copie de travail manque, donc l'ingestion est demandée ; celle-ci
          // réussit sans rien inscrire, et l'étape `proxy` échoue derrière —
          // après un repérage qui, lui, a abouti.
          ingest: async () => ({
            projectId: ID,
            sourcePath: path.join(replay, SOURCE),
            stagedPath: path.join(root, 'stage', SOURCE),
            copied: false,
            sizeBytes: 0,
            mtimeMs: 0,
            durationSec: 240,
          }),
          runCandidates: (id) =>
            runCandidates(id, { db, call: template([]), sleep: async () => {} }),
        },
      })
      await wait(ID).catch(() => {})

      const status = lireStatus(ID)
      expect(status?.error).toMatch(/copie de travail/)
      expect(status?.selectionReport).toMatchObject({ scored: 4, coverage: 1, partial: false })
    })

    /**
     * **Le décompte doit être lisible pendant la notation, pas seulement après.**
     * L'écran interroge toutes les deux secondes ; le lanceur, lui, n'écrivait le
     * statut qu'au changement d'étape, c'est-à-dire avant le premier appel au
     * modèle et plus jamais avant la fin. `repérage` restait donc nul pendant
     * toute la passe — l'information la plus utile, absente exactement pendant
     * qu'elle se construit. (relevé par Codex et Copilot)
     */
    it('publie le décompte pendant la notation, pas seulement à la fin', async () => {
      process.env.SCORE_BATCH = '2'
      const seen: unknown[] = []
      const spy: CallGemini = async (prompt, mode) => {
        if (mode === 'score') seen.push(lireStatus(ID)?.selectionReport ?? null)
        return template([])(prompt, mode)
      }

      await launch(ID, ['candidates'], {
        db,
        steps: {
          // Les options du lanceur sont **transmises**, `onBilan` compris : c'est
          // le raccord qu'on teste, et un doublon qui les jette le testerait à
          // vide.
          runCandidates: (id, options) =>
            runCandidates(id, { ...options, db, call: spy, sleep: async () => {} }),
        },
      })
      await wait(ID)

      // Deux lots : au premier appel rien n'est encore jugé, au second le premier
      // lot est rangé et le statut le dit déjà.
      expect(seen).toHaveLength(2)
      expect(seen[0]).toBeNull()
      expect(seen[1]).toMatchObject({ scored: 2, windows: 4, partial: true })
    })

    /**
     * Le bilan vit dans ce processus et survit à la passe qui l'a produit. Sans
     * l'oubli posé au lancement, une seconde exécution publierait le décompte de
     * la première pendant tout le temps qu'elle met à arriver au repérage —
     * une demi-heure, quand la transcription est du voyage.
     */
    it('oublie le bilan de la passe précédente dès le lancement de la suivante', async () => {
      await launch(ID, ['candidates'], {
        db,
        steps: {
          runCandidates: (id) =>
            runCandidates(id, { db, call: template([]), sleep: async () => {} }),
        },
      })
      await wait(ID)
      expect(lireStatus(ID)?.selectionReport).not.toBeNull()

      // Une seconde passe dont l'étape ne note rien : le décompte publié ne peut
      // venir que de la précédente.
      await launch(ID, ['candidates'], {
        db,
        forced: true,
        steps: { runCandidates: async () => [] },
      })
      await wait(ID)
      expect(lireStatus(ID)?.selectionReport).toBeNull()
    })
  })

  /**
   * La récupération, et c'est le cœur de cette étape.
   *
   * Mesuré sur `2025-06-15-cqlp` le 18 août 2026 : quatre lots de huit sur onze
   * reviennent `PROHIBITED_CONTENT`, soit 32 fenêtres écartées sans être jugées,
   * et **les 32 passent quand on les envoie une par une**. Le filtre ne vise pas
   * une fenêtre coupable, il vise la concentration de matière dans une charge.
   * Recouper est donc la seule façon de récupérer le matériel — et ce n'est pas
   * un nouvel essai de la même requête, c'en est une autre.
   */
  describe('la récupération des lots refusés', () => {
    /**
     * Un modèle qui refuse tout lot où figure l'une des fenêtres nommées, et qui
     * note normalement les autres. Les identifiants soumis à chaque appel sont
     * capturés : c'est ce qui montre la découpe.
     */
    function rejecting(
      forbidden: string[],
      batches: string[][],
    ): CallGemini {
      const normal = template([])
      return async (prompt, mode) => {
        if (mode !== 'score') return normal(prompt, mode)
        const ids = [...prompt.matchAll(/"id":"(window_\d+)"/g)].map((m) => m[1])
        batches.push(ids)
        if (ids.some((id) => forbidden.includes(id))) {
          return response('', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } as never)
        }
        return normal(prompt, mode)
      }
    }

    it('recoupe le lot en deux et récupère les fenêtres innocentes', async () => {
      // Deux lots de deux : le premier tombe à cause d'une seule de ses fenêtres.
      process.env.SCORE_BATCH = '2'
      const batches: string[][] = []
      await runCandidates(ID, { db, call: rejecting(['window_002'], batches), sleep: async () => {} })

      expect(batches).toEqual([
        ['window_001', 'window_002'],
        ['window_003', 'window_004'],
        ['window_001'],
        ['window_002'],
      ])
      const summary = lastSummary(ID)!
      // Trois fenêtres sur quatre jugées, là où le repli silencieux en perdait
      // deux pour une seule en cause.
      expect(summary.noted).toBe(3)
      expect(summary.neverNoted).toEqual(['window_002'])
    })

    it('une fenêtre refusée seule est comptée comme telle, pas recoupée à l’infini', async () => {
      process.env.SCORE_BATCH = '2'
      const batches: string[][] = []
      await runCandidates(ID, { db, call: rejecting(['window_002'], batches), sleep: async () => {} })

      const summary = lastSummary(ID)!
      expect(summary.rejected).toEqual(['window_002'])
      // Elle a été soumise seule **une** fois, et pas une de plus.
      expect(batches.filter((l) => l.length === 1 && l[0] === 'window_002')).toHaveLength(1)
    })

    /**
     * L'invariant écrit dans `BilanNotation`, et il tient **à tout instant** :
     * une fenêtre est non jugée tant qu'une réponse ne la juge pas, y compris
     * quand une panne l'empêche d'être soumise. Le contrôler ici, sur la passe
     * la plus accidentée, est ce qui empêche un décompte de perte de mentir sur
     * l'ampleur de la perte.
     */
    it('garde notées + jamaisNotées = fenêtres, panne comprise', async () => {
      process.env.SCORE_BATCH = '2'
      await runCandidates(ID, { db, call: rejecting(['window_002'], []), sleep: async () => {} })

      const summary = lastSummary(ID)!
      expect(summary.noted + summary.neverNoted.length).toBe(summary.windows)
    })

    /**
     * **La couverture est la seule mesure qui réponde à la question posée**
     * (spec §7.2) : « quelle part de l'émission a été jugée ». Un compte de lots
     * ne la donne pas — les fenêtres se chevauchent de 30 s, le dernier lot est
     * plus court, et une fenêtre couvre de la parole, pas une tranche d'horloge.
     *
     * Le transcript de ce fichier va de 0 à 235,25 s (premier mot au dernier), et
     * `buildWindows` en tire quatre fenêtres : [0, 93,5], [66, 159,5],
     * [132, 225,5] et [198, 237,5]. `window_002` écartée, l'union des trois
     * autres vaut 93,5 + 103,25 = 196,75 s, soit 83,6 %.
     */
    it('rapporte l’union des fenêtres notées à l’étendue du transcript', async () => {
      process.env.SCORE_BATCH = '2'
      await runCandidates(ID, { db, call: rejecting(['window_002'], []), sleep: async () => {} })

      expect(lastSummary(ID)!.coverage).toBeCloseTo(196.75 / 235.25, 3)
    })

    /**
     * Le contrôle qui distingue une union d'une somme, et il n'est pas
     * théorique : additionner les trois fenêtres donnerait 226,5 s, soit 96,3 %
     * — un chiffre qui annoncerait presque toute l'émission jugée là où un
     * sixième lui manque. Les 30 s de chevauchement seraient comptées deux fois.
     */
    it('mesure une union, pas une somme de fenêtres qui se chevauchent', async () => {
      process.env.SCORE_BATCH = '2'
      await runCandidates(ID, { db, call: rejecting(['window_002'], []), sleep: async () => {} })

      expect(lastSummary(ID)!.coverage).not.toBeCloseTo(226.5 / 235.25, 3)
    })

    it('couvre tout quand toutes les fenêtres sont notées', async () => {
      process.env.SCORE_BATCH = '2'
      await runCandidates(ID, { db, call: template([]), sleep: async () => {} })

      expect(lastSummary(ID)!.coverage).toBe(1)
    })

    /**
     * Une passe dont rien n'a répondu lève, et le bilan qu'elle laisse derrière
     * elle doit dire zéro — pas « pas de chiffre ». C'est exactement le cas où
     * l'écran a le plus besoin de le dire.
     */
    it('vaut zéro quand aucune fenêtre n’a été notée', async () => {
      process.env.SCORE_BATCH = '4'
      const allRejected: CallGemini = async () =>
        response('', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } as never)
      await expect(
        runCandidates(ID, { db, call: allRejected, sleep: async () => {} }),
      ).rejects.toThrow(GeminiBlockedError)

      expect(lastSummary(ID)!.coverage).toBe(0)
    })

    it('borne la descente à un budget, et compte ce qu’il ne paie pas', async () => {
      // Un seul lot de quatre, donc un budget de trois appels de récupération.
      // La descente en demanderait quatre : le dernier n'est pas payé.
      process.env.SCORE_BATCH = '4'
      const batches: string[][] = []
      await runCandidates(ID, { db, call: rejecting(['window_001'], batches), sleep: async () => {} })

      const summary = lastSummary(ID)!
      expect(summary.calls).toBe(4)
      expect(summary.rejected).toEqual(['window_001'])
      // `window_002` n'a jamais été soumise seule : le budget s'est épuisé avant.
      expect([...summary.neverNoted].sort()).toEqual(['window_001', 'window_002'])
      expect(batches.some((l) => l.length === 1 && l[0] === 'window_002')).toBe(false)
    })

    /**
     * Le budget se dépense sur les découpes les moins profondes d'abord, quel
     * que soit le lot d'où elles viennent. En profondeur, il s'épuisait sur la
     * première branche et abandonnait un lot voisin qu'un seul appel sauvait.
     */
    it('dépense le budget en largeur, pas sur la première branche', async () => {
      process.env.SCORE_BATCH = '4'
      const batches: string[][] = []
      await runCandidates(ID, { db, call: rejecting(['window_001'], batches), sleep: async () => {} })

      // La deuxième moitié du lot, innocente, est notée avant que la descente
      // n'aille chercher la fenêtre coupable dans la première.
      expect(batches.slice(0, 3)).toEqual([
        ['window_001', 'window_002', 'window_003', 'window_004'],
        ['window_001', 'window_002'],
        ['window_003', 'window_004'],
      ])
      expect(lastSummary(ID)!.noted).toBe(2)
    })

    /**
     * Le budget borne des **requêtes**, pas des sous-lots.
     *
     * `appelerGemini` réessaie jusqu'à trois fois une erreur passagère : débité
     * une fois par sous-lot, un plafond annoncé de 3 pouvait donc produire 9
     * requêtes — et jusqu'à 99 pour les 33 d'une vraie émission. Or la raison
     * d'être de ce plafond est le quota, et un 429 est précisément ce qui
     * déclenche les relances : la borne se relâchait exactement là où elle
     * devait tenir. (relevé par Copilot et Codex)
     */
    it('débite le budget à chaque requête, relances comprises', async () => {
      process.env.SCORE_BATCH = '4'
      const batches: string[][] = []
      let transient = 0
      const rejected = rejecting(['window_001'], batches)
      const flaky: CallGemini = async (prompt, mode) => {
        // Une seule erreur passagère, sur la première moitié recoupée : elle
        // coûte une requête de plus, donc une unité de budget de plus.
        if (mode === 'score' && prompt.includes('"id":"window_002"') && ++transient === 2) {
          throw new Error('503 unavailable')
        }
        return rejected(prompt, mode)
      }
      await runCandidates(ID, { db, call: flaky, sleep: async () => {} })

      const summary = lastSummary(ID)!
      // Quatre requêtes : le lot entier, la moitié refusée relancée deux fois,
      // puis la moitié innocente. La relance a mangé le budget qui aurait servi
      // à descendre jusqu'à la fenêtre seule.
      expect(summary.calls).toBe(4)
      expect(summary.noted).toBe(2)
      // Personne n'a été soumis seul : le budget s'est épuisé avant.
      expect(summary.rejected).toEqual([])
      expect([...summary.neverNoted].sort()).toEqual(['window_001', 'window_002'])
    })

    /**
     * Le filet, et sa seule raison d'être : **la perte ne doit jamais être
     * silencieuse**, surtout quand elle est totale.
     *
     * Le bilan ne sortait au journal que par le chemin heureux — un refus total
     * lève, une panne se propage — donc il se taisait exactement dans les cas
     * où il aurait le plus servi. (relevé par Copilot)
     */
    it('journalise la perte même quand la passe échoue', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        process.env.SCORE_BATCH = '2'
        let batches = 0
        const broken: CallGemini = async (prompt, mode) => {
          if (mode === 'score' && ++batches === 2) throw new Error('403 PERMISSION_DENIED')
          return template([])(prompt, mode)
        }
        await expect(
          runCandidates(ID, { db, call: broken, sleep: async () => {} }),
        ).rejects.toThrow(/PERMISSION_DENIED/)

        const lines = [...warn.mock.calls, ...log.mock.calls].map((c) => String(c[0]))
        // Le décompte est sorti, et il nomme les fenêtres non jugées plutôt que
        // de se contenter de les compter.
        expect(lines.some((l) => /2\/4 fenêtre\(s\) jugée\(s\)/.test(l))).toBe(true)
        expect(lines.some((l) => l.includes('window_003, window_004'))).toBe(true)
      } finally {
        warn.mockRestore()
        log.mockRestore()
      }
    })

    it('un lot qui passe du premier coup ne coûte aucun appel de plus', async () => {
      process.env.SCORE_BATCH = '2'
      const batches: string[][] = []
      await runCandidates(ID, { db, call: rejecting([], batches), sleep: async () => {} })

      expect(batches).toHaveLength(2)
      const summary = lastSummary(ID)!
      expect(summary.noted).toBe(4)
      expect(summary.neverNoted).toEqual([])
      expect(summary.rejected).toEqual([])
    })

    /**
     * L'invariant du bilan : `notées + jamaisNotées === fenêtres`, **y compris
     * quand la passe casse en route**. La liste se remplissait au fil des refus,
     * donc une erreur réseau sortait de la boucle et laissait un bilan qui
     * annonçait des fenêtres jugées sans localiser les autres — un décompte de
     * perte qui ne comptait pas la perte. (relevé par Copilot)
     */
    it('localise la perte même quand la passe casse en cours de route', async () => {
      process.env.SCORE_BATCH = '2'
      let batches = 0
      // Une panne qui n'a rien de passager : elle sort de la boucle au premier
      // coup, ce qui est exactement le cas où le bilan restait muet.
      const broken: CallGemini = async (prompt, mode) => {
        if (mode === 'score' && ++batches === 2) throw new Error('403 PERMISSION_DENIED')
        return template([])(prompt, mode)
      }
      await expect(
        runCandidates(ID, { db, call: broken, sleep: async () => {} }),
      ).rejects.toThrow(/PERMISSION_DENIED/)

      const summary = lastSummary(ID)!
      expect(summary.noted).toBe(2)
      expect(summary.neverNoted).toEqual(['window_003', 'window_004'])
      expect(summary.noted + summary.neverNoted.length).toBe(summary.windows)
    })

    /**
     * Un bilan périmé est pire qu'un bilan absent : il a l'air d'un résultat.
     * (relevé par Copilot)
     */
    it('n’expose pas le bilan de la passe précédente quand la suivante échoue avant de noter', async () => {
      await runCandidates(ID, { db, call: template([]), sleep: async () => {} })
      expect(lastSummary(ID)!.noted).toBeGreaterThan(0)

      upsertProject(db, {
        id: ID,
        sourcePath: path.join(replay, SOURCE),
        stagedPath: null,
        durationSec: null,
        sizeBytes: null,
        mtimeMs: null,
        createdAt: 0,
      })
      await expect(runCandidates(ID, { db, call: template([]) })).rejects.toThrow(/durée/)
      expect(lastSummary(ID)).toBeNull()
    })

    /**
     * Le compteur sert à raisonner sur un plafond de 15 requêtes par minute :
     * il doit compter les requêtes, pas les lots. (relevé par Copilot)
     */
    it('compte les relances comme des requêtes, parce que le quota les compte', async () => {
      process.env.SCORE_BATCH = '4'
      let attempts = 0
      const flaky: CallGemini = async (prompt, mode) => {
        if (mode === 'score' && ++attempts === 1) throw new Error('503 unavailable')
        return template([])(prompt, mode)
      }
      await runCandidates(ID, { db, call: flaky, sleep: async () => {} })

      // Un seul lot, mais deux requêtes : l'échec passager et la relance.
      expect(lastSummary(ID)!.calls).toBe(2)
    })

    it('compte aussi les fenêtres qu’une réponse omet', async () => {
      process.env.SCORE_BATCH = '4'
      const mute: CallGemini = async (prompt, mode) => {
        if (mode === 'score') return response(JSON.stringify({ windows: [] }))
        return template([])(prompt, mode)
      }
      await runCandidates(ID, { db, call: mute, sleep: async () => {} })

      const summary = lastSummary(ID)!
      expect(summary.noted).toBe(0)
      expect(summary.neverNoted).toHaveLength(summary.windows)
      // Une omission n'est pas un refus : rien n'est recoupé.
      expect(summary.rejected).toEqual([])
      expect(summary.calls).toBe(1)
    })
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
    await expect(runCandidates(ID, { db, call: template([]) })).rejects.toThrow(/durée/)
  })

  /**
   * La passe de détail était un appel unique sans recours : un refus du filtre y
   * faisait échouer toute l'étape. C'était tenable tant que la présélection
   * plafonnait à 24 fenêtres ; le dimensionnement sur la durée de parole
   * l'ouvre, et le refus mesuré porte sur la **concentration** de matière dans
   * une charge. Élargir sans donner de recours reviendrait à troquer six clips
   * contre une étape qui tombe.
   */
  describe('le garde-fou de la passe de détail', () => {
    /**
     * Huit grappes de parole séparées par dix minutes de silence.
     *
     * Le transcript ordinaire de ces tests tient en un seul bloc — ses fenêtres
     * se chevauchent toutes —, or c'est précisément la découpe en plusieurs
     * blocs qu'il faut exercer ici. Les trous font que `mergeOverlappingWindows`
     * n'a rien à recoller : 15 fenêtres, 8 blocs.
     */
    const CLUSTERS = 8
    /** Ce que `buildWindows` en tire, et sur quoi la descente porte réellement. */
    const WINDOWS = 15
    const BURST = {
      language: 'fr',
      segments: Array.from({ length: CLUSTERS * 4 }, (_, i) => {
        const start = Math.floor(i / 4) * 600 + (i % 4) * 20
        return {
          start,
          end: start + 12,
          text: `grappe ${Math.floor(i / 4)} phrase ${i % 4}`,
          words: [{ word: `mot${i}`, start, end: start + 12 }],
        }
      }),
    }

    beforeEach(() => {
      fs.writeFileSync(
        path.join(sidecarDir(SOURCE), 'transcript.json'),
        JSON.stringify(BURST),
      )
      upsertProject(db, {
        id: ID,
        sourcePath: path.join(replay, SOURCE),
        stagedPath: null,
        durationSec: 4800,
        sizeBytes: null,
        mtimeMs: null,
        createdAt: 0,
      })
      // Ces grappes ne portent que 384 s de parole, donc la présélection par
      // défaut n'en retiendrait que dix des quinze fenêtres et la découpe
      // n'aurait plus huit blocs à recouper. Le réglage élargit l'examen : ce
      // qui s'exerce ici est le garde-fou, pas le dimensionnement.
      setSetting(db, 'windowsPerClip', 8)
    })

    /**
     * Un modèle qui note tout, et qui rend un clip par bloc — sauf quand la
     * charge qu'on lui soumet remplit `refuse`, auquel cas il la bloque. Avec
     * `vide`, il répond `shorts: []` : une réponse valide qui ne trouve rien.
     */
    function detailer(
      rejected: (blocks: string[]) => boolean,
      loaded: string[][] = [],
      empty = false,
    ): CallGemini {
      return async (prompt, mode) => {
        if (mode === 'score') {
          const ids = [...prompt.matchAll(/"id":"(window_\d+)"/g)].map((m) => m[1])
          return response(
            JSON.stringify({
              windows: ids.map((id, i) => ({
                id,
                start: 0,
                end: 90,
                score: 90 - i,
                reason: 'ok',
              })),
            }),
          )
        }
        const blocks = [...prompt.matchAll(/"id":"(window_\d+)","start":([\d.]+)/g)].map((m) => ({
          id: m[1],
          start: Number(m[2]),
        }))
        loaded.push(blocks.map((b) => b.id))
        if (rejected(blocks.map((b) => b.id))) {
          return response('', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } as never)
        }
        return response(
          JSON.stringify({
            shorts: (empty ? [] : blocks).map((b) => ({
              start: b.start,
              end: b.start + 32,
              source_window_id: b.id,
              predicted_score: 80,
              video_description_for_tiktok: 'une vanne #impro',
              video_description_for_instagram: 'une vanne #impro',
              video_title_for_youtube_short: `Le moment ${b.id}`,
              viral_hook_text: 'Et là',
            })),
          }),
        )
      }
    }

    it('recoupe la charge au lieu de laisser tomber l’étape', async () => {
      const loaded: string[][] = []
      const clips = await runCandidates(ID, {
        db,
        call: detailer((blocks) => blocks.length > 2, loaded),
        sleep: async () => {},
      })

      // Les huit blocs finissent tous détaillés, par charges de deux.
      expect(clips).toHaveLength(CLUSTERS)
      const details = loaded.filter((c) => c.length > 0)
      expect(details[0]).toHaveLength(CLUSTERS)
      expect(details.filter((c) => c.length === 2)).toHaveLength(4)
    })

    /**
     * La descente va jusqu'à la fenêtre seule, et pas à un seul niveau : la
     * mesure du 18 août sur `cqlp` a demandé des lots de 8 aux demi-lots, puis
     * aux paires, puis aux unités. Un seul niveau laisserait la moitié des refus
     * dehors.
     *
     * **Elle descend sur les fenêtres, pas sur les blocs fusionnés**, et c'est
     * ce qui la rend utile : un bloc réunit tous les voisins qui se chevauchent,
     * donc s'arrêter à « un bloc » abandonnerait une région entière sans avoir
     * jamais réduit la charge. Ici, les quinze fenêtres finissent chacune seule.
     * (relevé par Codex)
     */
    it('descend jusqu’à la fenêtre seule quand il le faut', async () => {
      const loaded: string[][] = []
      await runCandidates(ID, {
        db,
        call: detailer((blocks) => blocks.length > 1, loaded),
        sleep: async () => {},
      })

      expect(loaded.filter((c) => c.length === 1)).toHaveLength(WINDOWS)
    })

    /**
     * Perdre une région sur huit vaut infiniment mieux que perdre l'émission.
     * C'est la leçon déjà écrite dans `noterLesFenêtres` : « tous les lots ont
     * été refusés » ne dit rien de la vidéo tant qu'on n'a pas essayé de plus
     * petites charges — et « un bloc a été refusé » n'en dit rien du tout.
     */
    it('abandonne une fenêtre refusée seule sans perdre les autres', async () => {
      const clips = await runCandidates(ID, {
        db,
        call: detailer((blocks) => blocks.includes('window_001')),
        sleep: async () => {},
      })

      // Les quinze fenêtres se fusionnent en huit blocs ; seule celle que le
      // filtre vise disparaît, et sa voisine de bloc revient toute seule.
      expect(clips.length).toBeGreaterThanOrEqual(CLUSTERS - 1)
      expect(clips.some((c) => c.title.includes('window_001'))).toBe(false)
    })

    it('mais un refus jusqu’à la fenêtre seule reste un refus de la vidéo', async () => {
      await expect(
        runCandidates(ID, { db, call: detailer(() => true), sleep: async () => {} }),
      ).rejects.toThrow(/jusqu'à la fenêtre seule/)
    })

    /**
     * La descente se borne toute seule, et c'est ce qui la dispense du budget
     * de `récupérer` : elle parcourt un arbre binaire sur un ensemble de blocs
     * **fixe**, donc `2k - 1` appels au pire. Un plafond calqué sur `récupérer`
     * — `3k` — n'aurait jamais pu se déclencher, et aurait laissé derrière lui
     * une branche morte et un message d'erreur pour un cas impossible.
     *
     * Le message peut donc affirmer « jusqu'au bloc seul » sans prudence
     * oratoire : contrairement à `noterLesFenêtres`, la descente y arrive
     * toujours.
     */
    it('se borne à 2k-1 appels, sans budget à tenir', async () => {
      const loaded: string[][] = []
      const error = await runCandidates(ID, {
        db,
        call: detailer(() => true, loaded),
        sleep: async () => {},
      }).then(
        () => null,
        (e: Error) => e,
      )

      expect(error).toBeInstanceOf(GeminiBlockedError)
      expect(error!.message).toMatch(/jusqu'à la fenêtre seule/)
      // Quinze fenêtres toutes refusées : 29 appels, et chacune a bien été
      // soumise seule avant d'être comptée comme refusée.
      expect(loaded).toHaveLength(2 * WINDOWS - 1)
      expect(loaded.filter((c) => c.length === 1)).toHaveLength(WINDOWS)
    })

    /**
     * Le verdict compte les **réponses**, jamais les clips.
     *
     * `parseDetailResponse` tient `shorts: []` pour une réponse valide — « aucun
     * moment exploitable ici ». Une moitié qui répond vide pendant que l'autre
     * est refusée laissait donc `clips` vide avec des refus au compteur, et
     * l'étape échouait en accusant la vidéo d'un refus qu'elle n'a pas subi.
     * (relevé par Codex et Copilot)
     */
    it('ne confond pas « aucun clip trouvé » avec « aucune réponse »', async () => {
      const clips = await runCandidates(ID, {
        db,
        // Tout ce qui porte le dernier bloc est refusé ; le reste répond vide.
        call: detailer((blocks) => blocks.includes('window_015'), [], true),
        sleep: async () => {},
      })

      expect(clips).toEqual([])
      expect(getClips(db, ID)).toEqual([])
    })

    /**
     * Le plafond réglé survit à la découpe.
     *
     * La consigne seule ne suffit pas : une part qui s'arrondit à zéro est
     * relevée à un pour ne pas abandonner de région, donc la somme des consignes
     * enfants peut dépasser le plafond. Avec `maximumClips = 2` et une descente
     * jusqu'aux fenêtres, quinze appels demandent chacun un clip. C'est la coupe
     * finale qui rend le réglage vrai. (relevé par Copilot)
     */
    it('tient le plafond réglé même après une découpe complète', async () => {
      setSetting(db, 'maximumClips', 2)
      const clips = await runCandidates(ID, {
        db,
        call: detailer((blocks) => blocks.length > 1),
        sleep: async () => {},
      })

      expect(clips).toHaveLength(2)
      expect(getClips(db, ID)).toHaveLength(2)
    })

    /**
     * Le plafond compte des propositions qui survivront.
     *
     * Deux horodatages bruts différents se calent souvent sur le même clip —
     * c'est le métier de `snapToWords` — et `mergeCandidates` écarte ensuite le
     * doublon. Plafonner avant de dédoublonner laissait donc le condamné
     * consommer le quota, et évinçait un candidat valide que le réglage
     * autorisait. (relevé par Codex)
     */
    it('dédoublonne avant de plafonner, pas après', async () => {
      setSetting(db, 'maximumClips', 2)
      // Deux bornes brutes distinctes qui se calent toutes deux sur (0, 32), et
      // une troisième bien distincte.
      const raw = [
        { start: 1, end: 30 },
        { start: 2, end: 31 },
        { start: 41, end: 70 },
      ]
      const call: CallGemini = async (prompt, mode) => {
        if (mode === 'score') {
          const ids = [...prompt.matchAll(/"id":"(window_\d+)"/g)].map((m) => m[1])
          return response(
            JSON.stringify({
              windows: ids.map((id, i) => ({ id, start: 0, end: 90, score: 90 - i, reason: 'ok' })),
            }),
          )
        }
        return response(
          JSON.stringify({
            shorts: raw.map((b, i) => ({
              ...b,
              source_window_id: 'window_001',
              predicted_score: 80,
              video_description_for_tiktok: `proposition ${i}`,
              video_description_for_instagram: `proposition ${i}`,
              video_title_for_youtube_short: `Le moment ${i}`,
              viral_hook_text: 'Et là',
            })),
          }),
        )
      }

      const clips = await runCandidates(ID, { db, call, sleep: async () => {} })

      // Avant le correctif : `[A, A, B]` coupé à deux donnait `[A, A]`, puis un
      // seul clip après dédoublonnage — B disparaissait pour rien.
      expect(clips).toHaveLength(2)
      expect(new Set(clips.map((c) => c.id)).size).toBe(2)
    })

    /**
     * Après une découpe, le plafond garde les meilleurs clips de l'émission,
     * pas ceux de la première charge.
     *
     * Chaque réponse est bien ordonnée par performance prédite, mais **cet
     * ordre n'est local qu'à sa sous-requête** : `descendre` concatène la
     * branche gauche avant la droite, et couper là gardait les clips de cette
     * branche quoi que la seconde ait rendu. Un clip faible d'une moitié
     * déplaçait ainsi un clip bien meilleur rendu par l'autre.
     * (relevé par Codex)
     *
     * La descente porte sur `retenues`, ordonnée par note de **fenêtre** : la
     * moitié gauche n'est donc pas la première moitié du transcript, et les
     * identifiants attendus ici s'en déduisent plutôt que de se coder en dur.
     */
    it('reclasse les résultats d’une découpe avant de plafonner', async () => {
      setSetting(db, 'maximumClips', 2)
      // Le modèle note d'autant mieux que la grappe est tardive, et rend ses
      // clips comme le prompt le lui demande — le meilleur d'abord. Les deux
      // meilleurs de l'émission sont donc tout au bout, dans la seconde moitié
      // de la descente.
      const submitted = new Map<string, number>()
      const call: CallGemini = async (prompt, mode) => {
        if (mode === 'score') return detailer(() => false)(prompt, mode)
        const blocks = [...prompt.matchAll(/"id":"(window_\d+)","start":([\d.]+)/g)].map((m) => ({
          id: m[1],
          start: Number(m[2]),
        }))
        for (const block of blocks) submitted.set(block.id, block.start)
        // Plus de quatre blocs dans la charge : refusée. La descente coupe une
        // fois, et chaque moitié répond ensuite pour elle seule.
        if (blocks.length > 4) {
          return response('', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } as never)
        }
        return response(
          JSON.stringify({
            shorts: [...blocks]
              .sort((a, b) => b.start - a.start)
              .map((block) => ({
                start: block.start,
                end: block.start + 32,
                source_window_id: block.id,
                predicted_score: Math.round(block.start / 600) * 10 + 10,
                video_description_for_tiktok: 'une vanne #impro',
                video_description_for_instagram: 'une vanne #impro',
                video_title_for_youtube_short: `Le moment ${block.id}`,
                viral_hook_text: 'Et là',
              })),
          }),
        )
      }

      const clips = await runCandidates(ID, { db, call: call, sleep: async () => {} })

      // Les deux blocs les mieux notés, qui sont les deux derniers de
      // l'émission — et qui tombent tous deux dans la seconde branche de la
      // descente. Avant le correctif : `window_011` et `window_009`, les deux
      // premiers clips de la branche gauche.
      const best = [...submitted.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, 2)
        .map(([id]) => `Le moment ${id}`)
      expect(clips.map((c) => c.title)).toEqual(best)
    })

    /**
     * Le plafond compte les propositions qui survivront — y compris quand la
     * décision tombe pendant que la requête est en vol.
     *
     * `PATCH /api/clips/:id` reste ouverte pendant qu'une exécution de fond
     * tourne. Un instantané pris **avant** l'appel traite encore comme
     * disponible un clip que quelqu'un vient d'écarter : la proposition
     * consommait un créneau du plafond, `mergeCandidates` l'écartait ensuite sur
     * la relecture fraîche, et la passe rendait moins de clips que le maximum
     * réglé. (relevé par Codex)
     */
    it('relit les décisions prises pendant la requête avant de plafonner', async () => {
      setSetting(db, 'maximumClips', 2)
      const model = detailer(() => false)
      const firstPass = await runCandidates(ID, { db, call: model, sleep: async () => {} })
      expect(firstPass).toHaveLength(2)

      // La décision tombe **pendant** l'appel de détail de la passe suivante :
      // ni avant, où l'instantané la verrait, ni après, où seule la fusion la
      // verrait.
      const discarded: Clip = { ...firstPass[0], status: 'discarded' }
      const call: CallGemini = async (prompt, mode) => {
        if (mode === 'detail') putClip(db, discarded)
        return model(prompt, mode)
      }

      const clips = await runCandidates(ID, { db, call: call, sleep: async () => {} })

      // Le clip écarté ne consomme plus de créneau : deux propositions
      // survivent, comme le plafond l'autorise. Avant le correctif, une seule —
      // `mergeCandidates` écartait la première sur la relecture fraîche, et la
      // suivante avait déjà été coupée par le plafond.
      expect(clips.filter((c) => c.status === 'candidate')).toHaveLength(2)
      // Et la décision, elle, traverse la passe intacte.
      expect(clips.filter((c) => c.id === discarded.id)).toEqual([discarded])
    })

    /**
     * La cible de clips suit la découpe. Demander le plancher entier à chaque
     * moitié en rendrait deux fois trop — et le plancher est ce que le modèle
     * rend, pas une borne basse.
     */
    it('met la cible de clips au prorata des blocs soumis', async () => {
      const prompts: string[] = []
      const spy: CallGemini = async (prompt, mode) => {
        if (mode === 'detail') prompts.push(prompt)
        return detailer((blocks) => blocks.length > 2)(prompt, mode)
      }
      await runCandidates(ID, { db, call: spy, sleep: async () => {} })

      const target = (prompt: string) => {
        const [, bottom] = /return (\d+) to (\d+) clips/.exec(prompt)!
        return Number(bottom)
      }
      const entier = target(prompts[0])
      const quarter = prompts.filter((p) => (p.match(/"id":"window_\d+"/g) ?? []).length === 2)
      expect(entier).toBeGreaterThan(target(quarter[0]))
      expect(target(quarter[0])).toBeGreaterThanOrEqual(1)
    })
  })

  describe('lireTranscript', () => {
    it('écarte un mot sans horodatage plutôt que de jeter le transcript', () => {
      const file = path.join(root, 'partiel.json')
      fs.writeFileSync(
        file,
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
      const lu = lireTranscript(file)
      // WhisperX laisse des mots non alignés — chiffres, ponctuation. Ils ne
      // servent qu'à `snapToWords`, qui cherche des frontières : un mot sans
      // frontière n'en est pas une.
      expect(lu.segments[0].words).toEqual([{ word: 'euros', start: 1, end: 2 }])
      expect(lu.language).toBe('unknown')
    })

    it('lève sur un fichier qui n’a pas la forme d’un transcript', () => {
      const file = path.join(root, 'faux.json')
      fs.writeFileSync(file, JSON.stringify({ texte: 'bonjour' }))
      expect(() => lireTranscript(file)).toThrow(/illisible/)
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
    ])('ne laisse pas fuiter le chemin du sidecar — fichier %s', (name, content) => {
      const file = path.join(root, `sidecar-secret-${name}.json`)
      if (content !== undefined) fs.writeFileSync(file, content)
      try {
        lireTranscript(file)
        expect.unreachable('lireTranscript aurait dû lever')
      } catch (error) {
        expect((error as Error).message).toMatch(/illisible dans le sidecar/)
        expect((error as Error).message).not.toContain(file)
        expect((error as Error).message).not.toContain(root)
      }
    })
  })
})

/**
 * La part couverte, seule. Les cas limites d'une mesure ne se rencontrent pas
 * dans une passe complète : un transcript sans mot aligné, une fenêtre qui
 * déborde de l'étendue, une liste vide.
 */
describe('partCouverte', () => {
  it('additionne des intervalles disjoints', () => {
    expect(partCovered([{ start: 0, end: 10 }, { start: 20, end: 30 }], { start: 0, end: 40 })).toBe(
      0.5,
    )
  })

  it('ne compte qu’une fois ce que deux intervalles se partagent', () => {
    expect(partCovered([{ start: 0, end: 30 }, { start: 20, end: 40 }], { start: 0, end: 40 })).toBe(
      1,
    )
  })

  it('accepte des intervalles dans le désordre', () => {
    expect(partCovered([{ start: 20, end: 30 }, { start: 0, end: 10 }], { start: 0, end: 40 })).toBe(
      0.5,
    )
  })

  /**
   * Une fenêtre se cale sur des **segments**, dont la fin dépasse le dernier mot
   * aligné : sans écrêtage, la part dépasserait 1 et l'écran annoncerait 104 %.
   */
  it('écrête à l’étendue, donc ne dépasse jamais 1', () => {
    expect(partCovered([{ start: -50, end: 500 }], { start: 0, end: 40 })).toBe(1)
  })

  it('ignore ce qui tombe entièrement hors de l’étendue', () => {
    expect(partCovered([{ start: 100, end: 200 }], { start: 0, end: 40 })).toBe(0)
  })

  it('rend zéro sans intervalle', () => {
    expect(partCovered([], { start: 0, end: 40 })).toBe(0)
  })

  /**
   * Un transcript sans mot aligné n'a pas d'étendue. Zéro plutôt qu'une
   * division par zéro : il n'y avait pas de matière, donc aucune part n'en a été
   * jugée.
   */
  it('rend zéro quand l’étendue est vide, sans diviser par zéro', () => {
    expect(partCovered([{ start: 0, end: 10 }], { start: 12, end: 12 })).toBe(0)
  })

  /**
   * Arrondi au dix-millième : `status.json` se relit à l'œil, et
   * `0.3333333333333333` n'y apprend rien de plus que `0.3333`.
   */
  it('arrondit au dix-millième', () => {
    expect(partCovered([{ start: 0, end: 1 }], { start: 0, end: 3 })).toBe(0.3333)
  })
})
