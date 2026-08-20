/**
 * **Des planches-contact pour juger `orientationOf` à l'œil, sur cent
 * cinquante personnes tirées de tout le corpus.**
 *
 *     pnpm tsx scripts/spike/orientation-sheet.ts
 *     pnpm tsx scripts/spike/orientation-sheet.ts 2025-06-15-cqlp --sheets 6 --per-sheet 20
 *     pnpm tsx scripts/spike/orientation-sheet.ts --seed 2 --out /tmp/orientation-sheets
 *     pnpm tsx scripts/spike/orientation-sheet.ts --range 0.25,0.80 --out /tmp/orientation-sheets
 *     pnpm tsx scripts/spike/orientation-sheet.ts --missing-shoulder --out /tmp/orientation-sheets
 *
 * `orientationOf` (`src/core/framing.ts`) n'a été validée que sur quatre
 * personnes choisies à la main — trop peu pour lui faire confiance. Lire une
 * distribution de `frontality` ne suffit pas non plus : ce dépôt compte cinq
 * fois où une lecture d'image a renversé une conclusion chiffrée. Ce script
 * produit donc des images à regarder, pas un tableau à croire sur parole.
 *
 * **Le principe.** Toutes les boîtes gardées par le cadrage (score suffisant,
 * pas de premier plan) reçoivent leur `orientationOf`. Celles qui ont une
 * `frontality` sont triées et coupées en `--sheets` tranches d'effectif égal
 * — des quantiles, pas des intervalles de largeur fixe, parce que rien ne dit
 * que la distribution est équilibrée. Chaque tranche donne une planche : une
 * grille de vignettes de tête, triée par frontalité croissante. Si le score
 * sépare vraiment le profil du visage de face, la planche va d'un bout à
 * l'autre **sans inversion visible** ; s'il ne sépare rien, ça se voit en une
 * seconde. Une planche à part, toujours produite, montre les `unknown` : ce
 * que la fonction refuse de trancher doit se voir aussi — des dos tournés
 * disent qu'elle est honnête, des visages nets diraient qu'elle est cassée.
 *
 * **Deux planches uniques, sur demande, qui remplacent les strates.**
 * `--range <lo>,<hi>` restreint le tirage aux boîtes dont
 * `lo <= frontality <= hi` (jamais les `unknown`) — utile pour lire de près
 * où un seuil devrait tomber. `--missing-shoulder` restreint le tirage aux
 * boîtes dont `orientationOf(b).terms.shoulderRatio` vaut `null`, `unknown`
 * compris — le test direct d'une hypothèse : `earAsymmetry` et `eyeTerm`
 * mesurent tous deux la visibilité du visage et peuvent s'effondrer ensemble
 * pour une raison sans rapport avec l'orientation (cheveux, regard baissé),
 * et sans le terme des épaules pour les rattraper, seule la planche dit si
 * ces boîtes-là sont mal classées. Les deux options s'excluent entre elles et
 * sont refusées si elles arrivent combinées, plutôt que d'inventer un ordre
 * de priorité entre elles.
 *
 * **Le tirage est équilibré entre émissions** (voir `sampleBalanced`) et
 * **déterministe** (voir `makeRng`) : une planche redemandée avec le même
 * `--seed` après avoir changé un seuil montre le même tirage, donc compare
 * ce qui a changé et rien d'autre.
 *
 * **La vignette part de la tête** (`headBounds`), élargie généreusement pour
 * garder du contexte ; sur un `unknown`, `headBounds` ne rend rien, alors on
 * part du quart supérieur de la boîte de la personne. Le carré est ensuite
 * ramené dans les bornes de l'image et redimensionné à `--thumb` pixels de
 * côté — une planche a besoin de vignettes de taille uniforme pour se lire
 * d'un coup d'œil.
 *
 * **La sortie ne va jamais dans `projects/`** — un lien symbolique vers le
 * magasin partagé des worktrees — mais dans `--out`, ou un dossier temporaire
 * par défaut, comme `framing-thumbnails.ts`.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas'

import {
  FRAMING_DEFAULTS,
  ORIENTATION_DEFAULTS,
  headBounds,
  isForeground,
  orientationOf,
} from '@/core/framing'
import type { Orientation } from '@/core/framing'
import type { PersonBox } from '@/core/shots'
import { analysisPath, proxyPath } from '@/server/paths'
import { lireAnalysis } from '@/server/steps/analysis'
import { chargerEnv, createBar, finBar, quit } from '../dev-common'

/** Les quatre émissions du disque, faute d'argument. */
const DEFAULT_PROJECTS = [
  '2025-06-15-cqlp',
  '2026-03-08-caro-mdlm',
  '2026-05-31-nabla',
  '2026-22-02-entre-nous',
]

