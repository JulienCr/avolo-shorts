/**
 * Rattache un bloc à copier-coller (`board/verdicts.ts`) au registre versionné
 * (`cases.ts`) — issue #191, lot 3, le dernier lien laissé de côté.
 *
 * **Ne modifie jamais `cases.ts`.** Ce module ne fait que lire et diffuser des
 * lignes prêtes à coller ; c'est `scripts/framing-cases.ts` qui les imprime, et
 * l'humain qui les colle. Un remplacement scripté dans un littéral imbriqué
 * échouerait en silence si l'ancre manquait — voir `CLAUDE.md` § « Éditer un
 * fichier par script ».
 *
 * **La clé d'une carte n'est pas un identifiant de cas.** Le format
 * `${projectId}@${shotStartMs}#${stateId}@${instantMs}` porte le début du
 * plan, jamais l'instant représentatif que le libellé humain affiche à côté —
 * rapprocher sur l'instant échouerait sur chaque cas de la planche réelle.
 */

import { shotStartMs } from '@/core/shots'
import { parseCopyOut, type RejectedLine } from './board/verdicts'
import { FRAMING_CASES, PROJECTS, type Call, type FramingCase, type ShowName } from './cases'

/** Le propriétaire du dépôt, tel qu'il figure déjà dans `cases.ts` (`by: 'JulienCr'`). */
export const BOARD_OWNER = 'JulienCr'

const INTERVAL_TOLERANCE_S = 0.001

const PROJECT_TO_SHOW: Record<string, ShowName> = Object.fromEntries(
  (Object.entries(PROJECTS) as [ShowName, string][]).map(([show, projectId]) => [projectId, show]),
)

export type CardKey = { projectId: string; shotStartMs: number; stateId: string; instantMs: number }

const KEY_RE = /^(.+)@(\d+)#([^@]+)@(\d+)$/

/** `undefined` sur une clé qui ne suit pas `${projectId}@${shotStartMs}#${stateId}@${instantMs}`. */
export function parseCardKey(key: string): CardKey | undefined {
  const m = KEY_RE.exec(key)
  if (!m) return undefined
  return { projectId: m[1], shotStartMs: Number(m[2]), stateId: m[3], instantMs: Number(m[4]) }
}

export type CardHeader = { key: string; projectId: string; shotStart: number; shotEnd: number; instant: number }

const HEADER_RE = /^(\S+)\s+(?:—|--)\s+(\S+)\s+([\d.]+)-([\d.]+)\s+@([\d.]+)\s*$/

/**
 * Le texte lisible de chaque carte (`<clé> — <projet> <début>-<fin> @<instant>`),
 * en plus de ce que `parseCopyOut` retient déjà — c'est lui qui porte la fin de
 * plan, absente de la clé, nécessaire pour détecter un intervalle en désaccord.
 */
export function extractHeaders(text: string): Map<string, CardHeader> {
  const headers = new Map<string, CardHeader>()
  for (const raw of text.split('\n')) {
    const m = HEADER_RE.exec(raw)
    if (!m) continue
    headers.set(m[1], {
      key: m[1],
      projectId: m[2],
      shotStart: Number(m[3]),
      shotEnd: Number(m[4]),
      instant: Number(m[5]),
    })
  }
  return headers
}

const FRENCH_MONTHS: Record<string, string> = {
  janvier: '01',
  février: '02',
  mars: '03',
  avril: '04',
  mai: '05',
  juin: '06',
  juillet: '07',
  août: '08',
  septembre: '09',
  octobre: '10',
  novembre: '11',
  décembre: '12',
}

const PROVENANCE_DATE_RE = /(\d{1,2})\s+([a-zàâéèêîôûü]+)\s+(\d{4})/i

