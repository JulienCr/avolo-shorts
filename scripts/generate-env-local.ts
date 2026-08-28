/**
 * Écrit `.env.local` avec les secrets `op://…` de `.env` résolus une bonne
 * fois, en **un seul** sous-processus `op`.
 *
 * Avant cette PR, `resolveSecrets` (`src/server/secrets.ts`) lançait un
 * `op read` par référence distincte, en parallèle : quatre approbations
 * 1Password au lieu d'une. Les deux résolvent désormais leur lot en un seul
 * `op inject` ; le socle partagé (gabarit à sentinelles, injecteur
 * `execFile`+stdin) vit dans `src/server/op-inject.ts`.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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

const ENV_LOCAL_PATH = '.env.local'

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
 * La valeur d'une variable, débarrassée de ses guillemets et d'un commentaire
 * de fin de ligne — vérifié sur Node 22.22.1 : `process.loadEnvFile` tronque
 * une valeur non guillemetée au premier `#`, et coupe une valeur guillemetée
 * juste après son guillemet fermant.
 */
function extractValue(rawValue: string): string {
  const quote = rawValue[0]
  if (quote === '"' || quote === "'") {
    const closing = rawValue.indexOf(quote, 1)
    return closing === -1 ? rawValue.slice(1) : rawValue.slice(1, closing)
  }
  const hash = rawValue.indexOf('#')
  return (hash === -1 ? rawValue : rawValue.slice(0, hash)).trim()
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
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line
    const equals = withoutExport.indexOf('=')
    if (equals === -1) continue
    const name = withoutExport.slice(0, equals).trim()
    if (name === 'OP_BIN') continue
    const value = extractValue(withoutExport.slice(equals + 1).trimStart())
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
  let resolved: [string, string][]
  try {
    const output = await inject(buildTemplateShared(injectEntries, nonce))
    const values = parseOutputShared(output, injectEntries, nonce)
    resolved = entries.map((entry) => [entry.name, values.get(entry.name) as string])
  } catch {
    const failures: string[] = []
    const partial: [string, string][] = []
    for (const entry of entries) {
      try {
        partial.push([entry.name, await readOne(entry.reference)])
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        failures.push(`${entry.name} : impossible de lire ${entry.reference}. ${message}`)
      }
    }
    if (failures.length > 0) throw new Error(failures.join('\n'))
    resolved = partial
  }

  // Un champ vidé dans 1Password rendrait `KEY=''` — prioritaire sur `.env` —
  // et le garde-fou équivalent de `resolveSecrets` ne verrait plus jamais
  // passer l'adresse `op://` pour le détecter. (relevé par Copilot et Aristarque)
  const empty = resolved.filter(([, value]) => value === '')
  if (empty.length > 0) {
    throw new Error(empty.map(([name]) => `${name} : 1Password rend une valeur vide. Le champ est vide.`).join('\n'))
  }
  return resolved
}

/**
 * Entoure `value` de guillemets simples, sans y toucher. Ni `\"` ni `\\` ne
 * sont décodés par `process.loadEnvFile` **ni** par le `dotenv` de
 * `@next/env` — vérifié, ça tronque ou double le secret. Les guillemets
 * simples, eux, ne subissent aucune interprétation des deux côtés : un
 * antislash, un guillemet double ou un saut de ligne y passent intacts.
 * Deux caractères n'ont pas de représentation sûre : l'apostrophe et `$`.
 */
function quoteValue(name: string, value: string): string {
  if (value.includes("'")) {
    throw new Error(
      `${name} : la valeur résolue contient une apostrophe, qu'aucune syntaxe de ` +
        '.env.local ne sait représenter sans risque de troncature. Retirer la ' +
        'référence op:// de .env pour cette variable et la garder littérale.',
    )
  }
  if (value.includes('$')) {
    throw new Error(
      `${name} : la valeur résolue contient un $, que le dotenv-expand de @next/env ` +
        "interprète comme une expansion de variable même entre apostrophes, alors que " +
        'process.loadEnvFile ne le décode jamais. Aucun fichier .env* ne règle ce cas : ' +
        "@next/env charge aussi bien .env que .env.local, donc garder la valeur littérale " +
        "dans .env expose next dev à la même corruption. Sortir cette variable de tout " +
        'fichier .env* et l\'injecter directement dans l\'environnement du process (export ' +
        'shell, secret manager du déploiement) avant de lancer next dev ou next start.',
    )
  }
  return `'${value}'`
}