/** Le binaire de `setup.sh`, comme dans `framing-thumbnails.ts`. */
function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || 'ffmpeg'
}

// ---------------------------------------------------------------------------
// Un xorshift32 écrit à la main : déterministe, seedé par `--seed`. Dix lignes
// suffisent, et `Math.random()` rendrait deux exécutions incomparables — on
// doit pouvoir revenir sur la même planche après avoir changé un seuil.
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  // Un seed nul bloquerait un xorshift à zéro pour toujours : il se
  // reproduit lui-même sous XOR. `| 0` ramène le seed en entier 32 bits.
  let state = (seed | 0) || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

/** Fisher-Yates, en place, avec le générateur déterministe ci-dessus. */
function shuffleInPlace<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

/**
 * Tire `n` éléments dans `items`, équilibré entre les groupes que `groupOf`
 * distingue — ici les émissions.
 *
 * **Par tour de table, pas par tirage uniforme sur tout le lot.** Un tirage
 * uniforme laisserait l'émission la mieux représentée dominer la planche,
 * exactement ce que la consigne interdit. Le tour de table visite les
 * groupes dans un ordre mélangé et en prend un à chacun, sous un plafond à
 * 89 % de `n` — strictement sous 90 %.
 *
 * **Le plafond ne s'applique que s'il reste une alternative.** Avec un seul
 * groupe, ou si le respecter laisserait la planche incomplète faute d'autre
 * source, une seconde passe pioche dans ce qu'il reste sans plafond : mieux
 * vaut une planche déséquilibrée que trente vignettes réclamées et vingt-sept
 * servies.
 */
function sampleBalanced<T>(
  items: readonly T[],
  groupOf: (item: T) => string,
  n: number,
  rng: () => number,
): T[] {
  if (n <= 0 || items.length === 0) return []

  const byGroup = new Map<string, T[]>()
  for (const item of items) {
    const g = groupOf(item)
    const arr = byGroup.get(g)
    if (arr) arr.push(item)
    else byGroup.set(g, [item])
  }
  for (const arr of byGroup.values()) shuffleInPlace(arr, rng)
  const groups = shuffleInPlace([...byGroup.keys()], rng)

  const cap = groups.length <= 1 ? n : Math.max(1, Math.ceil(n * 0.89))
  const taken = new Map<string, number>()
  const picked: T[] = []

  let progress = true
  while (picked.length < n && progress) {
    progress = false
    for (const g of groups) {
      if (picked.length >= n) break
      const arr = byGroup.get(g)
      if (arr === undefined || arr.length === 0) continue
      if ((taken.get(g) ?? 0) >= cap) continue
      const item = arr.pop()
      if (item === undefined) continue
      picked.push(item)
      taken.set(g, (taken.get(g) ?? 0) + 1)
      progress = true
    }
  }

  // Le plafond a empêché d'atteindre `n` : on complète sans lui plutôt que de
  // rendre une planche trop courte.
  if (picked.length < n) {
    const leftover = groups.flatMap((g) => byGroup.get(g) ?? [])
    shuffleInPlace(leftover, rng)
    for (const item of leftover) {
      if (picked.length >= n) break
      picked.push(item)
    }
  }

  return picked
}

/**
 * Découpe `sorted` en `k` tranches contiguës d'effectif aussi égal que
 * possible — des quantiles, pas des intervalles de largeur fixe : la
 * distribution de la frontalité est probablement très déséquilibrée, et des
 * intervalles de largeur fixe rendraient des tranches vides.
 */
function quantileStrata<T>(sorted: readonly T[], k: number): T[][] {
  const n = sorted.length
  const base = Math.floor(n / k)
  const extra = n % k
  const strata: T[][] = []
  let idx = 0
  for (let i = 0; i < k; i += 1) {
    const size = base + (i < extra ? 1 : 0)
    strata.push(sorted.slice(idx, idx + size))
    idx += size
  }
  return strata
}

// ---------------------------------------------------------------------------
// La population.
// ---------------------------------------------------------------------------

/** Une boîte gardée, avec son émission, son orientation, et la taille du proxy dont elle vient. */
type PopEntry = {
  projectId: string
  box: PersonBox
  orientation: Orientation
  proxyW: number
  proxyH: number
}

/** Une boîte gardée dont `orientationOf` a su donner une frontalité. */
type KnownEntry = { entry: PopEntry; frontality: number }

function toKnown(population: readonly PopEntry[]): KnownEntry[] {
  const out: KnownEntry[] = []
  for (const entry of population) {
    const f = entry.orientation.frontality
    if (f !== null) out.push({ entry, frontality: f })
  }
  return out
}

/** L'émission abrégée pour une légende — le préfixe de date ôté, tronquée si besoin. */
function showAbbrev(projectId: string): string {
  const stripped = projectId.replace(/^\d{4}-\d{2}-\d{2}-/, '')
  return stripped.length > 14 ? `${stripped.slice(0, 13)}…` : stripped
}

