/**
 * L'aperçu DOM des sous-titres pose-t-il la même géométrie que libass ?
 *
 *     pnpm tsx scripts/measure-caption-geometry.ts
 *
 * Mesure au pixel — cadratin, interligne, extents, distance bas d'encre →
 * bas du cadre — et compare à la fraction que `CaptionOverlay` pose. Sort
 * non-zéro si un écart dépasse 2 px sur 1920. Isole un mot AU REPOS
 * (`columnClusters`) : le mot actif grossit de 108 % dès 110 ms.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas'

import {
  captionUnits,
  DEFAULT_CAPTION_STYLE,
  MARGIN_SIDE,
  PLAYRES_X,
  PLAYRES_Y,
  renderAss,
} from '@/core/captions/ass'
import { ASS_FONTSIZE_TO_EM, ANTON_UNITS_PER_EM } from '@/core/captions/font-metrics'
import type { Word } from '@/core/transcript'
import { createCaptionMeasure } from '@/server/caption-measure'
import { ffmpegBin } from '@/server/ffmpeg'

/**
 * `|OS/2.sTypoDescender|` d'Anton, en unités de cadratin — voir
 * `tests/server/font-metrics.test.ts`, qui relit la table et le confirme.
 * Sert à convertir la marge ASS (mesurée jusqu'au bas de la boîte
 * `usWin`) en distance jusqu'au bas d'encre réel d'un mot sans
 * descendante — la seule grandeur que ce script puisse observer.
 */
const ANTON_TYPO_DESCENT_UNITS = 674

const CANVAS = { w: 1080, h: 1920 }
const FPS = 30
const FONTS_DIR = path.join(process.cwd(), 'fonts')
const TOLERANCE_PX = 2
/** Luminance au-dessus de laquelle un pixel compte comme de l'encre — même seuil que `measure-caption-wrap-stability.ts`. */
const LUMA_THRESHOLD = 60

function word(text: string, start: number, end: number): Word {
  return { word: text, start, end }
}

/**
 * Deux occurrences du même mot, sur une ligne : la première reste au repos
 * pendant que la seconde est active (`event 1`, voir la doc de tête). Sert
 * au cadratin et à la distance bas d'encre → bas du cadre.
 */
function restingWordCard(): Word[] {
  return [word('putain', 0, 0.3), word('putain', 0.3, 1.8)]
}
const RESTING_SAMPLE_SEC = 1.0 // dans la fenêtre du second événement (0,3 → 1,8)

/**
 * Neuf répétitions d'un mot court, forcé sur trois lignes égales (3+3+3),
 * échantillonné avec le mot actif sur la ligne 3 : les lignes 1 et 2, seules
 * mesurées, restent alors toutes les deux au repos dans la MÊME image.
 *
 * **Deux lignes ne suffisent pas** — vérifié : le mot actif y est forcément
 * sur l'une des deux comparées, et deux images séparées (une par ligne
 * active) mesurent 129 px d'interligne, 9 px de trop face au contenu identique
 * sans aucun mot actif (120 px, la valeur réelle).
 */
function threeLineCard(): Word[] {
  const repeats = 9
  const words: Word[] = []
  for (let i = 0; i < repeats; i++) words.push(word('bonjour', i * 0.3, i * 0.3 + 0.28))
  words[words.length - 1] = { ...words[words.length - 1], end: words[words.length - 1].end + 1.5 }
  return words
}
const THREE_LINE_CLEAN_SAMPLE_SEC = 2.25 // mot actif sur la ligne 3 (mot d'indice 7) : lignes 1 et 2 au repos

type Frame = { data: Uint8ClampedArray; width: number; height: number }
type Extent = { top: number; bottom: number; left: number; right: number }

async function loadFrame(pngPath: string): Promise<Frame> {
  const image = await loadImage(pngPath)
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const { data, width, height } = ctx.getImageData(0, 0, image.width, image.height)
  return { data, width, height }
}

function luma(frame: Frame, x: number, y: number): number {
  const i = (y * frame.width + x) * 4
  return 0.299 * frame.data[i] + 0.587 * frame.data[i + 1] + 0.114 * frame.data[i + 2]
}

/** Les bandes horizontales d'encre — une par ligne visible, tolérant jusqu'à deux lignes de pixels inactives (comme `measure-caption-wrap-stability.ts`). */
function rowBands(frame: Frame): [number, number][] {
  const rowHasInk = (y: number): boolean => {
    for (let x = 0; x < frame.width; x++) if (luma(frame, x, y) > LUMA_THRESHOLD) return true
    return false
  }
  const bands: [number, number][] = []
  let top = -1
  let gap = 0
  for (let y = 0; y < frame.height; y++) {
    if (rowHasInk(y)) {
      if (top === -1) top = y
      gap = 0
    } else if (top !== -1) {
      gap++
      if (gap > 2) {
        bands.push([top, y - gap])
        top = -1
      }
    }
  }
  if (top !== -1) bands.push([top, frame.height - 1])
  return bands
}

