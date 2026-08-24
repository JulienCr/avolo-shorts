/**
 * Écrit `.env.local` avec les secrets `op://…` de `.env` résolus une bonne
 * fois, en **un seul** sous-processus `op`.
 *
 * Le défaut mesuré de `resolveSecrets` (`src/server/secrets.ts`) : quatre
 * références distinctes lancent quatre `op read` en parallèle, donc 1Password
 * demande quatre approbations au lieu d'une. `op inject` lit un gabarit sur
 * stdin et remplace chaque `{{ op://… }}` en un seul aller-retour. Le socle
 * partagé (gabarit à sentinelles, injecteur `execFile`+stdin) vit dans
 * `src/server/op-inject.ts`, réutilisé ici et par `resolveSecrets`.
 */

import { randomUUID } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { isReference, lireInOnePassword, type SecretPlayer } from '@/server/secrets'
import {
  buildInjectTemplate as buildTemplateShared,
  createBatchInjector,
  parseInjectOutput as parseOutputShared,
  type BatchInjector,
  type InjectEntry,
} from '@/server/op-inject'

/** Le délai de garde d'un aller-retour vers 1Password. Voir `src/server/secrets.ts`. */
const DELAY_MS = 60_000

function opBin(): string {
  return process.env.OP_BIN || 'op'
}

export interface EnvReference {
  readonly name: string
  readonly reference: string
}

function toInjectEntries(entries: readonly EnvReference[]): InjectEntry[] {
  return entries.map((entry) => ({ key: entry.name, reference: entry.reference }))
}

/** Le gabarit à sentinelles de `src/server/op-inject.ts`, indexé par nom de variable. */
export function buildInjectTemplate(entries: readonly EnvReference[], nonce: string): string {
  return buildTemplateShared(toInjectEntries(entries), nonce)
}

/** Les valeurs résolues de `src/server/op-inject.ts`, indexées par nom de variable. */
export function parseInjectOutput(output: string, entries: readonly EnvReference[], nonce: string): Map<string, string> {
  return parseOutputShared(output, toInjectEntries(entries), nonce)
}

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

function injectViaOp(template: string): Promise<string> {
  return createBatchInjector({ bin: opBin(), timeoutMs: DELAY_MS })(template)
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
  readOne: SecretPlayer,
): Promise<[string, string][]> {
  if (entries.length === 0) return []

  const nonce = randomUUID()
  const injectEntries = toInjectEntries(entries)
  try {
    const output = await inject(buildTemplateShared(injectEntries, nonce))
    const values = parseOutputShared(output, injectEntries, nonce)
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

  const resolved = await resolveEnvLocal(entries, injectViaOp, lireInOnePassword)
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
