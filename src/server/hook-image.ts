import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { GlobalFonts, createCanvas, type FontKey } from '@napi-rs/canvas'

import {
  hookGeometry,
  hookIsBurned,
  hookLayout,
  hookPlacement,
  hookRgba,
  type HookMeasure,
  type ResolvedHook,
} from '@/core/hook'

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
 * mémorisée par dossier, `GlobalFonts` étant un registre global à
 * `@napi-rs/canvas` et non un état par instance de canevas.
 *
 * **Keyée sur le contenu du fichier, pas seulement sur le dossier.** Un
 * premier passage qui ne rechargeait jamais après le premier rendu rendait
 * inopérant le remplacement d'Anton que l'empreinte (`fontsDigest`,
 * `src/server/steps/render.ts`) prétend pourtant gérer : le condensat de
 * police change, le rendu se déclare périmé et se relance — mais rasterisait
 * encore avec l'ancienne police en mémoire, certifiant un PNG incohérent
 * avec le condensat qui venait de le déclarer à jour. Relevé par Copilot sur
 * la PR #117. `registerFromPath` de `@napi-rs/canvas` 1.0.7 déduplique en
 * plus par **chemin**, pas par contenu : rappeler la fonction sur le même
 * chemin sans retirer l'ancienne entrée ne rechargerait pas non plus les
 * octets — d'où le `GlobalFonts.remove(oldKey)` avant de réenregistrer.
 */
const registeredFonts = new Map<string, { digest: string; key: FontKey | null }>()

