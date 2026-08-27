/**
 * Trois compositions de doublage improvise, rendues sur des instants reels.
 *
 *     pnpm tsx scripts/spike/dubbing-ab.ts
 *
 * Aucune option : les instants sont fixes (contrat de la PR). Modele sur
 * `scripts/spike/subshot-ab.ts` (`stackArgs`) — filtergraph ecrit a la main,
 * rendu reel, pas de detection.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'

import { videoEncodedArgs } from '@/core/ffmpeg/encoder'
import { encoderName, ffmpegBin, ffprobeBin, runFfmpeg } from '@/server/ffmpeg'
import { resolveSource } from '@/server/paths'
import { chargerEnv, quit } from '../dev-common'

// ---------------------------------------------------------------------------
// Geometrie mesuree par l'orchestrateur, sur le proxy 960x540 (contrat §2).
// ---------------------------------------------------------------------------

/** Les sources sont toutes en 1920x1080 (CLAUDE.md) ; verifie a l'execution. */
const SOURCE = { w: 1920, h: 1080 } as const

/** Le disque des comediens, en fractions de la source. */
const DISC_FRACTION = { x0: 0.777, y0: 0.07, x1: 0.988, y1: 0.444 } as const

/** Le haut de la bande rythmo, en fraction de la hauteur source. */
const STRIP_Y_FRACTION = 0.926

const CANVAS = { w: 1080, h: 1920 } as const

type Rect = { x: number; w: number; y: number; h: number }

/** Le plus grand entier pair inferieur ou egal a `n` — ffmpeg/yuv420p veut du pair. */
function evenFloor(n: number): number {
  const f = Math.floor(n)
  return f % 2 === 0 ? f : f - 1
}

const discPx: Rect = {
  x: evenFloor(DISC_FRACTION.x0 * SOURCE.w),
  y: evenFloor(DISC_FRACTION.y0 * SOURCE.h),
  w: evenFloor((DISC_FRACTION.x1 - DISC_FRACTION.x0) * SOURCE.w),
  h: evenFloor((DISC_FRACTION.y1 - DISC_FRACTION.y0) * SOURCE.h),
}
const stripTopPx = evenFloor(STRIP_Y_FRACTION * SOURCE.h)
const stripPx: Rect = { x: 0, y: stripTopPx, w: SOURCE.w, h: SOURCE.h - stripTopPx }
const filmFullPx: Rect = { x: 0, y: 0, w: SOURCE.w, h: stripTopPx }
const filmNarrowPx: Rect = { x: 0, y: 0, w: discPx.x, h: stripTopPx }

/** La hauteur d'un pave une fois mis a la largeur du canevas, aspect conserve. */
function scaledHeight(rect: Rect): number {
  return evenFloor((rect.h / rect.w) * CANVAS.w)
}

type VariantId = 'A' | 'B' | 'C'

type Variant = {
  id: VariantId
  label: string
  film: { crop: Rect; h: number }
  pip: { crop: Rect; h: number } | null
  strip: { crop: Rect; h: number }
}

function makeVariant(id: VariantId, label: string, film: Rect, withPip: boolean): Variant {
  return {
    id,
    label,
    film: { crop: film, h: scaledHeight(film) },
    pip: withPip ? { crop: discPx, h: scaledHeight(discPx) } : null,
    strip: { crop: stripPx, h: scaledHeight(stripPx) },
  }
}

const VARIANTS: readonly Variant[] = [
  makeVariant('A', 'A - plein cadre + PiP', filmFullPx, true),
  makeVariant('B', 'B - film retreci + PiP', filmNarrowPx, true),
  makeVariant('C', 'C - plein cadre, sans PiP', filmFullPx, false),
]

// ---------------------------------------------------------------------------
// Le filtergraph.
// ---------------------------------------------------------------------------

const crop = (r: Rect): string => `crop=${r.w}:${r.h}:${r.x}:${r.y}`

/**
 * Le masque circulaire d'un pave PiP : `lum`/`cb`/`cr` recopient l'image,
 * `a` s'annule hors de l'ellipse inscrite dans le rectangle scale.
 */
const CIRCLE_ALPHA =
  "if(lte((X-W/2)*(X-W/2)/((W/2)*(W/2))+(Y-H/2)*(Y-H/2)/((H/2)*(H/2)),1),255,0)"

