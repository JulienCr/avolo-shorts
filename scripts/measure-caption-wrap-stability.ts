/**
 * La mise en lignes d'un carton de sous-titres saute-t-elle d'une image à
 * l'autre pendant une même séquence ?
 *
 *     pnpm tsx scripts/measure-caption-wrap-stability.ts
 *
 * **La question.** Avant cette PR, `renderAss` laisse `WrapStyle: 0` et
 * n'écrit aucun `\N` : libass recalcule le retour à la ligne à chaque image, à
 * partir de la largeur du mot actif — qui varie de 90 % à 108 % pendant les
 * 110 ms de l'effet `pop`. Un carton posé pile à la frontière peut donc
 * afficher une ligne à une image et deux à la suivante, en boucle. La PR fige
 * la coupure une fois par carton (`wrapCard`) et l'écrit en `\N` explicites
 * sous `WrapStyle: 2` : ce script compte les lignes réellement affichées,
 * image par image, pour prouver que le nombre change avant et reste constant
 * après.
 *
 * **Comment le carton frontière est trouvé.** Le texte candidat s'allonge mot
 * par mot jusqu'à ce que la version « legacy » (voir plus bas) affiche un
 * nombre de lignes différent d'une image à l'autre — c'est une mesure, donc
 * une recherche, pas une assertion : personne ne connaît a priori la largeur
 * d'« BONJOUR BONJOUR… » en Anton, en pixels, sous fscx animé.
 *
 * **Le document « legacy » n'est pas une copie figée de l'ancien `renderAss`.**
 * Une copie à la main dérive du code qu'elle prétend représenter sans le
 * signaler (relevé en revue de plan). Il est donc **dérivé mécaniquement** du
 * document produit par le `renderAss` actuel — retirer les `\N`, remettre
 * `WrapStyle: 0`, enlever la ligne `PlayResX` — puis cette dérivation est
 * **vérifiée une fois** contre la sortie réelle du `renderAss` du commit
 * parent (`02eda14`), obtenue en import dynamique depuis un worktree jetable.
 * Si les deux diffèrent, le script s'arrête : ça voudrait dire que cette PR a
 * changé autre chose que la coupure de ligne.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'

import { captionUnits, DEFAULT_CAPTION_STYLE, renderAss } from '@/core/captions/ass'
import type { Word } from '@/core/transcript'
import { createCaptionMeasure } from '@/server/caption-measure'
import { ffmpegBin } from '@/server/ffmpeg'

/** 1080×1920 : la même sortie 9:16 que `verticalCanvas` dans `renderClip`. */
const CANVAS = { w: 1080, h: 1920 }
const FPS = 30
const FONTS_DIR = path.join(process.cwd(), 'fonts')

/**
 * Un carton de `repeats` fois « bonjour » suivi d'un mot de remplissage de
 * `fillerLen` lettres — le second réglage affine la largeur totale plus finement
 * qu'un mot entier, pour viser la frontière au plus près.
 */
function candidateCard(repeats: number, fillerLen: number): Word[] {
  const words: Word[] = []
  for (let i = 0; i < repeats; i++) {
    words.push({ word: 'bonjour', start: i * 0.3, end: i * 0.3 + 0.28 })
  }
  if (fillerLen > 0) {
    const t = repeats * 0.3
    words.push({ word: 'x'.repeat(fillerLen), start: t, end: t + 0.28 })
  }
  words[words.length - 1] = { ...words[words.length - 1], end: words[words.length - 1].end + 1.5 }
  return words
}

/** `renderAss` d'aujourd'hui, moins `\N`, `WrapStyle: 2` et `PlayResX` — la forme que le commit parent écrivait. */
function deriveLegacy(ass: string): string {
  return ass
    .replace(/\\N/g, ' ')
    .replace(/^WrapStyle: 2$/m, 'WrapStyle: 0')
    .replace(/^PlayResX: \d+\n/m, '')
}

/**
 * La sortie réelle de `renderAss(cards, style)` au commit parent, par un
 * worktree jetable et le chargeur ESM de `tsx` — emprunté au `node_modules`
 * de ce dépôt (`NODE_PATH`) plutôt que réinstallé dans le worktree jetable,
 * qui n'a pas les siens. Aucune installation n'y tourne jamais, donc aucun
 * risque du piège des `node_modules` partagés entre worktrees (routage figé
 * vers le mauvais dossier au premier `pnpm install` lancé depuis l'un d'eux) :
 * on ne fait ici que lire, jamais installer.
 */
function parentRenderAss(card: Word[]): string {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-wrap-parent-'))
  const outFile = path.join(worktree, 'probe.out')
  try {
    execFileSync('git', ['worktree', 'add', '--detach', worktree, '02eda14'], { stdio: 'pipe' })
    const probe = path.join(worktree, 'probe.ts')
    fs.writeFileSync(
      probe,
      [
        "import { renderAss, DEFAULT_CAPTION_STYLE } from './src/core/captions/ass'",
        "import fs from 'node:fs'",
        `const card = ${JSON.stringify(card)}`,
        `fs.writeFileSync(${JSON.stringify(outFile)}, renderAss([card], DEFAULT_CAPTION_STYLE as never))`,
      ].join('\n'),
    )
    const nodeModules = path.join(process.cwd(), 'node_modules')
    const loader = path.join(nodeModules, 'tsx/dist/loader.mjs')
    execFileSync(process.execPath, ['--import', loader, probe], {
      stdio: 'pipe',
      cwd: worktree,
      env: { ...process.env, NODE_PATH: nodeModules },
    })
    return fs.readFileSync(outFile, 'utf8')
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { stdio: 'pipe' })
  }
}

