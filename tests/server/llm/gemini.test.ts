import { Type } from '@google/genai'
import { describe, expect, it } from 'vitest'

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
