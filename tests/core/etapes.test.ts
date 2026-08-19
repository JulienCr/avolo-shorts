import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Le critère de sortie de l'issue #39, vérifié comme on vérifie du code :
 * **ajouter une étape au graphe sans toucher au client doit casser le
 * type-check.**
 *
 * Le symptôme qui a ouvert le ticket est réel et silencieux : `analysis`,
 * ajoutée au graphe par la PR #31, manquait à la table de libellés du client, et
 * l'écran affichait un libellé vide avec un `aria-label` « undefined en cours »
 * pendant toute l'analyse d'un projet neuf. Ni le lint, ni les tests, ni le
 * type-check ne bronchaient.
 *
 * Le correctif est un `Record<StepName, string>` exhaustif. Ce test-ci le tient
 * en compilant une sonde : la table courante, assignée à un `Record` dont
 * l'union porte **une étape de plus**. Si TypeScript s'en plaint, alors
 * l'exhaustivité est bien exigée, et la prochaine étape ajoutée au graphe
 * échouera de la même façon. Si quelqu'un relâchait le type — un
 * `Record<string, string>`, un `Partial<…>` —, la sonde compilerait et ce test
 * tomberait. C'est le même geste que `tests/core/purete.test.ts` avec ESLint :
 * une garantie portée par un type se défait sans bruit.
 */

const root = path.resolve(import.meta.dirname, '../..')
const probe = path.join(root, 'src/core/__sonde-etapes.ts')

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

/** Compile un fichier virtuel posé dans `src/core/`, et rend ses erreurs. */
function errors(code: string): string[] {
  const host = ts.createCompilerHost(OPTIONS, true)
  const lireTrue = host.getSourceFile.bind(host)
  const existsTrue = host.fileExists.bind(host)

  host.getSourceFile = (name, version, ...remaining) =>
    path.resolve(name) === probe
      ? ts.createSourceFile(name, code, version, true, ts.ScriptKind.TS)
      : lireTrue(name, version, ...remaining)
  host.fileExists = (name) => path.resolve(name) === probe || existsTrue(name)

  const program = ts.createProgram([probe], OPTIONS, host)
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file !== undefined && path.resolve(d.file.fileName) === probe)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))
}

describe('le vocabulaire des étapes', () => {
  it('refuse une union d’étapes plus large que la table', () => {
    const messages = errors(
      [
        "import type { StepName } from '@/core/graph'",
        "import { LABELS_STEPS } from '@/core/phase'",
        "type Étendu = StepName | 'sous_titres'",
        'export const sonde: Record<Étendu, string> = LABELS_STEPS',
      ].join('\n'),
    )
    expect(messages.join('\n')).toContain('sous_titres')
  })

  it('accepte l’union telle que le graphe la déclare', () => {
    // Le contrôle négatif, sans lequel le premier test passerait aussi bien sur
    // une sonde qui ne compile pas du tout.
    const messages = errors(
      [
        "import type { StepName } from '@/core/graph'",
        "import { LABELS_STEPS } from '@/core/phase'",
        'export const sonde: Record<StepName, string> = LABELS_STEPS',
      ].join('\n'),
    )
    expect(messages).toEqual([])
  })
})