// ---------------------------------------------------------------------------
// Les mesures de population, sur stdout — pas la planche. Elles répondent à
// deux questions posées avant de toucher `frontalThreshold` : le terme des
// épaules manque-t-il assez souvent pour changer l'échelle du problème, et où
// est la masse de la frontalité avant de déplacer un seuil dedans.
// ---------------------------------------------------------------------------

/** Compte par tranche de frontalité de 0,1 en 0,1 — dix tranches, la dernière fermée des deux côtés. */
function frontalityHistogram(entries: readonly KnownEntry[]): number[] {
  const buckets = new Array(10).fill(0) as number[]
  for (const { frontality } of entries) {
    const idx = Math.min(9, Math.floor(frontality * 10))
    buckets[idx] += 1
  }
  return buckets
}

function printHistogram(buckets: readonly number[], total: number): void {
  buckets.forEach((n, i) => {
    const lo = (i / 10).toFixed(1)
    const hi = ((i + 1) / 10).toFixed(1)
    const bracket = i === 9 ? ']' : '['
    const pct = total === 0 ? '0.0' : ((100 * n) / total).toFixed(1)
    console.log(`    [${lo} ; ${hi}${bracket}  ${String(n).padStart(7)}   ${pct.padStart(5)} %`)
  })
}

/**
 * Les trois mesures demandées avant de toucher au seuil : combien de boîtes
 * n'ont pas de terme d'épaules (et ce qu'elles deviennent, `facing`), où est
 * la masse de la frontalité, et si cette masse se déplace selon que le terme
 * d'épaules est disponible.
 */
function printPopulationMeasures(population: readonly PopEntry[], known: readonly KnownEntry[]): void {
  const total = population.length
  const noShoulder = population.filter((e) => e.orientation.terms.shoulderRatio === null)
  const noShoulderPct = total === 0 ? '0.0' : ((100 * noShoulder.length) / total).toFixed(1)

  console.log('')
  console.log('=== Mesures de population ===')
  console.log('')
  console.log(`1. shoulderRatio=null : ${noShoulder.length}/${total} boîte(s) (${noShoulderPct} %).`)
  const byFacing = new Map<string, number>()
  for (const e of noShoulder) {
    byFacing.set(e.orientation.facing, (byFacing.get(e.orientation.facing) ?? 0) + 1)
  }
  for (const facing of ['frontal', 'profile', 'unknown']) {
    const n = byFacing.get(facing) ?? 0
    const pct = noShoulder.length === 0 ? '0.0' : ((100 * n) / noShoulder.length).toFixed(1)
    console.log(
      `     facing=${facing.padEnd(8)} ${String(n).padStart(7)}   ${pct.padStart(5)} % de shoulderRatio=null`,
    )
  }

  console.log('')
  console.log(`2. Répartition par tranche de frontalité — population non-unknown, n=${known.length} :`)
  printHistogram(frontalityHistogram(known), known.length)

  const withShoulder = known.filter((k) => k.entry.orientation.terms.shoulderRatio !== null)
  console.log('')
  console.log(`3. Même répartition, restreinte à shoulderRatio ≠ null — n=${withShoulder.length} :`)
  printHistogram(frontalityHistogram(withShoulder), withShoulder.length)
  console.log('')
}

// ---------------------------------------------------------------------------
// La vignette.
// ---------------------------------------------------------------------------

type Region = { x0: number; y0: number; x1: number; y1: number }

/**
 * La zone à cadrer : la tête si `headBounds` en rend une, sinon le quart
 * supérieur de la boîte de la personne — le cas `unknown`, où il n'y a pas de
 * points de tête fiables à regarder.
 */
function vignetteRegion(box: PersonBox): Region {
  const head = headBounds(box)
  if (head !== null) return head
  return { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y0 + (box.y1 - box.y0) / 4 }
}

/**
 * Le plancher du côté du carré, en fraction de la largeur du proxy : évite un
 * carré dégénéré quand les points de tête sont quasi confondus (profil pur)
 * ou quand la boîte est minuscule (sujet lointain). Une valeur de confort —
 * ce script est un spike, pas une mesure.
 */
const MIN_SIDE_FRACTION = 0.06

/**
 * Un carré centré sur `(cx, cy)`, de côté `side`, ramené dans les bornes de
 * l'image — recentré si le centre est proche d'un bord, réduit si `side`
 * dépasse la plus petite dimension de l'image.
 */
