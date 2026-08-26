/**
 * Le tamis en ligne de commande (issue #191 lot 5) : fait passer le corpus
 * entier au travers d'une métrique descriptive et rend ce qui mérite un œil
 * — les extrémités d'une distribution, ou le voisinage d'un seuil.
 *
 *     pnpm tsx scripts/framing-sieve.ts --metrique frontality-min-median --famille autour --seuil 0.15 --largeur 0.04
 *     pnpm tsx scripts/framing-sieve.ts --metrique required-width --famille extremes --n 12
 *     pnpm tsx scripts/framing-sieve.ts --metrique head-height --famille extremes --brut --format jsonl
 *
 * **Aucun cache.** `sweepCorpus` balaie le corpus entier à chaque appel — 2,8 s
 * mesurées sur cette machine (4364 plans, 489 splittés), en dessous du coût
 * d'invalider un cache correctement quand `worker/detect.py` change. Ne pas en
 * ajouter un ici.
 *
 * `--famille autour` livre une réponse pente-ou-falaise : sans `--largeur`,
 * une largeur de bande choisie en silence répondrait à une question que
 * personne n'a mesurée, donc elle est refusée plutôt que défaut.
 *
 * Trois formats : `table` (distribution et picks, pour lire), `cas` (des
 * littéraux `FramingCase` prêts à coller dans `scripts/framing/cases.ts`,
 * `label: null` — lecture seule, ce script n'écrit jamais le registre) et
 * `jsonl` (un `SievePick` par ligne, pour enchaîner sur `framing-board`).
 */

import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

import { PROJECTS, type ProjectId, type ShowName } from './framing/cases'
import { sweepCorpus, type CorpusOptions } from './framing/corpus'
import { METRICS, type MetricName, type ShotMetric } from './framing/metrics'
import { sieve, type Family, type SievePick } from './framing/sieve'
import { chargerEnv, quit } from './dev-common'

const USAGE =
  'Usage : pnpm tsx scripts/framing-sieve.ts --metrique <nom> --famille extremes|autour ' +
  '[--seuil V] [--largeur W] [--n N] [--graine S] [--projets a,b] ' +
  '[--population splits|plans] [--brut] [--format table|cas|jsonl] [--out <fichier>]'

function isMetricName(name: string): name is MetricName {
  return name in METRICS
}

const PROJECT_TO_SHOW = new Map<ProjectId, ShowName>(
  Object.entries(PROJECTS).map(([show, id]) => [id as ProjectId, show as ShowName]),
)

function median(sorted: readonly number[]): number {
  const m = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) return sorted[0]
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function distributionText(metric: ShotMetric, values: readonly number[]): string {
  if (values.length === 0) return `${metric.what} (${metric.unit}) : aucune valeur définie.`
  const sorted = [...values].sort((a, b) => a - b)
  const deciles = Array.from({ length: 9 }, (_, i) => quantile(sorted, (i + 1) / 10))
  return (
    `${metric.what} (${metric.unit})\n` +
    `  min ${sorted[0].toFixed(4)}  déciles [${deciles.map((d) => d.toFixed(4)).join(', ')}]  ` +
    `max ${sorted[sorted.length - 1].toFixed(4)}  médiane ${median(sorted).toFixed(4)}`
  )
}

function pickLine(p: SievePick): string {
  const instant = p.instants.length === 0 ? '(aucune image ne définit la métrique)' : `t=${p.instants[0].toFixed(3)}`
  return `  #${p.rank} ${p.side.padEnd(5)} ${p.value.toFixed(4).padStart(9)}  ${p.id}  ${instant}`
}

function formatTable(
  metric: ShotMetric,
  family: Family,
  seed: string,
  values: readonly number[],
  result: { picks: SievePick[]; total: number; defined: number; undefinedCount: number },
): string {
  const lines: string[] = []
  lines.push(`graine « ${seed} »  —  ${result.defined}/${result.total} plans définis, ${result.undefinedCount} exclus (null/NaN/Infinity)`)
  lines.push(distributionText(metric, values))
  lines.push('')
  const bySide = new Map<string, SievePick[]>()
  for (const p of result.picks) {
    const l = bySide.get(p.side) ?? []
    l.push(p)
    bySide.set(p.side, l)
  }
  for (const [side, picks] of bySide) {
    lines.push(`${side} (${picks.length}) :`)
    for (const p of picks) lines.push(pickLine(p))
  }
  return lines.join('\n')
}

