import { describe, expect, it } from 'vitest'

import { versLlmResponse, versRaisonDeFin } from '@/server/llm/ollama'

describe('Ollama : la traduction des raisons de fin', () => {
  it('traduit length en MAX_TOKENS', () => {
    expect(versRaisonDeFin('length')).toBe('MAX_TOKENS')
  })

  it('met les autres raisons en majuscules, sans inventer de refus de contenu', () => {
    // Un modèle local n'a pas de filtre fournisseur : rien ici ne doit
    // produire une raison que `REFUS_DE_CONTENU` reconnaîtrait.
    expect(versRaisonDeFin('stop')).toBe('STOP')
  })

  it('rend une chaîne vide sans raison', () => {
    expect(versRaisonDeFin(null)).toBe('')
    expect(versRaisonDeFin(undefined)).toBe('')
  })
})

describe('Ollama : la traduction de la réponse', () => {
  it('porte le texte du message et la raison de fin normalisée', () => {
    const réponse = versLlmResponse({
      message: { content: '{"shorts": []}' },
      done_reason: 'stop',
    })
    expect(réponse.text).toBe('{"shorts": []}')
    expect(réponse.candidates?.[0]?.finishReason).toBe('STOP')
  })

  it('ne porte jamais promptFeedback : Ollama ne bloque pas pour du contenu', () => {
    const réponse = versLlmResponse({ message: { content: 'x' }, done_reason: 'stop' })
    expect(réponse.promptFeedback).toBeUndefined()
  })
})
