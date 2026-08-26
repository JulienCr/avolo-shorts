/**
 * La grammaire du bloc à copier-coller — issue #191, lot 2, §5.
 *
 * C'est la grammaire que le squelette `decision-sheet` non modifié émet déjà
 * (`build()` dans `reference/skeleton.html`) : un titre, la bande « déjà
 * tranché », puis par carte une clé, un verdict, une note optionnelle. Les
 * constantes ci-dessous (`UNDECIDED`, les mots de verdict) sont dupliquées
 * plutôt qu'importées de `template.ts` : le `T` du squelette vit à l'intérieur
 * d'une chaîne de script figée, inatteignable depuis Node.
 *
 * **Le piège qui décide si ça marche** : `T.undecided` vaut « sans réponse »
 * pour *aucune réponse donnée*, et « je ne sais pas » est une vraie réponse —
 * l'issue #191 la dit la plus informative des trois. Les deux ne doivent
 * jamais se confondre : un test les épingle.
 */

import type { Board } from './card'

export type Call = 'keep' | 'drop' | 'unsure'
export type Answer = { key: string; call: Call | null; note: string; commit?: string }

export type RejectedLine = { line: number; text: string; why: string }

const UNDECIDED = 'sans réponse'
const CALL_WORD: Record<Call, string> = { keep: 'garder', drop: 'écarter', unsure: 'je ne sais pas' }
const WORD_TO_CALL: Record<string, Call> = {
  garder: 'keep',
  écarter: 'drop',
  'je ne sais pas': 'unsure',
}

export function formatCopyOut(o: { board: Board; answers: Answer[]; remarks: string }): string {
  const { board, answers, remarks } = o
  const byKey = new Map(answers.map((a) => [a.key, a]))
  const lines: string[] = []

  // Même structure que `build()` dans `template.ts` (T.copyOutTitle porte les
  // deux premières lignes) : les deux implémentations doivent rendre le même
  // texte, l'une en JS client, l'autre ici côté Node.
  lines.push(`Planche : ${board.spec.id}`)
  lines.push(`Commit : ${board.commit}`)
  lines.push('')

  lines.push('Réglé')
  for (const [label, text] of board.spec.settled) lines.push(`  · ${label} : ${text}`)
  lines.push('')

  for (const card of board.cards) {
    const answer = byKey.get(card.key)
    lines.push(`${card.key} — ${card.projectId} ${card.shot.start}-${card.shot.end} @${card.instant}`)
    const call = answer?.call ?? null
    lines.push(`  → ${call === null ? UNDECIDED : CALL_WORD[call]}`)
    const note = answer?.note.trim()
    if (note) {
      const noteLines = note.split('\n')
      lines.push(`  note : ${noteLines[0]}`)
      for (const cont of noteLines.slice(1)) lines.push(`    ${cont}`)
    }
    if (answer?.commit && answer.commit !== board.commit) lines.push(`  (sous ${answer.commit})`)
    lines.push('')
  }

  const trimmedRemarks = remarks.trim()
  if (trimmedRemarks) {
    lines.push('Remarques')
    for (const r of trimmedRemarks.split('\n')) lines.push(`  ${r}`)
    lines.push('')
  }

  return lines.join('\n').replace(/\n+$/, '\n')
}

const HEADER_RE = /^Planche\s*:\s*(.+)$/
const COMMIT_RE = /^Commit\s*:\s*(.+)$/
const CARD_RE = /^(\S+)\s+(?:—|--)\s+(\S+)\s+[\d.]+-[\d.]+\s+@[\d.]+\s*$/
const ARROW_RE = /^\s*(?:→|->)\s*(.+?)\s*$/
const NOTE_RE = /^\s*note\s*:\s*(.*)$/
const CONTINUATION_RE = /^ {4,}(.*)$/
const SOUS_RE = /^\s*\(sous\s+(\S+)\)\s*$/
const SETTLED_RE = /^\s*(?:·|\*)\s+/

type PendingCard = { key: string; call: Call | null; note: string[]; commit?: string; invalid: boolean }

export function parseCopyOut(text: string): {
  boardId: string
  commit: string
  answers: Answer[]
  rejected: RejectedLine[]
} {
  const rawLines = text.split('\n')
  let boardId = ''
  let commit = ''
  const answers: Answer[] = []
  const rejected: RejectedLine[] = []
  let current: PendingCard | null = null
  let inRemarks = false

  const flush = () => {
    if (current && !current.invalid) {
      answers.push({
        key: current.key,
        call: current.call,
        note: current.note.join('\n').trim(),
        ...(current.commit ? { commit: current.commit } : {}),
      })
    }
    current = null
  }

  rawLines.forEach((raw, i) => {
    const lineNo = i + 1
    const trimmed = raw.trim()
    if (trimmed === '') return
    if (trimmed === 'Remarques') {
      flush()
      inRemarks = true
      return
    }
    if (inRemarks) return

    if (!boardId) {
      const m = HEADER_RE.exec(raw)
      if (m) {
        boardId = m[1].trim()
        return
      }
    }
    if (!commit) {
      const m = COMMIT_RE.exec(raw)
      if (m) {
        commit = m[1].trim()
        return
      }
    }
    if (trimmed === 'Réglé' || SETTLED_RE.test(raw)) {
      flush()
      return
    }

    const cardMatch = CARD_RE.exec(raw)
    if (cardMatch) {
      flush()
      current = { key: cardMatch[1], call: null, note: [], invalid: false }
      return
    }

    if (!current) {
      rejected.push({ line: lineNo, text: raw, why: 'ligne hors bloc de carte' })
      return
    }

    const arrowMatch = ARROW_RE.exec(raw)
    if (arrowMatch) {
      const word = arrowMatch[1].trim()
      if (word === UNDECIDED) {
        current.call = null
        return
      }
      const call = WORD_TO_CALL[word]
      if (call) {
        current.call = call
        return
      }
      // Un verdict hors de l'énumération n'est jamais rangé en `null` : ce
      // serait indiscernable d'une carte sans réponse. La carte entière est
      // rejetée plutôt que de mentir sur son verdict.
      current.invalid = true
      rejected.push({ line: lineNo, text: raw, why: `verdict inconnu « ${word} »` })
      return
    }

    const sousMatch = SOUS_RE.exec(raw)
    if (sousMatch) {
      current.commit = sousMatch[1]
      return
    }

    const noteMatch = NOTE_RE.exec(raw)
    if (noteMatch) {
      current.note.push(noteMatch[1])
      return
    }

    const contMatch = CONTINUATION_RE.exec(raw)
    if (contMatch && current.note.length > 0) {
      current.note.push(contMatch[1])
      return
    }

    rejected.push({ line: lineNo, text: raw, why: 'ligne non reconnue' })
  })
  flush()

  return { boardId, commit, answers, rejected }
}
