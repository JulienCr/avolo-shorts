// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderBoardPage } from '../../scripts/framing/board/page'
import { buildCard, type Board, type BoardCard } from '../../scripts/framing/board/card'
import type { BoardSpec } from '../../scripts/framing/board/spec'
import type { ShotState } from '../../scripts/framing/board/share'

/**
 * Mécanise la check-list de pré-publication de la skill `decision-sheet` —
 * la check-list existe pour qu'un humain la fasse avant de publier une page
 * écrite à la main ; ici un programme l'écrit, donc elle doit être un test.
 */

function makeState(id: string, label: string, instant: number): ShotState {
  return {
    state: { id, label },
    share: { count: 12, total: 20, fraction: 0.6 },
    instant,
    run: { start: instant - 2, end: instant + 2, share: { count: 8, total: 20, fraction: 0.4 } },
  }
}

function makeCard(
  key: string,
  opts: { stake?: string; alt?: string; variantLabel?: string; caseId?: string; shot?: { start: number; end: number } } = {},
): BoardCard {
  const built = buildCard({
    caseId: opts.caseId ?? 'default-case',
    projectId: '2025-06-15-cqlp',
    shot: opts.shot ?? { start: 2107, end: 2138 },
    state: makeState('de-face', 'de face', 2120),
    instant: 2120,
    images: [
      {
        variantId: 'v1',
        variantLabel: opts.variantLabel ?? 'Variante 1',
        dataUri: 'data:image/png;base64,AAAA',
        alt: opts.alt ?? 'alt v1',
        decision: { ratio: '1:1', split: false, cropX: 0.5, canvas: 'vertical' },
      },
      {
        variantId: 'v2',
        variantLabel: 'Variante 2',
        dataUri: 'data:image/png;base64,BBBB',
        alt: 'alt v2',
        decision: { ratio: '9:16', split: false, cropX: 0.4, canvas: 'vertical' },
      },
    ],
    stake: opts.stake ?? 'stake',
  })
  return { ...built, key }
}

const SPEC: BoardSpec = {
  id: 'orientation-bimodale',
  title: 'Orientation bimodale',
  eyebrow: 'Cadrage',
  lede: 'lede de la planche',
  callout: { title: 'Attention', body: 'lire avant de juger' },
  variants: [{ id: 'v1', label: 'Variante 1', kind: 'settings', settings: {} }],
  sections: [{ title: 'Cas', lede: 'section lede' }],
  classifier: 'frontality-bimodal@0.6',
  settled: [['Le tronc', 'suit la pose']],
}

function makeBoard(cards: BoardCard[]): Board {
  return { spec: SPEC, cards, commit: 'abc123', generatedAt: '2026-08-26' }
}

