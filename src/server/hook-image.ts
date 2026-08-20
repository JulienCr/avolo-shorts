import path from 'node:path'
import { GlobalFonts, createCanvas, type SKRSContext2D } from '@napi-rs/canvas'

import { hookIsBurned, hookLayout, hookPlacement, hookRgba, type ResolvedHook } from '@/core/hook'

/**
 * Le rasteriseur du hook : `ResolvedHook` + un canevas → un PNG, fond plein à
 * coins arrondis qui épouse le texte, posé aux coordonnées où l'incruster.
 *
 * **Remplace `src/core/hook-ass.ts`, supprimé le 20 août 2026.** `BorderStyle:
 * 3` de l'ASS ne dessine que des angles droits, et une boîte par ligne — le
 * propriétaire du dépôt a regardé les rendus et demandé un fond plein à coins
 * arrondis qui épouse un texte court, ce que l'ASS ne sait pas faire. Le hook
 * s'incruste donc désormais en `overlay`, comme `logo.png`/`twitch.png`
 * (`src/core/ffmpeg/args.ts`), et non plus par un second document `ass=`.
 *
 * **`@napi-rs/canvas`, vérifié installable et fonctionnel sous WSL sur cette
 * machine** (binaire préconstruit, pas de compilation) : `GlobalFonts`
 * charge `fonts/Anton-Regular.ttf` explicitement, sans dépendre de
 * fontconfig ni d'une police installée sur l'hôte — la même contrainte que
 * `renderAss` tient déjà pour les sous-titres via `fontsdir=`.
 *
 * **Ce fichier vit dans `src/server/`, pas dans `src/core/`.** La frontière
 * de pureté (`tests/core/purete.test.ts`) refuse tout import hors `./`,
 * `@/core/` et `zod` — `@napi-rs/canvas` en est exclu. La géométrie pure
 * (`hookLayout`, `hookPlacement`, `hookRgba`) reste dans `@/core/hook`, seule
 * la rasterisation — mesure réelle du texte, dessin, encodage PNG — est ici.
 */

/** L'image PNG du hook, prête à être posée sur un canevas par `overlay=x:y`. */
export type HookImage = {
  buffer: Buffer
  width: number
  height: number
  x: number
  y: number
}

/**
 * `fonts/Anton-Regular.ttf` chargée sous le nom de famille `Anton` —
 * mémorisé par dossier pour ne l'enregistrer qu'une fois par processus,
 * `GlobalFonts` étant un registre global à `@napi-rs/canvas` et non un état
 * par instance de canevas.
 */
const registeredFontFolders = new Set<string>()

function ensureFontRegistered(fontsDir: string): void {
  if (registeredFontFolders.has(fontsDir)) return
  registeredFontFolders.add(fontsDir)
  const file = path.join(fontsDir, 'Anton-Regular.ttf')
  try {
    const registered = GlobalFonts.registerFromPath(file, 'Anton')
    if (registered === null) {
      console.warn(
        `Police Anton introuvable pour le hook (${file}) : le rasteriseur se repliera sur la ` +
          'police par défaut du système, ce qui ne ressemblera pas au rendu attendu.',
      )
    }
  } catch (error) {
    console.warn(
      `Police Anton illisible pour le hook (${file}) : ${error instanceof Error ? error.message : 'erreur inconnue'}.`,
    )
  }
}

