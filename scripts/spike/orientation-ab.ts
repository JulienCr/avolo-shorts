/**
 * **Avant/après en une image : ce que le spectateur verrait si on écartait la
 * personne de profil du calcul d'empan (cas 2 du spike « qui parle »).**
 *
 *     pnpm tsx scripts/spike/orientation-ab.ts --json projects/2026-05-31-nabla/spike/addressable.json
 *     pnpm tsx scripts/spike/orientation-ab.ts --json <fichier> --cases 6 --controls 3 --seed 1 --out /tmp/orientation-ab
 *
 * `scripts/spike/addressable.ts --json <fichier>` produit le gisement du cas 2 :
 * les plans à deux personnes, en 16:9, où l'une est nettement plus de face que
 * l'autre. **Ce script réutilise ce fichier plutôt que de refaire la
 * sélection** (skill `cadrage`) — il ne recalcule ni `chooseRatio`, ni
 * `computeFraming`, ni `orientationOf` à sa façon : ce sont les seules
 * autorités de géométrie (`src/core/framing.ts`).
 *
 * **Ce qu'une image montre**, trois panneaux à la même hauteur :
 *
 * 1. la **source** — l'image du proxy à l'instant le plus défavorable du plan
 *    (celui où l'empan est le plus large, pas le plus flatteur), avec les
 *    boîtes, le tronc, la tête, la frontalité de chaque personne, et les deux
 *    rectangles de crop : **jaune** pour aujourd'hui, **orange** pour le
 *    candidat ;
 * 2. **aujourd'hui** — le canevas 9:16 tel qu'il sort en production : fond
 *    flouté tiré d'avant toute incrustation, plan posé dessus à sa taille
 *    (`sizeInCanvas`) — la même composition que `blurredVariantArgs`
 *    (`src/core/ffmpeg/args.ts`), reproduite ici pour une image fixe ;
 * 3. **candidat** — le même canevas, ratio et crop recalculés en écartant, à
 *    chaque image du plan, la personne la plus de profil du calcul d'empan.
 *
 * **Le candidat n'invente aucun calcul.** Il ne fait que filtrer la
 * population de boîtes passée à `computeFraming` : pour chaque image du plan
 * où deux personnes sont retenues (score suffisant, pas de premier plan — les
 * mêmes filtres qu'`empans` interne à `framing.ts`, reconstruits ici avec les
 * seules primitives exportées `isForeground` et `FRAMING_DEFAULTS`), on
 * compare leurs `orientationOf(...).frontality` ; si l'écart dépasse
 * `FRONTAL_GAP_MARGIN`, la moins frontale est retirée de cette image-là. Tout
 * le reste — ratio, position du crop, taille dans le canevas — passe par
 * `chooseRatio` et `computeFraming`, jamais recalculé à la main.
 *
 * **Les contrôles négatifs comptent autant que les cas.** `--controls`
 * produit, en plus, des images sur des plans où la règle ne doit **rien**
 * changer : deux personnes de face (écart de frontalité faible), une seule
 * personne, et — si le corpus en offre un — deux personnes de profil. Sur ces
 * images, les panneaux 2 et 3 doivent être identiques ; ce script le vérifie
 * et le dit dans la légende, en toutes lettres si ce n'est pas le cas.
 *
 * **Deux écarts assumés avec `addressable.ts`, documentés plutôt que cachés.**
 *
 * - `addressable.ts` ne retient un gagnant que si le camp perdant n'est
 *   **jamais** `'unknown'` sur les images décisives (`loserNeverUnknown`).
 *   Ce champ n'est pas écrit dans le JSON (`toJsonShotEntry`), donc ce script ne
 *   peut pas le revérifier : la sélection des cas se fonde sur `winningRank`
 *   et sur le ratio qu'obtiendrait ce rang seul, pas sur cette troisième
 *   condition. Un cas retenu ici peut donc, en théorie, différer d'un cas que
 *   la section d. d'`addressable.ts` aurait classé « core ».
 * - Le plan est traité **comme s'il était monté en entier** (le segment passé
 *   à `computeFraming` couvre tout `[shot.start, shot.end)`), alors que le
 *   `ratio` du JSON vient d'une population restreinte au montage réel
 *   (`inClipSeconds`, qui peut être plus court que la durée du plan). Ce
 *   script recalcule donc son propre « aujourd'hui » et le compare au `ratio`
 *   du JSON ; un écart est signalé bruyamment sur la ligne de résumé plutôt
 *   que masqué.
 *
 * Conventions reprises de `scripts/framing-thumbnails.ts` et
 * `scripts/spike/orientation-sheet.ts` : arguments analysés à la main, valeur
 * illisible refusée et jamais remplacée par un défaut, `execFileSync` d'ffmpeg
 * avec `-ss` avant `-i`, binaire par `process.env.FFMPEG_BIN || 'ffmpeg'`,
 * sortie dans `--out` ou un `mkdtempSync`, jamais dans `projects/`.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCanvas, loadImage, type Canvas, type Image } from '@napi-rs/canvas'

import type { Ratio } from '@/core/edl'
import {
  FRAMING_DEFAULTS,
  ORIENTATION_DEFAULTS,
  RATIOS,
  computeFraming,
  cropRect,
  headBounds,
  isForeground,
  orientationOf,
  outputSize,
  personBounds,
  requiredWidths,
  sizeInCanvas,
} from '@/core/framing'
import type { PersonBox, Shot } from '@/core/shots'
import { analysisPath, proxyPath } from '@/server/paths'
import { lireAnalysis, type Analysis } from '@/server/steps/analysis'
import { chargerEnv, quit } from '../dev-common'

// ---------------------------------------------------------------------------
// Le fichier `addressable.ts --json` : lu, jamais recalculé.
// ---------------------------------------------------------------------------

type JsonPlan = {
  start: number
  end: number
  inClipSeconds: number
  ratio: Ratio
  typicalPeople: number
  ratioIfRank0: Ratio
  ratioIfRank1: Ratio
  medianFrontalityRank0: number | null
  medianFrontalityRank1: number | null
  winningRank: 0 | 1 | null
}

type JsonShow = { editedSeconds: number; shots: JsonPlan[] }
type AddressableData = Record<string, JsonShow>

function isRatio(v: unknown): v is Ratio {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(RATIOS, v)
}
function isNumberOrNull(v: unknown): v is number | null {
  return v === null || typeof v === 'number'
}
function isWinningRank(v: unknown): v is 0 | 1 | null {
  return v === null || v === 0 || v === 1
}

/**
 * Lit et valide légèrement le JSON d'`addressable.ts`. **Une forme inattendue
 * est refusée avec un message qui nomme la commande de régénération**, jamais
 * lue à moitié — le même principe que `lireAnalysis` sur une version
 * d'`analysis.json` inconnue.
 */
