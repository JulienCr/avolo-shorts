import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { CAPACITIES, isLocal, priorityFor, resourceFor, type LocalModels } from '@/core/resources'

const ALL_LOCAL: LocalModels = { selection: true, correction: true, hook: true }
const ALL_REMOTE: LocalModels = { selection: false, correction: false, hook: false }

describe('resourceFor', () => {
  it('bascule sur le GPU quand le fournisseur reglé est Ollama, pas sur le reseau', () => {
    // La regle contre-intuitive de cette PR : Ollama tourne sur la meme carte
    // que WhisperX, via la passerelle WSL. Ce n'est pas un appel reseau.
    expect(resourceFor('correction', ALL_LOCAL)).toBe('gpu')
    expect(resourceFor('correction', ALL_REMOTE)).toBe('net')
    expect(resourceFor('candidates', ALL_LOCAL)).toBe('gpu')
    expect(resourceFor('candidates', ALL_REMOTE)).toBe('net')
  })

  it('ne reserve rien pour l’audio', () => {
    expect(resourceFor('audio', ALL_LOCAL)).toBeNull()
    expect(resourceFor('audio', ALL_REMOTE)).toBeNull()
  })
})

describe('priorityFor', () => {
  it('fait passer les rendus avant le transcript, et le transcript avant le proxy', () => {
    expect(priorityFor('renders')).toBeLessThan(priorityFor('transcript'))
    expect(priorityFor('transcript')).toBeLessThan(priorityFor('proxy'))
  })
})

describe('isLocal', () => {
  it('dit local pour null, gpu et cpu ; distant pour net', () => {
    expect(isLocal(null)).toBe(true)
    expect(isLocal('gpu')).toBe(true)
    expect(isLocal('cpu')).toBe(true)
    expect(isLocal('net')).toBe(false)
  })
})

describe('CAPACITIES', () => {
  it('porte un jeton par ressource, deux pour le reseau', () => {
    expect(CAPACITIES).toEqual({ gpu: 1, cpu: 1, net: 2 })
  })
})

/**
 * Meme methode que `tests/core/etapes.test.ts` : une sonde compilee prouve
 * qu'ajouter une etape au graphe sans y ajouter sa ressource casse le
 * type-check, au lieu de rendre `undefined` en silence.
 */

const root = path.resolve(import.meta.dirname, '../..')
const probe = path.join(root, 'src/core/__sonde-resources.ts')

const OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2017,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  baseUrl: root,
  paths: { '@/*': ['./src/*'] },
  types: [],
}

function errors(code: string): string[] {
  const host = ts.createCompilerHost(OPTIONS, true)
  const readTrue = host.getSourceFile.bind(host)
  const existsTrue = host.fileExists.bind(host)

  host.getSourceFile = (name, version, ...remaining) =>
    path.resolve(name) === probe
      ? ts.createSourceFile(name, code, version, true, ts.ScriptKind.TS)
      : readTrue(name, version, ...remaining)
  host.fileExists = (name) => path.resolve(name) === probe || existsTrue(name)

  const program = ts.createProgram([probe], OPTIONS, host)
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file !== undefined && path.resolve(d.file.fileName) === probe)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))
}

describe('exhaustivite de priorityFor sur StepName', () => {
  it('refuse une union d’etapes plus large que ce que priorityFor connait', () => {
    const messages = errors(
      [
        "import type { StepName } from '@/core/graph'",
        "import { priorityFor } from '@/core/resources'",
        "type Etendu = StepName | 'sous_titres'",
        'export function sonde(step: Etendu): number {',
        '  return priorityFor(step)',
        '}',
      ].join('\n'),
    )
    expect(messages.join('\n')).toContain('sous_titres')
  })

  it('accepte l’union telle que le graphe la declare', () => {
    const messages = errors(
      [
        "import type { StepName } from '@/core/graph'",
        "import { priorityFor } from '@/core/resources'",
        'export function sonde(step: StepName): number {',
        '  return priorityFor(step)',
        '}',
      ].join('\n'),
    )
    expect(messages).toEqual([])
  })
})