/** Le nombre de bandes de texte affichées sur une image, par projection de luminance sur les lignes. */
async function textBandCount(pngPath: string): Promise<number> {
  const image = await loadImage(pngPath)
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const { data, width, height } = ctx.getImageData(0, 0, image.width, image.height)

  const rowActive: boolean[] = []
  for (let y = 0; y < height; y++) {
    let maxLuma = 0
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      if (luma > maxLuma) maxLuma = luma
    }
    rowActive.push(maxLuma > 60)
  }

  // Tolère jusqu'à deux lignes de pixels inactives au sein d'une même bande —
  // l'espace entre deux glyphes de hauteurs différentes, pas un saut de ligne.
  let bands = 0
  let gap = 0
  let inBand = false
  for (const active of rowActive) {
    if (active) {
      if (!inBand) bands++
      inBand = true
      gap = 0
    } else if (inBand) {
      gap++
      if (gap > 2) inBand = false
    }
  }
  return bands
}

/** Burne `ass` sur fond noir et rend le nombre de bandes de texte à chaque image de `durationSec`. */
function burnAndCountBands(ass: string, durationSec: number, outDir: string): Promise<number[]> {
  fs.mkdirSync(outDir, { recursive: true })
  const assPath = path.join(outDir, 'cue.ass')
  fs.writeFileSync(assPath, ass)
  execFileSync(
    ffmpegBin(),
    [
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=black:s=${CANVAS.w}x${CANVAS.h}:d=${durationSec}:r=${FPS}`,
      '-vf', `ass=filename='${assPath}':fontsdir='${FONTS_DIR}'`,
      path.join(outDir, 'frame_%04d.png'),
    ],
    { stdio: 'pipe' },
  )
  const frames = fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith('frame_'))
    .sort()
    .map((f) => path.join(outDir, f))
  return Promise.all(frames.map(textBandCount))
}

async function main(): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-wrap-measure-'))
  const { sizeUnits } = captionUnits(DEFAULT_CAPTION_STYLE)
  const measure = createCaptionMeasure(FONTS_DIR, DEFAULT_CAPTION_STYLE.fontName, sizeUnits)

  console.log("Recherche du carton frontière (rendu ffmpeg, plusieurs dizaines d'essais)…\n")

  let winner: { card: Word[]; branchAss: string; legacyDerived: string; legacyBands: number[] } | null = null

  // `repeats` cadre le nombre de mots pleins, `fillerLen` affine la largeur
  // restante lettre par lettre : plus fin qu'un mot entier, nécessaire pour
  // viser la frontière que la police réelle place à un endroit que la mesure
  // interne de `@napi-rs/canvas` ne prédit qu'approximativement.
  outer: for (let repeats = 2; repeats <= 8 && winner === null; repeats++) {
    for (let fillerLen = 0; fillerLen <= 16; fillerLen++) {
      const card = candidateCard(repeats, fillerLen)
      const branchAss = renderAss([card], DEFAULT_CAPTION_STYLE, measure)
      const legacyDerived = deriveLegacy(branchAss)
      const cueDuration = card[card.length - 1].end - card[0].start
      const legacyBands = await burnAndCountBands(
        legacyDerived,
        cueDuration,
        path.join(scratch, `legacy-${repeats}-${fillerLen}`),
      )
      const distinct = new Set(legacyBands)
      if (distinct.size > 1) {
        console.log(
          `Frontière trouvée : ${repeats} × « bonjour » + filler de ${fillerLen} lettres — ` +
            `bandes/legacy = [${legacyBands.join(',')}]`,
        )
        winner = { card, branchAss, legacyDerived, legacyBands }
        break outer
      }
    }
  }

  if (winner === null) {
    console.log("\nAucun carton frontière trouvé dans la grille essayée : l'élargir.")
    return
  }

  // La dérivation « legacy » n'est vérifiée qu'une fois, sur le carton gagnant
  // — pas à chaque essai de la recherche, dont le coût (un worktree par
  // candidat) serait sinon payé plusieurs dizaines de fois pour rien.
  const legacyReal = parentRenderAss(winner.card)
  if (winner.legacyDerived !== legacyReal) {
    console.error(
      'La dérivation « legacy » ne correspond pas à la sortie réelle du commit parent : ' +
        'le changement dépasse la coupure de ligne, arrêt.',
    )
    console.error('--- dérivée ---\n' + winner.legacyDerived)
    console.error('--- réelle (02eda14) ---\n' + legacyReal)
    process.exitCode = 1
    return
  }
  console.log('Dérivation « legacy » vérifiée identique à la sortie réelle du commit 02eda14.\n')

  const cueDuration = winner.card[winner.card.length - 1].end - winner.card[0].start
  const branchBands = await burnAndCountBands(winner.branchAss, cueDuration, path.join(scratch, 'branch-winner'))
  const legacyDistinct = new Set(winner.legacyBands)
  const branchDistinct = new Set(branchBands)

  console.log(`Bandes par image, AVANT (02eda14, dérivé et vérifié) : [${winner.legacyBands.join(',')}]`)
  console.log(`Bandes par image, APRÈS (cette branche)               : [${branchBands.join(',')}]`)
  console.log(
    `\nRésultat : avant varie sur {${[...legacyDistinct].sort().join(',')}} bandes selon l'image ` +
      `(instabilité mesurée), après reste constante à ${[...branchDistinct].join(',')} bande(s) ` +
      `(${branchDistinct.size === 1 ? 'STABLE' : 'ENCORE INSTABLE — à investiguer'}).`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