function readAddressableJson(file: string): AddressableData {
  const regen = `pnpm tsx scripts/spike/addressable.ts --json ${file}`
  if (!fs.existsSync(file)) {
    throw new Error(`${file} est introuvable. Régénère-le avec « ${regen} ».`)
  }
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${file} n'a pas la forme attendue (objet par émission). Régénère-le avec « ${regen} ».`)
  }
  const out: AddressableData = {}
  for (const [projectId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`${file} : l'entrée « ${projectId} » n'a pas la forme attendue. Régénère-le avec « ${regen} ».`)
    }
    const show = value as { editedSeconds?: unknown; shots?: unknown }
    if (typeof show.editedSeconds !== 'number' || !Array.isArray(show.shots)) {
      throw new Error(
        `${file} : l'entrée « ${projectId} » ne porte pas editedSeconds/shots. Régénère-le avec « ${regen} ».`,
      )
    }
    const plans: JsonPlan[] = show.shots.map((raw, i) => {
      if (typeof raw !== 'object' || raw === null) {
        throw new Error(`${file} : ${projectId}.shots[${i}] n'a pas la forme attendue.`)
      }
      const p = raw as Record<string, unknown>
      const ok =
        typeof p.start === 'number' &&
        typeof p.end === 'number' &&
        typeof p.inClipSeconds === 'number' &&
        isRatio(p.ratio) &&
        typeof p.typicalPeople === 'number' &&
        isRatio(p.ratioIfRank0) &&
        isRatio(p.ratioIfRank1) &&
        isNumberOrNull(p.medianFrontalityRank0) &&
        isNumberOrNull(p.medianFrontalityRank1) &&
        isWinningRank(p.winningRank)
      if (!ok) {
        throw new Error(
          `${file} : ${projectId}.shots[${i}] ne porte pas les champs attendus. Régénère-le avec « ${regen} ».`,
        )
      }
      return p as unknown as JsonPlan
    })
    out[projectId] = { editedSeconds: show.editedSeconds, shots: plans }
  }
  return out
}

// ---------------------------------------------------------------------------
// Un xorshift32 déterministe, seedé par `--seed` — copié depuis
// `orientation-sheet.ts` : chaque script de mesure garde le sien plutôt que
// d'exporter une primitive depuis un module de cadrage.
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let state = (seed | 0) || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function shuffleInPlace<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

/** La médiane, au sens strict — dupliquée comme dans `addressable.ts` et `framing.ts`. */
function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const m = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

// ---------------------------------------------------------------------------
// La sélection : cas et contrôles, tirés du JSON ou de l'analyse brute.
// ---------------------------------------------------------------------------

/**
 * L'écart de frontalité, entre deux personnes d'une même image, au-delà
 * duquel le candidat écarte la moins frontale du calcul d'empan.
 *
 * Même valeur que le défaut `--frontal-margin` d'`addressable.ts` : les deux
 * répondent à la même question (« l'écart est-il assez net pour ne pas être
 * du bruit de détection ? ») et diverger changerait ce que ce script montre
 * de ce que le gisement mesure.
 */
const FRONTAL_GAP_MARGIN = 0.25

/** La durée minimale, en secondes, d'un plan candidat pour un contrôle « solo » ou « profil ». */
const MIN_CONTROL_SHOT_SECONDS = 3

/** Le nombre minimal d'images à deux personnes pour juger un plan « les deux de profil » — pas du bruit sur une ou deux images. */
const MIN_TWO_PERSON_FRAMES = 3