function squareCrop(
  cx: number,
  cy: number,
  side: number,
  w: number,
  h: number,
): { x: number; y: number; s: number } {
  const s = Math.max(1, Math.min(Math.round(side), Math.floor(w), Math.floor(h)))
  const x = Math.round(Math.min(Math.max(cx - s / 2, 0), w - s))
  const y = Math.round(Math.min(Math.max(cy - s / 2, 0), h - s))
  return { x, y, s }
}

/**
 * Le carré à extraire pour une boîte : centré sur `vignetteRegion`, élargi à
 * **au moins trois fois la largeur des points de tête** — la consigne — et
 * tout autant sur la hauteur, parce qu'un profil pur peut avoir une largeur
 * de points de tête quasi nulle sans que sa hauteur le soit ; cadrer sur la
 * seule largeur couperait alors le front ou le menton.
 */
function vignetteCrop(
  box: PersonBox,
  proxyW: number,
  proxyH: number,
): { x: number; y: number; s: number } {
  const region = vignetteRegion(box)
  const regionWpx = Math.abs(region.x1 - region.x0) * proxyW
  const regionHpx = Math.abs(region.y1 - region.y0) * proxyH
  const cx = ((region.x0 + region.x1) / 2) * proxyW
  const cy = ((region.y0 + region.y1) / 2) * proxyH
  const side = Math.max(regionWpx * 3, regionHpx * 3, proxyW * MIN_SIDE_FRACTION)
  return squareCrop(cx, cy, side, proxyW, proxyH)
}

/**
 * Une vignette carrée en PNG, directement en mémoire — pas de fichier
 * intermédiaire pour 150 petites images. `-ss` avant `-i`, comme dans
 * `framing-thumbnails.ts` : c'est ce qui rend le seek rapide plutôt que de
 * décoder depuis le début à chaque appel.
 */
function extractThumbnail(
  proxy: string,
  t: number,
  crop: { x: number; y: number; s: number },
  thumb: number,
): Buffer {
  return execFileSync(
    ffmpegBin(),
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      t.toFixed(3),
      '-i',
      proxy,
      '-frames:v',
      '1',
      '-vf',
      `crop=${crop.s}:${crop.s}:${crop.x}:${crop.y},scale=${thumb}:${thumb}`,
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
  )
}

// ---------------------------------------------------------------------------
// La planche.
// ---------------------------------------------------------------------------

const COLUMNS = 6
const CELL_GAP = 12
const CAPTION_HEIGHT = 34
const HEADER_TOP_PAD = 14
const HEADER_TITLE_HEIGHT = 32
const HEADER_SUB_LINE_HEIGHT = 18
const HEADER_BOTTOM_PAD = 14

const COLOR_BACKGROUND = '#14161c'
const COLOR_TITLE = '#f2f4f8'
const COLOR_SUBTITLE = '#9aa4b2'
const COLOR_CAPTION = '#c9d1db'
const COLOR_CELL_BORDER = '#454c60'

function fmt3(n: number): string {
  return n.toFixed(3)
}

/** `null` s'affiche `-`, jamais `0.00` : l'absence de signal n'est pas le signal le plus prudent. */
function fmtTerm(n: number | null): string {
  return n === null ? '-' : n.toFixed(2)
}

/** Les deux lignes de légende d'une vignette. */
function captions(entry: PopEntry): [string, string] {
  const { orientation } = entry
  const line1 =
    orientation.frontality === null
      ? `frontality=unknown  facing=${orientation.facing}`
      : `frontality=${fmt3(orientation.frontality)}  facing=${orientation.facing}`
  const { earAsymmetry, eyeTerm, shoulderRatio } = orientation.terms
  const line2 =
    `${showAbbrev(entry.projectId)} t=${entry.box.t.toFixed(1)}s ` +
    `ea=${fmtTerm(earAsymmetry)} ey=${fmtTerm(eyeTerm)} sh=${fmtTerm(shoulderRatio)}`
  return [line1, line2]
}

/**
 * La plus grande taille de police, entre `min` et `start`, qui tienne `text`
 * dans `maxWidth`. Une planche a des légendes de longueur variable —
 * `showAbbrev` tronque le nom, mais pas `t=…s` ni les trois termes — et une
 * taille fixe déborde sur la vignette voisine dès que le texte est un peu
 * long. Mesuré avec `measureText`, comme `wrapLines` le fait déjà pour le
 * hook (`src/server/hook-image.ts`), jamais estimé.
 */
function fitFontSize(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  font: (size: number) => string,
  start: number,
  min: number,
): number {
  for (let size = start; size > min; size -= 1) {
    ctx.font = font(size)
    if (ctx.measureText(text).width <= maxWidth) return size
  }
  ctx.font = font(min)
  return min
}

/** `text`, tronqué avec une ellipse pour tenir dans `maxWidth` à la police déjà posée sur `ctx`. */
function truncateToWidth(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let t = text
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) {
    t = t.slice(0, -1)
  }
  return `${t}…`
}