/** La date de la bande « Réglé » (`26 août 2026`), jamais l'horloge système — un verdict est daté de sa pose. */
export function parseProvenanceDate(commitLine: string): string | undefined {
  const m = PROVENANCE_DATE_RE.exec(commitLine)
  if (!m) return undefined
  const month = FRENCH_MONTHS[m[2].toLowerCase()]
  if (!month) return undefined
  return `${m[3]}-${month}-${m[1].padStart(2, '0')}`
}

/**
 * La ligne (1-indexée) où `label: null,` attend le cas `caseId`, dans le texte
 * source de `cases.ts` fourni par l'appelant — jamais lu ici depuis le disque,
 * pour que la recherche reste testable sur un fixture.
 */
export function findLabelNullLine(casesSource: string, caseId: string): number | undefined {
  const lines = casesSource.split('\n')
  const idRe = new RegExp(`id:\\s*'${caseId}'`)
  const start = lines.findIndex((l) => idRe.test(l))
  if (start === -1) return undefined
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/id:\s*'/.test(lines[i])) break
    if (/label:\s*null\s*,/.test(lines[i])) return i + 1
  }
  return undefined
}

function tsString(s: string): string {
  return JSON.stringify(s)
}

function renderLabelLiteral(o: { call: Call; by: string; on: string; note: string; from: string }, indent: string): string {
  return [
    `${indent}label: {`,
    `${indent}  call: ${tsString(o.call)},`,
    `${indent}  by: ${tsString(o.by)},`,
    `${indent}  on: ${tsString(o.on)},`,
    `${indent}  note: ${tsString(o.note)},`,
    `${indent}  from: ${tsString(o.from)},`,
    `${indent}},`,
  ].join('\n')
}

function shotAnchor(c: FramingCase): { start: number; end: number } | undefined {
  return c.anchor.at === 'shot' ? c.anchor.shot : undefined
}

export type MatchResult =
  | { outcome: 'matched'; case: FramingCase }
  | { outcome: 'mismatch'; case: FramingCase; why: string }
  | { outcome: 'noCase' }

function matchCase(header: CardHeader, key: CardKey, cases: readonly FramingCase[]): MatchResult {
  const show = PROJECT_TO_SHOW[header.projectId]
  if (show === undefined) return { outcome: 'noCase' }
  const candidate = cases.find((c) => {
    const shot = shotAnchor(c)
    return c.show === show && shot !== undefined && shotStartMs(shot) === key.shotStartMs
  })
  if (candidate === undefined) return { outcome: 'noCase' }
  const shot = shotAnchor(candidate)
  if (
    shot === undefined ||
    Math.abs(shot.start - header.shotStart) > INTERVAL_TOLERANCE_S ||
    Math.abs(shot.end - header.shotEnd) > INTERVAL_TOLERANCE_S
  ) {
    return {
      outcome: 'mismatch',
      case: candidate,
      why:
        `l'intervalle du bloc [${header.shotStart}; ${header.shotEnd}] ne correspond pas au plan ` +
        `enregistré de ${candidate.id} [${shot?.start}; ${shot?.end}]`,
    }
  }
  return { outcome: 'matched', case: candidate }
}

export type NewCaseOutcome = {
  kind: 'new'
  key: string
  header: CardHeader
  call: Call
  note: string
  show: ShowName | undefined
  literal: string
}

export type IngestOutcome =
  | { kind: 'rejected'; line: number; text: string; why: string }
  | { kind: 'mismatch'; key: string; case: FramingCase; why: string }
  | NewCaseOutcome
  | { kind: 'confirmed'; key: string; case: FramingCase; call: Call }
  | { kind: 'undecided'; key: string }
  | { kind: 'fill'; key: string; case: FramingCase; call: Call; literal: string; line: number | undefined }
  | { kind: 'change'; key: string; case: FramingCase; before: Call; after: Call; literal: string }

export type IngestResult = { boardId: string; commit: string; on: string; outcomes: IngestOutcome[] }

/** `shotStartMs` sur un `CardHeader` — mêmes bornes, arrondi identique. */
export function headerShotStartMs(h: CardHeader): number {
  return shotStartMs({ start: h.shotStart, end: h.shotEnd })
}