/** Le contenu d'un `.env.local` : une variable par ligne, à guillemets simples. */
export function formatEnvLocal(resolved: readonly [string, string][]): string {
  return resolved.map(([name, value]) => `${name}=${quoteValue(name, value)}\n`).join('')
}

/**
 * Formate `resolved` puis écrit `path` — jamais l'inverse. `formatEnvLocal`
 * valide chaque valeur (`quoteValue`) avant que `writeEnvLocalFile` ne
 * touche le disque : si une valeur est rejetée, l'appel s'arrête avant
 * d'écrire, et un `.env.local` déjà présent est supprimé (issue #230) plutôt
 * que laissé avec un secret révoqué, prioritaire sur `.env`.
 */
export function writeResolvedEnvLocal(path: string, resolved: readonly [string, string][]): void {
  let content: string
  try {
    content = formatEnvLocal(resolved)
  } catch (cause) {
    // La suppression est best-effort : si elle échoue à son tour (permissions,
    // TOCTOU), le message diagnostique de quoteValue prime sur l'erreur fs.
    try {
      removeStaleEnvLocal(path)
    } catch {
      // ignoré, voir commentaire ci-dessus
    }
    throw cause
  }
  writeEnvLocalFile(path, content)
}

/**
 * Supprime `.env.local` s'il existe. Ce fichier n'est jamais que le dernier
 * résultat de ce script : quand `.env` ne porte plus de référence `op://`, le
 * laisser en place ferait persister un secret révoqué, prioritaire sur `.env`
 * qui, lui, est à jour. (relevé par les trois relecteurs)
 */
export function removeStaleEnvLocal(path: string): boolean {
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

/**
 * Écrit `content` dans `path` en `0600`, sans jamais exposer une fenêtre où le
 * fichier porte des permissions plus larges. `writeFileSync(path, …, {mode})`
 * n'applique `mode` qu'à la création : si `.env.local` existe déjà en `0644`,
 * il serait réécrit avec ces permissions jusqu'au `chmodSync` suivant. Écrire
 * dans un fichier temporaire neuf, donc créé en `0600`, puis le renommer par
 * dessus évite cette fenêtre. (relevé par Copilot et Aristarque)
 */
export function writeEnvLocalFile(path: string, content: string): void {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmpPath, content, { mode: 0o600 })
  renameSync(tmpPath, path)
}

/**
 * Lit `.env`, avec un message qui nomme le fichier attendu et son remède —
 * pas le `ENOENT` brut de Node. Cas réel : un worktree git, où `.env` est
 * ignoré et n'est donc pas partagé avec le dépôt principal.
 */
export function readEnvFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new Error(
        `${path} est introuvable dans ${process.cwd()}. ` +
          "`.env` est ignoré par git : un worktree ne le partage pas avec le " +
          `dépôt principal. Le copier depuis là, ou le recréer depuis ${path}.example.`,
      )
    }
    throw cause
  }
}

async function main(): Promise<void> {
  const source = readEnvFile('.env')
  const entries = parseEnvReferences(source)
  if (entries.length === 0) {
    if (removeStaleEnvLocal(ENV_LOCAL_PATH)) {
      console.log(`${ENV_LOCAL_PATH} supprimé : .env ne porte plus aucune référence op://.`)
    } else {
      console.log('Aucune référence op:// dans .env : rien à écrire dans .env.local.')
    }
    return
  }

  const resolved = await resolveEnvLocal(entries, injectViaOp, lireInOnePassword)
  writeResolvedEnvLocal(ENV_LOCAL_PATH, resolved)
  console.log(`.env.local : ${resolved.map(([name]) => name).join(', ')} résolue(s).`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  })
}