type Case2Candidate = { project: string; plan: JsonPlan }

/**
 * Les plans du gisement 1 (déjà filtrés par `addressable.ts` : deux
 * personnes, 16:9, plan assez long) où un rang gagne **et** où l'écarter
 * change vraiment le ratio — c'est `orientationVerdict === 'core'`
 * d'`addressable.ts`, minorée de `loserNeverUnknown` (voir l'en-tête).
 */
function collectCase2Candidates(data: AddressableData): Case2Candidate[] {
  const out: Case2Candidate[] = []
  for (const [project, show] of Object.entries(data)) {
    for (const plan of show.shots) {
      if (plan.winningRank === null) continue
      const ratioIfWinner = plan.winningRank === 0 ? plan.ratioIfRank0 : plan.ratioIfRank1
      if (ratioIfWinner === '16:9') continue
      out.push({ project, plan })
    }
  }
  return out
}

type Control1Candidate = { project: string; plan: JsonPlan; gap: number }

/** Les plans du gisement 1 où les deux personnes sont proches en frontalité — le contrôle « deux visages ». */
function collectControl1Candidates(data: AddressableData): Control1Candidate[] {
  const out: Control1Candidate[] = []
  for (const [project, show] of Object.entries(data)) {
    for (const plan of show.shots) {
      if (plan.medianFrontalityRank0 === null || plan.medianFrontalityRank1 === null) continue
      out.push({ project, plan, gap: Math.abs(plan.medianFrontalityRank0 - plan.medianFrontalityRank1) })
    }
  }
  return out.sort((a, b) => a.gap - b.gap)
}

/** Les boîtes retenues par le cadrage sur une image — score suffisant, pas de premier plan. */
function keptBoxes(boxes: PersonBox[]): PersonBox[] {
  return boxes.filter((b) => b.score >= FRAMING_DEFAULTS.minScore && !isForeground(b))
}

function groupByFrame(boxes: PersonBox[]): Map<number, PersonBox[]> {
  const byFrame = new Map<number, PersonBox[]>()
  for (const b of boxes) {
    const key = Math.round(b.t * 1000)
    const arr = byFrame.get(key)
    if (arr) arr.push(b)
    else byFrame.set(key, [b])
  }
  return byFrame
}

type ControlSoloCandidate = { project: string; shot: Shot }

/**
 * Les plans à une seule personne (médiane des images retenues), sur
 * l'analyse entière — pas seulement le montage : un contrôle n'a pas besoin
 * d'être publiable, seulement représentatif.
 */
function findControlSoloShots(data: AddressableData, analyses: Map<string, Analysis>): ControlSoloCandidate[] {
  const out: ControlSoloCandidate[] = []
  for (const project of Object.keys(data)) {
    const analysis = analyses.get(project)
    if (analysis === undefined) continue
    for (const shot of analysis.shots) {
      if (shot.end - shot.start < MIN_CONTROL_SHOT_SECONDS) continue
      const inWindow = analysis.boxes.filter((b) => b.t >= shot.start && b.t < shot.end)
      const byFrame = groupByFrame(inWindow)
      const counts = [...byFrame.values()].map((boxes) => keptBoxes(boxes).length)
      if (counts.length > 0 && median(counts) === 1) out.push({ project, shot })
    }
  }
  return out
}

type ControlProfileCandidate = { project: string; shot: Shot; medianA: number; medianB: number }

/** L'abscisse du centre de `personBounds` — le même repère qu'`addressable.ts` pour le rang gauche/droite. */
function centerOf(box: PersonBox): number {
  const bounds = personBounds(box)
  return (bounds.x0 + bounds.x1) / 2
}

/**
 * Les plans à deux personnes où les deux sont, médianement, de profil
 * (`frontality` sous `ORIENTATION_DEFAULTS.frontalThreshold` pour les deux
 * rangs) — la posture normale de l'impro sur ce plateau, donc un contrôle
 * qu'on peut ne pas trouver dans un corpus donné (« si tu en trouves un »).
 */