function commitHash(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'inconnu'
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function formatCas(metric: ShotMetric, family: Family, picks: readonly SievePick[]): string {
  const commit = commitHash()
  const date = today()
  const familyText = family.kind === 'extremes' ? `extremes n=${family.n}` : `autour ${family.threshold}±${family.width}`
  const origin = `sieve ${metric.name} ${family.kind} ${date} ${commit}`
  const lines: string[] = []
  for (const p of picks) {
    if (p.instants.length === 0) {
      console.error(`${p.id} : aucune image ne définit la métrique, pas de cas généré.`)
      continue
    }
    const show = PROJECT_TO_SHOW.get(p.project)
    if (show === undefined) {
      console.error(`${p.id} : projet ${p.project} sans nom d'émission connu, pas de cas généré.`)
      continue
    }
    lines.push(
      '{\n' +
        `  id: '${p.id}',\n` +
        `  show: '${show}',\n` +
        `  scope: { over: 'shot' },\n` +
        `  anchor: { at: 'shot', shot: { start: ${p.shot.start}, end: ${p.shot.end} }, instants: [${p.instants[0]}] },\n` +
        `  probes: '${metric.what} (${familyText}) : ${p.side} = ${p.value.toFixed(4)} ${metric.unit}',\n` +
        '  label: null,\n' +
        `  tags: [{ rule: '${metric.name}', outcome: '${String(p.value)}', at: '${commit}', on: '${date}' }],\n` +
        `  origin: '${origin}',\n` +
        '  retired: null,\n' +
        '},',
    )
  }
  return lines.join('\n')
}

function formatJsonl(picks: readonly SievePick[]): string {
  return picks.map((p) => JSON.stringify(p)).join('\n')
}

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const value = (flag: string): string | undefined => {
    const i = arguments_.indexOf(flag)
    if (i < 0) return undefined
    const raw = arguments_[i + 1]
    return raw === undefined || raw.startsWith('--') ? undefined : raw
  }

  const rawMetric = value('--metrique')
  if (rawMetric === undefined || !isMetricName(rawMetric)) {
    console.error(
      `--metrique attend l'une de ${Object.keys(METRICS).join(', ')}, reçu « ${String(rawMetric)} ».\n${USAGE}`,
    )
    return 1
  }
  const metric: ShotMetric = METRICS[rawMetric]

  const rawFamille = value('--famille')
  if (rawFamille !== 'extremes' && rawFamille !== 'autour') {
    console.error(`--famille attend extremes ou autour, reçu « ${String(rawFamille)} ».\n${USAGE}`)
    return 1
  }

  const rawN = value('--n')
  const n = rawN === undefined ? 20 : Number(rawN)
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--n attend un entier ≥ 1, reçu « ${String(rawN)} ».`)
    return 1
  }

  const seed = value('--graine') ?? 'avolo'
  const brut = arguments_.includes('--brut')

  let family: Family
  if (rawFamille === 'extremes') {
    family = { kind: 'extremes', n, spread: !brut }
  } else {
    const rawSeuil = value('--seuil')
    const rawLargeur = value('--largeur')
    if (rawSeuil === undefined || rawLargeur === undefined) {
      console.error("--famille autour exige --seuil et --largeur, tous deux obligatoires.")
      return 1
    }
    const threshold = Number(rawSeuil)
    const width = Number(rawLargeur)
    if (!Number.isFinite(threshold)) {
      console.error(`--seuil attend un nombre, reçu « ${rawSeuil} ».`)
      return 1
    }
    if (!Number.isFinite(width) || width < 0) {
      console.error(`--largeur attend un nombre ≥ 0, reçu « ${rawLargeur} ».`)
      return 1
    }
    family = { kind: 'around', threshold, width, n }
  }

  const rawPopulation = value('--population') ?? 'splits'
  if (rawPopulation !== 'splits' && rawPopulation !== 'plans') {
    console.error(`--population attend splits ou plans, reçu « ${rawPopulation} ».`)
    return 1
  }
  const population: CorpusOptions['population'] = rawPopulation === 'splits' ? 'splits' : 'shots'

  const rawProjets = value('--projets')
  let projects: ProjectId[] | undefined
  if (rawProjets !== undefined) {
    projects = []
    for (const token of rawProjets.split(',').map((t) => t.trim()).filter((t) => t.length > 0)) {
      const id = (PROJECTS as Record<string, string>)[token]
      if (id === undefined) {
        console.error(
          `--projets : « ${token} » inconnu. Attendu : ${Object.keys(PROJECTS).join(', ')}.`,
        )
        return 1
      }
      projects.push(id as ProjectId)
    }
  }

  const rawFormat = value('--format') ?? 'table'
  if (rawFormat !== 'table' && rawFormat !== 'cas' && rawFormat !== 'jsonl') {
    console.error(`--format attend table, cas ou jsonl, reçu « ${rawFormat} ».`)
    return 1
  }

  const { samples, skipped } = sweepCorpus({ projects, population })
  for (const s of skipped) console.error(`ignoré : ${s.project} — ${s.why}`)

  const values: number[] = []
  for (const s of samples) {
    const v = metric.of(s)
    if (v !== null && Number.isFinite(v)) values.push(v)
  }

  const result = sieve(samples, metric, family, seed)

  const text =
    rawFormat === 'table'
      ? formatTable(metric, family, seed, values, result)
      : rawFormat === 'cas'
        ? formatCas(metric, family, result.picks)
        : formatJsonl(result.picks)

  const outFile = value('--out')
  if (outFile === undefined) {
    console.log(text)
  } else {
    fs.writeFileSync(outFile, `${text}\n`)
    console.error(`Écrit : ${outFile}`)
  }

  return 0
}

void main().then(quit, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quit(1)
})