function buildNewCaseLiteral(header: CardHeader, call: Call, note: string, show: ShowName | undefined, by: string, on: string, from: string, origin: string): string {
  const id = show !== undefined ? `${show}-${headerShotStartMs(header)}` : `<PROJET INCONNU>-${headerShotStartMs(header)}`
  const lines = [
    `  {`,
    `    id: ${tsString(id)},`,
    `    show: ${show !== undefined ? tsString(show) : `/* aucune entree PROJECTS pour ${header.projectId} — a ajouter d'abord */ ${tsString(header.projectId)}`},`,
    `    scope: { over: 'shot' },`,
    `    anchor: { at: 'shot', shot: { start: ${header.shotStart}, end: ${header.shotEnd} }, instants: [${header.instant}] },`,
    `    probes: ${tsString('')}, // a completer : ce que le cas eprouve`,
    renderLabelLiteral({ call, by, on, note, from }, '    '),
    `    tags: [],`,
    `    origin: ${tsString(origin)},`,
    `    retired: null,`,
    `  },`,
  ]
  return lines.join('\n')
}

export function ingestBlock(
  text: string,
  opts: { by: string; casesSource?: string; cases?: readonly FramingCase[] },
): IngestResult {
  const cases = opts.cases ?? FRAMING_CASES
  const parsed = parseCopyOut(text)
  const headers = extractHeaders(text)
  const on = parseProvenanceDate(parsed.commit)
  if (on === undefined) {
    throw new Error(`date introuvable dans la ligne « Commit : ${parsed.commit} ».`)
  }
  const from = `planche ${parsed.boardId}`
  const origin = `planche ${parsed.boardId}, commit ${parsed.commit}`

  const outcomes: IngestOutcome[] = parsed.rejected.map((r: RejectedLine) => ({ kind: 'rejected', ...r }))

  for (const answer of parsed.answers) {
    const header = headers.get(answer.key)
    const keyParts = parseCardKey(answer.key)
    if (header === undefined || keyParts === undefined) {
      outcomes.push({ kind: 'rejected', line: -1, text: answer.key, why: 'clé de carte illisible' })
      continue
    }
    if (answer.call === null) {
      outcomes.push({ kind: 'undecided', key: answer.key })
      continue
    }
    const match = matchCase(header, keyParts, cases)
    if (match.outcome === 'mismatch') {
      outcomes.push({ kind: 'mismatch', key: answer.key, case: match.case, why: match.why })
      continue
    }
    if (match.outcome === 'noCase') {
      const show = PROJECT_TO_SHOW[header.projectId]
      outcomes.push({
        kind: 'new',
        key: answer.key,
        header,
        call: answer.call,
        note: answer.note,
        show,
        literal: buildNewCaseLiteral(header, answer.call, answer.note, show, opts.by, on, from, origin),
      })
      continue
    }
    const { case: c } = match
    if (c.label === null) {
      const literal = renderLabelLiteral({ call: answer.call, by: opts.by, on, note: answer.note, from }, '    ')
      const line = opts.casesSource ? findLabelNullLine(opts.casesSource, c.id) : undefined
      outcomes.push({ kind: 'fill', key: answer.key, case: c, call: answer.call, literal, line })
      continue
    }
    if (c.label.call === answer.call) {
      outcomes.push({ kind: 'confirmed', key: answer.key, case: c, call: answer.call })
      continue
    }
    const literal = renderLabelLiteral({ call: answer.call, by: opts.by, on, note: answer.note, from }, '    ')
    outcomes.push({ kind: 'change', key: answer.key, case: c, before: c.label.call, after: answer.call, literal })
  }

  return { boardId: parsed.boardId, commit: parsed.commit, on, outcomes }
}

const CALL_WORD: Record<Call, string> = { keep: 'garder', drop: 'écarter', unsure: 'je ne sais pas' }

