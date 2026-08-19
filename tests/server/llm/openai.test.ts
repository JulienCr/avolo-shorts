import { afterEach, describe, expect, it, vi } from 'vitest'

import { createOpenAiCall, toFinishReason, toLlmResponse } from '@/server/llm/openai'

describe('OpenAI : la traduction des raisons de fin', () => {
  it('traduit length en MAX_TOKENS, comme une troncature côté Gemini', () => {
    expect(toFinishReason('length')).toBe('MAX_TOKENS')
  })

  it('traduit content_filter en CONTENT_FILTER, reconnu par REFUS_DE_CONTENU', () => {
    expect(toFinishReason('content_filter')).toBe('CONTENT_FILTER')
  })

  it('met les autres raisons en majuscules, sans les réinterpréter', () => {
    expect(toFinishReason('stop')).toBe('STOP')
    expect(toFinishReason('tool_calls')).toBe('TOOL_CALLS')
  })

  it('rend une chaîne vide sans raison', () => {
    expect(toFinishReason(null)).toBe('')
    expect(toFinishReason(undefined)).toBe('')
  })
})

describe('OpenAI : la traduction de la réponse', () => {
  it('porte le texte et la raison de fin normalisée', () => {
    const réponse = toLlmResponse({
      choices: [{ finish_reason: 'stop', message: { content: '{"windows": []}' } }],
    })
    expect(réponse.text).toBe('{"windows": []}')
    expect(réponse.candidates?.[0]?.finishReason).toBe('STOP')
  })

  it('un refus structuré (message.refusal) l’emporte sur finish_reason: stop', () => {
    const réponse = toLlmResponse({
      choices: [{ finish_reason: 'stop', message: { refusal: 'Je ne peux pas.' } }],
    })
    expect(réponse.candidates?.[0]?.finishReason).toBe('CONTENT_FILTER')
    // Aucun texte n'est rendu : le refus n'est pas une réponse à parser.
    expect(réponse.text).toBeUndefined()
  })

  it('un refusal vide n’est pas un refus', () => {
    const réponse = toLlmResponse({
      choices: [{ finish_reason: 'stop', message: { content: 'ok', refusal: '' } }],
    })
    expect(réponse.candidates?.[0]?.finishReason).toBe('STOP')
    expect(réponse.text).toBe('ok')
  })

  it('une réponse sans choix ne casse pas : texte absent, raison vide', () => {
    const réponse = toLlmResponse({})
    expect(réponse.text).toBeUndefined()
    expect(réponse.candidates?.[0]?.finishReason).toBe('')
  })
})

describe('createOpenAiCall', () => {
  const config = () => ({
    schema: { type: 'object' as const, properties: {}, required: [] },
    temperature: 0.2,
    maxOutputTokens: 512,
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('envoie la clé dans l’en-tête Authorization, jamais dans l’URL', async () => {
    const requêtes: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        requêtes.push({ url, init })
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }),
        } as Response
      }),
    )

    const appel = createOpenAiCall({
      model: 'gpt-4.1-mini',
      apiKey: 'sk-test-secret',
      timeoutMs: 5_000,
      config,
    })
    await appel('prompt', 'score')

    expect(requêtes).toHaveLength(1)
    const [{ url, init }] = requêtes
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(url).not.toContain('sk-test-secret')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test-secret')

    const corps = JSON.parse(String(init.body)) as { model: string; temperature: number }
    expect(corps.model).toBe('gpt-4.1-mini')
    expect(corps.temperature).toBe(0.2)
  })

  it('coupe la requête quand le signal externe s’annule, sans attendre le délai', async () => {
    let signalCapturé: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        signalCapturé = init.signal as AbortSignal
        // Une promesse qui ne se résout jamais : seule l'annulation du
        // signal doit permettre au test de conclure.
        return new Promise<Response>(() => {})
      }),
    )

    const controleur = new AbortController()
    const appel = createOpenAiCall({
      model: 'gpt-4.1-mini',
      apiKey: 'sk-test',
      signal: controleur.signal,
      // Un délai large : si l'annulation qui compte est celle du timeout et
      // non celle du signal externe, ce test resterait bloqué jusqu'à lui.
      timeoutMs: 60_000,
      config,
    })
    void appel('prompt', 'score')

    await vi.waitFor(() => expect(signalCapturé).toBeDefined())
    expect(signalCapturé?.aborted).toBe(false)

    controleur.abort()
    // `AbortSignal.any` compose les deux signaux : l'abandon de l'externe
    // se voit sur celui remis à `fetch`, sans attendre le timeout de 60 s.
    expect(signalCapturé?.aborted).toBe(true)
  })
})
