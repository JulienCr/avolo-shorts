import fs from 'node:fs'
import type Database from 'better-sqlite3'

import {
  flattenTranscript,
  parseCorrectionResponse,
  toProposedCorrection,
  validateCorrections,
  type CorrectionRejectionReason,
  type FlatWord,
  type ProposedCorrection,
} from '@/core/correction'
import { correctionPrompt, correctionWordsJson } from '@/core/gemini/prompts'
import type { Project } from '@/server/db'
import { createCallFromSettings } from '@/server/llm/registry'
import { callWithRetry } from '@/server/llm/retry'
import type { JsonSchema, LlmCallConfig, LlmMode } from '@/server/llm/types'
import { placeSidecar, resolveSource } from '@/server/paths'
import { ExecutionInCurrentError } from '@/server/run'
import { editingResponds } from '@/server/steps/ingest'
import { lireTranscript } from '@/server/steps/candidates'

/**
 * L'orchestration de la correction du transcript par modèle (spec §9,
 * étage 2) : découpe en empans, appel au modèle, validation par le noyau pur
 * (`@/core/correction`). Rien n'est écrit ici — l'écriture réutilise
 * `correctTranscript` (`src/server/steps/transcript.ts`), une substitution à
 * la fois, depuis l'écran.
 */

/** Environ 120 mots par empan, au milieu de la fourchette 80-150 mesurée (spec §9). */
const SPAN_WORDS = 120

/** Court : un empan de ~120 mots ne justifie pas les 120 s du repérage (`DELAY_CALL_MS`). */
const TIMEOUT_MS = 45_000

const SCHEMA_CORRECTION: JsonSchema = {
  type: 'object',
  properties: {
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          merge: { type: 'integer' },
          w: { type: 'string' },
        },
        required: ['i', 'w'],
      },
    },
  },
  required: ['corrections'],
}

function configuration(mode: LlmMode): LlmCallConfig {
  if (mode !== 'correction') {
    // Ce fichier ne configure que la correction : un appel dans un autre
    // mode ne peut venir que d'un défaut de câblage.
    throw new Error(
      `configuration(mode) de la correction appelée avec le mode '${mode}' : seul 'correction' est attendu ici.`,
    )
  }
  // Basse : ponctuer et arbitrer des homophones est un jugement calibré,
  // comme la notation du repérage (`SCHEMA_NOTATION`, `candidates.ts`), pas
  // une tâche créative.
  return { schema: SCHEMA_CORRECTION, temperature: 0.2, maxOutputTokens: 4096 }
}

/** Découpe la liste plate en empans contigus, sans chevauchement. */
function spans(flat: readonly FlatWord[]): { words: FlatWord[]; offset: number }[] {
  const result: { words: FlatWord[]; offset: number }[] = []
  for (let offset = 0; offset < flat.length; offset += SPAN_WORDS) {
    result.push({ words: flat.slice(offset, offset + SPAN_WORDS), offset })
  }
  return result
}

export type ProposeCorrectionsOutcome =
  | {
      ok: true
      proposals: ProposedCorrection[]
      /** Un compte par catégorie de refus — pas la liste, l'écran n'affiche qu'un total. */
      rejected: Partial<Record<CorrectionRejectionReason, number>>
    }
  | { ok: false; reason: 'no-transcript' }

/**
 * Propose des corrections sur le transcript entier d'un projet, sans rien
 * écrire.
 * @param options.isRunning Revérifié avant chaque empan — pas seulement à
 * l'entrée, où la route l'a déjà fait — pour la contrainte de VRAM
 * (`CLAUDE.md`) sur un lot qui peut tourner plusieurs dizaines de secondes.
 * @param options.signal Respecté empan par empan — voir `callWithRetry`.
 * @returns `no-transcript` si le projet n'a pas encore de transcript.
 */
export async function proposeTranscriptCorrections(
  db: Database.Database,
  project: Project,
  options: { signal?: AbortSignal; isRunning?: (projectId: string) => boolean } = {},
): Promise<ProposeCorrectionsOutcome> {
  const isRunning = options.isRunning ?? (() => false)

  if (!(await editingResponds(resolveSource(project.sourcePath)))) {
    throw new Error(
      'Le dossier des replays ne répond pas : impossible de lire le sidecar. ' +
        'REPLAY_DIR est monté en 9p et peut être monté avec son transport mort dessous — ' +
        '/proc/mounts ne le distingue pas. Rouvrir le lecteur côté Windows, ou remonter le partage.',
    )
  }

  const placement = placeSidecar(project.sourcePath, project.id)
  if (!fs.existsSync(placement.transcript)) return { ok: false, reason: 'no-transcript' }

  const transcript = lireTranscript(placement.transcript)
  const flat = flattenTranscript(transcript)

  const call = createCallFromSettings(db, 'correction', {
    signal: options.signal,
    timeoutMs: TIMEOUT_MS,
    config: configuration,
  })

  const proposals: ProposedCorrection[] = []
  const rejected: Partial<Record<CorrectionRejectionReason, number>> = {}
  const tally = (reason: CorrectionRejectionReason): void => {
    rejected[reason] = (rejected[reason] ?? 0) + 1
  }

  for (const span of spans(flat)) {
    // `ExecutionInCurrentError`, pas une `Error` nue : `statusFor` (`@/server/http`)
    // la mappe déjà en 409, comme la sonde d'entrée de la route — la spec §9
    // n'a qu'un seul code pour « une exécution tourne », pas un second en 500.
    if (isRunning(project.id)) throw new ExecutionInCurrentError(project.id)

    const prompt = correctionPrompt({
      language: transcript.language,
      wordsJson: correctionWordsJson(span.words.map((f) => f.word.word)),
    })

    const candidates = await callWithRetry(call, prompt, 'correction', {
      signal: options.signal,
      analyze: parseCorrectionResponse,
      label: 'la correction du transcript',
    })

    const validation = validateCorrections(
      span.words.map((f) => f.word),
      candidates,
    )
    for (const r of validation.rejected) tally(r.reason)

    for (const validated of validation.accepted) {
      const converted = toProposedCorrection(flat, span.offset, validated)
      if (!converted.ok) {
        tally(converted.reason)
        continue
      }
      proposals.push(converted.proposal)
    }
  }

  return { ok: true, proposals, rejected }
}