/** Le fond flou : la trame source entiere, avant toute incrustation (regle du depot). */
function backgroundChain(): string {
  return (
    `[0:v]fps=30,scale=${CANVAS.w}:${CANVAS.h}:force_original_aspect_ratio=increase,` +
    `crop=${CANVAS.w}:${CANVAS.h},gblur=sigma=12,setsar=1[bg]`
  )
}

/** Le pave "vout" d'une variante : fond, puis film, PiP eventuel, bande — empiles, centres. */
function buildFilterComplex(v: Variant): string {
  const graph: string[] = [backgroundChain()]
  const blockH = v.film.h + (v.pip?.h ?? 0) + v.strip.h
  const top = Math.round((CANVAS.h - blockH) / 2)

  graph.push(`[0:v]fps=30,${crop(v.film.crop)},scale=${CANVAS.w}:${v.film.h}:flags=lanczos,setsar=1[film]`)
  graph.push(`[bg][film]overlay=x=0:y=${top}[s1]`)
  let stage = 's1'
  let y = top + v.film.h
  let n = 1

  if (v.pip) {
    graph.push(
      `[0:v]fps=30,${crop(v.pip.crop)},scale=${CANVAS.w}:${v.pip.h}:flags=lanczos,format=yuva420p,` +
        `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${CIRCLE_ALPHA}'[pip]`,
    )
    n += 1
    graph.push(`[${stage}][pip]overlay=x=0:y=${y}[s${n}]`)
    stage = `s${n}`
    y += v.pip.h
  }

  graph.push(`[0:v]fps=30,${crop(v.strip.crop)},scale=${CANVAS.w}:${v.strip.h}:flags=lanczos,setsar=1[strip]`)
  n += 1
  graph.push(`[${stage}][strip]overlay=x=0:y=${y}[vout]`)

  return graph.join(';')
}

// ---------------------------------------------------------------------------
// Rendu : image fixe, extrait video, planche de contact.
// ---------------------------------------------------------------------------

function stillArgs(source: string, t: number, v: Variant, dst: string): string[] {
  return [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'warning',
    '-ss', t.toFixed(3),
    '-i', source,
    '-filter_complex', buildFilterComplex(v),
    '-map', '[vout]',
    '-an',
    '-frames:v', '1',
    '-update', '1',
    '--', dst,
  ]
}

function videoArgs(source: string, t: number, durationSec: number, v: Variant, dst: string): string[] {
  return [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'warning', '-stats',
    '-ss', t.toFixed(3),
    '-i', source,
    '-t', durationSec.toFixed(3),
    '-filter_complex', buildFilterComplex(v),
    '-map', '[vout]',
    '-map', '0:a',
    ...videoEncodedArgs(encoderName(), 'quality'),
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '--', dst,
  ]
}

/** Une etiquette "A" / "B" / "C" en PNG transparent, a la largeur du panneau. */
function writeLabelImage(text: string, panelW: number, dst: string): void {
  const h = 48
  const canvas = createCanvas(panelW, h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)'
  ctx.fillRect(0, 0, panelW, h)
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 22px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, panelW / 2, h / 2)
  fs.writeFileSync(dst, canvas.toBuffer('image/png'))
}

/** Les variantes d'un instant, cote a cote, etiquetees. */
async function buildContactSheet(
  stills: { id: VariantId; label: string; file: string }[],
  outDir: string,
  dst: string,
): Promise<void> {
  const panelW = 400
  const panelH = evenFloor((panelW * CANVAS.h) / CANVAS.w)
  const labelFiles = stills.map(({ id, label }) => {
    const p = path.join(outDir, `label-${id}.png`)
    writeLabelImage(label, panelW, p)
    return p
  })

  const graph: string[] = []
  stills.forEach((_, i) => {
    graph.push(`[${i}:v]scale=${panelW}:${panelH}:flags=lanczos,setsar=1[s${i}]`)
    graph.push(`[s${i}][${stills.length + i}:v]overlay=x=0:y=0[p${i}]`)
  })
  graph.push(`${stills.map((_, i) => `[p${i}]`).join('')}hstack=inputs=${stills.length}[v]`)

  await runFfmpeg(
    [
      '-hide_banner', '-nostdin', '-y', '-loglevel', 'warning',
      ...stills.flatMap(({ file }) => ['-i', file]),
      ...labelFiles.flatMap((file) => ['-i', file]),
      '-filter_complex', graph.join(';'),
      '-map', '[v]',
      '--', dst,
    ],
    { what: 'planche de contact' },
  )
}

