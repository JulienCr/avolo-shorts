import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

import {
  ANTON_TYPO_HEIGHT,
  ANTON_UNITS_PER_EM,
  ANTON_WIN_HEIGHT,
  ASS_FONTSIZE_TO_EM,
  CSS_HALF_LEADING_OVER_EM,
} from '@/core/captions/font-metrics'

/**
 * Le garde-fou le plus rentable du lot : si `fonts/Anton-Regular.ttf` change,
 * ce test échoue avant que l'aperçu ne se redimensionne de 20 % en silence.
 *
 * Un lecteur `sfnt` minimal, local à ce fichier — `src/core` ne lit aucun
 * fichier, et aucune dépendance de parsing de police n'est installée ici.
 * Ne lit que `head.unitsPerEm` et les quatre champs d'`OS/2` dont
 * `font-metrics.ts` dérive ses constantes.
 */
function readFontMetrics(file: string): {
  unitsPerEm: number
  usWinAscent: number
  usWinDescent: number
  sTypoAscender: number
  sTypoDescender: number
  useTypoMetrics: boolean
} {
  const buf = fs.readFileSync(file)
  const numTables = buf.readUInt16BE(4)
  const offsets: Record<string, number> = {}
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16
    offsets[buf.toString('ascii', record, record + 4)] = buf.readUInt32BE(record + 8)
  }
  const head = offsets['head']
  const os2 = offsets['OS/2']
  if (head === undefined || os2 === undefined) throw new Error('table head ou OS/2 absente')
  const fsSelection = buf.readUInt16BE(os2 + 62)
  return {
    unitsPerEm: buf.readUInt16BE(head + 18),
    usWinAscent: buf.readUInt16BE(os2 + 74),
    usWinDescent: buf.readUInt16BE(os2 + 76),
    sTypoAscender: buf.readInt16BE(os2 + 68),
    sTypoDescender: buf.readInt16BE(os2 + 70),
    useTypoMetrics: (fsSelection & 0x80) !== 0,
  }
}

describe('les métriques d’Anton (fonts/Anton-Regular.ttf)', () => {
  const metrics = readFontMetrics(path.join(process.cwd(), 'fonts', 'Anton-Regular.ttf'))

  it('USE_TYPO_METRICS est posé — condition de validité de CSS_HALF_LEADING_OVER_EM', () => {
    expect(metrics.useTypoMetrics).toBe(true)
  })

  it('ANTON_UNITS_PER_EM suit head.unitsPerEm', () => {
    expect(ANTON_UNITS_PER_EM).toBe(metrics.unitsPerEm)
  })

  it('ANTON_WIN_HEIGHT suit usWinAscent + usWinDescent', () => {
    expect(ANTON_WIN_HEIGHT).toBe(metrics.usWinAscent + metrics.usWinDescent)
  })

  it('ANTON_TYPO_HEIGHT suit sTypoAscender − sTypoDescender', () => {
    expect(ANTON_TYPO_HEIGHT).toBe(metrics.sTypoAscender - metrics.sTypoDescender)
  })

  it('ASS_FONTSIZE_TO_EM vaut exactement unitsPerEm / (usWinAscent + usWinDescent)', () => {
    expect(ASS_FONTSIZE_TO_EM).toBe(metrics.unitsPerEm / (metrics.usWinAscent + metrics.usWinDescent))
  })

  it('CSS_HALF_LEADING_OVER_EM suit (winHeight − typoHeight) / (2 × unitsPerEm)', () => {
    const winHeight = metrics.usWinAscent + metrics.usWinDescent
    const typoHeight = metrics.sTypoAscender - metrics.sTypoDescender
    expect(CSS_HALF_LEADING_OVER_EM).toBe((winHeight - typoHeight) / (2 * metrics.unitsPerEm))
  })
})
