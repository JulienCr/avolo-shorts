/**
 * Le seul point qui lit `AiSettings` pour résoudre `LocalModels` : `AiSettings`
 * vit dans `src/lib/api.ts`, hors de portée de `src/core`.
 */

import type { LocalModels } from '@/core/resources'
import { providerModelFor } from '@/server/llm/registry'
import type { AiSettings } from '@/lib/api'

export function localModels(ai: AiSettings): LocalModels {
  return {
    selection: providerModelFor(ai, 'selection').provider === 'ollama',
    correction: providerModelFor(ai, 'correction').provider === 'ollama',
    hook: providerModelFor(ai, 'hook').provider === 'ollama',
  }
}
