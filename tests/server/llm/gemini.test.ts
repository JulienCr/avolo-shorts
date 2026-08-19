import { Type } from '@google/genai'
import { describe, expect, it, vi } from 'vitest'

import type { JsonSchema } from '@/server/llm/types'
import { toGeminiSchema } from '@/server/llm/gemini'

describe('la conversion du schéma générique vers celui de Gemini', () => {
  it('convertit chaque type primitif', () => {
    expect(toGeminiSchema({ type: 'string' })).toEqual({ type: Type.STRING })
    expect(toGeminiSchema({ type: 'integer' })).toEqual({ type: Type.INTEGER })
    expect(toGeminiSchema({ type: 'number' })).toEqual({ type: Type.NUMBER })
    expect(toGeminiSchema({ type: 'boolean' })).toEqual({ type: Type.BOOLEAN })
  })

  it('convertit un objet, propriétés et champs requis compris', () => {
    const schéma: JsonSchema = {
      type: 'object',
      properties: { id: { type: 'string' }, score: { type: 'integer' } },
      required: ['id', 'score'],
    }
    expect(toGeminiSchema(schéma)).toEqual({
      type: Type.OBJECT,
      properties: { id: { type: Type.STRING }, score: { type: Type.INTEGER } },
      required: ['id', 'score'],
    })
  })

  it('convertit un tableau, récursivement', () => {
    const schéma: JsonSchema = {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    }
    expect(toGeminiSchema(schéma)).toEqual({
      type: Type.ARRAY,
      items: { type: Type.OBJECT, properties: { id: { type: Type.STRING } }, required: ['id'] },
    })
  })

  it('reproduit les deux schémas réels du repérage sans perte', () => {
    // Les schémas de `candidates.ts` (`SCHÉMA_NOTATION`) après la
    // généralisation : la même forme que celle qui tournait en dur avant
    // cette PR, vérifiée ici plutôt que déduite.
    const notation: JsonSchema = {
      type: 'object',
      properties: {
        windows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              start: { type: 'number' },
              end: { type: 'number' },
              score: { type: 'integer' },
              reason: { type: 'string' },
            },
            required: ['id', 'start', 'end', 'score', 'reason'],
          },
        },
      },
      required: ['windows'],
    }
    const converti = toGeminiSchema(notation)
    expect(converti.type).toBe(Type.OBJECT)
    expect(converti.required).toEqual(['windows'])
    expect(converti.properties?.windows?.type).toBe(Type.ARRAY)
  })
})

describe('createGeminiCall', () => {
  it('passe la clé au SDK, jamais ailleurs, et convertit le schéma du mode', async () => {
    vi.resetModules()
    const generateContent = vi.fn(async () => ({ text: '{}' }))
    const constructions: unknown[] = []
    vi.doMock('@google/genai', async (importOriginal) => {
      const réel = await importOriginal<typeof import('@google/genai')>()
      return {
        ...réel,
        GoogleGenAI: vi.fn().mockImplementation(function (this: unknown, config: unknown) {
          constructions.push(config)
          return { models: { generateContent } }
        }),
      }
    })

    const { createGeminiCall: créer } = await import('@/server/llm/gemini')
    const contrôleur = new AbortController()
    const appel = créer({
      model: 'gemini-3.1-flash-lite',
      apiKey: 'clé-de-test',
      signal: contrôleur.signal,
      timeoutMs: 42_000,
      config: (mode) => ({
        schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
        temperature: mode === 'detail' ? 0.9 : 0.2,
        maxOutputTokens: 16_384,
      }),
    })

    await appel('un prompt', 'detail')

    // La clé part au constructeur du SDK, avec le délai fini — jamais
    // recopiée dans la config de génération, qui n'a pas à la connaître.
    expect(constructions).toEqual([{ apiKey: 'clé-de-test', httpOptions: { timeout: 42_000 } }])

    expect(generateContent).toHaveBeenCalledTimes(1)
    const [appelé] = generateContent.mock.calls[0] as unknown as [
      { model: string; contents: string; config: Record<string, unknown> },
    ]
    expect(appelé.model).toBe('gemini-3.1-flash-lite')
    expect(appelé.contents).toBe('un prompt')
    // Le mode « detail » choisit la température créative, comme
    // `configuration(mode)` dans `candidates.ts`.
    expect(appelé.config.temperature).toBe(0.9)
    expect(appelé.config.maxOutputTokens).toBe(16_384)
    // Le signal traverse jusqu'à la requête réelle : c'est la propriété
    // vérifiée en vrai par la PR #71, et cette PR ne devait pas la perdre.
    expect(appelé.config.abortSignal).toBe(contrôleur.signal)
    expect((appelé.config.responseSchema as { type: unknown }).type).toBe(Type.OBJECT)

    vi.doUnmock('@google/genai')
  })
})
