import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildUiBoard, pairShots, parseShotFilename, renderUiBoardPage, type RenderedShotPair } from '../../scripts/ui/board'

describe('parseShotFilename', () => {
  it('lit écran, étiquette et viewport depuis le nom de fichier', () => {
    expect(parseShotFilename('clip-before-2560x1320.png')).toEqual({
      screen: 'clip',
      label: 'before',
      width: 2560,
      height: 1320,
    })
  })

  it('rend null hors du format', () => {
    expect(parseShotFilename('clip-before.png')).toBeNull()
    expect(parseShotFilename('clip-sideways-1920x1080.png')).toBeNull()
    expect(parseShotFilename('notes.txt')).toBeNull()
  })
})

describe('pairShots', () => {
  it('associe avant/après par écran et viewport', () => {
    const { pairs, unmatched } = pairShots(
      ['clip-before-2560x1320.png', 'clip-before-1024x640.png'],
      ['clip-after-2560x1320.png', 'clip-after-1024x640.png'],
    )
    expect(pairs).toHaveLength(2)
    expect(unmatched).toHaveLength(0)
  })

  it('signale un fichier sans vis-à-vis plutôt que de le taire', () => {
    const { pairs, unmatched } = pairShots(['clip-before-2560x1320.png'], ['clip-after-1024x640.png'])
    expect(pairs).toHaveLength(0)
    expect(unmatched.sort()).toEqual(['clip-after-1024x640.png', 'clip-before-2560x1320.png'])
  })
})

describe('renderUiBoardPage', () => {
  const pair: RenderedShotPair = {
    screen: 'clip',
    width: 1920,
    height: 1080,
    beforeFile: 'clip-before-1920x1080.png',
    afterFile: 'clip-after-1920x1080.png',
    beforeDataUri: 'data:image/png;base64,AAAA',
    afterDataUri: 'data:image/png;base64,BBBB',
  }

  it('refuse une planche sans paire', () => {
    expect(() => renderUiBoardPage({ title: 't', pairs: [], commit: 'abc', generatedAt: 'x' })).toThrow(/aucune paire/)
  })

  it('échappe un titre qui porte du HTML', () => {
    const html = renderUiBoardPage({
      title: '<script>alert(1)</script>',
      pairs: [pair],
      commit: 'abc',
      generatedAt: 'x',
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('échappe un écran qui porte des guillemets, sans casser les attributs', () => {
    const html = renderUiBoardPage({
      title: 't',
      pairs: [{ ...pair, screen: 'clip" onmouseover="evil()' }],
      commit: 'abc',
      generatedAt: 'x',
    })
    expect(html).not.toContain('onmouseover="evil()"')
    expect(html).toContain('&quot;')
  })

  it('pose les deux images en data URI, avant puis après', () => {
    const html = renderUiBoardPage({ title: 't', pairs: [pair], commit: 'abc', generatedAt: 'x' })
    const beforeIndex = html.indexOf(pair.beforeDataUri)
    const afterIndex = html.indexOf(pair.afterDataUri)
    expect(beforeIndex).toBeGreaterThan(-1)
    expect(afterIndex).toBeGreaterThan(beforeIndex)
  })
})

describe('buildUiBoard', () => {
  it('écrit une planche depuis deux dossiers de captures', () => {
    const beforeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shot-test-before-'))
    const afterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shot-test-after-'))
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shot-test-out-'))
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47])

    fs.writeFileSync(path.join(beforeDir, 'clip-before-1920x1080.png'), fakePng)
    fs.writeFileSync(path.join(afterDir, 'clip-after-1920x1080.png'), fakePng)

    const out = path.join(outDir, 'board.html')
    const result = buildUiBoard({ beforeDir, afterDir, out, commit: 'deadbee' })

    expect(result.pairs).toBe(1)
    expect(result.unmatched).toHaveLength(0)
    expect(fs.existsSync(out)).toBe(true)
    const html = fs.readFileSync(out, 'utf8')
    expect(html).toContain('data:image/png;base64,')

    fs.rmSync(beforeDir, { recursive: true, force: true })
    fs.rmSync(afterDir, { recursive: true, force: true })
    fs.rmSync(outDir, { recursive: true, force: true })
  })

  it('refuse quand aucune paire ne se forme', () => {
    const beforeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shot-test-before-'))
    const afterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shot-test-after-'))
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shot-test-out-'))

    expect(() => buildUiBoard({ beforeDir, afterDir, out: path.join(outDir, 'board.html'), commit: 'deadbee' })).toThrow(
      /aucune paire/,
    )

    fs.rmSync(beforeDir, { recursive: true, force: true })
    fs.rmSync(afterDir, { recursive: true, force: true })
    fs.rmSync(outDir, { recursive: true, force: true })
  })
})