function findControlProfileShots(
  data: AddressableData,
  analyses: Map<string, Analysis>,
): ControlProfileCandidate[] {
  const out: ControlProfileCandidate[] = []
  for (const project of Object.keys(data)) {
    const analysis = analyses.get(project)
    if (analysis === undefined) continue
    for (const shot of analysis.shots) {
      if (shot.end - shot.start < MIN_CONTROL_SHOT_SECONDS) continue
      const inWindow = analysis.boxes.filter((b) => b.t >= shot.start && b.t < shot.end)
      const byFrame = groupByFrame(inWindow)
      const frontA: number[] = []
      const frontB: number[] = []
      let twoPersonFrames = 0
      for (const boxes of byFrame.values()) {
        const kept = keptBoxes(boxes)
        if (kept.length !== 2) continue
        twoPersonFrames += 1
        const [a, b] = [...kept].sort((x, y) => centerOf(x) - centerOf(y))
        const oa = orientationOf(a)
        const ob = orientationOf(b)
        if (oa.frontality !== null) frontA.push(oa.frontality)
        if (ob.frontality !== null) frontB.push(ob.frontality)
      }
      if (twoPersonFrames < MIN_TWO_PERSON_FRAMES || frontA.length === 0 || frontB.length === 0) continue
      const medianA = median(frontA)
      const medianB = median(frontB)
      if (medianA < ORIENTATION_DEFAULTS.frontalThreshold && medianB < ORIENTATION_DEFAULTS.frontalThreshold) {
        out.push({ project, shot, medianA, medianB })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Le candidat : filtrer la population, jamais recalculer la géométrie.
// ---------------------------------------------------------------------------

/**
 * Écarte, image par image, la personne la plus de profil quand deux
 * personnes sont retenues et que leur écart de frontalité dépasse
 * `FRONTAL_GAP_MARGIN`. Toute autre image (0, 1 ou 3+ personnes retenues, ou
 * écart trop faible) passe inchangée.
 *
 * **Ce n'est qu'un filtre sur `people`** : le ratio et le crop qui en
 * sortent viennent ensuite de `computeFraming`, jamais recalculés ici.
 */
function dropProfilePerson(boxes: PersonBox[]): PersonBox[] {
  const byFrame = groupByFrame(boxes)
  const out: PersonBox[] = []
  for (const frameBoxes of byFrame.values()) {
    const retained = keptBoxes(frameBoxes)
    if (retained.length === 2) {
      const [a, b] = retained
      const oa = orientationOf(a)
      const ob = orientationOf(b)
      if (
        oa.frontality !== null &&
        ob.frontality !== null &&
        Math.abs(oa.frontality - ob.frontality) > FRONTAL_GAP_MARGIN
      ) {
        const dropped = oa.frontality > ob.frontality ? b : a
        for (const box of frameBoxes) if (box !== dropped) out.push(box)
        continue
      }
    }
    out.push(...frameBoxes)
  }
  return out
}

/** L'instant, dans `[shot.start, shot.end)`, où l'empan (aujourd'hui) est le plus large — le plus défavorable. */
function widestInstant(analysis: Analysis, shot: Shot): number | null {
  const inWindow = analysis.boxes.filter((b) => b.t >= shot.start && b.t < shot.end)
  const byFrame = groupByFrame(inWindow)
  let best: { t: number; width: number } | null = null
  for (const [key, boxes] of byFrame) {
    const width = requiredWidths(boxes)[0]
    if (width === undefined) continue
    if (best === null || width > best.width) best = { t: key / 1000, width }
  }
  return best?.t ?? null
}

/** Le ratio et le `cropX` que `computeFraming` rend pour ce seul plan, sur cette population. */
function frameShot(analysis: Analysis, shot: Shot, people: PersonBox[]): { ratio: Ratio; cropX: number } {
  const framing = computeFraming({
    segments: [{ start: shot.start, end: shot.end }],
    shots: analysis.shots,
    people,
    srcW: analysis.source.w,
    srcH: analysis.source.h,
    ratio: 'auto',
    cropMode: 'auto',
  })
  const found = framing.shots.find((s) => s.shot.start === shot.start && s.shot.end === shot.end)
  if (found === undefined) {
    throw new Error(`computeFraming n'a rendu aucun plan pour [${shot.start} ; ${shot.end}).`)
  }
  return { ratio: found.ratio, cropX: found.cropX }
}

// ---------------------------------------------------------------------------
// Le rendu ffmpeg d'un panneau composé — la même construction que
// `blurredVariantArgs` (`src/core/ffmpeg/args.ts`), pour une image fixe.
// ---------------------------------------------------------------------------

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || 'ffmpeg'
}

/**
 * Le flou du fond. Même valeur que `BACKGROUND_SIGMA` dans
 * `src/core/ffmpeg/args.ts` — recopiée, pas importée : ce n'est pas un calcul
 * de cadrage exporté, et `src/core/ffmpeg/args.ts` n'est pas de ce spike.
 */
const BACKGROUND_SIGMA_SPIKE = 12

function extractFrame(proxy: string, t: number): Buffer {
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
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
  )
}

/**
 * Le panneau composé : crop, puis fond flouté (tiré du crop, avant toute
 * incrustation) et plan posé dessus à sa taille — voir `buildRender` dans
 * `src/core/ffmpeg/args.ts` autour de la ligne 664. Reproduit, pas inventé :
 * même ordre de filtres, même `force_original_aspect_ratio=increase`, même
 * `overlay=x=0:y=(H-h)/2`.
 */
function renderComposedPanel(
  proxy: string,
  t: number,
  ratio: Ratio,
  cropX: number,
  proxyW: number,
  proxyH: number,
): Buffer {
  const canvas = outputSize('9:16')
  const crop = cropRect(ratio, cropX, proxyW, proxyH)
  const inCanvas = sizeInCanvas(ratio, canvas)
  const cropFilter = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`

  const filter =
    inCanvas.h >= canvas.h
      ? `[0:v]${cropFilter},scale=${canvas.w}:${canvas.h}:flags=lanczos,setsar=1[out]`
      : [
          `[0:v]${cropFilter},setsar=1[c]`,
          `[c]split=2[bga][fga]`,
          `[bga]scale=${canvas.w}:${canvas.h}:force_original_aspect_ratio=increase,` +
            `crop=${canvas.w}:${canvas.h},gblur=sigma=${BACKGROUND_SIGMA_SPIKE}[bg]`,
          `[fga]scale=${canvas.w}:${inCanvas.h}:flags=lanczos[fg]`,
          `[bg][fg]overlay=x=0:y=(H-h)/2,setsar=1[out]`,
        ].join(';')

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
      '-filter_complex',
      filter,
      '-map',
      '[out]',
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
// Le panneau source annoté — dessiné avec @napi-rs/canvas, pas ffmpeg :
// c'est le seul des trois qui porte du texte (la frontalité de chacun).
// ---------------------------------------------------------------------------

const COLOR_GRAY = 'gray'
const COLOR_RED = 'red'
const COLOR_LIME = 'lime'
const COLOR_CYAN = 'cyan'
const COLOR_MAGENTA = 'magenta'
const COLOR_YELLOW = 'yellow'
const COLOR_ORANGE = 'orange'
const COLOR_BACKGROUND = '#14161c'
const COLOR_TITLE = '#f2f4f8'
const COLOR_SUBTITLE = '#9aa4b2'
const COLOR_CAPTION = '#c9d1db'
const COLOR_CELL_BORDER = '#454c60'

type CropPx = { x: number; y: number; w: number; h: number }

/** Le sort d'une boîte — les mêmes trois couleurs que `framing-thumbnails.ts`. */
function boxColor(b: PersonBox): string {
  if (!(b.score >= FRAMING_DEFAULTS.minScore)) return COLOR_GRAY
  return isForeground(b) ? COLOR_RED : COLOR_LIME
}

async function renderSourcePanel(
  proxy: string,
  t: number,
  boxesAtT: PersonBox[],
  proxyW: number,
  proxyH: number,
  todayCrop: CropPx,
  candidateCrop: CropPx,
): Promise<Canvas> {
  const raw = extractFrame(proxy, t)
  const img = await loadImage(raw)
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)

  for (const b of boxesAtT) {
    const color = boxColor(b)
    const kept = color === COLOR_LIME
    const x = b.x0 * proxyW
    const y = b.y0 * proxyH
    const w = (b.x1 - b.x0) * proxyW
    const h = (b.y1 - b.y0) * proxyH
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.strokeRect(x, y, w, h)
    if (!kept) continue

    // Le tronc : ce que le cadrage exige vraiment de cette personne.
    const bounds = personBounds(b)
    ctx.strokeStyle = COLOR_CYAN
    ctx.lineWidth = 1
    ctx.strokeRect(bounds.x0 * proxyW, y, Math.max(1, (bounds.x1 - bounds.x0) * proxyW), h)

    const head = headBounds(b)
    if (head !== null) {
      ctx.strokeStyle = COLOR_MAGENTA
      ctx.lineWidth = 2
      ctx.strokeRect(
        head.x0 * proxyW,
        head.y0 * proxyH,
        Math.max(3, (head.x1 - head.x0) * proxyW),
        Math.max(3, (head.y1 - head.y0) * proxyH),
      )
    }

    const orientation = orientationOf(b)
    const label =
      orientation.frontality === null
        ? `frontality=${orientation.facing}`
        : `frontality=${orientation.frontality.toFixed(2)}`
    ctx.font = '13px monospace'
    ctx.fillStyle = color
    ctx.textBaseline = 'bottom'
    const labelY = y - 2 < 12 ? y + h + 13 : y - 2
    ctx.fillText(label, x + 2, labelY)
  }

  ctx.setLineDash([])
  ctx.strokeStyle = COLOR_YELLOW
  ctx.lineWidth = 4
  ctx.strokeRect(todayCrop.x, todayCrop.y, todayCrop.w, todayCrop.h)

  ctx.setLineDash([10, 6])
  ctx.strokeStyle = COLOR_ORANGE
  ctx.lineWidth = 3
  ctx.strokeRect(candidateCrop.x, candidateCrop.y, candidateCrop.w, candidateCrop.h)
  ctx.setLineDash([])

  return canvas
}

// ---------------------------------------------------------------------------
// La planche finale : trois panneaux à la même hauteur, un bandeau de
// réglages en haut — reprend l'ossature de `renderSheet` dans
// `orientation-sheet.ts`.
// ---------------------------------------------------------------------------

const TARGET_HEIGHT = 640
const PANEL_GAP = 20
const CAPTION_LINES = 2
const CAPTION_LINE_HEIGHT = 16
const CAPTION_PAD_TOP = 8
const HEADER_TOP_PAD = 16
const HEADER_TITLE_HEIGHT = 26
const HEADER_SUB_LINE_HEIGHT = 15
const HEADER_BOTTOM_PAD = 16

type Panel = { image: Image | Canvas; caption: string[] }

async function composeFigure(panels: Panel[], title: string, subtitle: string[], outFile: string): Promise<void> {
  const scaled = panels.map((p) => {
    const scale = TARGET_HEIGHT / p.image.height
    return { ...p, w: Math.max(1, Math.round(p.image.width * scale)), h: TARGET_HEIGHT }
  })
  const captionH = CAPTION_PAD_TOP + CAPTION_LINES * CAPTION_LINE_HEIGHT
  const gridW = scaled.reduce((sum, p) => sum + p.w, 0) + PANEL_GAP * (scaled.length + 1)
  const headerH = HEADER_TOP_PAD + HEADER_TITLE_HEIGHT + subtitle.length * HEADER_SUB_LINE_HEIGHT + HEADER_BOTTOM_PAD
  const totalH = headerH + PANEL_GAP + TARGET_HEIGHT + captionH + PANEL_GAP

  const canvas = createCanvas(gridW, totalH)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = COLOR_BACKGROUND
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.textBaseline = 'top'
  ctx.fillStyle = COLOR_TITLE
  ctx.font = 'bold 18px sans-serif'
  ctx.fillText(title, 16, HEADER_TOP_PAD)
  ctx.fillStyle = COLOR_SUBTITLE
  ctx.font = '12px monospace'
  subtitle.forEach((line, i) => {
    ctx.fillText(line, 16, HEADER_TOP_PAD + HEADER_TITLE_HEIGHT + i * HEADER_SUB_LINE_HEIGHT)
  })

  let x = PANEL_GAP
  const y = headerH + PANEL_GAP
  for (const p of scaled) {
    ctx.drawImage(p.image, x, y, p.w, p.h)
    ctx.strokeStyle = COLOR_CELL_BORDER
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, p.w - 1, p.h - 1)
    ctx.fillStyle = COLOR_CAPTION
    ctx.font = '12px monospace'
    p.caption.forEach((line, i) => {
      ctx.fillText(line, x + 2, y + p.h + CAPTION_PAD_TOP + i * CAPTION_LINE_HEIGHT)
    })
    x += p.w + PANEL_GAP
  }

  await fs.promises.writeFile(outFile, canvas.toBuffer('image/png'))
}

// ---------------------------------------------------------------------------
// Un cas ou un contrôle, rendu de bout en bout.
// ---------------------------------------------------------------------------

type Kind = 'case' | 'control-frontal' | 'control-solo' | 'control-profile'

function titleFor(kind: Kind): string {
  switch (kind) {
    case 'case':
      return 'Cas 2 — écarter la personne de profil'
    case 'control-frontal':
      return 'Contrôle — deux personnes de face (écart de frontalité faible)'
    case 'control-solo':
      return 'Contrôle — une seule personne'
    case 'control-profile':
      return 'Contrôle — deux personnes de profil'
  }
}

type ComparisonResult = {
  kind: Kind
  project: string
  shot: Shot
  t: number
  todayRatio: Ratio
  todayCropX: number
  candidateRatio: Ratio
  candidateCropX: number
  identical: boolean
  divergesFromJson: boolean
  file: string
}

async function renderComparison(
  kind: Kind,
  index: number,
  project: string,
  shot: Shot,
  analysis: Analysis,
  outDir: string,
  expectedRatio: Ratio | undefined,
): Promise<ComparisonResult> {
  const proxy = proxyPath(project)
  if (!fs.existsSync(proxy)) {
    throw new Error(`Proxy introuvable pour ${project} : ${proxy}`)
  }

  const boxesInShot = analysis.boxes.filter((b) => b.t >= shot.start && b.t < shot.end)
  const today = frameShot(analysis, shot, boxesInShot)
  const candidateBoxes = dropProfilePerson(boxesInShot)
  const candidate = frameShot(analysis, shot, candidateBoxes)

  const divergesFromJson = expectedRatio !== undefined && expectedRatio !== today.ratio
  if (divergesFromJson) {
    console.error(
      `  ATTENTION : ${project} [${shot.start.toFixed(1)} ; ${shot.end.toFixed(1)}) — le JSON annonce ` +
        `${String(expectedRatio)}, ce script recalcule ${today.ratio} en traitant le plan entier comme monté. ` +
        `Voir l'en-tête du script.`,
    )
  }

  const t = widestInstant(analysis, shot) ?? (shot.start + shot.end) / 2
  const roundedT = Math.round(t * 1000)
  const framesAtT = analysis.boxes.filter((b) => Math.round(b.t * 1000) === roundedT)

  const proxyW = analysis.proxy.w
  const proxyH = analysis.proxy.h
  const todayCropPx = cropRect(today.ratio, today.cropX, proxyW, proxyH)
  const candidateCropPx = cropRect(candidate.ratio, candidate.cropX, proxyW, proxyH)

  const sourcePanel = await renderSourcePanel(proxy, t, framesAtT, proxyW, proxyH, todayCropPx, candidateCropPx)
  const todayImg = await loadImage(renderComposedPanel(proxy, t, today.ratio, today.cropX, proxyW, proxyH))
  const candidateImg = await loadImage(
    renderComposedPanel(proxy, t, candidate.ratio, candidate.cropX, proxyW, proxyH),
  )

  const identical = today.ratio === candidate.ratio && Math.abs(today.cropX - candidate.cropX) < 1e-6
  const canvasSize = outputSize('9:16')
  const todayCoverage = (sizeInCanvas(today.ratio, canvasSize).h / canvasSize.h) * 100
  const candidateCoverage = (sizeInCanvas(candidate.ratio, canvasSize).h / canvasSize.h) * 100

  const title = `${titleFor(kind)} — ${project} ${shot.start.toFixed(1)}→${shot.end.toFixed(1)} s — t=${t.toFixed(1)} s`
  const subtitle = [
    `FRAMING_DEFAULTS  minScore=${FRAMING_DEFAULTS.minScore} margin=${FRAMING_DEFAULTS.margin} ` +
      `bottomEdge=${FRAMING_DEFAULTS.bottomEdge} foregroundMaxHeight=${FRAMING_DEFAULTS.foregroundMaxHeight} ` +
      `sideTrim=${FRAMING_DEFAULTS.sideTrim} sideTrimMax=${FRAMING_DEFAULTS.sideTrimMax}`,
    `torso=${FRAMING_DEFAULTS.torso} torsoMinScore=${FRAMING_DEFAULTS.torsoMinScore} ` +
      `torsoPad=${FRAMING_DEFAULTS.torsoPad} torsoTrim=${FRAMING_DEFAULTS.torsoTrim}`,
    `ORIENTATION_DEFAULTS  frontalThreshold=${ORIENTATION_DEFAULTS.frontalThreshold} ` +
      `sideDeadband=${ORIENTATION_DEFAULTS.sideDeadband} shoulderRatioFull=${ORIENTATION_DEFAULTS.shoulderRatioFull} ` +
      `— écart de frontalité retenu pour écarter une personne : ${FRONTAL_GAP_MARGIN}`,
    kind === 'case'
      ? "candidat : la personne la moins frontale est écartée du calcul d'empan, image par image, quand l'écart dépasse le seuil ci-dessus"
      : `contrôle : la règle ne devrait rien changer sur ce plan — panneaux identiques : ${identical ? 'oui' : 'NON, voir ci-dessous'}`,
  ]

  const panels: Panel[] = [
    {
      image: sourcePanel,
      caption: [
        `source — ${project} t=${t.toFixed(1)} s`,
        `jaune=crop aujourd'hui (${today.ratio})  orange=crop candidat (${candidate.ratio})`,
      ],
    },
    {
      image: todayImg,
      caption: [`aujourd'hui — ${today.ratio}`, `${todayCoverage.toFixed(1)} % de hauteur de canevas`],
    },
    {
      image: candidateImg,
      caption: [
        `candidat — ${candidate.ratio}`,
        `${candidateCoverage.toFixed(1)} % de hauteur de canevas${identical ? '  (identique à aujourd’hui)' : ''}`,
      ],
    },
  ]

  const file = path.join(
    outDir,
    `${String(index).padStart(2, '0')}-${kind}-${project}_${Math.round(shot.start * 1000)}-${Math.round(shot.end * 1000)}.png`,
  )
  await composeFigure(panels, title, subtitle, file)

  return {
    kind,
    project,
    shot,
    t,
    todayRatio: today.ratio,
    todayCropX: today.cropX,
    candidateRatio: candidate.ratio,
    candidateCropX: candidate.cropX,
    identical,
    divergesFromJson,
    file,
  }
}

