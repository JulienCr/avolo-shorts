/**
 * Le registre des cas de cadrage, en ligne de commande (issue #191 lot 1).
 *
 *     pnpm tsx scripts/framing-cases.ts list [selector]
 *     pnpm tsx scripts/framing-cases.ts show <id>
 *     pnpm tsx scripts/framing-cases.ts verify [selector] [--strict]
 *     pnpm tsx scripts/framing-cases.ts verify --baseline [selector]
 *     pnpm tsx scripts/framing-cases.ts ingest [--from <fichier>|-] [--change] [--strict]
 *
 * `selector` : `all` (défaut), `active`, `labelled`, `unlabelled`, `keep`,
 * `drop`, `unsure`, un nom d'émission, un identifiant de cas, ou une liste de
 * ces termes séparée par des virgules — voir `selectCases`.
 *
 * `verify` est la commande de régression : elle doit tourner en quelques
 * secondes, imprime la dérive de chaque cas (information, pas un échec en
 * soi), et sort en 1 sous `--strict` si un cas est absent ou introuvable, si
 * son plan a bougé depuis l'étiquetage, ou si son ratio, son split ou sa
 * raison de refus a changé depuis son témoin (`framingChanged` — un témoin
 * absent ne compte jamais comme une dérive).
 *
 * `verify --baseline` ne vérifie rien : elle imprime, pour chaque cas sans
 * témoin ou dont le témoin est périmé, le littéral `baseline: { … }` à coller
 * dans `scripts/framing/cases.ts` — jamais n'écrit le fichier, même doctrine
 * que `ingest` (voir `scripts/framing/ingest.ts`).
 *
 * `ingest` lit le bloc à copier-coller d'une planche (`board/verdicts.ts`) et
 * imprime les lignes à coller dans `scripts/framing/cases.ts` — jamais
 * n'écrit le fichier. `--from -` (ou l'absence de `--from`) lit `stdin`.
 * `--change` débloque l'émission d'un changement de verdict ; `--strict`
 * sort en 1 dès qu'il y a quoi que ce soit à regarder, même sans conséquence.
 */

import fs from 'node:fs'
import { computeShotSplit, FRAMING_DEFAULTS } from '@/core/framing'
import { analysisPath, projectDir } from '@/server/paths'
import {
  resolveCase,
  todayFramingSnapshot,
  type CaseDrift,
  type CaseNote,
  type FramingSnapshot,
  type ResolvedCase,
} from './framing/case-registry'
import {
  findCase,
  projectOf,
  selectCases,
  type CaseBaseline,
  type FramingCase,
  type IsoDay,
} from './framing/cases'
import { BOARD_OWNER, hasAnyReport, hasBlockingIssues, ingestBlock, renderIngestReport } from './framing/ingest'
import { chargerEnv, quit } from './dev-common'

function anchorText(c: FramingCase): string {
  return c.anchor.at === 'shot'
    ? `[${c.anchor.shot.start.toFixed(3)}; ${c.anchor.shot.end.toFixed(3)}]`
    : `t=${c.anchor.instants[0].toFixed(3)}`
}

function listCases(cases: readonly FramingCase[]): void {
  for (const c of cases) {
    const verdict = c.label?.call ?? (c.retired !== null ? 'retiré' : 'sans étiquette')
    console.log(`${c.id}  ${c.show}  ${anchorText(c)}  ${verdict}  ${c.probes}`)
  }
}

function describeDrift(d: CaseDrift): string {
  switch (d.kind) {
    case 'shotMoved':
      return (
        `plan déplacé (enregistré [${d.recorded.start.toFixed(3)}; ${d.recorded.end.toFixed(3)}], ` +
        `aujourd'hui [${d.today.start.toFixed(3)}; ${d.today.end.toFixed(3)}])`
      )
    case 'shotGone':
      return `plan enregistré introuvable ([${d.recorded.start.toFixed(3)}; ${d.recorded.end.toFixed(3)}])`
    case 'instantOutsideShot':
      return `instant ${d.instant.toFixed(3)} hors du plan [${d.shot.start.toFixed(3)}; ${d.shot.end.toFixed(3)}]`
    case 'nearBoundary':
      return `instant ${d.instant.toFixed(3)} à ${d.distance.toFixed(3)} s d'une frontière (image ${d.frame})`
    case 'framingChanged':
      return `${d.field} a changé depuis le témoin (témoin ${String(d.baseline)}, aujourd'hui ${String(d.today)})`
  }
}

