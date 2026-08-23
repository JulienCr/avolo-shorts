import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import type Database from 'better-sqlite3'

import { isAAbsence } from '@/server/bytes'
import {
  flattenTranscript,
  orderForApplication,
  parseCorrectionResponse,
  shiftEntries,
  toProposedCorrection,
  validateCorrections,
  EMPTY_CORRECTION_LOG,
  type CorrectionEntry,
  type CorrectionLog,
  type CorrectionRejectionReason,
  type FlatWord,
  type ProposedCorrection,
} from '@/core/correction'
import { correctionPrompt, correctionWordsJson } from '@/core/gemini/prompts'
import type { Project } from '@/server/db'
import { pathTemporary } from '@/server/ffmpeg'
import { createCallFromSettings } from '@/server/llm/registry'
import { callWithRetry } from '@/server/llm/retry'
import type { JsonSchema, LlmCallConfig, LlmMode } from '@/server/llm/types'
import { placeSidecar, resolveSource } from '@/server/paths'
import { ExecutionInCurrentError } from '@/server/run'
import { editingResponds } from '@/server/steps/ingest'
import { lireTranscript } from '@/server/steps/candidates'
import { correctTranscript, type TranscriptCorrectionRejection } from '@/server/steps/transcript'

/**
 * L'orchestration de la correction du transcript par modèle (spec §9,
 * étage 2) : découpe en empans, appel au modèle, validation par le noyau pur
 * (`@/core/correction`), écriture et journal.
 *
 * **Deux fonctions publiques, deux moments distincts.** `proposeTranscriptCorrections`
 * ne fait que proposer — c'est le cœur, réutilisé tel quel ; `applyTranscriptCorrections`
 * l'appelle puis écrit, via `correctTranscript` (`src/server/steps/transcript.ts`), la
 * même file d'écriture que la correction manuelle. C'est `applyTranscriptCorrections`
 * que l'étape `correction` du graphe appelle (`src/server/run.ts`).
 *
 * **Ce qu'on avale, ce qu'on lève** (issues #136, #141) : on avale ce qui
 * n'empêche pas l'aval d'être correct, on lève ce qui laisse un état
 * incohérent. Une panne du modèle laisse un transcript intact — on avale
 * (`CorrectionProposalError`, seule tolérée par `src/server/run.ts`). Une
 * panne d'écriture laisse un transcript à moitié corrigé sans trace — on
 * lève, d'où le journal écrit au fil de l'eau plutôt qu'en un seul lot, pour
 * qu'elle ne perde jamais plus d'une substitution. Un nettoyage raté après
 * publication (`candidates.json` invalidé, `correction.json` écarté dans
 * `transcript.ts`) ne laisse rien d'incohérent — on avale et on journalise.
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

/**
 * Une panne survenue avant toute écriture — le repérage du transcript, la
 * connectivité au Drive, ou l'appel au modèle lui-même.
 *
 * **Le type porte un fait sur l'état du disque, pas la nature de la panne.**
 * `proposeTranscriptCorrections` ne fait que lire et proposer ; rien de ce
 * qu'elle peut lever n'a encore touché le transcript ni le journal. C'est ce
 * qui rend son échec tolérable : le repli sur le texte non corrigé
 * (`src/server/run.ts`, `case 'correction'`) ne laisse rien d'incohérent
 * derrière lui.
 *
 * **Une panne d'écriture, plus loin dans `applyTranscriptCorrections`, n'est
 * jamais enveloppée dans ce type.** Elle peut laisser le transcript à moitié
 * corrigé ; la confondre avec celle-ci avalait aussi les pannes de stockage
 * (issue #136) — l'appelant ne doit tolérer que celle-ci.
 */
export class CorrectionProposalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CorrectionProposalError'
  }
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

// ---------------------------------------------------------------------------
// Le journal — lecture, écriture atomique, application, et son inverse
// ---------------------------------------------------------------------------

/**
 * Lit `correction.json` depuis son chemin. Rend le journal vide si absent.
 * @throws Toute erreur qui n'est pas une absence (`isAAbsence`) — un JSON
 * tronqué ou une erreur disque ne doit pas passer pour « aucune correction » :
 * la présence du fichier marque déjà l'étape faite, donc une corruption
 * avalée en silence serait écrasée par la prochaine passe, sans laisser de
 * trace. (relevé par Copilot et Aristarque)
 */
