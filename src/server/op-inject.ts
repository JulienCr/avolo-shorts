import { execFile } from 'node:child_process'

/**
 * Le socle `op inject` partagé par `resolveSecrets` (`src/server/secrets.ts`)
 * et `pnpm generate-env:local` (`scripts/generate-env-local.ts`) : un gabarit
 * à sentinelles, une par entrée, plutôt qu'une découpe par ligne — un secret
 * peut porter des sauts de ligne (une clé privée), qu'une découpe par ligne
 * abîmerait.
 */

export interface InjectEntry {
  readonly key: string
  readonly reference: string
}

/** Ce qui envoie un gabarit à `op inject` et rend sa sortie. Injecté par les tests. */
export type BatchInjector = (template: string) => Promise<string>

function sentinel(kind: 'START' | 'END', key: string, nonce: string): string {
  return `<<<${kind}:${nonce}:${key}>>>`
}

/** Un gabarit à sentinelles pour `op inject`, une par entrée de `entries`. */
export function buildInjectTemplate(entries: readonly InjectEntry[], nonce: string): string {
  return entries
    .map(
      (entry) =>
        `${sentinel('START', entry.key, nonce)}\n{{ ${entry.reference} }}\n${sentinel('END', entry.key, nonce)}`,
    )
    .join('\n')
}

/**
 * Les valeurs résolues, extraites entre les sentinelles de chaque entrée —
 * sans ajouter ni retirer d'espace autour, un saut de ligne final faisant
 * partie du secret qui le porte.
 */
export function parseInjectOutput(
  output: string,
  entries: readonly InjectEntry[],
  nonce: string,
): Map<string, string> {
  const values = new Map<string, string>()
  for (const entry of entries) {
    const start = `${sentinel('START', entry.key, nonce)}\n`
    const end = `\n${sentinel('END', entry.key, nonce)}`
    const startIndex = output.indexOf(start)
    if (startIndex === -1) {
      throw new Error(`${entry.key} : sentinelle de départ absente de la sortie de op inject.`)
    }
    const valueStart = startIndex + start.length
    const endIndex = output.indexOf(end, valueStart)
    if (endIndex === -1) {
      throw new Error(`${entry.key} : sentinelle de fin absente de la sortie de op inject.`)
    }
    values.set(entry.key, output.slice(valueStart, endIndex))
  }
  return values
}

export interface OpInjectOptions {
  readonly bin: string
  readonly timeoutMs: number
  readonly maxBufferBytes?: number
  /** Les arguments avant le gabarit sur stdin. `['inject']` pour `op`. */
  readonly args?: readonly string[]
}

/**
 * `execFile` promisifié n'accepte pas d'entrée standard : `op inject` lit son
 * gabarit sur stdin, donc on retombe sur la forme à callback pour écrire dessus
 * avant que le processus ne se termine.
 */
export function createBatchInjector(options: OpInjectOptions): BatchInjector {
  const { bin, timeoutMs, maxBufferBytes = 16 * 1024 * 1024, args = ['inject'] } = options
  return (template) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        bin,
        [...args],
        { encoding: 'utf8', timeout: timeoutMs, maxBuffer: maxBufferBytes },
        (error, stdout) => {
          if (error) reject(error)
          else resolve(stdout)
        },
      )
      // Un binaire introuvable ne fait échouer `execFile` qu'après coup :
      // `stdin` peut déjà être clos, et y écrire lèverait un EPIPE non
      // rattrapé ailleurs. Le callback ci-dessus rapporte déjà l'échec.
      child.stdin?.on('error', () => {})
      try {
        child.stdin?.end(template)
      } catch {
        // Ignoré : voir le commentaire ci-dessus.
      }
    })
}
