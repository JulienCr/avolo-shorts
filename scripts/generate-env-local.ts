/**
 * Écrit `.env.local` avec les secrets `op://…` de `.env` résolus une bonne
 * fois, en **un seul** sous-processus `op`.
 *
 * Le défaut mesuré de `resolveSecrets` (`src/server/secrets.ts`) : quatre
 * références distinctes lancent quatre `op read` en parallèle, donc 1Password
 * demande quatre approbations au lieu d'une — aucun des quatre process ne
 * profite de la session que les autres établissent. `op inject` lit un gabarit
 * sur stdin et remplace chaque `{{ op://… }}` en un seul aller-retour, quels
 * que soient le coffre, la fiche et le champ.
 */

import { execFile } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { isReference } from '@/server/secrets'

const execFileP = promisify(execFile)

/** Le délai de garde d'un aller-retour vers 1Password. Voir `src/server/secrets.ts`. */
const DELAY_MS = 60_000

function opBin(): string {
  return process.env.OP_BIN || 'op'
}

export interface EnvReference {
  readonly name: string
  readonly reference: string
}

/** Ce qu'`op inject` reçoit sur stdin. Injecté par les tests, qui ne lancent jamais `op`. */
export type BatchInjector = (template: string) => Promise<string>

/** Ce qui lit une référence isolée, pour le diagnostic quand le lot échoue. */
export type SecretReader = (reference: string) => Promise<string>

/**
 * Les variables de `content` dont la valeur est une adresse `op://…`, dans
 * l'ordre où elles apparaissent. Une valeur littérale ne ressort pas — c'est le
 * point : `.env.local` ne doit porter que ce qui n'était pas déjà en clair.
 */
export function parseEnvReferences(content: string): EnvReference[] {
  const entries: EnvReference[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals === -1) continue
    const name = line.slice(0, equals).trim()
    if (name === 'OP_BIN') continue
    let value = line.slice(equals + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (isReference(value)) entries.push({ name, reference: value })
  }
  return entries
}

function sentinel(kind: 'START' | 'END', name: string, nonce: string): string {
  return `<<<${kind}:${nonce}:${name}>>>`
}

/**
 * Un gabarit à sentinelles, une par variable. Les sentinelles délimitent
 * chaque valeur plutôt qu'une découpe par ligne : un secret peut contenir des
 * sauts de ligne (une clé privée), qu'une découpe par ligne abîmerait.
 */
export function buildInjectTemplate(entries: readonly EnvReference[], nonce: string): string {
  return entries
    .map((entry) => `${sentinel('START', entry.name, nonce)}\n{{ ${entry.reference} }}\n${sentinel('END', entry.name, nonce)}`)
    .join('\n')
}

/**
 * Les valeurs résolues, extraites entre les sentinelles de chaque variable —
 * sans ajouter ni retirer d'espace autour, un saut de ligne final faisant
 * partie du secret qui le porte.
 */
export function parseInjectOutput(
  output: string,
  entries: readonly EnvReference[],
  nonce: string,
): Map<string, string> {
  const values = new Map<string, string>()
  for (const entry of entries) {
    const start = `${sentinel('START', entry.name, nonce)}\n`
    const end = `\n${sentinel('END', entry.name, nonce)}`
    const startIndex = output.indexOf(start)
    if (startIndex === -1) {
      throw new Error(`${entry.name} : sentinelle de départ absente de la sortie de op inject.`)
    }
    const valueStart = startIndex + start.length
    const endIndex = output.indexOf(end, valueStart)
    if (endIndex === -1) {
      throw new Error(`${entry.name} : sentinelle de fin absente de la sortie de op inject.`)
    }
    values.set(entry.name, output.slice(valueStart, endIndex))
  }
  return values
}

/**
 * `execFile` promisifié n'accepte pas d'entrée standard : `op inject` lit son
 * gabarit sur stdin, donc on retombe sur la forme à callback pour écrire dessus
 * avant que le processus ne se termine.
 */
function injectViaOp(template: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      opBin(),
      ['inject'],
      { encoding: 'utf8', timeout: DELAY_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
    child.stdin?.end(template)
  })
}

async function readViaOp(reference: string): Promise<string> {
  const { stdout } = await execFileP(opBin(), ['read', '--no-newline', reference], {
    encoding: 'utf8',
    timeout: DELAY_MS,
  })
  return stdout
}

/**
 * Résout `entries` en un seul appel à `inject`. `op inject` échoue en bloc dès
 * qu'une référence est fausse et ne nomme que la première fautive : quand le
 * lot échoue, on retombe sur `readOne` en **séquentiel** — jamais en
 * parallèle, c'est tout l'objet de ce script — pour un diagnostic par
 * référence.
 */
export async function resolveEnvLocal(
  entries: readonly EnvReference[],
  inject: BatchInjector,
  readOne: SecretReader,
): Promise<[string, string][]> {
  if (entries.length === 0) return []

  const nonce = randomUUID()
  try {
    const output = await inject(buildInjectTemplate(entries, nonce))
    const values = parseInjectOutput(output, entries, nonce)
    return entries.map((entry) => [entry.name, values.get(entry.name) as string])
  } catch {
    const failures: string[] = []
    const resolved: [string, string][] = []
    for (const entry of entries) {
      try {
        resolved.push([entry.name, await readOne(entry.reference)])
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        failures.push(`${entry.name} : impossible de lire ${entry.reference}. ${message}`)
      }
    }
    if (failures.length > 0) throw new Error(failures.join('\n'))
    return resolved
  }
}

/** Échappe une valeur pour un `.env` à guillemets doubles, à la manière de `dotenv`. */
function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
}

/** Le contenu d'un `.env.local` : une variable par ligne, à guillemets doubles. */
export function formatEnvLocal(resolved: readonly [string, string][]): string {
  return resolved.map(([name, value]) => `${name}="${escapeValue(value)}"\n`).join('')
}

async function main(): Promise<void> {
  const source = readFileSync('.env', 'utf8')
  const entries = parseEnvReferences(source)
  if (entries.length === 0) {
    console.log('Aucune référence op:// dans .env : rien à écrire dans .env.local.')
    return
  }

  const resolved = await resolveEnvLocal(entries, injectViaOp, readViaOp)
  writeFileSync('.env.local', formatEnvLocal(resolved), { mode: 0o600 })
  chmodSync('.env.local', 0o600)
  console.log(`.env.local : ${resolved.map(([name]) => name).join(', ')} résolue(s).`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  })
}