function readCorrectionLogFrom(path: string): CorrectionLog {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8')) as CorrectionLog
  } catch (cause) {
    if (isAAbsence(cause)) return EMPTY_CORRECTION_LOG
    throw cause
  }
}

/**
 * Le journal des corrections d'un projet — l'historique que l'écran affiche.
 *
 * **Sondée avant `placeSidecar`, comme `correctTranscript` et
 * `proposeTranscriptCorrections`.** `placeSidecar` fait des appels
 * *synchrones* — `existsSync`, `mkdirSync` — et sur un montage 9p au
 * transport mort, un appel synchrone gèle la boucle d'événements entière,
 * donc tout le serveur : ouvrir le panneau transcript ne doit pas pouvoir
 * geler une analyse en cours. (relevé par Codex, Copilot et Aristarque)
 * @returns Le journal vide si la correction n'a jamais tourné sur ce projet,
 * jamais une erreur : c'est l'état normal entre le repérage et la première
 * exécution de l'étape `correction`.
 * @throws Si le dossier des replays ne répond pas.
 */
export async function readCorrectionLog(project: Project): Promise<CorrectionLog> {
  if (!(await editingResponds(resolveSource(project.sourcePath)))) {
    throw new Error(
      'Le dossier des replays ne répond pas : impossible de lire l’historique de correction. ' +
        'REPLAY_DIR est monté en 9p et peut être monté avec son transport mort dessous — ' +
        '/proc/mounts ne le distingue pas. Rouvrir le lecteur côté Windows, ou remonter le partage.',
    )
  }
  const placement = placeSidecar(project.sourcePath, project.id)
  return readCorrectionLogFrom(placement.correction)
}

/**
 * Écrit le journal, nom temporaire puis `rename` — comme `correctTranscript`.
 * Une étape tuée avant ce renommage ne doit rien laisser qui passe pour un
 * artefact fait.
 */
async function writeCorrectionLog(path: string, log: CorrectionLog): Promise<void> {
  const temporary = pathTemporary(path)
  await fsp.writeFile(temporary, `${JSON.stringify(log, null, 2)}\n`, 'utf8')
  await fsp.rename(temporary, path)
}

export type ApplyCorrectionsOutcome = {
  /** Les entrées du journal, **après** cette passe — le journal entier, pas seulement les nouvelles. */
  entries: CorrectionEntry[]
  /** Combien de substitutions proposées ont effectivement été écrites. */
  applied: number
  /** Combien ont échoué à l'écriture (ancre déjà changée sous les pieds d'une autre) — tolérées, pas bloquantes. */
  failed: number
  rejected: Partial<Record<CorrectionRejectionReason, number>>
}

/**
 * Propose, puis écrit : le chemin que l'étape `correction` du graphe appelle.
 *
 * **Le journal s'accumule, il ne se réécrit pas** (spec §9, correction du
 * 23 août 2026) — sauf quand `freshTranscript` est vrai. Une seconde passe
 * travaille sur un texte déjà corrigé ; ses substitutions ne recouvrent jamais
 * celles d'une passe précédente, et les perdre de l'historique retirerait la
 * moitié de ce que le journal promet en échange de l'écriture sans veto
 * (contrat de cette PR : « l'historique de ce qui a été changé, avec la
 * possibilité de défaire »). Une retranscription, elle, remplace
 * `transcript.json` en entier — les positions d'un journal antérieur n'y
 * correspondent plus à rien, et `freshTranscript` (posé par `src/server/run.ts`
 * quand `transcript` vient de tourner dans la même exécution) le fait
 * repartir vide, exactement comme `transcript.json` lui-même repart vide.
 *
 * **Ordre rightmost-first par phrase** (`orderForApplication`), et
 * **décalage des entrées déjà présentes** (`shiftEntries`) après chaque
 * fusion écrite : une substitution qui remplace N mots par un seul décale de
 * N−1 tout ce qui, dans la même phrase, se trouve plus loin — qu'il vienne de
 * cette passe ou d'une passe précédente. C'est la même formule que `undoCorrectionEntry`
 * applique en sens inverse.
 *
 * **Jamais `isRunning`** : l'exécution en cours, ici, est la nôtre — la
 * passer ferait échouer l'étape sur `ExecutionInCurrentError` à chaque
 * analyse (piège documenté au contrat de cette PR).
 *
 * **La VRAM est libre par construction** : cette étape suit toujours
 * `transcript` dans le graphe, qui a attendu la sortie du sous-processus
 * WhisperX avant de rendre la main (`src/server/steps/transcript.ts`).
 *
 * @throws {CorrectionProposalError} Si le transcript est absent (ne devrait
 * pas arriver : le graphe garantit `transcript` avant `correction`) ou si le
 * modèle est injoignable — l'appelant (`src/server/run.ts`) tolère celle-ci,
 * jamais une autre : voir le type.
 * @throws Toute autre erreur, survenue dans la boucle d'écriture — elle peut
 * laisser le transcript à moitié corrigé, donc elle propage sans repli.
 */
