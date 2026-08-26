import { describe, expect, it } from 'vitest'
import { formatCopyOut, parseCopyOut, type Answer } from '../../scripts/framing/board/verdicts'
import { buildCard, type Board, type BoardCard } from '../../scripts/framing/board/card'
import type { BoardSpec } from '../../scripts/framing/board/spec'
import type { ShotState } from '../../scripts/framing/board/share'

const SPEC: BoardSpec = {
  id: 'orientation-bimodale',
  title: 'Orientation bimodale',
  eyebrow: 'Cadrage',
  lede: 'lede',
  variants: [{ id: 'v1', label: 'Variante 1', kind: 'settings', settings: {} }],
  sections: [{ title: 'Section', cases: [] }],
  classifier: 'frontality-bimodal@0.6',
  settled: [['Le tronc', 'suit la pose']],
}

function board(cards: Board['cards'], commit = 'abc123'): Board {
  return { spec: SPEC, cards, commit, generatedAt: '2026-08-26' }
}

function card(key: string, projectId = 'cqlp', shot = { start: 0, end: 10 }, instant = 5): BoardCard {
  const state: ShotState = {
    state: { id: 'de-face', label: 'de face' },
    share: { count: 5, total: 10, fraction: 0.5 },
    instant,
    run: { start: 4, end: 6, share: { count: 2, total: 10, fraction: 0.2 } },
  }
  const built = buildCard({
    caseId: `${projectId}-${shot.start}`,
    projectId,
    shot,
    state,
    instant,
    images: [
      {
        variantId: 'v1',
        variantLabel: 'Variante 1',
        dataUri: 'data:image/png;base64,AAAA',
        alt: 'alt',
        decision: { ratio: '1:1', split: false, cropX: 0.5, canvas: 'vertical' },
      },
    ],
    stake: 'stake',
  })
  return { ...built, key }
}

describe('aller-retour parseCopyOut ∘ formatCopyOut', () => {
  it('retrouve la planche, le commit et les réponses', () => {
    const cards = [card('k1'), card('k2', 'cqlp', { start: 20, end: 30 }, 25)]
    const b = board(cards)
    const answers: Answer[] = [
      { key: 'k1', call: 'keep', note: 'un vrai profil' },
      { key: 'k2', call: 'unsure', note: '' },
    ]
    const text = formatCopyOut({ board: b, answers, remarks: 'RAS' })
    const parsed = parseCopyOut(text)
    expect(parsed.boardId).toBe(b.spec.id)
    expect(parsed.commit).toBe(b.commit)
    const byKey = new Map(parsed.answers.map((a) => [a.key, a]))
    expect(byKey.get('k1')?.call).toBe('keep')
    expect(byKey.get('k1')?.note).toBe('un vrai profil')
    expect(byKey.get('k2')?.call).toBe('unsure')
    expect(parsed.rejected).toEqual([])
  })
})

describe('tolérance aux séparateurs', () => {
  it('« — » et « -- » se parsent identiquement', () => {
    const cards = [card('k1')]
    const b = board(cards)
    const answers: Answer[] = [{ key: 'k1', call: 'drop', note: '' }]
    const text = formatCopyOut({ board: b, answers, remarks: '' })
    const alt = text.replace(' — ', ' -- ')
    expect(parseCopyOut(text).answers).toEqual(parseCopyOut(alt).answers)
  })

  it('« → » et « -> » se parsent identiquement', () => {
    const cards = [card('k1')]
    const b = board(cards)
    const answers: Answer[] = [{ key: 'k1', call: 'keep', note: '' }]
    const text = formatCopyOut({ board: b, answers, remarks: '' })
    const alt = text.replace('  → garder', '  -> garder')
    expect(parseCopyOut(text).answers).toEqual(parseCopyOut(alt).answers)
  })
})

describe('verdict inconnu', () => {
  it('est refusé, pas rangé en `null`', () => {
    const cards = [card('k1')]
    const b = board(cards)
    const text = formatCopyOut({ board: b, answers: [], remarks: '' }).replace('sans réponse', 'peut-etre')
    const parsed = parseCopyOut(text)
    expect(parsed.answers.find((a) => a.key === 'k1')).toBeUndefined()
    expect(parsed.rejected.length).toBeGreaterThan(0)
    expect(parsed.rejected[0].why).toContain('peut-etre')
  })
})

describe('sans réponse / je ne sais pas', () => {
  it('sont deux issues distinctes', () => {
    const cards = [card('k1'), card('k2', 'cqlp', { start: 20, end: 30 }, 25)]
    const b = board(cards)
    const answers: Answer[] = [{ key: 'k2', call: 'unsure', note: '' }]
    const text = formatCopyOut({ board: b, answers, remarks: '' })
    const parsed = parseCopyOut(text)
    const byKey = new Map(parsed.answers.map((a) => [a.key, a]))
    expect(byKey.get('k1')?.call).toBeNull()
    expect(byKey.get('k2')?.call).toBe('unsure')
  })
})

describe('note', () => {
  it('une note multi-lignes survit', () => {
    const cards = [card('k1')]
    const b = board(cards)
    const answers: Answer[] = [{ key: 'k1', call: 'keep', note: 'ligne un\nligne deux\nligne trois' }]
    const text = formatCopyOut({ board: b, answers, remarks: '' })
    const parsed = parseCopyOut(text)
    expect(parsed.answers[0].note).toBe('ligne un\nligne deux\nligne trois')
  })

  it('une note contenant un tiret cadratin survit', () => {
    const cards = [card('k1')]
    const b = board(cards)
    const answers: Answer[] = [{ key: 'k1', call: 'keep', note: 'profil franc — presque un dos' }]
    const text = formatCopyOut({ board: b, answers, remarks: '' })
    const parsed = parseCopyOut(text)
    expect(parsed.answers[0].note).toBe('profil franc — presque un dos')
  })
})

describe('provenance du commit', () => {
  it("une réponse posée sous un autre commit est marquée « (sous ...) »", () => {
    const cards = [card('k1')]
    const b = board(cards, 'newsha')
    const answers: Answer[] = [{ key: 'k1', call: 'keep', note: '', commit: 'oldsha' }]
    const text = formatCopyOut({ board: b, answers, remarks: '' })
    expect(text).toContain('(sous oldsha)')
    const parsed = parseCopyOut(text)
    expect(parsed.answers[0].commit).toBe('oldsha')
  })
})