function describeNote(n: CaseNote): string {
  return `instant ${n.instant.toFixed(3)} posé pile sur le début du plan [${n.shot.start.toFixed(3)}; ${n.shot.end.toFixed(3)}]`
}

/** `--strict` ne s'arrête que sur une vraie dérive — jamais sur une simple note. */
export function hasDrift(resolved: readonly Pick<ResolvedCase, 'drift'>[]): boolean {
  return resolved.some((r) => r.drift.length > 0)
}

/** `oui`, ou `non (<SplitRejection>)` — recalculé pour porter la cause, que `ShotFraming` ne garde pas. */
function splitState(resolved: ResolvedCase): string {
  if (resolved.shot.split !== undefined) return 'oui'
  const boxes = resolved.analysis.boxes.filter(
    (b) => b.t >= resolved.shot.shot.start && b.t < resolved.shot.shot.end,
  )
  const result = computeShotSplit(
    boxes,
    resolved.shot.shot,
    resolved.shot.ratio,
    resolved.analysis.source.w,
    resolved.analysis.source.h,
    FRAMING_DEFAULTS,
  )
  return `non (${result.rejection ?? 'inconnu'})`
}

function showCase(id: string): number {
  const c = findCase(id)
  if (c === undefined) {
    console.error(`Cas inconnu : ${id}. Voir « list » pour les identifiants valides.`)
    return 1
  }
  console.log(JSON.stringify(c, null, 2))
  try {
    const resolved = resolveCase(c)
    console.log(`\nRésolution — projet ${resolved.projectId}`)
    console.log(
      `  plan : [${resolved.shot.shot.start.toFixed(3)}; ${resolved.shot.shot.end.toFixed(3)}], ` +
        `ratio ${resolved.shot.ratio}, source ${resolved.shot.source}`,
    )
    console.log(`  split : ${splitState(resolved)}`)
    console.log(
      `  dérive : ${resolved.drift.length === 0 ? 'aucune' : resolved.drift.map(describeDrift).join(' ; ')}`,
    )
    if (resolved.notes.length > 0) {
      console.log(`  note   : ${resolved.notes.map(describeNote).join(' ; ')}`)
    }
  } catch (e) {
    console.error(`Résolution impossible : ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
  return 0
}

function verifyCases(selector: string, strict: boolean): number {
  const cases = selectCases(selector)
  const resolvedDrift: Pick<ResolvedCase, 'drift'>[] = []
  let missingCount = 0
  let driftCount = 0
  let notedCount = 0
  for (const c of cases) {
    const projectId = projectOf(c)
    const projectPresent = fs.existsSync(projectDir(projectId))
    const analysisPresent = fs.existsSync(analysisPath(projectId))
    if (!projectPresent || !analysisPresent) {
      missingCount += 1
      resolvedDrift.push({ drift: [{ kind: 'shotGone', recorded: { start: 0, end: 0 } }] })
      console.log(
        `${c.id}  projet=${projectPresent ? 'ok' : 'ABSENT'}  analyse=${analysisPresent ? 'ok' : 'ABSENTE'}`,
      )
      continue
    }
    try {
      const r = resolveCase(c)
      resolvedDrift.push(r)
      if (r.drift.length > 0) driftCount += 1
      if (r.notes.length > 0) notedCount += 1
      console.log(
        `${c.id}  plan=[${r.shot.shot.start.toFixed(3)}; ${r.shot.shot.end.toFixed(3)}]` +
          `  split=${splitState(r)}` +
          `  dérive=${r.drift.length === 0 ? 'aucune' : r.drift.map(describeDrift).join(' ; ')}`,
      )
      if (r.notes.length > 0) {
        console.log(`${c.id}    note (sans conséquence) : ${r.notes.map(describeNote).join(' ; ')}`)
      }
    } catch (e) {
      missingCount += 1
      resolvedDrift.push({ drift: [{ kind: 'shotGone', recorded: { start: 0, end: 0 } }] })
      console.log(`${c.id}  ERREUR : ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  console.log(
    `\n${cases.length} cas vérifiés — ${driftCount} en dérive, ${notedCount} ancrés sur une frontière (sans conséquence), ${missingCount} absents.`,
  )
  return strict && hasDrift(resolvedDrift) ? 1 : 0
}

function isoToday(): IsoDay {
  return new Date().toISOString().slice(0, 10) as IsoDay
}

function renderBaselineLiteral(b: CaseBaseline): string {
  const rejection = b.rejection === null ? 'null' : JSON.stringify(b.rejection)
  return `baseline: { ratio: ${JSON.stringify(b.ratio)}, split: ${b.split}, rejection: ${rejection}, on: ${JSON.stringify(b.on)} },`
}

function baselineStale(recorded: CaseBaseline | null, today: FramingSnapshot): boolean {
  return (
    recorded === null ||
    recorded.ratio !== today.ratio ||
    recorded.split !== today.split ||
    recorded.rejection !== today.rejection
  )
}

/**
 * `verify --baseline` : imprime, sans jamais écrire `cases.ts`, le littéral à
 * coller pour chaque cas sans témoin ou dont le témoin ne correspond plus à
 * ce que le code produit aujourd'hui.
 */
function printBaselines(selector: string): number {
  const cases = selectCases(selector)
  const on = isoToday()
  let staleCount = 0
  for (const c of cases) {
    try {
      const r = resolveCase(c)
      const today = todayFramingSnapshot(r.shot, r.analysis)
      if (!baselineStale(c.baseline, today)) continue
      staleCount += 1
      console.log(`${c.id}  ${c.baseline === null ? 'sans témoin' : 'témoin périmé'} :`)
      console.log(`  ${renderBaselineLiteral({ ...today, on })}`)
    } catch (e) {
      console.log(`${c.id}  ERREUR : ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (staleCount === 0) console.log('Tous les témoins sont à jour.')
  return 0
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function ingestCommand(fromArg: string | undefined, change: boolean, strict: boolean): Promise<number> {
  const text = fromArg === undefined || fromArg === '-' ? await readStdin() : fs.readFileSync(fromArg, 'utf8')
  const casesSource = fs.readFileSync(new URL('./framing/cases.ts', import.meta.url), 'utf8')
  const result = ingestBlock(text, { by: BOARD_OWNER, casesSource })
  for (const line of renderIngestReport(result, { change })) console.log(line)
  if (hasBlockingIssues(result.outcomes, change)) return 1
  if (strict && hasAnyReport(result.outcomes)) return 1
  return 0
}

async function main(): Promise<number> {
  await chargerEnv()
  const [sub, ...rest] = process.argv.slice(2)
  const strict = rest.includes('--strict')
  const baselineFlag = rest.includes('--baseline')
  const positional = rest.filter((a) => !a.startsWith('--'))

  switch (sub) {
    case 'list':
      listCases(selectCases(positional[0] ?? 'all'))
      return 0
    case 'show': {
      const id = positional[0]
      if (id === undefined) {
        console.error('Usage : pnpm tsx scripts/framing-cases.ts show <id>')
        return 1
      }
      return showCase(id)
    }
    case 'verify':
      return baselineFlag ? printBaselines(positional[0] ?? 'all') : verifyCases(positional[0] ?? 'all', strict)
    case 'ingest': {
      const change = rest.includes('--change')
      const fromIdx = rest.indexOf('--from')
      const fromArg = fromIdx !== -1 ? rest[fromIdx + 1] : undefined
      return ingestCommand(fromArg, change, strict)
    }
    default:
      console.error(
        'Usage : pnpm tsx scripts/framing-cases.ts <list|show|verify|ingest> [selector] [--strict] [--baseline] [--from <fichier>|-] [--change]',
      )
      return 1
  }
}

// Gardé par `import.meta.url`, comme `generate-env-local.ts` : un test qui
// importe `hasDrift` ne doit pas relancer la CLI en même temps.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main().then(quit, (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e))
    quit(1)
  })
}
