import { afterEach, describe, expect, it, vi } from 'vitest'

import { applySettings, openDb } from '@/server/db'
import {
  createCall,
  createCallFromSettings,
  providerAvailability,
  providerModelFor,
  apiKeyVariableFor,
} from '@/server/llm/registry'
import type { AiSettings } from '@/lib/api'

afterEach(() => {
  vi.unstubAllEnvs()
})

const AI: AiSettings = {
  selectionProvider: 'gemini',
  selectionModel: 'gemini-3.1-flash-lite',
  correctionProvider: 'openai',
  correctionModel: 'gpt-4.1-mini',
  hookProvider: 'ollama',
  hookModel: 'llama3.1',
  ollamaBaseUrl: '',
}

describe('providerModelFor', () => {
  it('projette chacun des trois usages sur son fournisseur et son modèle', () => {
    expect(providerModelFor(AI, 'selection')).toEqual({ provider: 'gemini', model: AI.selectionModel })
    expect(providerModelFor(AI, 'correction')).toEqual({
      provider: 'openai',
      model: AI.correctionModel,
    })
    expect(providerModelFor(AI, 'hook')).toEqual({ provider: 'ollama', model: AI.hookModel })
  })
})

describe('apiKeyVariableFor', () => {
  it('nomme la variable de chaque fournisseur à clé, et rien pour Ollama', () => {
    expect(apiKeyVariableFor('gemini')).toBe('GEMINI_API_KEY')
    expect(apiKeyVariableFor('openai')).toBe('OPENAI_API_KEY')
    expect(apiKeyVariableFor('ollama')).toBeUndefined()
  })
})

describe('providerAvailability', () => {
  it('Ollama est toujours disponible : pas de clé à vérifier', () => {
    expect(providerAvailability('ollama')).toEqual({ available: true, reason: null })
  })

  it('dit qu’un fournisseur sans clé n’est pas disponible, sans exposer de valeur', () => {
    vi.stubEnv('GEMINI_API_KEY', '')
    const résultat = providerAvailability('gemini')
    expect(résultat.available).toBe(false)
    expect(résultat.reason).toContain('GEMINI_API_KEY')
  })

  it('dit qu’un fournisseur avec une clé littérale est disponible', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-000')
    expect(providerAvailability('openai')).toEqual({ available: true, reason: null })
  })

  it('une clé restée à l’état de référence 1Password non résolue n’est pas disponible', () => {
    vi.stubEnv('GEMINI_API_KEY', 'op://Personal/Avolo-Shorts/GEMINI_API_KEY')
    const résultat = providerAvailability('gemini')
    expect(résultat.available).toBe(false)
    // Le message ne doit jamais recopier l'adresse en clair (c'est ce que
    // `exigerSecret` garantit) : seul son sens — « relancer le serveur » — sort.
    expect(résultat.reason?.toLowerCase()).toContain('relancer')
  })
})

describe('createCall', () => {
  it('construit un LlmCall pour chacun des trois fournisseurs', () => {
    const config = () => ({ schema: { type: 'string' as const }, temperature: 0, maxOutputTokens: 1 })
    for (const provider of ['gemini', 'openai', 'ollama'] as const) {
      const appel = createCall(provider, { model: 'x', timeoutMs: 1000, config })
      expect(typeof appel).toBe('function')
    }
  })
})

describe('createCallFromSettings', () => {
  it('choisit le fournisseur réglé pour l’usage demandé', () => {
    vi.stubEnv('GEMINI_API_KEY', 'clé-de-test')
    const db = openDb(':memory:')
    applySettings(db, { ai: { selectionProvider: 'gemini', selectionModel: 'gemini-3.1-flash-lite' } })

    const config = () => ({ schema: { type: 'string' as const }, temperature: 0, maxOutputTokens: 1 })
    const appel = createCallFromSettings(db, 'selection', { timeoutMs: 1000, config })
    expect(typeof appel).toBe('function')
  })

  it('lève tout de suite si le fournisseur réglé n’a pas sa clé — avant le premier appel réseau', () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    const db = openDb(':memory:')
    applySettings(db, { ai: { correctionProvider: 'openai' } })

    const config = () => ({ schema: { type: 'string' as const }, temperature: 0, maxOutputTokens: 1 })
    expect(() =>
      createCallFromSettings(db, 'correction', { timeoutMs: 1000, config }),
    ).toThrow(/OPENAI_API_KEY/)
  })

  it('ne lève jamais pour Ollama : il n’a pas de clé', () => {
    const db = openDb(':memory:')
    applySettings(db, { ai: { hookProvider: 'ollama' } })

    const config = () => ({ schema: { type: 'string' as const }, temperature: 0, maxOutputTokens: 1 })
    expect(() =>
      createCallFromSettings(db, 'hook', { timeoutMs: 1000, config }),
    ).not.toThrow()
  })
})
