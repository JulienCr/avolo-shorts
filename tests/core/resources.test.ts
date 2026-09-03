import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  CAPACITIES,
  isLocal,
  PRIORITIES,
  priorityFor,
  resourceFor,
  type LocalModels,
} from '@/core/resources'

const ALL_LOCAL: LocalModels = { selection: true, correction: true, hook: true }
const ALL_REMOTE: LocalModels = { selection: false, correction: false, hook: false }
// Mixed on purpose: catches a swap between `local.selection` and
// `local.correction` that ALL_LOCAL/ALL_REMOTE cannot, since both usages
// agree there.
const MIXED: LocalModels = { selection: true, correction: false, hook: true }

describe('resourceFor', () => {
  it('switches to gpu when the configured provider is Ollama, not net', () => {
    // The counter-intuitive rule this PR pins: Ollama runs on the same card
    // as WhisperX, through the WSL gateway. It is not a network call.
    expect(resourceFor('correction', ALL_LOCAL)).toBe('gpu')
    expect(resourceFor('correction', ALL_REMOTE)).toBe('net')
    expect(resourceFor('candidates', ALL_LOCAL)).toBe('gpu')
    expect(resourceFor('candidates', ALL_REMOTE)).toBe('net')
  })

  it('ties each step to its own LLM usage, not the other one', () => {
    expect(resourceFor('candidates', MIXED)).toBe('gpu')
    expect(resourceFor('correction', MIXED)).toBe('net')
  })

  it('reserves gpu for renders, transcript and analysis; cpu for proxy; nothing for audio', () => {
    expect(resourceFor('renders', ALL_LOCAL)).toBe('gpu')
    expect(resourceFor('transcript', ALL_LOCAL)).toBe('gpu')
    expect(resourceFor('analysis', ALL_LOCAL)).toBe('gpu')
    expect(resourceFor('proxy', ALL_LOCAL)).toBe('cpu')
    expect(resourceFor('audio', ALL_LOCAL)).toBeNull()
    expect(resourceFor('audio', ALL_REMOTE)).toBeNull()
  })
})

describe('priorityFor', () => {
  it('orders every step, renders first and proxy last', () => {
    const order: readonly (keyof typeof PRIORITIES)[] = [
      'renders',
      'audio',
      'transcript',
      'correction',
      'candidates',
      'analysis',
      'proxy',
    ]
    const priorities = order.map((step) => priorityFor(step))
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b))
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

describe('exhaustiveness of PRIORITIES over StepName', () => {
  it('rejects a step union wider than the table', () => {
    // Assigns the table itself, not a call through priorityFor's narrow
    // parameter — a call-site mismatch would fire regardless of whether
    // PRIORITIES actually covers every step.
    const messages = errors(
      [
        "import type { StepName } from '@/core/graph'",
        "import { PRIORITIES } from '@/core/resources'",
        "type Extended = StepName | 'subtitles'",
        'export const probe: Record<Extended, number> = PRIORITIES',
      ].join('\n'),
    )
    expect(messages.join('\n')).toContain('subtitles')
  })

  it('accepts the union as the graph declares it', () => {
    const messages = errors(
      [
        "import type { StepName } from '@/core/graph'",
        "import { PRIORITIES } from '@/core/resources'",
        'export const probe: Record<StepName, number> = PRIORITIES',
      ].join('\n'),
    )
    expect(messages).toEqual([])
  })
})