// ---------------------------------------------------------------------------
// Verification d'entree : les sources sont bien 1920x1080, sinon la geometrie
// hardcodee ci-dessus ne veut rien dire.
// ---------------------------------------------------------------------------

function probeDimensions(file: string): { w: number; h: number } {
  const lines = execFileSync(
    ffprobeBin(),
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'default=nw=1', file],
    { encoding: 'utf8' },
  ).split('\n')
  const fields = new Map<string, string>()
  for (const line of lines) {
    const at = line.indexOf('=')
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  return { w: Number.parseInt(fields.get('width') ?? '', 10), h: Number.parseInt(fields.get('height') ?? '', 10) }
}

// ---------------------------------------------------------------------------
// Les instants du contrat (§5), fixes.
// ---------------------------------------------------------------------------

type Instant = { file: string; slug: string; t: number; video: boolean }

const INSTANTS: readonly Instant[] = [
  { file: '2026-22-02-entre-nous.mp4', slug: 'entre-nous-t6390', t: 6390, video: true },
  { file: '2026-22-02-entre-nous.mp4', slug: 'entre-nous-t2400', t: 2400, video: true },
  { file: '2026-03-08-caro-mdlm.mp4', slug: 'caro-mdlm-t5476', t: 5476, video: false },
]

const CLIP_DURATION_SEC = 20
const OUT_DIR = '/home/julien/dev/avolo-shorts/tmp/dubbing-spike'

function weight(file: string): string {
  return `${(fs.statSync(file).size / 1024 ** 2).toFixed(1)} Mio`
}

async function main(): Promise<number> {
  await chargerEnv()
  fs.mkdirSync(OUT_DIR, { recursive: true })

  console.log(`Encodeur : ${encoderName()}. ffmpeg : ${ffmpegBin()}.`)
  console.log(
    `Rectangles (px, source ${SOURCE.w}x${SOURCE.h}) : disque=${JSON.stringify(discPx)}, ` +
      `bande=${JSON.stringify(stripPx)}, film plein=${JSON.stringify(filmFullPx)}, ` +
      `film retreci=${JSON.stringify(filmNarrowPx)}.`,
  )

  const produced: string[] = []

  for (const instant of INSTANTS) {
    const source = resolveSource(instant.file)
    const dims = probeDimensions(source)
    if (dims.w !== SOURCE.w || dims.h !== SOURCE.h) {
      console.error(
        `${instant.file} fait ${dims.w}x${dims.h}, pas ${SOURCE.w}x${SOURCE.h} : la geometrie ` +
          'codee en dur dans ce script ne s\'applique pas. Arret.',
      )
      return 1
    }

    const stillFiles: { id: VariantId; label: string; file: string }[] = []
    for (const variant of VARIANTS) {
      const stillDst = path.join(OUT_DIR, `still_${instant.slug}_${variant.id}.png`)
      console.log(`Image : ${instant.slug} / ${variant.id} -> ${stillDst}`)
      await runFfmpeg(stillArgs(source, instant.t, variant, stillDst), { what: `image ${instant.slug}/${variant.id}` })
      stillFiles.push({ id: variant.id, label: variant.label, file: stillDst })
      produced.push(stillDst)

      if (instant.video) {
        const videoDst = path.join(OUT_DIR, `video_${instant.slug}_${variant.id}.mp4`)
        console.log(`Video : ${instant.slug} / ${variant.id} -> ${videoDst}`)
        await runFfmpeg(
          videoArgs(source, instant.t, CLIP_DURATION_SEC, variant, videoDst),
          { what: `video ${instant.slug}/${variant.id}`, durationSec: CLIP_DURATION_SEC },
        )
        produced.push(videoDst)
      }
    }

    const sheetDst = path.join(OUT_DIR, `contact_${instant.slug}.png`)
    console.log(`Planche : ${instant.slug} -> ${sheetDst}`)
    await buildContactSheet(stillFiles, OUT_DIR, sheetDst)
    produced.push(sheetDst)
  }

  console.log('\nFichiers produits :')
  for (const file of produced) console.log(`  ${file}  (${weight(file)})`)

  return 0
}

void main().then(quit, (e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e))
  quit(1)
})