export async function applyTranscriptCorrections(
  project: Project,
  db: Database.Database,
  options: { signal?: AbortSignal; freshTranscript?: boolean } = {},
): Promise<ApplyCorrectionsOutcome> {
  // **Rien ici n'a encore écrit** : un échec, quelle qu'en soit la cause —
  // modèle injoignable, Drive muet, ou l'invariant du graphe qui ne tient
  // pas —, laisse le transcript intact. `CorrectionProposalError` porte
  // exactement ce fait jusqu'à l'appelant.
  let proposed: ProposeCorrectionsOutcome
  try {
    proposed = await proposeTranscriptCorrections(db, project, { signal: options.signal })
  } catch (cause) {
    throw new CorrectionProposalError(cause instanceof Error ? cause.message : String(cause), { cause })
  }
  if (!proposed.ok) {
    throw new CorrectionProposalError(
      `Correction du transcript de ${project.id} : le transcript est introuvable alors que le ` +
        'graphe le garantit avant cette étape — voir readingPresence/planSteps.',
    )
  }

  const placement = placeSidecar(project.sourcePath, project.id)
  const previous = options.freshTranscript === true ? EMPTY_CORRECTION_LOG : readCorrectionLogFrom(placement.correction)

  let entries = [...previous.entries]
  let applied = 0
  let failed = 0

  for (const proposal of orderForApplication(proposed.proposals)) {
    const result = await correctTranscript(project, proposal.lineId, proposal.correction)
    if (!result.ok) {
      failed += 1
      continue
    }
    applied += 1
    const width = proposal.correction.to - proposal.correction.from + 1
    const delta = 1 - width
    if (delta !== 0) entries = shiftEntries(entries, proposal.lineId, proposal.correction.to, delta)
    entries.push({
      id: crypto.randomUUID(),
      lineId: proposal.lineId,
      from: proposal.correction.from,
      expected: [...proposal.correction.expected],
      replacement: proposal.replacement,
      timecode: proposal.timecode,
    })
    // **Au fil de l'eau, pas une seule fois à la fin** (issue #136) : le
    // transcript vient de changer sous ce mot précis, donc le journal doit
    // refléter ce changement avant le prochain — sinon une panne d'écriture
    // entre deux substitutions laisse un transcript partiellement corrigé
    // avec un journal qui ne porte trace d'aucune d'elles. Le pire qui reste
    // possible est une seule substitution non journalisée — celle en cours
    // au moment de la panne —, jamais le lot entier.
    await writeCorrectionLog(placement.correction, { entries })
  }

  return { entries, applied, failed, rejected: proposed.rejected }
}

export type UndoCorrectionOutcome =
  | { ok: true; entries: CorrectionEntry[]; correctedSpan: { start: number; end: number } }
  | { ok: false; reason: 'unknown-entry' | TranscriptCorrectionRejection }

