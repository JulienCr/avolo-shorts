/**
 * The only reader of `AiSettings` for `LocalModels`: `AiSettings` lives in
 * `src/lib/api.ts`, out of `src/core`'s reach.
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
