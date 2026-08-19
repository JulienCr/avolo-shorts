import { describe, expect, it } from 'vitest'

import { versLlmResponse, versRaisonDeFin } from '@/server/llm/openai'

describe('OpenAI : la traduction des raisons de fin', () => {
  it('traduit length en MAX_TOKENS, comme une troncature côté Gemini', () => {
    expect(versRaisonDeFin('length')).toBe('MAX_TOKENS')
  })

  it('traduit content_filter en CONTENT_FILTER, reconnu par REFUS_DE_CONTENU', () => {
    expect(versRaisonDeFin('content_filter')).toBe('CONTENT_FILTER')
  })

  it('met les autres raisons en majuscules, sans les réinterpréter', () => {
    expect(versRaisonDeFin('stop')).toBe('STOP')
    expect(versRaisonDeFin('tool_calls')).toBe('TOOL_CALLS')
  })

  it('rend une chaîne vide sans raison', () => {
    expect(versRaisonDeFin(null)).toBe('')
    expect(versRaisonDeFin(undefined)).toBe('')
  })
})

describe('OpenAI : la traduction de la réponse', () => {
  it('porte le texte et la raison de fin normalisée', () => {
    const réponse = versLlmResponse({
      choices: [{ finish_reason: 'stop', message: { content: '{"windows": []}' } }],
    })
    expect(réponse.text).toBe('{"windows": []}')
    expect(réponse.candidates?.[0]?.finishReason).toBe('STOP')
  })

  it('un refus structuré (message.refusal) l’emporte sur finish_reason: stop', () => {
    const réponse = versLlmResponse({
      choices: [{ finish_reason: 'stop', message: { refusal: 'Je ne peux pas.' } }],
    })
    expect(réponse.candidates?.[0]?.finishReason).toBe('CONTENT_FILTER')
    // Aucun texte n'est rendu : le refus n'est pas une réponse à parser.
    expect(réponse.text).toBeUndefined()
  })

  it('un refusal vide n’est pas un refus', () => {
    const réponse = versLlmResponse({
      choices: [{ finish_reason: 'stop', message: { content: 'ok', refusal: '' } }],
    })
    expect(réponse.candidates?.[0]?.finishReason).toBe('STOP')
    expect(réponse.text).toBe('ok')
  })

  it('une réponse sans choix ne casse pas : texte absent, raison vide', () => {
    const réponse = versLlmResponse({})
    expect(réponse.text).toBeUndefined()
    expect(réponse.candidates?.[0]?.finishReason).toBe('')
  })
})