type SheetItem = { buffer: Buffer; caption1: string; caption2: string }
type SheetMeta = { title: string; subtitle: string[] }

/**
 * Assemble une planche : bandeau de réglages en haut, grille de vignettes en
 * dessous, triée par l'appelant avant d'arriver ici. `COLUMNS` colonnes fixes
 * — 6, comme la grille de référence de 30 en 6×5 — et autant de lignes qu'il
 * en faut pour le nombre de vignettes reçu.
 */
async function renderSheet(items: SheetItem[], meta: SheetMeta, thumb: number, out: string): Promise<void> {
  const cols = COLUMNS
  const rows = Math.max(1, Math.ceil(items.length / cols))
  const cellW = thumb
  const cellH = thumb + CAPTION_HEIGHT
  const gridW = cols * cellW + (cols + 1) * CELL_GAP
  const gridH = rows * cellH + (rows + 1) * CELL_GAP
  const headerH =
    HEADER_TOP_PAD + HEADER_TITLE_HEIGHT + meta.subtitle.length * HEADER_SUB_LINE_HEIGHT + HEADER_BOTTOM_PAD

  const canvas = createCanvas(gridW, headerH + gridH)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = COLOR_BACKGROUND
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Le bandeau tient sur la largeur de la grille, dont on ne connaît pas la
  // longueur du texte à l'avance — le nom des strates et les effectifs
  // varient. Chaque ligne se redimensionne pour tenir, et se tronque si même
  // la taille plancher déborde encore.
  const headerMaxW = gridW - 32
  ctx.textBaseline = 'top'

  ctx.fillStyle = COLOR_TITLE
  const titleFont = (s: number): string => `bold ${s}px sans-serif`
  const titleSize = fitFontSize(ctx, meta.title, headerMaxW, titleFont, 20, 12)
  ctx.font = titleFont(titleSize)
  ctx.fillText(truncateToWidth(ctx, meta.title, headerMaxW), 16, HEADER_TOP_PAD)

  ctx.fillStyle = COLOR_SUBTITLE
  const subtitleFont = (s: number): string => `${s}px monospace`
  meta.subtitle.forEach((line, i) => {
    const size = fitFontSize(ctx, line, headerMaxW, subtitleFont, 13, 9)
    ctx.font = subtitleFont(size)
    ctx.fillText(
      truncateToWidth(ctx, line, headerMaxW),
      16,
      HEADER_TOP_PAD + HEADER_TITLE_HEIGHT + i * HEADER_SUB_LINE_HEIGHT,
    )
  })

  const captionMaxW = cellW - 8
  const captionFont = (s: number): string => `${s}px monospace`

  for (let i = 0; i < items.length; i += 1) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const cellX = CELL_GAP + col * (cellW + CELL_GAP)
    const cellY = headerH + CELL_GAP + row * (cellH + CELL_GAP)

    const img = await loadImage(items[i].buffer)
    ctx.drawImage(img, cellX, cellY, thumb, thumb)

    // Le filet entre les vignettes : un contour autour de chaque cellule,
    // vignette et légende comprises.
    ctx.strokeStyle = COLOR_CELL_BORDER
    ctx.lineWidth = 1
    ctx.strokeRect(cellX + 0.5, cellY + 0.5, cellW - 1, cellH - 1)

    ctx.fillStyle = COLOR_CAPTION
    // **Mesurée, pas devinée** : deux vignettes voisines de 220 px avec une
    // légende de trente caractères se chevauchent à la première taille fixe
    // essayée — vérifié à l'image sur le tirage de test. `fitFontSize`
    // rétrécit jusqu'à ce que ça tienne, `truncateToWidth` tranche le reste.
    const size1 = fitFontSize(ctx, items[i].caption1, captionMaxW, captionFont, 11, 7)
    ctx.font = captionFont(size1)
    ctx.fillText(truncateToWidth(ctx, items[i].caption1, captionMaxW), cellX + 4, cellY + thumb + 2)

    const size2 = fitFontSize(ctx, items[i].caption2, captionMaxW, captionFont, 11, 7)
    ctx.font = captionFont(size2)
    ctx.fillText(truncateToWidth(ctx, items[i].caption2, captionMaxW), cellX + 4, cellY + thumb + 17)
  }

  fs.writeFileSync(out, canvas.toBuffer('image/png'))
}

// ---------------------------------------------------------------------------
// Le programme.
// ---------------------------------------------------------------------------

function usage(): string {
  return (
    'Usage : pnpm tsx scripts/spike/orientation-sheet.ts [<projectId…>] ' +
    '[--per-sheet 30] [--sheets 4] [--seed 1] [--out <dossier>] [--thumb 220] ' +
    '[--range <lo>,<hi> | --missing-shoulder]'
  )
}

