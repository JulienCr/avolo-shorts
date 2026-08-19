import { describe, expect, it } from 'vitest'

import { toLlmResponse, toFinishReason } from '@/server/llm/openai'

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