/**
 * Défait une substitution du journal : l'inverse, par le même chemin
 * d'écriture, mêmes gardes, même file (`correctTranscript`).
 *
 * **Recalcule les entrées voisines, ne les jette pas.** Défaire une fusion de
 * N mots réinsère N−1 mots dans la phrase : toute autre entrée de cette même
 * phrase, plus loin, doit avancer d'autant pour continuer à désigner le bon
 * mot — sinon elle reste dans le journal, mais mentirait sur ce qu'elle
 * permettrait de défaire. `shiftEntries` porte cette formule, la même qu'à
 * l'application, en sens inverse.
 *
 * @param isRunning Transmis à `correctTranscript`, contrairement à
 * `applyTranscriptCorrections` : contrairement à l'étape du graphe, ce geste
 * part d'une requête HTTP indépendante d'une exécution en cours, donc soumis
 * à la même garde que la correction manuelle.
 */
export async function undoCorrectionEntry(
  project: Project,
  id: string,
  isRunning: (projectId: string) => boolean = () => false,
): Promise<UndoCorrectionOutcome> {
  // Même garde que `readCorrectionLog` et `correctTranscript`, et pour la
  // même raison : `placeSidecar` gèle la boucle d'événements sur un montage
  // 9p au transport mort. (relevé par Copilot)
  if (!(await editingResponds(resolveSource(project.sourcePath)))) {
    throw new Error(
      'Le dossier des replays ne répond pas : impossible de défaire cette correction. ' +
        'REPLAY_DIR est monté en 9p et peut être monté avec son transport mort dessous — ' +
        '/proc/mounts ne le distingue pas. Rouvrir le lecteur côté Windows, ou remonter le partage.',
    )
  }
  const placement = placeSidecar(project.sourcePath, project.id)
  const log = readCorrectionLogFrom(placement.correction)
  const entry = log.entries.find((e) => e.id === id)
  if (entry === undefined) return { ok: false, reason: 'unknown-entry' }

  const result = await correctTranscript(
    project,
    entry.lineId,
    { from: entry.from, to: entry.from, expected: [entry.replacement], replacement: entry.expected },
    isRunning,
  )
  if (!result.ok) return result

  const remaining = log.entries.filter((e) => e.id !== id)
  const shifted = shiftEntries(remaining, entry.lineId, entry.from, entry.expected.length - 1)
  await writeCorrectionLog(placement.correction, { entries: shifted })

  return { ok: true, entries: shifted, correctedSpan: result.correctedSpan }
}

export type RemoveEntryOutcome = { ok: true; entries: CorrectionEntry[] } | { ok: false; reason: 'unknown-entry' }

/**
 * Retire une entrée de l'historique sans toucher au transcript.
 *
 * **Le rattrapage de dernier recours** (issues #134, #138) : une passe
 * ultérieure peut proposer un empan qui recouvre le mot d'une entrée déjà
 * journalisée, et une correction manuelle plus tôt dans la même phrase ne
 * recale pas le journal — deux chemins, peut-être d'autres à venir, qui
 * laissent un `from` périmé. `undoCorrectionEntry` refuse alors pour
 * toujours en `anchor-mismatch`, sans qu'aucun des deux appelants ne l'ait
 * prévu. Plutôt que de fermer chaque chemin un par un, au risque d'en
 * oublier, ce geste garantit qu'aucune entrée ne reste jamais bloquée :
 * n'écrivant que sur le journal, il n'a pas de garde d'ancrage à faire
 * respecter.
 */
export async function removeCorrectionEntry(project: Project, id: string): Promise<RemoveEntryOutcome> {
  // Même garde que `readCorrectionLog` et `undoCorrectionEntry`, et pour la
  // même raison : `placeSidecar` gèle la boucle d'événements sur un montage
  // 9p au transport mort.
  if (!(await editingResponds(resolveSource(project.sourcePath)))) {
    throw new Error(
      'Le dossier des replays ne répond pas : impossible de retirer cette entrée de l’historique. ' +
        'REPLAY_DIR est monté en 9p et peut être monté avec son transport mort dessous — ' +
        '/proc/mounts ne le distingue pas. Rouvrir le lecteur côté Windows, ou remonter le partage.',
    )
  }
  const placement = placeSidecar(project.sourcePath, project.id)
  const log = readCorrectionLogFrom(placement.correction)
  if (!log.entries.some((e) => e.id === id)) return { ok: false, reason: 'unknown-entry' }

  const entries = log.entries.filter((e) => e.id !== id)
  await writeCorrectionLog(placement.correction, { entries })
  return { ok: true, entries }
}
