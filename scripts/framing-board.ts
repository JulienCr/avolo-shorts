/**
 * CLI de planche de comparaison de cadrage — issue #191, lot 3.
 *
 * Deux façons de fournir les cas : `--spec` charge une `BoardSpec` complète
 * (`.ts` avec un export par défaut, ou `.json`) ; `--cas` construit une
 * planche à la volée depuis le registre (`scripts/framing/cases.ts`) et un
 * petit catalogue de variantes nommées, pour un balayage rapide.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildBoard } from './framing/board/build'
import type { BoardCase, BoardSpec, FramingVariant } from './framing/board/spec'
import { projectOf, selectCases, type FramingCase } from './framing/cases'
import { chargerEnv, quit } from './dev-common'

/**
 * Le catalogue de `--variantes` : le balayage qui revient le plus, le
 * split-screen activé contre désactivé — voir l'addendum de l'issue #191 sur
 * les trois cas qui sortent aujourd'hui `split=oui` malgré un verdict humain
 * `drop`.
 */
const KNOWN_VARIANTS: Readonly<Record<string, FramingVariant>> = {
  'split-on': { id: 'split-on', label: 'Split activé', kind: 'settings', settings: {} },
  'split-off': { id: 'split-off', label: 'Split désactivé', kind: 'settings', settings: { splitScreen: false } },
}