/** Un entier lu sur la ligne de commande, refusé s'il est illisible — jamais remplacé par le défaut en silence. */
function intFlag(
  value: (flag: string) => string | undefined,
  flag: string,
  defaultValue: number,
  min: number,
): number | undefined {
  const raw = value(flag)
  if (raw === undefined) return defaultValue
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) {
    console.error(`${flag} attend un entier ≥ ${min}, reçu « ${raw} ».`)
    return undefined
  }
  return n
}

/**
 * `lo,hi` en `{ lo, hi }` — ou `undefined` si mal formé : non numérique, hors
 * de [0,1], ou `lo >= hi`. Jamais remplacé par un défaut, comme `intFlag` :
 * un intervalle illisible se refuse.
 */
function parseRange(raw: string): { lo: number; hi: number } | undefined {
  const parts = raw.split(',')
  if (parts.length !== 2 || parts[0].trim() === '' || parts[1].trim() === '') return undefined
  const lo = Number(parts[0])
  const hi = Number(parts[1])
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined
  if (lo < 0 || lo > 1 || hi < 0 || hi > 1) return undefined
  if (lo >= hi) return undefined
  return { lo, hi }
}

/** Le mode de tirage : les strates par défaut, ou l'une des deux planches uniques. */
type Mode = { kind: 'strata' } | { kind: 'range'; lo: number; hi: number } | { kind: 'missing-shoulder' }

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const flagsWithValue = new Set<number>()
  for (const flag of ['--per-sheet', '--sheets', '--seed', '--out', '--thumb', '--range']) {
    const i = arguments_.indexOf(flag)
    if (i >= 0) flagsWithValue.add(i + 1)
  }
  const positional = arguments_.filter((a, i) => !a.startsWith('--') && !flagsWithValue.has(i))
  const value = (flag: string): string | undefined => {
    const i = arguments_.indexOf(flag)
    if (i < 0) return undefined
    const raw = arguments_[i + 1]
    return raw === undefined || raw.startsWith('--') ? undefined : raw
  }

  const projectIds = positional.length > 0 ? positional : DEFAULT_PROJECTS

  const perSheet = intFlag(value, '--per-sheet', 30, 1)
  const sheetsCount = intFlag(value, '--sheets', 4, 1)
  const seed = intFlag(value, '--seed', 1, Number.MIN_SAFE_INTEGER)
  const thumbSize = intFlag(value, '--thumb', 220, 32)
  if (perSheet === undefined || sheetsCount === undefined || seed === undefined || thumbSize === undefined) {
    console.error(usage())
    return 1
  }

  // `--range` et `--missing-shoulder` s'excluent entre eux et remplacent les
  // strates : une planche unique plutôt que `--sheets` tranches. Un intervalle
  // illisible se refuse, jamais remplacé par un défaut.
  const rangeRaw = value('--range')
  const missingShoulder = arguments_.includes('--missing-shoulder')
  if (rangeRaw !== undefined && missingShoulder) {
    console.error('--range et --missing-shoulder sont exclusifs l’un de l’autre.')
    return 1
  }
  let mode: Mode = { kind: 'strata' }
  if (rangeRaw !== undefined) {
    const parsed = parseRange(rangeRaw)
    if (parsed === undefined) {
      console.error(`--range attend « lo,hi » avec 0 ≤ lo < hi ≤ 1, reçu « ${rangeRaw} ».`)
      return 1
    }
    mode = { kind: 'range', lo: parsed.lo, hi: parsed.hi }
  } else if (missingShoulder) {
    mode = { kind: 'missing-shoulder' }
  }

  const outDir = value('--out') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'orientation-sheets-'))
  fs.mkdirSync(outDir, { recursive: true })

  const rng = makeRng(seed)

  // ---- La population -------------------------------------------------

  const proxies = new Map<string, string>()
  const population: PopEntry[] = []
  let usableProjects = 0

  for (const projectId of projectIds) {
    const aPath = analysisPath(projectId)
    const pPath = proxyPath(projectId)
    if (!fs.existsSync(aPath) || !fs.existsSync(pPath)) {
      console.error(`${projectId} : analyse ou proxy manquant (${aPath} / ${pPath}), ignoré.`)
      continue
    }
    const analysis = lireAnalysis(aPath)
    proxies.set(projectId, pPath)
    usableProjects += 1
    for (const box of analysis.boxes) {
      // `!(score >= seuil)` et non `score < seuil` : un score `NaN` doit tomber du côté écarté.
      if (!(box.score >= FRAMING_DEFAULTS.minScore)) continue
      if (isForeground(box)) continue
      population.push({
        projectId,
        box,
        orientation: orientationOf(box),
        proxyW: analysis.proxy.w,
        proxyH: analysis.proxy.h,
      })
    }
  }

  if (usableProjects === 0 || population.length === 0) {
    console.error("Aucune boîte retenue : aucun projet exploitable, ou aucune boîte au-dessus du seuil.")
    return 1
  }

  const known = toKnown(population).sort((a, b) => a.frontality - b.frontality)
  const unknownEntries = population.filter((e) => e.orientation.facing === 'unknown')

  printPopulationMeasures(population, known)

  // ---- Le tirage, planche par planche ---------------------------------

  type Plan = {
    file: string
    title: string
    subtitle: string[]
    drawn: PopEntry[]
    // Pour le tableau final.
    reportLabel: string
    reportBounds: string
    reportPopulation: number
  }

  const settingsLine =
    `ORIENTATION_DEFAULTS  pointMinScore=${ORIENTATION_DEFAULTS.pointMinScore.toFixed(2)}  ` +
    `shoulderRatioFull=${ORIENTATION_DEFAULTS.shoulderRatioFull.toFixed(2)}  ` +
    `frontalThreshold=${ORIENTATION_DEFAULTS.frontalThreshold.toFixed(2)}  ` +
    `sideDeadband=${ORIENTATION_DEFAULTS.sideDeadband.toFixed(2)}`
  const populationLine =
    `Population : score ≥ ${FRAMING_DEFAULTS.minScore.toFixed(2)} (minScore), premier plan exclu ` +
    `(bottomEdge=${FRAMING_DEFAULTS.bottomEdge.toFixed(2)}, foregroundMaxHeight=${FRAMING_DEFAULTS.foregroundMaxHeight.toFixed(2)})`

  const plans: Plan[] = []

  if (mode.kind === 'strata') {
    const strata = quantileStrata(known, sheetsCount)

    strata.forEach((stratum, i) => {
      if (stratum.length === 0) {
        console.error(`Strate ${i + 1}/${sheetsCount} : population vide, planche non produite.`)
        return
      }
      const lo = stratum[0].frontality
      const hi = stratum[stratum.length - 1].frontality
      const drawn = sampleBalanced(stratum, (k) => k.entry.projectId, perSheet, rng)
        .sort((a, b) => a.frontality - b.frontality)
        .map((k) => k.entry)

      plans.push({
        file: path.join(outDir, `sheet-${i + 1}-${fmt3(lo)}-${fmt3(hi)}.png`),
        title:
          `Planche ${i + 1}/${sheetsCount} — orientationOf — frontality [${fmt3(lo)} ; ${fmt3(hi)}] — ` +
          `${drawn.length}/${perSheet} vignette(s), population ${stratum.length}`,
        subtitle: [
          settingsLine,
          populationLine,
          `seed=${seed}  trié par frontalité croissante, gauche→droite puis haut→bas`,
        ],
        drawn,
        reportLabel: `strate ${i + 1}/${sheetsCount}`,
        reportBounds: `[${fmt3(lo)} ; ${fmt3(hi)}]`,
        reportPopulation: stratum.length,
      })
    })

    // La planche des `unknown`, toujours produite : elle importe autant que
    // les autres, voir l'en-tête de ce fichier.
    {
      const drawn = sampleBalanced(unknownEntries, (e) => e.projectId, perSheet, rng).sort(
        (a, b) => a.projectId.localeCompare(b.projectId) || a.box.t - b.box.t,
      )
      const pct = ((100 * unknownEntries.length) / population.length).toFixed(1)
      plans.push({
        file: path.join(outDir, 'sheet-unknown.png'),
        title:
          `Planche unknown — orientationOf — facing='unknown' — ${drawn.length}/${perSheet} vignette(s), ` +
          `population ${unknownEntries.length} (${pct} % de la population totale)`,
        subtitle: [
          settingsLine,
          populationLine,
          `seed=${seed}  trié par émission puis par t (pas de frontalité à trier)`,
        ],
        drawn,
        reportLabel: 'unknown',
        reportBounds: 'n/a',
        reportPopulation: unknownEntries.length,
      })
    }
  } else if (mode.kind === 'range') {
    // Une planche unique, restreinte à `lo <= frontality <= hi` — jamais les
    // `unknown`, qui n'ont pas de frontalité à comparer.
    const { lo, hi } = mode
    const filtered = known.filter((k) => k.frontality >= lo && k.frontality <= hi)
    if (filtered.length === 0) {
      console.error(`--range ${fmt3(lo)},${fmt3(hi)} : population vide, aucune planche produite.`)
      return 1
    }
    const drawn = sampleBalanced(filtered, (k) => k.entry.projectId, perSheet, rng)
      .sort((a, b) => a.frontality - b.frontality)
      .map((k) => k.entry)

    plans.push({
      file: path.join(outDir, `sheet-range-${fmt3(lo)}-${fmt3(hi)}.png`),
      title:
        `Planche range — orientationOf — frontality [${fmt3(lo)} ; ${fmt3(hi)}] — ` +
        `${drawn.length}/${perSheet} vignette(s), population ${filtered.length}`,
      subtitle: [
        settingsLine,
        populationLine,
        `restriction : --range ${fmt3(lo)},${fmt3(hi)} (unknown exclus)`,
        `seed=${seed}  trié par frontalité croissante`,
      ],
      drawn,
      reportLabel: 'range',
      reportBounds: `[${fmt3(lo)} ; ${fmt3(hi)}]`,
      reportPopulation: filtered.length,
    })
  } else {
    // `--missing-shoulder` : toutes frontalités confondues, `unknown` compris
    // — le test direct de l'hypothèse (b), qui ne dépend pas de savoir si
    // `frontality` a pu se calculer.
    const filtered = population.filter((e) => e.orientation.terms.shoulderRatio === null)
    if (filtered.length === 0) {
      console.error('--missing-shoulder : population vide, aucune planche produite.')
      return 1
    }
    const drawn = sampleBalanced(filtered, (e) => e.projectId, perSheet, rng).sort((a, b) => {
      const fa = a.orientation.frontality
      const fb = b.orientation.frontality
      if (fa !== null && fb !== null) return fa - fb
      if (fa !== null) return -1
      if (fb !== null) return 1
      return a.projectId.localeCompare(b.projectId) || a.box.t - b.box.t
    })
    const pct = ((100 * filtered.length) / population.length).toFixed(1)

    plans.push({
      file: path.join(outDir, 'sheet-no-shoulder.png'),
      title:
        `Planche no-shoulder — orientationOf — terms.shoulderRatio=null — ` +
        `${drawn.length}/${perSheet} vignette(s), population ${filtered.length} (${pct} % de la population totale)`,
      subtitle: [
        settingsLine,
        populationLine,
        'restriction : --missing-shoulder (terms.shoulderRatio === null, unknown compris)',
        `seed=${seed}  trié par frontalité croissante, unknown groupés en fin`,
      ],
      drawn,
      reportLabel: 'no-shoulder',
      reportBounds: 'n/a',
      reportPopulation: filtered.length,
    })
  }

  // ---- L'extraction, avec une seule barre de progression pour tout -----

  const totalJobs = plans.reduce((sum, p) => sum + p.drawn.length, 0)
  console.log(`Extraction de ${totalJobs} vignette(s) sur ${plans.length} planche(s)...`)
  const bar = createBar('vignettes')
  let done = 0

  const sheetItems: SheetItem[][] = []
  for (const plan of plans) {
    const items: SheetItem[] = []
    for (const entry of plan.drawn) {
      const proxy = proxies.get(entry.projectId)
      if (proxy === undefined) continue // Ne peut pas arriver : `drawn` vient de `population`, déjà filtrée sur un proxy connu.
      const crop = vignetteCrop(entry.box, entry.proxyW, entry.proxyH)
      const buffer = extractThumbnail(proxy, entry.box.t, crop, thumbSize)
      const [caption1, caption2] = captions(entry)
      items.push({ buffer, caption1, caption2 })
      done += 1
      bar(done / totalJobs)
    }
    sheetItems.push(items)
  }
  finBar()

  // ---- Le rendu des planches --------------------------------------------

  for (const [i, plan] of plans.entries()) {
    await renderSheet(sheetItems[i], { title: plan.title, subtitle: plan.subtitle }, thumbSize, plan.file)
    console.log(`  ${plan.file}`)
  }

  // ---- Le rapport ---------------------------------------------------------

  console.log('')
  console.log('Strate       Bornes                  Population   Tirées   Répartition par émission')
  for (const plan of plans) {
    const byShow = new Map<string, number>()
    for (const entry of plan.drawn) {
      byShow.set(entry.projectId, (byShow.get(entry.projectId) ?? 0) + 1)
    }
    const repartition = [...byShow.entries()]
      .map(([id, n]) => `${showAbbrev(id)}=${n}`)
      .join(' ')
    console.log(
      `${plan.reportLabel.padEnd(12)} ${plan.reportBounds.padEnd(23)} ${String(plan.reportPopulation).padStart(10)} ` +
        `${String(plan.drawn.length).padStart(8)}   ${repartition}`,
    )
  }

  const unknownPct = ((100 * unknownEntries.length) / population.length).toFixed(1)
  console.log('')
  console.log(
    `Population totale (score ≥ ${FRAMING_DEFAULTS.minScore}, hors premier plan) : ${population.length} boîte(s) sur ${usableProjects} projet(s).`,
  )
  console.log(`unknown : ${unknownEntries.length} boîte(s), soit ${unknownPct} % de la population.`)

  return 0
}

void main().then(quit, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quit(1)
})
