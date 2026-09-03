/**
 * The physical-resource vocabulary a later scheduler will share across
 * projects. No semaphore here, only what a step consumes and its order.
 */

import type { LlmUsage } from '@/core/llm'
import type { StepName } from '@/core/graph'

export type Resource = 'gpu' | 'cpu' | 'net'

/** What a step is queued on, and for how long. `waitedMs` is derived at read time. */
export type Wait = { resource: Resource; waitedMs: number }

/** Whether each LLM usage is served locally. Resolved by the caller. */
export type LocalModels = Record<LlmUsage, boolean>

export const PRIORITIES: Record<StepName, number> = {
  renders: 5,
  audio: 10,
  transcript: 20,
  correction: 30,
  candidates: 40,
  analysis: 70,
  proxy: 80,
}

/**
 * A step served by a local model takes the GPU, never the network.
 *
 * @param local - Which LLM usages are resolved to a local model.
 * @returns The resource the step reserves, or `null` if it reserves nothing.
 */
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

/** @returns The step's priority; lower goes first. */
export function priorityFor(step: StepName): number {
  return PRIORITIES[step]
}

/** @returns Whether a resource is local; `net` is the only non-local one. */
export function isLocal(resource: Resource | null): boolean {
  return resource !== 'net'
}

export const CAPACITIES: Record<Resource, number> = { gpu: 1, cpu: 1, net: 2 }
