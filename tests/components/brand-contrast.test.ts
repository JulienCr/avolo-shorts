/**
 * Vérifie le contraste WCAG des paires token/foreground de `globals.css` sans
 * navigateur ni framework CSS : on relit les valeurs `oklch(...)` du fichier
 * source et on les convertit soi-même en sRGB (~30 lignes, aucune dépendance
 * neuve). Placé sous `tests/components/` plutôt que `tests/core/` parce que ce
 * qu'il pin est un contrat d'interface — la palette de l'UI — même si le calcul
 * lui-même est pur.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const css = readFileSync(
  path.resolve(import.meta.dirname, '../../src/app/globals.css'),
  'utf-8',
)

function oklchToSrgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l - 0.0894841775 * a - 1.291485548 * b
  const [ll, mm, ss] = [l_ ** 3, m_ ** 3, s_ ** 3]
  const rl = 4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss
  const gl = -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss
  const bl = -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss
  const toSrgb = (x: number) => {
    const v = Math.min(1, Math.max(0, x))
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
  }
  return [toSrgb(rl), toSrgb(gl), toSrgb(bl)]
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

function extractBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`bloc ${selector} introuvable dans globals.css`)
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

function tokenOklch(block: string, name: string): [number, number, number] {
  const re = new RegExp(`--${name}:\\s*oklch\\(([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\)`)
  const match = block.match(re)
  if (!match) throw new Error(`jeton --${name} introuvable dans le bloc`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

const pairs = ['brand-blue', 'stage', 'success', 'warning', 'destructive']

describe.each(['root', 'dark'] as const)('contraste des jetons de marque (%s)', (theme) => {
  const block = extractBlock(theme === 'root' ? ':root' : '.dark')

  it.each(pairs)('%s vs %s-foreground >= 4.5:1', (name) => {
    const fg = oklchToSrgb(...tokenOklch(block, `${name}-foreground`))
    const bg = oklchToSrgb(...tokenOklch(block, name))
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5)
  })
})

/**
 * Les enfants de la barre (`StripProgress`, l'état d'enregistrement,
 * « Réessayer ») lisent `--muted-foreground` et `--destructive` sans savoir
 * qu'ils rendent sur `--brand-blue`. `.bg-brand-blue` les redéfinit
 * localement (globals.css) ; ce test pin ce contrat plutôt que de laisser la
 * régression Copilot/Codex (PR #242) revenir en silence.
 */
describe('contraste des jetons de barre sur .bg-brand-blue', () => {
  const brandBlue = oklchToSrgb(...tokenOklch(extractBlock(':root'), 'brand-blue'))
  const scope = extractBlock('.bg-brand-blue')

  it.each(['muted-foreground', 'destructive', 'foreground'])('%s vs brand-blue >= 4.5:1', (name) => {
    const fg = oklchToSrgb(...tokenOklch(scope, name))
    expect(contrastRatio(fg, brandBlue)).toBeGreaterThanOrEqual(4.5)
  })

  it('border vs brand-blue >= 3:1 (contraste non textuel, WCAG 1.4.11)', () => {
    const border = oklchToSrgb(...tokenOklch(scope, 'border'))
    expect(contrastRatio(border, brandBlue)).toBeGreaterThanOrEqual(3)
  })
})