/** Les clusters horizontaux d'encre d'une bande — un par mot, séparés par l'espace entre eux. */
function columnClusters(frame: Frame, yRange: [number, number]): [number, number][] {
  const colHasInk = (x: number): boolean => {
    for (let y = yRange[0]; y <= yRange[1]; y++) if (luma(frame, x, y) > LUMA_THRESHOLD) return true
    return false
  }
  const clusters: [number, number][] = []
  let left = -1
  let gap = 0
  for (let x = 0; x < frame.width; x++) {
    if (colHasInk(x)) {
      if (left === -1) left = x
      gap = 0
    } else if (left !== -1) {
      gap++
      if (gap > 4) {
        clusters.push([left, x - gap])
        left = -1
      }
    }
  }
  if (left !== -1) clusters.push([left, frame.width - 1])
  return clusters
}

/** Les extents d'encre dans une sous-fenêtre — isole un mot d'un autre sur la même ligne. */
function inkExtent(frame: Frame, xRange: [number, number], yRange: [number, number]): Extent {
  let top = Infinity
  let bottom = -1
  let left = Infinity
  let right = -1
  for (let y = yRange[0]; y <= yRange[1]; y++) {
    for (let x = xRange[0]; x <= xRange[1]; x++) {
      if (luma(frame, x, y) > LUMA_THRESHOLD) {
        if (y < top) top = y
        if (y > bottom) bottom = y
        if (x < left) left = x
        if (x > right) right = x
      }
    }
  }
  return { top, bottom, left, right }
}