describe('renderBoardPage', () => {
  it('chaque <img> porte un alt non vide', () => {
    const html = renderBoardPage(makeBoard([makeCard('k1'), makeCard('k2')]))
    document.body.innerHTML = html
    const imgs = document.querySelectorAll('img')
    expect(imgs.length).toBeGreaterThan(0)
    imgs.forEach((img) => expect(img.getAttribute('alt')?.trim()).toBeTruthy())
  })

  it('chaque <figure> porte un <figcaption> qui contient la part', () => {
    const html = renderBoardPage(makeBoard([makeCard('k1')]))
    document.body.innerHTML = html
    const figures = document.querySelectorAll('figure')
    expect(figures.length).toBeGreaterThan(0)
    figures.forEach((fig) => {
      const caption = fig.querySelector('figcaption')
      expect(caption).not.toBeNull()
      expect(caption?.textContent).toMatch(/%/)
      expect(caption?.textContent).toMatch(/images/)
    })
  })

  it('le dénominateur du compteur égale le nombre de sections `.q`', () => {
    const cards = [makeCard('k1'), makeCard('k2'), makeCard('k3')]
    const html = renderBoardPage(makeBoard(cards))
    document.body.innerHTML = html
    const qCount = document.querySelectorAll('.q').length
    expect(qCount).toBe(cards.length)
    const prog = document.getElementById('prog')?.textContent ?? ''
    expect(prog).toContain(`/ ${cards.length}`)
  })

  it('chaque groupe de radios a un `name` unique, un seul groupe par carte', () => {
    const html = renderBoardPage(makeBoard([makeCard('k1'), makeCard('k2')]))
    document.body.innerHTML = html
    const names = new Set<string>()
    document.querySelectorAll('.q').forEach((section) => {
      const radioNames = new Set(
        Array.from(section.querySelectorAll('input[type="radio"]')).map((r) => r.getAttribute('name')),
      )
      expect(radioNames.size).toBe(1)
      const name = [...radioNames][0]
      expect(name).toBeTruthy()
      expect(names.has(name as string)).toBe(false)
      names.add(name as string)
    })
  })

  it('les `data-key` sont uniques', () => {
    const html = renderBoardPage(makeBoard([makeCard('k1'), makeCard('k2'), makeCard('k3')]))
    document.body.innerHTML = html
    const keys = Array.from(document.querySelectorAll('.q')).map((s) => s.getAttribute('data-key'))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('aucun littéral de couleur hors des trois blocs de jetons', () => {
    const html = renderBoardPage(makeBoard([makeCard('k1')]))
    const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(html)
    expect(styleMatch).not.toBeNull()
    const css = styleMatch![1]

    const rootBlock = /:root\{[\s\S]*?\n\}/.exec(css)?.[0] ?? ''
    const darkMediaBlock = /@media \(prefers-color-scheme: dark\)\{[\s\S]*?\n  \}\n\}/.exec(css)?.[0] ?? ''
    const dataThemeBlock = /:root\[data-theme="dark"\]\{[\s\S]*?\n\}/.exec(css)?.[0] ?? ''
    const tokenBlocks = rootBlock + darkMediaBlock + dataThemeBlock
    expect(tokenBlocks.length).toBeGreaterThan(0)

    const outsideTokens = css.replace(rootBlock, '').replace(darkMediaBlock, '').replace(dataThemeBlock, '')
    const colorLiteral = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g
    expect(outsideTokens.match(colorLiteral)).toBeNull()
  })

  it('les trois blocs de jetons définissent le même ensemble de jetons de couleur', () => {
    const html = renderBoardPage(makeBoard([makeCard('k1')]))
    const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(html)
    const css = styleMatch![1]
    const rootBlock = /:root\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    const darkMediaBlock = /@media \(prefers-color-scheme: dark\)\{\s*:root:not\(\[data-theme="light"\]\)\{([\s\S]*?)\n  \}/.exec(css)?.[1] ?? ''
    const dataThemeBlock = /:root\[data-theme="dark"\]\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''

    const tokensOf = (block: string) => {
      const matches = block.matchAll(/(--[a-z0-9-]+)\s*:/g)
      const names = [...matches].map((m) => m[1])
      // Les jetons de mise en page (`--measure`, `--wide`) ne vivent que dans
      // `:root` : ils ne varient pas par thème, contrairement aux couleurs.
      return new Set(names.filter((n) => n !== '--measure' && n !== '--wide'))
    }

    const rootTokens = tokensOf(rootBlock)
    const darkTokens = tokensOf(darkMediaBlock)
    const themeTokens = tokensOf(dataThemeBlock)
    expect(rootTokens.size).toBeGreaterThan(0)
    expect(darkTokens).toEqual(rootTokens)
    expect(themeTokens).toEqual(rootTokens)
  })

  it('aucun `{{` ne survit', () => {
    const html = renderBoardPage(makeBoard([makeCard('k1')]))
    expect(html).not.toContain('{{')
  })

  it('un libellé contenant `<`, `&` et `"` sort échappé', () => {
    const card = makeCard('k1', { stake: 'un <script> & "citation"' })
    const html = renderBoardPage(makeBoard([card]))
    expect(html).not.toContain('un <script> & "citation"')
    expect(html).toContain('un &lt;script&gt; &amp; &quot;citation&quot;')
  })
})

describe('renderBoardPage : regroupement par cas et par section — addendum lot 3', () => {
  it('deux cartes du même cas partagent un seul `stake`, pas un par carte', () => {
    const cards = [
      makeCard('k1', { caseId: 'caseA', stake: 'enjeu du cas A' }),
      makeCard('k2', { caseId: 'caseA', stake: 'enjeu du cas A' }),
    ]
    const html = renderBoardPage(makeBoard(cards))
    const occurrences = html.split('enjeu du cas A').length - 1
    expect(occurrences).toBe(1)
  })

  it('deux cas distincts affichent chacun leur `stake`', () => {
    const cards = [
      makeCard('k1', { caseId: 'caseA', stake: 'enjeu A' }),
      makeCard('k2', { caseId: 'caseB', stake: 'enjeu B' }),
    ]
    const html = renderBoardPage(makeBoard(cards))
    expect(html).toContain('enjeu A')
    expect(html).toContain('enjeu B')
  })

  it('une carte dont le cas figure dans une section se range sous cette section', () => {
    const specWithCase: BoardSpec = {
      ...SPEC,
      sections: [
        {
          title: 'Cas connus',
          cases: [{ id: 'caseA', projectId: '2025-06-15-cqlp', at: 2120, clipId: null, stake: 'enjeu A' }],
        },
      ],
    }
    const board: Board = { spec: specWithCase, cards: [makeCard('k1', { caseId: 'caseA' })], commit: 'abc123', generatedAt: '2026-08-26' }
    const html = renderBoardPage(board)
    document.body.innerHTML = html
    const section = Array.from(document.querySelectorAll('.board-section')).find((s) =>
      s.textContent?.includes('Cas connus'),
    )
    expect(section).toBeDefined()
    expect(section?.querySelector('.q')).not.toBeNull()
  })

  it("une carte dont le cas n'apparaît dans aucune section reste affichée, hors section", () => {
    const html = renderBoardPage(makeBoard([makeCard('k1', { caseId: 'inconnu-de-toutes-sections' })]))
    document.body.innerHTML = html
    expect(document.querySelectorAll('.q').length).toBe(1)
  })

  it('le compteur de progression continue de compter des cartes, pas des cas', () => {
    const cards = [
      makeCard('k1', { caseId: 'caseA' }),
      makeCard('k2', { caseId: 'caseA' }),
      makeCard('k3', { caseId: 'caseB' }),
    ]
    const html = renderBoardPage(makeBoard(cards))
    document.body.innerHTML = html
    const prog = document.getElementById('prog')?.textContent ?? ''
    expect(prog).toContain('/ 3')
    expect(document.querySelectorAll('.q').length).toBe(3)
  })
})
