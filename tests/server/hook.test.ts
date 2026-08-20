import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST as postHook } from '@/app/api/clips/[id]/hook/route'
import { GeminiBlockedError } from '@/server/steps/candidates'
import type { Clip } from '@/core/edl'
import { applySettings, closeDb, getClip, getDb, putClip, upsertProject } from '@/server/db'
import { scheduleHookBackfill } from '@/server/steps/hook-backfill'
import { generateHook } from '@/server/steps/hook'

/**
 * La génération du hook — `generateHook`, premier appelant de l'usage
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

function ollamaResponse(hook: string, badge = ''): Response {
  return new Response(JSON.stringify({ message: { content: JSON.stringify({ hook, badge }) } }), {
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

describe('generateHook', () => {
  it("produit le texte du fournisseur, normalisé — c'est le critère 7", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ollamaResponse('Ce pingouin va tout faire capoter'))
    vi.stubGlobal('fetch', fetchMock)

    const { text } = await generateHook(getDb(), baseClip().id)
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

    await generateHook(getDb(), clip.id)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { messages: { content: string }[] }
    const prompt = body.messages[0].content
    expect(prompt).toContain('Alors moi je dis que')
    expect(prompt).not.toContain('ce pingouin ment')
  })

  it('un texte vide rendu par le modèle est une réponse valide, pas une erreur', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ollamaResponse('')))
    await expect(generateHook(getDb(), baseClip().id)).resolves.toEqual({ text: '', badge: '' })
  })

  it('normalise le texte rendu — guillemets et plafond de six mots', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ollamaResponse('"un deux trois quatre cinq six sept huit neuf dix onze douze"'),
      ),
    )
    const { text } = await generateHook(getDb(), baseClip().id)
    expect(text.startsWith('"')).toBe(false)
    expect(text.split(' ')).toHaveLength(6)
  })

  it("échoue avant tout appel réseau quand le fournisseur réglé n'a pas sa clé — critère 8", async () => {
    applySettings(getDb(), { ai: { hookProvider: 'gemini', hookModel: 'gemini-3.1-flash-lite' } })
    vi.stubEnv('GEMINI_API_KEY', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateHook(getDb(), baseClip().id)).rejects.toThrow(/GEMINI_API_KEY/)
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
    await expect(generateHook(getDb(), baseClip().id)).rejects.toThrow()
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

    await expect(generateHook(getDb(), baseClip().id)).rejects.toThrow(GeminiBlockedError)
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
describe('le badge, à la régénération', () => {
  it('rend le badge du modèle, normalisé', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ollamaResponse('Une accroche', '  «\u00a0DÉFI 10\u00a0»  ')))
    const { badge } = await generateHook(getDb(), baseClip().id)
    expect(badge).toBe('DÉFI 10')
  })

  it('un badge absent de la réponse vaut la chaîne vide, sans échouer', async () => {
    // Une réponse de l'ancienne forme — `{ hook }` seul — reste exploitable :
    // le badge n'est pas la raison de l'appel.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: { content: JSON.stringify({ hook: 'Une accroche' }) } }), {
          status: 200,
        }),
      ),
    )
    await expect(generateHook(getDb(), baseClip().id)).resolves.toEqual({
      text: 'Une accroche',
      badge: '',
    })
  })

  it('un badge bavard est ramené à trois mots', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ollamaResponse('Une accroche', 'un badge beaucoup trop long')))
    const { badge } = await generateHook(getDb(), baseClip().id)
    expect(badge).toBe('un badge beaucoup')
  })

  /**
   * **« Régénérer » remplace la PAIRE, y compris par du vide.** Garder
   * l'ancienne pastille au-dessus d'une accroche neuve lui accolerait un
   * sur-titre écrit pour un texte qui n'est plus là.
   */
  it('la route écrit les deux champs, et efface un badge que le modèle ne reconduit pas', async () => {
    const clip = baseClip({ hookText: 'Ancienne', hookBadge: 'DÉFI 09' })
    putClip(getDb(), clip)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ollamaResponse('Une accroche neuve', '')))

    const response = await postHook(new Request('http://x', { method: 'POST' }), context(clip.id))
    expect(response.status).toBe(200)

    const written = getClip(getDb(), clip.id)
    expect(written?.hookText).toBe('Une accroche neuve')
    expect(written?.hookBadge).toBe('')
  })

  it('la route écrit le badge quand le modèle en propose un', async () => {
    const clip = baseClip({ hookText: 'Ancienne', hookBadge: '' })
    putClip(getDb(), clip)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ollamaResponse('Une accroche neuve', 'DÉFI 10')))

    await postHook(new Request('http://x', { method: 'POST' }), context(clip.id))
    expect(getClip(getDb(), clip.id)?.hookBadge).toBe('DÉFI 10')
  })
})

})

/**
 * Le rattrapage à la transition `candidate → kept`
 * (`src/server/steps/hook-backfill.ts`).
 *
 * Ce que ces tests fixent : il ne part que sur un hook vide, il n'écrase
 * jamais rien, il ne part qu'une fois, et son échec ne se voit nulle part
 * ailleurs que dans un avertissement.
 */
