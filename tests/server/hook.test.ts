import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST as postHook } from '@/app/api/clips/[id]/hook/route'
import { GeminiBlockedError } from '@/server/steps/candidates'
import type { Clip } from '@/core/edl'
import { applySettings, closeDb, getClip, getDb, putClip, upsertProject } from '@/server/db'
import { generateHookText } from '@/server/steps/hook'

/**
 * La génération du hook — `generateHookText`, premier appelant de l'usage
 * `'hook'`, et `POST /api/clips/:id/hook`, son seul appelant.
 *
 * **Ollama, pas Gemini.** Ollama n'a pas de clé à vérifier : c'est le
 * fournisseur qui laisse la politique de clé (point 8) se tester à côté, sur
 * un fournisseur qui en réclame une, sans mélanger les deux préoccupations
 * dans le même test.
 */

const PROJECT = '2025-06-15-cqlp'

function baseClip(fields: Partial<Clip> = {}): Clip {
  return {
    id: `${PROJECT}_000060000-000090000`,
    projectId: PROJECT,
    segments: [{ start: 60, end: 90 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'Le pingouin au tribunal',
    description: 'Un procès improbable',
    status: 'kept',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    ...fields,
  }
}

let root: string

function writeTranscriptFixture(): void {
  const dir = path.join(root, 'projects', PROJECT, `${PROJECT}.avolo`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'transcript.json'),
    JSON.stringify({
      language: 'fr',
      segments: [
        { start: 60, end: 65, text: 'Alors moi je dis que ce pingouin ment', words: [] },
        { start: 70, end: 75, text: 'Un pingouin avec un cartable ça se discute', words: [] },
        // Hors du segment du clip [60,90) : ne doit pas apparaître dans le prompt.
        { start: 200, end: 205, text: 'Une phrase totalement hors sujet', words: [] },
      ],
    }),
  )
}

function ollamaResponse(hook: string): Response {
  return new Response(JSON.stringify({ message: { content: JSON.stringify({ hook }) } }), {
    status: 200,
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-hook-'))
  process.env.REPLAY_DIR = path.join(root, 'replays')
  process.env.STAGE_DIR = path.join(root, 'stage')
  process.env.PROJECTS_DIR = path.join(root, 'projects')
  fs.mkdirSync(process.env.REPLAY_DIR, { recursive: true })
  fs.writeFileSync(path.join(process.env.REPLAY_DIR, `${PROJECT}.mp4`), '')

  upsertProject(getDb(), {
    id: PROJECT,
    sourcePath: path.join(root, 'replays', `${PROJECT}.mp4`),
    stagedPath: path.join(root, 'stage', `${PROJECT}.mp4`),
    durationSec: 400,
    sizeBytes: 12,
    mtimeMs: 0,
    createdAt: 1,
  })
  putClip(getDb(), baseClip())
  writeTranscriptFixture()

  // Une adresse fixe : sans elle, `createOllamaCall` shellerait `ip route
  // show default` pour résoudre la passerelle WSL, un aller au système que ce
  // test n'a pas à payer.
  applySettings(getDb(), { ai: { hookProvider: 'ollama', ollamaBaseUrl: 'http://127.0.0.1:11434' } })
})

afterEach(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function context(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

describe('generateHookText', () => {
  it("produit le texte du fournisseur, normalisé — c'est le critère 7", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ollamaResponse('Ce pingouin va tout faire capoter'))
    vi.stubGlobal('fetch', fetchMock)

    const text = await generateHookText(getDb(), baseClip().id)
    expect(text).toBe('Ce pingouin va tout faire capoter')
    // 6, pas 10 : le plafond que `normalizeHookText` applique depuis la PR
    // #117 (relevé par Aristarque — le texte de ce test ne fait que 6 mots,
    // donc l'ancienne assertion à 10 ne l'exerçait pas ; la ligne 169
    // couvre déjà le plafond avec un texte de 12 mots).
    expect(text.split(' ').length).toBeLessThanOrEqual(6)

    // Le prompt envoyé porte le texte du clip, pas la phrase hors segment.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { messages: { content: string }[] }
    const prompt = body.messages[0].content
    expect(prompt).toContain('Alors moi je dis que ce pingouin ment')
    expect(prompt).toContain('Un pingouin avec un cartable ça se discute')
    expect(prompt).not.toContain('Une phrase totalement hors sujet')
  })

  it("filtre au mot, pas au segment Whisper entier — une coupe au milieu d'une phrase n'envoie que ce que le clip garde", async () => {
    // Le segment Whisper [60,66) chevauche le clip [60,63) sans y tenir en
    // entier : seuls les mots dont l'intervalle recoupe [60,63) doivent
    // atteindre le prompt.
    const dir = path.join(root, 'projects', PROJECT, `${PROJECT}.avolo`)
    fs.writeFileSync(
      path.join(dir, 'transcript.json'),
      JSON.stringify({
        language: 'fr',
        segments: [
          {
            start: 60,
            end: 66,
            text: 'Alors moi je dis que ce pingouin ment',
            words: [
              { word: 'Alors', start: 60, end: 60.5 },
              { word: 'moi', start: 60.5, end: 61 },
              { word: 'je', start: 61, end: 61.3 },
              { word: 'dis', start: 61.3, end: 61.6 },
              { word: 'que', start: 61.6, end: 61.9 },
              { word: 'ce', start: 64, end: 64.3 },
              { word: 'pingouin', start: 64.3, end: 65 },
              { word: 'ment', start: 65, end: 65.5 },
            ],
          },
        ],
      }),
    )
    const clip = baseClip({ segments: [{ start: 60, end: 63 }] })
    putClip(getDb(), clip)

    const fetchMock = vi.fn().mockResolvedValue(ollamaResponse('Ce pingouin va tout faire capoter'))
    vi.stubGlobal('fetch', fetchMock)

    await generateHookText(getDb(), clip.id)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { messages: { content: string }[] }
    const prompt = body.messages[0].content
    expect(prompt).toContain('Alors moi je dis que')
    expect(prompt).not.toContain('ce pingouin ment')
  })

  it('un texte vide rendu par le modèle est une réponse valide, pas une erreur', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ollamaResponse('')))
    await expect(generateHookText(getDb(), baseClip().id)).resolves.toBe('')
  })

  it('normalise le texte rendu — guillemets et plafond de six mots', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ollamaResponse('"un deux trois quatre cinq six sept huit neuf dix onze douze"'),
      ),
    )
    const text = await generateHookText(getDb(), baseClip().id)
    expect(text.startsWith('"')).toBe(false)
    expect(text.split(' ')).toHaveLength(6)
  })

  it("échoue avant tout appel réseau quand le fournisseur réglé n'a pas sa clé — critère 8", async () => {
    applySettings(getDb(), { ai: { hookProvider: 'gemini', hookModel: 'gemini-3.1-flash-lite' } })
    vi.stubEnv('GEMINI_API_KEY', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateHookText(getDb(), baseClip().id)).rejects.toThrow(/GEMINI_API_KEY/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('un blocage de contenu ne se réessaie pas — critère 9', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: {}, done_reason: 'length' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    // `done_reason: 'length'` se traduit en `MAX_TOKENS`, une troncature — pas
    // un refus. On simule ici plutôt une fin non nommée, qui échoue aussi sans
    // se réessayer (Ollama n'a pas de filtre fournisseur nommé, voir
    // `toFinishReason`) : le point qui compte est le même, un seul appel.
    await expect(generateHookText(getDb(), baseClip().id)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('propage un refus de contenu nommé sans le réessayer', async () => {
    // Simulé via une réponse Gemini bloquée, pour exercer `leverIfBlocked`
    // avec un refus réellement nommé plutôt que la fin non reconnue d'Ollama.
    applySettings(getDb(), { ai: { hookProvider: 'gemini', hookModel: 'gemini-3.1-flash-lite' } })
    vi.stubEnv('GEMINI_API_KEY', 'clé-de-test')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ finishReason: 'SAFETY' }],
          promptFeedback: {},
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateHookText(getDb(), baseClip().id)).rejects.toThrow(GeminiBlockedError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/clips/:id/hook', () => {
  it('régénère le hook et l’écrit sur le clip', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ollamaResponse('Un pingouin, un procès, un scandale')))

    const clip = baseClip()
    const response = await postHook(new Request('http://test', { method: 'POST' }), context(clip.id))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { clip: Clip }
    expect(body.clip.hookText).toBe('Un pingouin, un procès, un scandale')
    expect(getClip(getDb(), clip.id)?.hookText).toBe('Un pingouin, un procès, un scandale')
  })

  it('404 sur un clip inconnu', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const response = await postHook(new Request('http://test', { method: 'POST' }), context('inconnu'))
    expect(response.status).toBe(404)
  })

  it("400 sur un clip qui n'est pas gardé — un candidat ne consomme pas d'appel LLM", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const clip = baseClip({ status: 'candidate' })
    putClip(getDb(), clip)

    const response = await postHook(new Request('http://test', { method: 'POST' }), context(clip.id))
    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /**
   * **Le point sérieux relevé en review interne.** `putClip` remplace la
   * ligne entière ; écrire sur l'instantané pris avant l'appel au modèle
   * effacerait silencieusement tout ce qui s'est posé sur ce clip pendant les
   * trente secondes que l'appel peut prendre. La route relit le clip juste
   * avant d'écrire, et ce test le prouve en simulant une écriture concurrente
   * pendant que l'appel au modèle est encore en vol.
   */
  it('ne perd pas une écriture concurrente survenue pendant l’appel au modèle', async () => {
    let resolveFetch!: (value: Response) => void
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending))

    const clip = baseClip()
    const promise = postHook(new Request('http://test', { method: 'POST' }), context(clip.id))

    // Une écriture concurrente arrive pendant que l'appel au modèle est en
    // vol — un autre onglet, l'autosave du montage, un champ de texte.
    putClip(getDb(), { ...clip, title: 'Titre changé pendant l’appel' })

    resolveFetch(ollamaResponse('Un hook régénéré'))
    const response = await promise
    expect(response.status).toBe(200)

    const written = getClip(getDb(), clip.id)
    expect(written?.title).toBe('Titre changé pendant l’appel')
    expect(written?.hookText).toBe('Un hook régénéré')
  })
})