/** Rond au pair le plus proche, jamais sous 2 — même contrainte que `scheduleMarkers` (chrominance sous-échantillonnée en yuv420p). */
function pairEven(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

/**
 * Découpe `text` en lignes qui tiennent chacune sous `maxWidthPx`, glouton et
 * **sans jamais couper un mot** — la même règle que `WrapStyle: 0` de l'ASS
 * tenait déjà, et que `normalizeHookText` tient pour ses propres plafonds.
 * Un mot seul plus large que `maxWidthPx` reste sur sa ligne : mieux vaut une
 * boîte qui déborde légèrement de sa largeur maximale visée qu'un mot
 * tranché en deux.
 */
function wrapLines(ctx: SKRSContext2D, text: string, maxWidthPx: number): string[] {
  const words = text.split(' ').filter((w) => w !== '')
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = words[0]
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`
    if (ctx.measureText(candidate).width <= maxWidthPx) {
      current = candidate
    } else {
      lines.push(current)
      current = word
    }
  }
  lines.push(current)
  return lines
}

/**
 * Le PNG du hook, ou `null` quand il n'y a rien à incruster — exactement
 * quand `hookIsBurned(resolved)` est faux, comme `renderHookAss` avant elle.
 *
 * **La boîte épouse le texte** : sa largeur est celle de la ligne la plus
 * large, mesurée réellement (`measureText`, pas une estimation), plus le
 * rembourrage ; sa hauteur suit le nombre de lignes après retour à la ligne.
 * Toutes les fractions viennent de `hookLayout(resolved)`, multipliées par
 * `canvas.w` — jamais `canvas.h` : voir la doc de `HookLayout` dans
 * `@/core/hook` sur pourquoi c'est un renversement délibéré.
 */
export function renderHookImage(
  resolved: ResolvedHook,
  canvas: { w: number; h: number },
  fontsDir: string,
): HookImage | null {
  if (!hookIsBurned(resolved)) return null
  ensureFontRegistered(fontsDir)

  const layout = hookLayout(resolved)
  const family = resolved.font
  const fontSizePx = Math.max(1, Math.round(canvas.w * layout.fontSizeFraction))
  const lineHeightPx = Math.max(1, Math.round(canvas.w * layout.lineHeightFraction))
  const paddingXPx = Math.round(canvas.w * layout.paddingXFraction)
  const paddingYPx = Math.round(canvas.w * layout.paddingYFraction)
  const maxTextWidthPx = Math.max(
    1,
    Math.round(canvas.w * layout.maxBoxWidthFraction) - 2 * paddingXPx,
  )

  const text = resolved.uppercase ? resolved.text.toUpperCase() : resolved.text

  // Un canevas 1×1 jetable, seulement pour mesurer : `measureText` n'a besoin
  // d'aucune surface réelle, et créer la boîte définitive avant de connaître
  // sa taille est impossible — c'est précisément ce que la boîte doit rendre.
  const measurer = createCanvas(1, 1).getContext('2d')
  measurer.font = `${fontSizePx}px ${family}`
  const lines = wrapLines(measurer, text, maxTextWidthPx)
  const textWidthPx = Math.max(...lines.map((l) => measurer.measureText(l).width))

  const boxWidth = pairEven(Math.ceil(textWidthPx) + 2 * paddingXPx)
  const boxHeight = pairEven(Math.ceil(lines.length * lineHeightPx) + 2 * paddingYPx)
  // Le rayon ne dépasse jamais la moitié du plus petit côté : au-delà, un
  // arc de cercle de rayon supérieur à la moitié de la boîte ne se distingue
  // plus d'une gélule, et `roundRect` en déborderait de toute façon sur une
  // boîte étroite (hook d'un seul caractère, réglage de rayon extrême).
  const radiusPx = Math.min(canvas.w * layout.radiusFraction, boxWidth / 2, boxHeight / 2)

  const image = createCanvas(boxWidth, boxHeight)
  const ctx = image.getContext('2d')

  ctx.fillStyle = hookRgba(resolved.backgroundColor, resolved.backgroundOpacity)
  ctx.beginPath()
  ctx.roundRect(0, 0, boxWidth, boxHeight, radiusPx)
  ctx.fill()

  ctx.font = `${fontSizePx}px ${family}`
  ctx.fillStyle = resolved.textColor
  ctx.textBaseline = 'middle'
  ctx.textAlign = resolved.alignment
  const textX =
    resolved.alignment === 'left'
      ? paddingXPx
      : resolved.alignment === 'right'
        ? boxWidth - paddingXPx
        : boxWidth / 2

  lines.forEach((line, i) => {
    const y = paddingYPx + lineHeightPx * i + lineHeightPx / 2
    ctx.fillText(line, textX, y)
  })

  const buffer = image.toBuffer('image/png')
  const { x, y } = hookPlacement({ w: boxWidth, h: boxHeight }, canvas, resolved, layout)

  return { buffer, width: boxWidth, height: boxHeight, x, y }
}