function burn(ass: string, durationSec: number, sampleSec: number, outFile: string): void {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  const assPath = `${outFile}.ass`
  fs.writeFileSync(assPath, ass)
  execFileSync(
    ffmpegBin(),
    [
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=black:s=${CANVAS.w}x${CANVAS.h}:d=${durationSec}:r=${FPS}`,
      '-frames:v', '1',
      '-ss', String(sampleSec),
      '-vf', `ass=filename='${assPath}':fontsdir='${FONTS_DIR}'`,
      outFile,
    ],
    { stdio: 'pipe' },
  )
}

type Check = { label: string; predictedPx: number; measuredPx: number; ok: (diff: number) => boolean }

function equalCheck(label: string, predictedPx: number, measuredPx: number): Check {
  return { label, predictedPx, measuredPx, ok: (diff) => diff <= TOLERANCE_PX }
}

/**
 * Une borne, pas une égalité : la marge anti-débordement (`activeWordMargin`,
 * `captionLines`) rend le retour à la ligne conservateur, donc une ligne
 * réelle n'atteint pas forcément la colonne visée — elle ne doit jamais la
 * dépasser. `atLeast` : le bord gauche ne doit jamais être plus à gauche que
 * prédit ; sinon (bord droit), il ne doit jamais être plus à droite.
 */
function withinBoundCheck(label: string, predictedPx: number, measuredPx: number, atLeast: boolean): Check {
  return {
    label,
    predictedPx,
    measuredPx,
    ok: () => (atLeast ? measuredPx >= predictedPx - TOLERANCE_PX : measuredPx <= predictedPx + TOLERANCE_PX),
  }
}

function report(checks: Check[]): boolean {
  let ok = true
  console.log('grandeur'.padEnd(46), 'prédit'.padStart(10), 'mesuré'.padStart(10), 'écart'.padStart(8))
  for (const c of checks) {
    const diff = Math.abs(c.predictedPx - c.measuredPx)
    const pass = c.ok(diff)
    if (!pass) ok = false
    console.log(
      c.label.padEnd(46),
      c.predictedPx.toFixed(1).padStart(10),
      c.measuredPx.toFixed(1).padStart(10),
      `${diff.toFixed(1)}${pass ? '' : ' ❌'}`.padStart(8),
    )
  }
  return ok
}

/**
 * La hauteur d'encre attendue d'un mot au repos, par la même mesure réelle
 * que `createCaptionMeasure` (`@napi-rs/canvas`, la police du dépôt) plutôt
 * que par un ratio cadratin→cap-height qu'aucune table de police ne publie.
 * Valide ainsi que libass et `@napi-rs/canvas` s'accordent sur la forme
 * réelle des glyphes, pas seulement sur une fraction abstraite.
 */
function predictedInkHeightPx(fontSizeFractionOfH: number): number {
  const ctx = createCanvas(1, 1).getContext('2d')
  ctx.font = `bold ${Math.round(fontSizeFractionOfH * CANVAS.h)}px ${DEFAULT_CAPTION_STYLE.fontName}`
  const m = ctx.measureText('PUTAIN')
  return m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
}

async function run(scratch: string): Promise<void> {
  GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'Anton-Regular.ttf'), DEFAULT_CAPTION_STYLE.fontName)
  const { sizeUnits, marginUnits } = captionUnits(DEFAULT_CAPTION_STYLE)
  const measure = createCaptionMeasure(FONTS_DIR, DEFAULT_CAPTION_STYLE.fontName, sizeUnits)

  // Ce que `CaptionOverlay` pose, en fractions de H (ou de W pour la colonne) — voir sa doc.
  const fontSizeFraction = ASS_FONTSIZE_TO_EM * (sizeUnits / PLAYRES_Y)
  const lineHeightFraction = sizeUnits / PLAYRES_Y
  // Le correctif de demi-interligne de `CaptionOverlay` s'annule ici : il ne
  // sert qu'à poser sa boîte CSS, pas à prédire l'encre jusqu'au bas de la
  // boîte `usWin` d'ASS, décalé du vrai descendant typographique (`ANTON_TYPO_DESCENT_UNITS`).
  const inkBottomFraction = marginUnits / PLAYRES_Y + (ANTON_TYPO_DESCENT_UNITS / ANTON_UNITS_PER_EM) * fontSizeFraction
  const pxPerPlayresXUnit = CANVAS.w / PLAYRES_X

  const checks: Check[] = []

  // --- Cadratin et distance bas d'encre → bas du cadre --------------------
  const restingFile = path.join(scratch, 'resting.png')
  burn(renderAss([restingWordCard()], DEFAULT_CAPTION_STYLE, measure), 2, RESTING_SAMPLE_SEC, restingFile)
  const restingFrame = await loadFrame(restingFile)
  const restingRows = rowBands(restingFrame)
  if (restingRows.length !== 1) {
    console.error(`attendu une seule bande pour "putain putain", obtenu ${restingRows.length}`)
    process.exitCode = 1
    return
  }
  const restingClusters = columnClusters(restingFrame, restingRows[0])
  if (restingClusters.length !== 2) {
    console.error(`attendu deux mots pour "putain putain", obtenu ${restingClusters.length} cluster(s)`)
    process.exitCode = 1
    return
  }
  // Le premier mot (le plus à gauche) est celui resté au repos — voir la doc de tête.
  const resting = inkExtent(restingFrame, restingClusters[0], restingRows[0])
  checks.push(equalCheck('cadratin réel (hauteur d’encre, mot au repos)', predictedInkHeightPx(fontSizeFraction), resting.bottom - resting.top + 1))
  checks.push(equalCheck('distance bas d’encre → bas du cadre', inkBottomFraction * CANVAS.h, CANVAS.h - 1 - resting.bottom))

  // --- Interligne et extents gauche/droite ---------------------------------
  const threeLineAss = renderAss([threeLineCard()], DEFAULT_CAPTION_STYLE, measure)
  const duration = threeLineCard().at(-1)!.end + 0.5

  const cleanFile = path.join(scratch, 'three-lines.png')
  burn(threeLineAss, duration, THREE_LINE_CLEAN_SAMPLE_SEC, cleanFile)
  const cleanFrame = await loadFrame(cleanFile)
  const cleanRows = rowBands(cleanFrame)
  if (cleanRows.length !== 3) {
    console.error(`attendu trois lignes, obtenu ${cleanRows.length}`)
    process.exitCode = 1
    return
  }
  const [line1Top] = cleanRows[0]
  const [line2Top] = cleanRows[1]
  const line1Extent = inkExtent(cleanFrame, [0, cleanFrame.width - 1], cleanRows[0])

  checks.push(equalCheck('interligne (haut de ligne → haut de ligne)', lineHeightFraction * CANVAS.h, line2Top - line1Top))
  checks.push(withinBoundCheck('extent gauche ≥ colonne utile (ne déborde pas)', MARGIN_SIDE * pxPerPlayresXUnit, line1Extent.left, true))
  checks.push(withinBoundCheck('extent droit ≤ colonne utile (ne déborde pas)', (PLAYRES_X - MARGIN_SIDE) * pxPerPlayresXUnit, line1Extent.right, false))

  const ok = report(checks)
  console.log(`\n${ok ? 'OK' : 'ÉCART DÉTECTÉ'} — tolérance ${TOLERANCE_PX} px sur ${CANVAS.h}.`)
  if (!ok) process.exitCode = 1
}

async function main(): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-geometry-'))
  try {
    await run(scratch)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