/** `sha256` du fichier, tronqué : assez pour détecter un remplacement, pas pour l'identifier de façon cryptographique — le même usage que `fontsDigest`. */
function fileDigest(file: string): string {
  const bytes = fs.readFileSync(file)
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

/**
 * Exportée pour `src/server/caption-measure.ts`, qui a besoin de la même
 * police enregistrée pour mesurer ce que libass tracera — deux trackers
 * indépendants sur le même `GlobalFonts` se marcheraient dessus.
 */
export function ensureFontRegistered(fontsDir: string): void {
  const file = path.join(fontsDir, 'Anton-Regular.ttf')
  let digest: string
  try {
    digest = fileDigest(file)
  } catch (error) {
    console.warn(
      `Police Anton illisible (${file}) : ${error instanceof Error ? error.message : 'erreur inconnue'}.`,
    )
    return
  }
  const cached = registeredFonts.get(fontsDir)
  if (cached !== undefined && cached.digest === digest) return

  if (cached?.key !== null && cached?.key !== undefined) GlobalFonts.remove(cached.key)

  const registered = GlobalFonts.registerFromPath(file, 'Anton')
  if (registered === null) {
    console.warn(
      `Police Anton introuvable (${file}) : l'appelant se repliera sur la police par défaut ` +
        'du système, ce qui ne ressemblera pas au rendu attendu.',
    )
  }
  // On mémorise le digest même en cas d'échec d'enregistrement : sinon
  // chaque appel retenterait `registerFromPath` sur le même fichier cassé,
  // ce que le `Set` d'origine évitait déjà pour le cas nominal.
  registeredFonts.set(fontsDir, { digest, key: registered })
}

/**
 * Un `HookMeasure` adossé à `@napi-rs/canvas` — un canevas 1×1 jetable par
 * taille de police, `measureText` n'ayant besoin d'aucune surface réelle.
 */
function measurerFor(family: string): HookMeasure {
  return (fontSizePx) => {
    const ctx = createCanvas(1, 1).getContext('2d')
    ctx.font = `${fontSizePx}px ${family}`
    return (text) => ctx.measureText(text).width
  }
}

/**
 * Le PNG du hook, ou `null` quand il n'y a rien à incruster (`hookIsBurned`).
 * **La géométrie vient de `hookGeometry` (`@/core/hook`)** — ce fichier ne
 * fait plus que peindre le résultat.
 *
 * **L'image est un COMPOSITE** : la pastille du badge, quand il y en a un,
 * est dessinée dans le même PNG que le carton — jamais deux fichiers, pour
 * ne pas décaler `logoInputOffset` (`@/core/ffmpeg/args`) ni dédoubler
 * `PathsRender`. `renderClip` ne sait même pas qu'un badge existe.
 */
export function renderHookImage(
  resolved: ResolvedHook,
  canvas: { w: number; h: number },
  fontsDir: string,
): HookImage | null {
  if (!hookIsBurned(resolved)) return null
  ensureFontRegistered(fontsDir)

  const family = resolved.font
  const layout = hookLayout(resolved)
  const geometry = hookGeometry(resolved, canvas, measurerFor(family))
  const {
    lines,
    badgeText,
    hasBadge,
    fontSizePx,
    lineHeightPx,
    paddingXPx,
    paddingYPx,
    badgeFontSizePx,
    badgePaddingXPx,
    cardWidth,
    cardHeightDrawn,
    cardTop,
    cardX,
    badgeWidth,
    badgeHeight,
    badgeX,
    compositeWidth,
    compositeHeight,
  } = geometry

  const image = createCanvas(compositeWidth, compositeHeight)
  const ctx = image.getContext('2d')

  // **LE CARTON D'ABORD, la pastille ensuite, et l'ordre est une exigence.**
  // La pastille mord sur le bord haut du carton : peinte avant, le fond
  // opaque du carton en effacerait la partie basse. Tout le dessin tient
  // là-dedans. (Le calque de preview a le problème inverse — dans le DOM,
  // c'est le frère SUIVANT qui recouvre — d'où le `zIndex` qu'il porte.)
  ctx.fillStyle = hookRgba(resolved.backgroundColor, resolved.backgroundOpacity)
  ctx.beginPath()
  // Le rayon ne dépasse jamais la moitié du plus petit côté : au-delà, un
  // arc de cercle de rayon supérieur à la moitié de la boîte ne se distingue
  // plus d'une gélule, et `roundRect` en déborderait de toute façon sur une
  // boîte étroite (hook d'un seul caractère, réglage de rayon extrême).
  ctx.roundRect(
    cardX,
    cardTop,
    cardWidth,
    cardHeightDrawn,
    Math.min(canvas.w * layout.radiusFraction, cardWidth / 2, cardHeightDrawn / 2),
  )
  ctx.fill()

  ctx.font = `${fontSizePx}px ${family}`
  ctx.fillStyle = resolved.textColor
  ctx.textBaseline = 'middle'
  ctx.textAlign = resolved.alignment
  const textX =
    cardX +
    (resolved.alignment === 'left'
      ? paddingXPx
      : resolved.alignment === 'right'
        ? cardWidth - paddingXPx
        : cardWidth / 2)

  lines.forEach((line, i) => {
    const y = cardTop + paddingYPx + lineHeightPx * i + lineHeightPx / 2
    ctx.fillText(line, textX, y)
  })

  if (hasBadge) {
    // **`badgeBackground` NU, jamais `hookRgba`.** `backgroundOpacity` est le
    // réglage du CARTON, et une pastille translucide laisserait voir le
    // carton au travers dans la zone de chevauchement — ce qui se lirait
    // comme un raté, pas comme un effet.
    ctx.fillStyle = resolved.badgeBackground
    ctx.beginPath()
    ctx.roundRect(
      badgeX,
      0,
      badgeWidth,
      badgeHeight,
      Math.min(canvas.w * layout.badgeRadiusFraction, badgeWidth / 2, badgeHeight / 2),
    )
    ctx.fill()

    ctx.font = `${badgeFontSizePx}px ${family}`
    ctx.fillStyle = resolved.badgeColor
    ctx.textBaseline = 'middle'
    ctx.textAlign = resolved.alignment
    const badgeTextX =
      badgeX +
      (resolved.alignment === 'left'
        ? badgePaddingXPx
        : resolved.alignment === 'right'
          ? badgeWidth - badgePaddingXPx
          : badgeWidth / 2)
    ctx.fillText(badgeText, badgeTextX, badgeHeight / 2)
  }

  const buffer = image.toBuffer('image/png')
  const { x, y } = hookPlacement({ w: compositeWidth, h: compositeHeight }, canvas, resolved, layout)

  return { buffer, width: compositeWidth, height: compositeHeight, x, y }
}
