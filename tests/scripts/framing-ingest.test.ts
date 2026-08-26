import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  extractHeaders,
  findLabelNullLine,
  hasAnyReport,
  hasBlockingIssues,
  ingestBlock,
  parseCardKey,
  parseProvenanceDate,
  renderIngestReport,
} from '../../scripts/framing/ingest'
import { FRAMING_CASES, type FramingCase } from '../../scripts/framing/cases'
import { parseCopyOut } from '../../scripts/framing/board/verdicts'

const FIXTURE = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'framing-verdicts-reel.txt'),
  'utf8',
)

/**
 * La planche réelle (issue #191, lot 3) : cinq cartes cochées à la main sur
 * une vraie planche. Le fichier n'est jamais modifié ici — c'est la garantie
 * que le parseur lit ce que la page émet vraiment, sans concession.
 */
describe('ingestBlock sur la planche réelle', () => {
  it('lit les cinq entrées, aucune rejetée', () => {
    const result = ingestBlock(FIXTURE, { by: 'JulienCr' })
    expect(result.outcomes.filter((o) => o.kind === 'rejected')).toEqual([])
    expect(result.outcomes).toHaveLength(5)
  })

  it("la note multi-lignes d'entre-nous survit entière", () => {
    const result = ingestBlock(FIXTURE, { by: 'JulienCr' })
    const change = result.outcomes.find(
      (o) => o.kind === 'confirmed' && o.case.id === 'entre-nous-3495867',
    )
    expect(change).toBeDefined()
    const parsed = parseCopyOut(FIXTURE)
    const answer = parsed.answers.find((a) => a.key === '2026-22-02-entre-nous@3495867#unique@3501500')
    expect(answer?.note).toBe(
      'Baba est trop bord cadre, le zoom est moche.\nOn pourrait meme faire un 9:16 sur Mathilde uniquement',
    )
  })

  it('chaque entrée se rattache au bon cas par projet + début de plan', () => {
    const result = ingestBlock(FIXTURE, { by: 'JulienCr' })
    const ids = result.outcomes
      .filter((o): o is Extract<typeof o, { case: FramingCase }> => 'case' in o)
      .map((o) => o.case.id)
      .sort()
    expect(ids).toEqual(
      ['cqlp-1366033', 'entre-nous-3495867', 'fmr-1115733', 'nabla-2077400', 'nabla-6418667'].sort(),
    )
  })

  it('nabla-2077400 est un changement de verdict, rien n’est émis sans --change', () => {
    const result = ingestBlock(FIXTURE, { by: 'JulienCr' })
    const change = result.outcomes.find((o) => o.kind === 'change')
    if (change?.kind !== 'change') throw new Error('attendu un changement')
    expect(change.case.id).toBe('nabla-2077400')
    expect(change.before).toBe('drop')
    expect(change.after).toBe('keep')

    const withoutFlag = renderIngestReport(result, { change: false }).join('\n')
    expect(withoutFlag).not.toContain('littéral à coller')
    expect(withoutFlag).toContain('bloqué')

    const withFlag = renderIngestReport(result, { change: true }).join('\n')
    expect(withFlag).toContain('littéral à coller')
    expect(withFlag).toContain(`call: "keep"`)

    expect(hasBlockingIssues(result.outcomes, false)).toBe(true)
    expect(hasBlockingIssues(result.outcomes, true)).toBe(false)
  })

  it('les quatre autres confirment le verdict existant — rien à appliquer', () => {
    const result = ingestBlock(FIXTURE, { by: 'JulienCr' })
    const confirmed = result.outcomes.filter((o) => o.kind === 'confirmed')
    expect(confirmed).toHaveLength(4)
    const ids = confirmed.map((o) => (o.kind === 'confirmed' ? o.case.id : '')).sort()
    expect(ids).toEqual(['cqlp-1366033', 'entre-nous-3495867', 'fmr-1115733', 'nabla-6418667'].sort())
  })

  it('sans --change, exit non nul ; entièrement confirmé + --change, exit 0', () => {
    const result = ingestBlock(FIXTURE, { by: 'JulienCr' })
    expect(hasBlockingIssues(result.outcomes, false)).toBe(true)
    expect(hasBlockingIssues(result.outcomes, true)).toBe(false)
  })
})

