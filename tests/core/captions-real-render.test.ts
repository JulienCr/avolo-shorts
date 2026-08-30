import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

import { renderAss, DEFAULT_CAPTION_STYLE } from '@/core/captions/ass'
import type { Word } from '@/core/transcript'
import { createCaptionMeasure } from '@/server/caption-measure'

/**
 * Non-régression sur un rendu réel (`projects/` est gitignoré, absent d'un
 * worktree qui ne l'a pas symlinké). Les deux premiers cartons du `.ass`
 * réel sont reconstruits en `Word[]` — un mot par `Dialogue`, borné par son
 * `Start` et celui du suivant — puis rejoués par `renderAss` en production.
 * Le second carton exerce le retour à la ligne, le premier ne l'exerce pas.
 */
const FONTS_DIR = path.join(process.cwd(), 'fonts')
const REAL_ASS = path.join(
  process.cwd(),
  'projects/2026-22-02-entre-nous/renders/2026-22-02-entre-nous_001495095-001538044.ass',
)

function words(specs: [string, number, number][]): Word[] {
  return specs.map(([word, start, end]) => ({ word, start, end }))
}

describe('renderAss reproduit un rendu réel, mot pour mot', () => {
  if (!fs.existsSync(REAL_ASS)) {
    it.skip('fichier de rendu réel absent de ce worktree (projects/ est gitignoré)', () => {})
    return
  }

  const realLines = fs.readFileSync(REAL_ASS, 'utf8').replace(/^﻿/, '').split('\n')
  const realDialogues = realLines.filter((l) => l.startsWith('Dialogue:')).slice(0, 10)

  const card1 = words([
    ['REBOOTY', 0.08, 1.64],
    ['MATILDUS', 1.64, 2.52],
  ])
  const card2 = words([
    ['MEOR', 2.56, 3.22],
    ['ET', 3.22, 3.3],
    ['LÀ,', 3.3, 3.46],
    ['ON', 3.46, 3.52],
    ['ÉTAIT', 3.52, 3.64],
    ['EN', 3.64, 3.72],
    ['MODE,', 3.72, 4.04],
    ['PUTAIN', 4.04, 4.78],
  ])

  it('les dix événements reconstruits sont byte-identiques au fichier réel', () => {
    const measure = createCaptionMeasure(FONTS_DIR, DEFAULT_CAPTION_STYLE.fontName, 18)
    const ass = renderAss([card1, card2], DEFAULT_CAPTION_STYLE, measure)
    const rendered = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(rendered).toEqual(realDialogues)
  })
})
