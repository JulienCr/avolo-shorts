/**
 * Le vocabulaire des ressources physiques qu'un ordonnanceur ultérieur
 * partagera entre projets. Pas de sémaphore ici, juste ce qu'une étape
 * consomme et dans quel ordre elle doit passer.
 */

import type { LlmUsage } from '@/core/llm'
import type { StepName } from '@/core/graph'

export type Resource = 'gpu' | 'cpu' | 'net'

/** Si chaque usage LLM est servi localement. Résolu par l'appelant. */
export type LocalModels = Record<LlmUsage, boolean>

const PRIORITIES: Record<StepName, number> = {
  renders: 5,
  audio: 10,
  transcript: 20,
  correction: 30,
  candidates: 40,
  analysis: 70,
  proxy: 80,
}

/** `null` quand l'étape ne réserve rien. */
export function resourceFor(step: StepName, local: LocalModels): Resource | null {
  switch (step) {
    case 'renders':
    case 'transcript':
    case 'analysis':
      return 'gpu'
    case 'audio':
      return null
    case 'correction':
      return local.correction ? 'gpu' : 'net'
    case 'candidates':
      return local.selection ? 'gpu' : 'net'
    case 'proxy':
      return 'cpu'
  }
}

/** Le plus petit nombre passe en premier. */
export function priorityFor(step: StepName): number {
  return PRIORITIES[step]
}

/** Une étape est locale sauf si sa ressource est `net`. */
export function isLocal(resource: Resource | null): boolean {
  return resource !== 'net'
}

export const CAPACITIES: Record<Resource, number> = { gpu: 1, cpu: 1, net: 2 }