describe('cas synthétiques', () => {
  const NABLA_CASE = FRAMING_CASES.find((c) => c.id === 'nabla-2077400')
  if (NABLA_CASE === undefined) throw new Error('fixture de test invalide : nabla-2077400 introuvable')

  function block(cardLines: string, commitLine = 'Commit : abc1234 · 1 janvier 2026 à 08:00 · test'): string {
    return [`Planche : cas-test`, commitLine, '', 'Réglé', '  · rien', '', cardLines].join('\n')
  }

  it("une entrée dont l'intervalle contredit le registre est refusée, avec le nom du cas dans le message", () => {
    const text = block(
      [
        '2026-05-31-nabla@2077400#unique@2080500 — 2026-05-31-nabla 2077.4-9999 @2080.5',
        '  → garder',
      ].join('\n'),
    )
    const result = ingestBlock(text, { by: 'JulienCr' })
    expect(result.outcomes).toHaveLength(1)
    const [outcome] = result.outcomes
    if (outcome.kind !== 'mismatch') throw new Error('attendu un désaccord')
    expect(outcome.why).toContain('nabla-2077400')
  })

  it('une entrée dont le projet est inconnu est rapportée comme cas nouveau', () => {
    const text = block(
      [
        '2099-01-01-inconnu@1000#unique@1500 — 2099-01-01-inconnu 1-2 @1.5',
        '  → écarter',
      ].join('\n'),
    )
    const result = ingestBlock(text, { by: 'JulienCr' })
    expect(result.outcomes).toHaveLength(1)
    const [outcome] = result.outcomes
    if (outcome.kind !== 'new') throw new Error('attendu un cas nouveau')
    expect(outcome.show).toBeUndefined()
    expect(outcome.literal).toContain('2099-01-01-inconnu')
  })

  it('une carte au verdict hors énumération est rejetée, jamais rangée en "sans réponse"', () => {
    const text = block(
      [
        '2026-05-31-nabla@2077400#unique@2080500 — 2026-05-31-nabla 2077.4-2083.933 @2080.5',
        '  → oui',
      ].join('\n'),
    )
    const result = ingestBlock(text, { by: 'JulienCr' })
    expect(result.outcomes).toHaveLength(1)
    expect(result.outcomes[0].kind).toBe('rejected')
  })

  it('une carte sans réponse est "undecided", jamais rejetée ni appliquée', () => {
    const text = block(
      [
        '2026-05-31-nabla@2077400#unique@2080500 — 2026-05-31-nabla 2077.4-2083.933 @2080.5',
        '  → sans réponse',
      ].join('\n'),
    )
    const result = ingestBlock(text, { by: 'JulienCr' })
    expect(result.outcomes).toEqual([{ kind: 'undecided', key: '2026-05-31-nabla@2077400#unique@2080500' }])
    expect(hasBlockingIssues(result.outcomes, false)).toBe(false)
    expect(hasAnyReport(result.outcomes)).toBe(true)
  })

  it('un cas au label `null` produit un littéral à coller et localise sa ligne', () => {
    const unlabelled: FramingCase = {
      id: 'nabla-2077400-test',
      show: 'nabla',
      scope: { over: 'shot' },
      anchor: { at: 'shot', shot: { start: 100, end: 110 }, instants: [100] },
      probes: 'fixture de test',
      label: null,
      tags: [],
      origin: 'test',
      retired: null,
      baseline: null,
    }
    const text = block(
      ['2026-05-31-nabla@100000#unique@105000 — 2026-05-31-nabla 100-110 @105', '  → garder'].join('\n'),
    )
    const source = "  {\n    id: 'nabla-2077400-test',\n    label: null,\n  },\n"
    const result = ingestBlock(text, { by: 'JulienCr', casesSource: source, cases: [unlabelled] })
    expect(result.outcomes).toHaveLength(1)
    const [outcome] = result.outcomes
    if (outcome.kind !== 'fill') throw new Error('attendu un label à compléter')
    expect(outcome.line).toBe(3)
    expect(outcome.literal).toContain(`call: "keep"`)
  })
})

describe('parseCardKey', () => {
  it('décompose projet, début de plan, état et instant', () => {
    expect(parseCardKey('2026-05-31-nabla@2077400#unique@2080500')).toEqual({
      projectId: '2026-05-31-nabla',
      shotStartMs: 2077400,
      stateId: 'unique',
      instantMs: 2080500,
    })
  })

  it('rend `undefined` sur une clé qui ne suit pas la grammaire', () => {
    expect(parseCardKey('pas-une-cle')).toBeUndefined()
  })
})

describe('extractHeaders', () => {
  it("lit le projet et l'intervalle du texte lisible, absents de la clé", () => {
    const headers = extractHeaders(FIXTURE)
    const h = headers.get('2026-05-31-nabla@2077400#unique@2080500')
    expect(h).toEqual({
      key: '2026-05-31-nabla@2077400#unique@2080500',
      projectId: '2026-05-31-nabla',
      shotStart: 2077.4,
      shotEnd: 2083.933,
      instant: 2080.5,
    })
  })
})

describe('parseProvenanceDate', () => {
  it('convertit une date française en YYYY-MM-DD', () => {
    expect(parseProvenanceDate('ad4d957 (MODIFIÉ) · 26 août 2026 à 13:06 · encodeur nvenc')).toBe('2026-08-26')
  })

  it('rend `undefined` sans date reconnaissable', () => {
    expect(parseProvenanceDate('abc123')).toBeUndefined()
  })
})

describe('findLabelNullLine', () => {
  it('trouve la ligne `label: null,` du cas demandé', () => {
    const source = [
      '  {',
      "    id: 'a-1',",
      '    label: null,',
      '  },',
      '  {',
      "    id: 'b-2',",
      '    label: null,',
      '  },',
    ].join('\n')
    expect(findLabelNullLine(source, 'b-2')).toBe(7)
  })

  it("rend `undefined` si le cas n'a pas de `label: null`", () => {
    const source = "  {\n    id: 'a-1',\n    label: { call: 'keep' },\n  },\n"
    expect(findLabelNullLine(source, 'a-1')).toBeUndefined()
  })
})
