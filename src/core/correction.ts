import { z } from 'zod'

import type { Transcript, Word } from '@/core/transcript'

// ---------------------------------------------------------------------------
// La clé phonétique — voir spec §9 pour ce qu'elle laisse passer et rejette.
// ---------------------------------------------------------------------------

const SOFT_C_BEFORE = new Set(['e', 'i', 'y'])
const SILENT_TRAILING = new Set(['s', 't', 'd', 'x', 'z'])

/**
 * Une clé phonétique française approximative — voir spec §9.
 * @param token Un mot, ponctuation éventuelle comprise.
 * @returns Une clé comparable par égalité stricte.
 */
export function phoneticKey(token: string): string {
  const bare = token
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')

  let softened = ''
  for (let i = 0; i < bare.length; i += 1) {
    const c = bare[i]
    const next = bare[i + 1]
    softened += c === 'c' && next !== undefined && SOFT_C_BEFORE.has(next) ? 's' : c
  }

  let key = softened
  while (key.length > 1 && SILENT_TRAILING.has(key[key.length - 1])) {
    key = key.slice(0, -1)
  }
  return key
}

// ---------------------------------------------------------------------------
// La réponse du modèle
// ---------------------------------------------------------------------------

const CORRECTION_CANDIDATE_SCHEMA = z.object({
  i: z.number().int().min(0),
  w: z.string(),
  merge: z.number().int().min(1).optional(),
})

/** Une substitution telle que le modèle la rend, avant validation. */
export type CorrectionCandidate = z.infer<typeof CORRECTION_CANDIDATE_SCHEMA>

const CORRECTION_RESPONSE_SCHEMA = z.object({ corrections: z.array(z.unknown()) })

/**
 * Analyse l'enveloppe de la réponse du modèle.
 * @param raw Le JSON brut renvoyé par le modèle.
 * @returns Les candidats individuellement valides ; un candidat mal formé
 * est écarté sans faire échouer les autres.
 * @throws si le tableau `corrections` lui-même est absent ou mal typé.
 */
export function parseCorrectionResponse(raw: unknown): CorrectionCandidate[] {
  const envelope = CORRECTION_RESPONSE_SCHEMA.safeParse(raw)
  if (!envelope.success) {
    throw new Error('La réponse du modèle ne porte pas de tableau "corrections".')
  }
  const candidates: CorrectionCandidate[] = []
  for (const entry of envelope.data.corrections) {
    const lu = CORRECTION_CANDIDATE_SCHEMA.safeParse(entry)
    if (lu.success) candidates.push(lu.data)
  }
  return candidates
}

/** Pourquoi une substitution n'a pas été retenue — voir spec §9. */
export type CorrectionRejectionReason =
  | 'out-of-range'
  | 'overlap'
  | 'empty-word'
  | 'word-has-space'
  | 'phonetic-mismatch'
  | 'crosses-line'

/** Une substitution retenue, encore indexée dans l'empan soumis au modèle. */
export type ValidatedCorrection = {
  from: number
  to: number
  original: readonly string[]
  replacement: string
}

export type CorrectionValidation = {
  accepted: ValidatedCorrection[]
  rejected: { candidate: CorrectionCandidate; reason: CorrectionRejectionReason }[]
}

/**
 * Valide les substitutions d'un modèle contre l'empan qui les a produites —
 * le contrat de sortie de spec §9, appliqué.
 * @param span Les mots soumis au modèle ; l'index 0 est le premier de l'empan.
 * @param candidates Les substitutions rendues, déjà passées par `parseCorrectionResponse`.
 */