// ---------------------------------------------------------------------------
// Ligne de commande.
// ---------------------------------------------------------------------------

function usage(): string {
  return (
    'Usage : pnpm tsx scripts/spike/orientation-ab.ts --json <fichier addressable.json> ' +
    '[--cases 6] [--controls 3] [--seed 1] [--out <dossier>]'
  )
}

function intFlag(
  value: (flag: string) => string | undefined,
  present: (flag: string) => boolean,
  flag: string,
  defaultValue: number,
  min: number,
): number | undefined {
  const raw = value(flag)
  // **Un drapeau présent sans valeur n'est pas un drapeau absent.** Les deux
  // rendaient `undefined`, donc `--seed --out /tmp/x` prenait le défaut en
  // silence et l'instrument mesurait sous d'autres réglages que l'invocation
  // affichée — ce que la ligne au-dessus promet justement de refuser.
  // (relevé par Copilot)
  if (raw === undefined) {
    if (!present(flag)) return defaultValue
    console.error(`${flag} attend un entier ≥ ${min}, reçu sans valeur.`)
    return undefined
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) {
    console.error(`${flag} attend un entier ≥ ${min}, reçu « ${raw} ».`)
    return undefined
  }
  return n
}

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const value = (flag: string): string | undefined => {
    const i = arguments_.indexOf(flag)
    if (i < 0) return undefined
    const raw = arguments_[i + 1]
    return raw === undefined || raw.startsWith('--') ? undefined : raw
  }
  /** Le drapeau est-il écrit ? Distinct de « porte-t-il une valeur ». */
  const present = (flag: string): boolean => arguments_.includes(flag)
  /** Une chaîne facultative : absente vaut le défaut, présente et vide se refuse. */
  const stringFlag = (flag: string, defaultValue: string): string | undefined => {
    const raw = value(flag)
    if (raw !== undefined) return raw
    if (!present(flag)) return defaultValue
    console.error(`${flag} attend une valeur.`)
    return undefined
  }

  const jsonPath = value('--json')
  if (jsonPath === undefined) {
    console.error(usage())
    return 1
  }

  const casesCount = intFlag(value, present, '--cases', 6, 0)
  const controlsCount = intFlag(value, present, '--controls', 3, 0)
  const seed = intFlag(value, present, '--seed', 1, Number.MIN_SAFE_INTEGER)
  if (casesCount === undefined || controlsCount === undefined || seed === undefined) {
    console.error(usage())
    return 1
  }

  const outDir = stringFlag('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'orientation-ab-')))
  if (outDir === undefined) return 1
  fs.mkdirSync(outDir, { recursive: true })

  const data = readAddressableJson(jsonPath)
  const rng = makeRng(seed)

  const analyses = new Map<string, Analysis>()
  for (const project of Object.keys(data)) {
    const file = analysisPath(project)
    if (!fs.existsSync(file)) {
      console.error(`${project} : pas d'analyse (${file}), ignoré.`)
      continue
    }
    analyses.set(project, lireAnalysis(file))
  }
  if (analyses.size === 0) {
    console.error("Aucune analyse disponible pour les émissions du JSON.")
    return 1
  }

  const casePool = shuffleInPlace(collectCase2Candidates(data), rng)
  const cases = casePool.slice(0, casesCount)
  console.log(
    `Cas 2 : ${cases.length}/${casesCount} demandé(s), sur un gisement de ${casePool.length} plan(s) au total.`,
  )

  type PendingControl = { kind: Kind; project: string; shot: Shot; expectedRatio: Ratio | undefined }
  const pendingControls: PendingControl[] = []

  if (controlsCount >= 1) {
    const pool = collectControl1Candidates(data)
    const near = pool.filter((c) => c.gap < 0.15)
    const from = near.length > 0 ? near : pool.slice(0, 1)
    const picked = shuffleInPlace([...from], rng)[0]
    if (picked === undefined) {
      console.error('Contrôle « deux personnes de face » : aucun plan à écart de frontalité connu dans le JSON.')
    } else {
      pendingControls.push({
        kind: 'control-frontal',
        project: picked.project,
        shot: { start: picked.plan.start, end: picked.plan.end },
        expectedRatio: picked.plan.ratio,
      })
    }
  }

  if (controlsCount >= 2) {
    const pool = shuffleInPlace(findControlSoloShots(data, analyses), rng)
    const picked = pool[0]
    if (picked === undefined) {
      console.error("Contrôle « une seule personne » : aucun plan trouvé dans le corpus.")
    } else {
      pendingControls.push({
        kind: 'control-solo',
        project: picked.project,
        shot: picked.shot,
        expectedRatio: undefined,
      })
    }
  }

  if (controlsCount >= 3) {
    const pool = shuffleInPlace(findControlProfileShots(data, analyses), rng)
    const picked = pool[0]
    if (picked === undefined) {
      console.error("Contrôle « deux personnes de profil » : aucun plan trouvé dans le corpus (posture rare, tenu pour acquis).")
    } else {
      console.log(
        `  contrôle profil : ${picked.project} [${picked.shot.start.toFixed(1)} ; ${picked.shot.end.toFixed(1)}) ` +
          `frontalité médiane gauche=${picked.medianA.toFixed(2)} droite=${picked.medianB.toFixed(2)}`,
      )
      pendingControls.push({
        kind: 'control-profile',
        project: picked.project,
        shot: picked.shot,
        expectedRatio: undefined,
      })
    }
  }

  const results: ComparisonResult[] = []
  let index = 1

  for (const c of cases) {
    const analysis = analyses.get(c.project)
    if (analysis === undefined) continue
    results.push(
      await renderComparison(
        'case',
        index++,
        c.project,
        { start: c.plan.start, end: c.plan.end },
        analysis,
        outDir,
        c.plan.ratio,
      ),
    )
  }

  for (const c of pendingControls) {
    const analysis = analyses.get(c.project)
    if (analysis === undefined) continue
    results.push(await renderComparison(c.kind, index++, c.project, c.shot, analysis, outDir, c.expectedRatio))
  }

  console.log('')
  console.log(`${results.length} image(s) écrite(s) dans ${outDir} :`)
  for (const r of results) {
    const flag = r.kind === 'case' ? (r.identical ? 'PAS DE GAIN' : 'gain') : r.identical ? 'identique' : 'DIVERGE'
    console.log(
      `  ${r.file}` +
        `\n    ${r.kind.padEnd(16)} ${r.project} [${r.shot.start.toFixed(1)} ; ${r.shot.end.toFixed(1)}) t=${r.t.toFixed(1)}` +
        ` — aujourd'hui ${r.todayRatio} (cropX ${r.todayCropX.toFixed(3)}), candidat ${r.candidateRatio} (cropX ${r.candidateCropX.toFixed(3)}) — ${flag}` +
        (r.divergesFromJson ? '  [ratio recalculé ≠ JSON, voir ci-dessus]' : ''),
    )
  }

  return 0
}

void main().then(quit, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quit(1)
})
