import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { CAPACITIES, isLocal, priorityFor, resourceFor, type LocalModels } from '@/core/resources'

const ALL_LOCAL: LocalModels = { selection: true, correction: true, hook: true }
const ALL_REMOTE: LocalModels = { selection: false, correction: false, hook: false }

describe('resourceFor', () => {
  it('switches to gpu when the configured provider is Ollama, not net', () => {
    // The counter-intuitive rule this PR pins: Ollama runs on the same card
    // as WhisperX, through the WSL gateway. It is not a network call.
    expect(resourceFor('correction', ALL_LOCAL)).toBe('gpu')
    expect(resourceFor('correction', ALL_REMOTE)).toBe('net')
    expect(resourceFor('candidates', ALL_LOCAL)).toBe('gpu')
    expect(resourceFor('candidates', ALL_REMOTE)).toBe('net')
  })

  it('reserves nothing for audio', () => {
    expect(resourceFor('audio', ALL_LOCAL)).toBeNull()
    expect(resourceFor('audio', ALL_REMOTE)).toBeNull()
  })
})

describe('priorityFor', () => {
  it('runs renders before transcript, and transcript before proxy', () => {
    expect(priorityFor('renders')).toBeLessThan(priorityFor('transcript'))
    expect(priorityFor('transcript')).toBeLessThan(priorityFor('proxy'))
  })
})

describe('isLocal', () => {
  it('is true for null, gpu and cpu; false for net', () => {
    expect(isLocal(null)).toBe(true)
    expect(isLocal('gpu')).toBe(true)
    expect(isLocal('cpu')).toBe(true)
    expect(isLocal('net')).toBe(false)
  })
})

describe('CAPACITIES', () => {
  it('holds one token per resource, two for net', () => {
    expect(CAPACITIES).toEqual({ gpu: 1, cpu: 1, net: 2 })
  })
})

/**
 * Same method as `tests/core/etapes.test.ts`: a compiled probe proves that
 * adding a step to the graph without giving it a resource breaks the
 * type-check, instead of rendering `undefined` silently.
 */

const root = path.resolve(import.meta.dirname, '../..')
const probe = path.join(root, 'src/core/__probe-resources.ts')

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

describe('exhaustiveness of priorityFor over StepName', () => {
  it('rejects a step union wider than what priorityFor knows', () => {
    const messages = errors(
      [
        "import type { StepName } from '@/core/graph'",
        "import { priorityFor } from '@/core/resources'",
        "type Extended = StepName | 'subtitles'",
        'export function probe(step: Extended): number {',
        '  return priorityFor(step)',
        '}',
      ].join('\n'),
    )
    expect(messages.join('\n')).toContain('subtitles')
  })

  it('accepts the union as the graph declares it', () => {
    const messages = errors(
      [
        "import type { StepName } from '@/core/graph'",
        "import { priorityFor } from '@/core/resources'",
        'export function probe(step: StepName): number {',
        '  return priorityFor(step)',
        '}',
      ].join('\n'),
    )
    expect(messages).toEqual([])
  })
})