function value(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

async function loadSpecFile(file: string): Promise<BoardSpec> {
  if (file.endsWith('.json')) {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as BoardSpec
  }
  const mod: unknown = await import(pathToFileURL(path.resolve(file)).href)
  const spec = (mod as { default?: BoardSpec }).default ?? (mod as { spec?: BoardSpec }).spec
  if (spec === undefined) {
    throw new Error(`--spec ${file} : aucun export par défaut ni \`spec\` nommé — rien à construire.`)
  }
  return spec
}

function caseAsBoardCase(c: FramingCase): BoardCase {
  return {
    id: c.id,
    projectId: projectOf(c),
    at: c.anchor.instants[0],
    clipId: c.scope.over === 'clip' ? c.scope.clipId : null,
    stake: c.probes,
    known: c.label === null ? undefined : { call: c.label.call, on: c.label.on, by: c.label.by, note: c.label.note },
  }
}

/**
 * Libellés humains des mots-clés de sélection reconnus par `selectCases`
 * (voir `scripts/framing/cases.ts`), pour un titre par défaut lisible.
 */
const KEYWORD_LABELS: Readonly<Record<string, string>> = {
  all: 'Tous les cas',
  active: 'Cas actifs',
  labelled: 'Cas étiquetés',
  unlabelled: 'Cas non étiquetés',
  keep: 'Cas conservés',
  drop: 'Cas écartés',
  unsure: 'Cas incertains',
}

/** `['split-on', 'split-off']` → `'split on/off'` ; sinon une liste séparée par virgules. */
function formatVariantIds(ids: string[]): string {
  const parts = ids.map((id) => id.split('-'))
  const head = parts[0]?.[0]
  if (head !== undefined && parts.every((p) => p[0] === head && p.length === 2)) {
    return `${head} ${parts.map((p) => p[1]).join('/')}`
  }
  return ids.join(', ')
}

/**
 * Un titre distinctif par cas de planche : l'identifiant seul quand le
 * sélecteur désigne un cas unique, sinon le sélecteur (ou son libellé) et
 * les variantes — pour distinguer les planches produites au fil du temps.
 */
export function deriveDefaultTitle(selector: string, cases: FramingCase[], variantIds: string[]): string {
  const tokens = selector
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (tokens.length === 1 && cases.length === 1 && cases[0].id === tokens[0]) {
    return cases[0].id
  }
  const label = tokens.length === 1 ? (KEYWORD_LABELS[tokens[0]] ?? tokens[0]) : selector
  return `${label} · ${formatVariantIds(variantIds)}`
}

function specFromCases(o: {
  cases: FramingCase[]
  variantIds: string[]
  classifier: string
  selector: string
  title?: string
}): BoardSpec {
  const variants = o.variantIds.map((id) => {
    const v = KNOWN_VARIANTS[id]
    if (v === undefined) {
      throw new Error(`--variantes : "${id}" inconnu. Attendu : ${Object.keys(KNOWN_VARIANTS).join(', ')}.`)
    }
    return v
  })
  if (variants.length === 0) throw new Error('--variantes : au moins une variante est requise avec --cas.')
  return {
    id: `cas-${new Date().toISOString().slice(0, 10)}`,
    title: o.title ?? deriveDefaultTitle(o.selector, o.cases, o.variantIds),
    eyebrow: 'Cadrage',
    lede: `${o.cases.length} cas du registre, ${variants.length} variante(s).`,
    variants: variants as [FramingVariant, ...FramingVariant[]],
    sections: [{ title: 'Cas sélectionnés', cases: o.cases.map(caseAsBoardCase) }],
    classifier: o.classifier,
    settled: [],
  }
}

async function main(): Promise<number> {
  await chargerEnv()
  const args = process.argv.slice(2)

  const out = value(args, '--out')
  if (out === undefined) {
    console.error(
      'Usage : pnpm framing-board --spec <fichier.ts|.json> --out <fichier.html> [--max-mo N] [--largeur N]\n' +
        '     ou pnpm framing-board --cas <sélecteur> --variantes id1,id2 --out <fichier.html> ' +
          '[--classifieur id] [--titre <texte>]',
    )
    return 1
  }
  // Jamais dans `projects/` : la planche est un artefact de travail, pas une
  // sortie du produit — `projects/` est gitignoré et purgé par d'autres outils.
  if (out.split(path.sep).includes('projects')) {
    console.error(`--out ${out} : "projects/" est réservé aux données du produit.`)
    return 1
  }

  const rawMaxMo = value(args, '--max-mo')
  const maxMo = rawMaxMo === undefined ? undefined : Number(rawMaxMo)
  // Refusé et non corrigé : un plafond illisible remplacé en silence par le
  // défaut ferait passer ou échouer une planche sur une valeur qu'on n'a pas
  // demandée.
  if (maxMo !== undefined && (!Number.isFinite(maxMo) || maxMo <= 0)) {
    console.error(`--max-mo attend un nombre > 0, reçu « ${rawMaxMo} ».`)
    return 1
  }

  const rawLargeur = value(args, '--largeur')
  const displayWidth = rawLargeur === undefined ? undefined : Number(rawLargeur)
  if (displayWidth !== undefined && (!Number.isInteger(displayWidth) || displayWidth <= 0)) {
    console.error(`--largeur attend un entier > 0, reçu « ${rawLargeur} ».`)
    return 1
  }

  const specFile = value(args, '--spec')
  const casSelector = value(args, '--cas')

  let spec: BoardSpec
  if (specFile !== undefined) {
    spec = await loadSpecFile(specFile)
  } else if (casSelector !== undefined) {
    const rawVariantes = value(args, '--variantes')
    if (rawVariantes === undefined) {
      console.error('--cas exige --variantes <id1,id2,…>.')
      return 1
    }
    const cases = selectCases(casSelector)
    if (cases.length === 0) {
      console.error(`--cas ${casSelector} : aucun cas sélectionné.`)
      return 1
    }
    const titre = value(args, '--titre')
    if (titre !== undefined && titre.trim().length === 0) {
      console.error('--titre attend un texte non vide.')
      return 1
    }
    spec = specFromCases({
      cases,
      variantIds: rawVariantes
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      classifier: value(args, '--classifieur') ?? 'single',
      selector: casSelector,
      title: titre,
    })
  } else {
    console.error('Un de --spec ou --cas est requis.')
    return 1
  }

  const result = await buildBoard(spec, { out, maxMo, displayWidth })
  console.log(
    `Planche écrite : ${result.path} (${(result.bytes / (1024 * 1024)).toFixed(2)} Mo, ${result.cards} carte(s)).`,
  )
  return 0
}

// Guard nécessaire pour l'import du module dans les tests (`deriveDefaultTitle`) :
// sans lui, `main()` s'exécute et appelle `process.exit` au chargement.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().then(quit, (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e))
    quit(1)
  })
}