export function validateCorrections(
  span: readonly Word[],
  candidates: readonly CorrectionCandidate[],
): CorrectionValidation {
  const accepted: ValidatedCorrection[] = []
  const rejected: CorrectionValidation['rejected'] = []
  const taken = new Array<boolean>(span.length).fill(false)

  // Triés par position, pas par ordre de réception : sur un recouvrement, le
  // candidat le plus tôt dans l'empan l'emporte, indépendamment de l'ordre —
  // non garanti — dans lequel le modèle les a rendus.
  const ordered = [...candidates].sort((a, b) => a.i - b.i)

  for (const candidate of ordered) {
    const merge = candidate.merge ?? 1
    const from = candidate.i
    const to = from + merge - 1

    if (from < 0 || to < from || to >= span.length) {
      rejected.push({ candidate, reason: 'out-of-range' })
      continue
    }
    if (candidate.w === '') {
      rejected.push({ candidate, reason: 'empty-word' })
      continue
    }
    if (/\s/.test(candidate.w)) {
      rejected.push({ candidate, reason: 'word-has-space' })
      continue
    }
    if (taken.slice(from, to + 1).includes(true)) {
      rejected.push({ candidate, reason: 'overlap' })
      continue
    }
    const original = span.slice(from, to + 1).map((w) => w.word)
    if (phoneticKey(original.join('')) !== phoneticKey(candidate.w)) {
      rejected.push({ candidate, reason: 'phonetic-mismatch' })
      continue
    }
    for (let idx = from; idx <= to; idx += 1) taken[idx] = true
    accepted.push({ from, to, original, replacement: candidate.w })
  }

  return { accepted, rejected }
}

// ---------------------------------------------------------------------------
// La traduction : index d'empan du modèle -> index de phrase du dépôt
// ---------------------------------------------------------------------------

/** Un mot du transcript entier, situé dans sa phrase d'origine. */
export type FlatWord = { word: Word; segmentIndex: number; localIndex: number }

/**
 * Aplatit un transcript en liste plate, chaque mot sachant sa phrase.
 * @param transcript Le transcript entier.
 * @returns Les mots dans l'ordre, `segmentIndex` étant l'index brut dans
 * `transcript.segments` — celui que `l${i}` (`transcriptLines`,
 * `@/server/views`) porte déjà.
 */
export function flattenTranscript(transcript: Transcript): FlatWord[] {
  const flat: FlatWord[] = []
  transcript.segments.forEach((segment, segmentIndex) => {
    segment.words.forEach((word, localIndex) => {
      flat.push({ word, segmentIndex, localIndex })
    })
  })
  return flat
}

/**
 * Une substitution prête à s'appliquer sur un segment. Même forme que
 * `WordCorrection` (`@/lib/editing`) mais dupliquée : `src/core` n'importe
 * que `zod` (`eslint.config.mjs`).
 */
export type SegmentCorrection = {
  from: number
  to: number
  expected: readonly string[]
  replacement: readonly string[]
}

/** Une substitution proposée, prête pour l'écran de relecture. */
export type ProposedCorrection = {
  lineId: string
  /** Le début du mot corrigé, en secondes. */
  timecode: number
  correction: SegmentCorrection
  original: string
  replacement: string
}

/**
 * Retraduit une substitution validée vers la phrase qu'elle touche.
 * @param flat Le transcript aplati par `flattenTranscript`, dans le même
 * ordre que celui utilisé pour construire l'empan soumis au modèle.
 * @param spanOffset La position, dans `flat`, du premier mot de l'empan.
 * @returns `crosses-line` si `merge` couvrirait deux phrases distinctes —
 * `SegmentCorrection` est bornée à un seul segment, comme la correction
 * manuelle.
 */
export function toProposedCorrection(
  flat: readonly FlatWord[],
  spanOffset: number,
  validated: ValidatedCorrection,
): { ok: true; proposal: ProposedCorrection } | { ok: false; reason: 'crosses-line' } {
  const start = flat[spanOffset + validated.from]
  const end = flat[spanOffset + validated.to]
  if (start === undefined || end === undefined || start.segmentIndex !== end.segmentIndex) {
    return { ok: false, reason: 'crosses-line' }
  }
  return {
    ok: true,
    proposal: {
      lineId: `l${start.segmentIndex}`,
      timecode: start.word.start,
      correction: {
        from: start.localIndex,
        to: end.localIndex,
        expected: validated.original,
        replacement: [validated.replacement],
      },
      original: validated.original.join(' '),
      replacement: validated.replacement,
    },
  }
}