/**
 * Bloque l'ingestion (base comme `--strict`) : une ligne rejetée, un
 * intervalle en désaccord, un cas nouveau, un label à compléter, ou un
 * changement de verdict non débloqué par `--change`. `confirmed` et
 * `undecided` ne bloquent jamais la commande de base.
 */
export function hasBlockingIssues(outcomes: readonly IngestOutcome[], change: boolean): boolean {
  return outcomes.some((o) => {
    if (o.kind === 'confirmed' || o.kind === 'undecided') return false
    if (o.kind === 'change') return !change
    return true
  })
}

/** `--strict` : rien ne doit rester à regarder, pas même une carte sans réponse. */
export function hasAnyReport(outcomes: readonly IngestOutcome[]): boolean {
  return outcomes.some((o) => o.kind !== 'confirmed')
}

/** Les lignes imprimées par `ingest` — groupées par catégorie, jamais interrompues avant la fin. */
export function renderIngestReport(result: IngestResult, opts: { change: boolean }): string[] {
  const lines: string[] = []
  const push = (s = ''): void => void lines.push(s)
  const byKind = <K extends IngestOutcome['kind']>(k: K): Extract<IngestOutcome, { kind: K }>[] =>
    result.outcomes.filter((o): o is Extract<IngestOutcome, { kind: K }> => o.kind === k)

  push(`Planche ${result.boardId} — commit ${result.commit} — datée du ${result.on}.`)

  const rejected = byKind('rejected')
  if (rejected.length > 0) {
    push()
    push(`Rejetées (${rejected.length}) :`)
    for (const r of rejected) push(`  ligne ${r.line} : « ${r.text} » — ${r.why}`)
  }

  const mismatches = byKind('mismatch')
  if (mismatches.length > 0) {
    push()
    push(`Intervalles en désaccord, refusés (${mismatches.length}) :`)
    for (const m of mismatches) push(`  ${m.key} : ${m.why}`)
  }

  const news = byKind('new')
  if (news.length > 0) {
    push()
    push(`Cas nouveaux (${news.length}) — aucun cas existant pour cette clé :`)
    for (const n of news) {
      const reason = n.show === undefined ? ` (projet ${n.header.projectId} absent de PROJECTS)` : ''
      push(`  ${n.key}${reason} — ${CALL_WORD[n.call]}`)
      push('  littéral à ajouter dans scripts/framing/cases.ts :')
      for (const l of n.literal.split('\n')) push(`    ${l}`)
    }
  }

  const fills = byKind('fill')
  if (fills.length > 0) {
    push()
    push(`Labels à compléter, \`label: null\` en attente (${fills.length}) :`)
    for (const f of fills) {
      const where = f.line !== undefined ? `scripts/framing/cases.ts:${f.line}` : 'scripts/framing/cases.ts (ligne non localisée)'
      push(`  ${f.case.id} (${where}) — ${CALL_WORD[f.call]} :`)
      for (const l of f.literal.split('\n')) push(`    ${l}`)
    }
  }

  const changes = byKind('change')
  if (changes.length > 0) {
    push()
    push(`Changements de verdict (${changes.length}) :`)
    for (const c of changes) {
      push(`  ${c.case.id} : ${CALL_WORD[c.before]} -> ${CALL_WORD[c.after]}`)
      if (opts.change) {
        push('  littéral à coller :')
        for (const l of c.literal.split('\n')) push(`    ${l}`)
      } else {
        push('  bloqué — relancer avec --change pour émettre le remplacement à coller.')
      }
    }
  }

  const confirmed = byKind('confirmed')
  const undecided = byKind('undecided')
  push()
  push(
    `${result.outcomes.length} entrée(s) lue(s) — ${confirmed.length} confirmée(s), ${changes.length} changement(s), ` +
      `${news.length} nouveau(x), ${fills.length} à compléter, ${mismatches.length} en désaccord, ` +
      `${rejected.length} rejetée(s), ${undecided.length} sans réponse.`,
  )

  return lines
}