describe('scheduleHookBackfill', () => {
  it('remplit un clip fraîchement gardé dont l’accroche est vide', async () => {
    const clip = baseClip({ status: 'kept', hookText: '', hookBadge: '' })
    putClip(getDb(), clip)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ollamaResponse('Une accroche', 'DÉFI 10')))

    await scheduleHookBackfill(getDb(), clip.id)

    const written = getClip(getDb(), clip.id)
    expect(written?.hookText).toBe('Une accroche')
    expect(written?.hookBadge).toBe('DÉFI 10')
  })

  /**
   * **Le cas courant, et celui qui protège la contrainte du §7** : le hook
   * arrive gratuitement du repérage, donc le rattrapage ne doit consommer
   * aucun appel.
   */
  it('ne touche à rien quand l’accroche est déjà là — aucun appel réseau', async () => {
    const clip = baseClip({ status: 'kept', hookText: 'Déjà là' })
    putClip(getDb(), clip)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await scheduleHookBackfill(getDb(), clip.id)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(getClip(getDb(), clip.id)?.hookText).toBe('Déjà là')
  })

  it('ne part pas sur un clip qui n’est pas gardé', async () => {
    const clip = baseClip({ status: 'candidate', hookText: '' })
    putClip(getDb(), clip)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await scheduleHookBackfill(getDb(), clip.id)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('deux appels rapprochés ne produisent qu’un seul appel au modèle', async () => {
    const clip = baseClip({ status: 'kept', hookText: '' })
    putClip(getDb(), clip)
    const fetchMock = vi.fn().mockResolvedValue(ollamaResponse('Une accroche'))
    vi.stubGlobal('fetch', fetchMock)

    await Promise.all([
      scheduleHookBackfill(getDb(), clip.id),
      scheduleHookBackfill(getDb(), clip.id),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('un échec du fournisseur laisse le clip intact et ne rejette pas', async () => {
    const clip = baseClip({ status: 'kept', hookText: '' })
    putClip(getDb(), clip)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('quota dépassé')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(scheduleHookBackfill(getDb(), clip.id)).resolves.toBeUndefined()

    expect(getClip(getDb(), clip.id)?.hookText).toBe('')
    expect(getClip(getDb(), clip.id)?.status).toBe('kept')
    expect(warn).toHaveBeenCalled()
  })

  /**
   * Miroir du test « ne perd pas une écriture concurrente » de la route :
   * l'appel tient jusqu'à trente secondes, largement de quoi qu'une saisie
   * manuelle se glisse dedans. Elle gagne — un rattrapage n'écrase pas.
   */
  it('une saisie manuelle pendant l’appel gagne sur la réponse du modèle', async () => {
    const clip = baseClip({ status: 'kept', hookText: '' })
    putClip(getDb(), clip)

    let resolveFetch: (response: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
      ),
    )

    const work = scheduleHookBackfill(getDb(), clip.id)
    // Pendant l'appel, quelqu'un saisit son hook à la main.
    putClip(getDb(), { ...clip, hookText: 'Écrit à la main' })
    resolveFetch(ollamaResponse('Une accroche du modèle'))
    await work

    expect(getClip(getDb(), clip.id)?.hookText).toBe('Écrit à la main')
  })

  /**
   * **Relevé par Copilot sur la PR #121.** Contrairement au bouton
   * « Régénérer » et au `PATCH`, ce rattrapage part sans le moindre geste de
   * l'utilisateur sur CE clip précis au moment où l'appel se termine :
   * écrire quand même périmerait silencieusement une livraison que personne
   * n'a demandé de refaire. `fresh.status !== 'kept'` doit donc abandonner
   * sur `exported` comme sur `discarded`.
   */
  it('un export terminé pendant l’appel gagne aussi sur la réponse du modèle', async () => {
    const clip = baseClip({ status: 'kept', hookText: '' })
    putClip(getDb(), clip)

    let resolveFetch: (response: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
      ),
    )

    const work = scheduleHookBackfill(getDb(), clip.id)
    // Pendant l'appel, le clip est exporté.
    putClip(getDb(), { ...clip, status: 'exported' })
    resolveFetch(ollamaResponse('Une accroche du modèle'))
    await work

    const written = getClip(getDb(), clip.id)
    expect(written?.hookText).toBe('')
    expect(written?.status).toBe('exported')
  })

  /**
   * **Relevé par Copilot sur la PR #121.** La relecture ne garde que
   * `hookText` vide comme condition d'écriture, mais l'écran autorise à
   * saisir le badge avant l'accroche : un badge tapé pendant l'appel ne doit
   * pas disparaître sous celui que le modèle vient de générer.
   */
  it('un badge saisi pendant l’appel gagne sur celui du modèle', async () => {
    const clip = baseClip({ status: 'kept', hookText: '', hookBadge: '' })
    putClip(getDb(), clip)

    let resolveFetch: (response: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
      ),
    )

    const work = scheduleHookBackfill(getDb(), clip.id)
    // Pendant l'appel, quelqu'un saisit le badge à la main — sans hookText.
    putClip(getDb(), { ...clip, hookBadge: 'Écrit à la main' })
    resolveFetch(ollamaResponse('Une accroche du modèle', 'DÉFI 10'))
    await work

    const written = getClip(getDb(), clip.id)
    expect(written?.hookText).toBe('Une accroche du modèle')
    expect(written?.hookBadge).toBe('Écrit à la main')
  })
})
