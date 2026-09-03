import { describe, expect, it } from 'vitest'

import { localModels } from '@/server/resources'
import type { AiSettings } from '@/lib/api'

const AI: AiSettings = {
  selectionProvider: 'ollama',
  selectionModel: 'llama3.1',
  correctionProvider: 'gemini',
  correctionModel: 'gemini-3.1-flash-lite',
  hookProvider: 'openai',
  hookModel: 'gpt-4.1-mini',
  ollamaBaseUrl: '',
}

describe('localModels', () => {
  it('maps each usage to its own provider, not a neighbour', () => {
    expect(localModels(AI)).toEqual({ selection: true, correction: false, hook: false })
  })
})
