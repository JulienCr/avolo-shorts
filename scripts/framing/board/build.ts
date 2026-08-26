/**
 * Assemble une planche complète, de la spécification au fichier HTML —
 * issue #191, lot 3.
 *
 * `buildBoard` est le seul point qui touche à la fois `input.ts`,
 * `framing.ts` et `still.ts` : charger un projet, résoudre chaque variante
 * par le vrai chemin de cadrage, rendre chaque image par le vrai chemin de
 * rendu, puis composer la page (`page.ts`, lot 2).
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FramingSettings } from '@/core/framing'
import { encoderName } from '@/server/ffmpeg'
import { forgetAnalyses } from '@/server/clip-framing'
import { buildCard, type Board, type BoardCard, type BoardImage } from './card'
import { frontalityBimodal, SINGLE_STATE } from './classifiers'
import { resolveVariant } from './framing'
import { loadBoardInput, type BoardInput } from './input'
import { renderBoardPage } from './page'
import { partitionShot, type FrameClassifier } from './share'
import { validateSpec, type BoardCase, type BoardSpec, type FramingVariant } from './spec'
import { renderStill, stillArgs, type StillRequest } from './still'

/**
 * Résout `spec.classifier` — une chaîne, portée par la spécification pour
 * finir dans la bande de reproductibilité — vers l'instance que `share.ts`
 * exécute. `classifiers.ts` reste le seul foyer des classifieurs eux-mêmes ;
 * ceci n'en est que l'index par identifiant.
 */
function classifierFor(id: string): FrameClassifier {
  if (id === SINGLE_STATE.id) return SINGLE_STATE
  const m = /^frontality-bimodal@([\d.]+)$/.exec(id)
  if (m !== null) return frontalityBimodal(Number(m[1]))
  throw new Error(
    `buildBoard : classifieur inconnu "${id}". Attendu : "${SINGLE_STATE.id}" ou "frontality-bimodal@<seuil>".`,
  )
}

/** La ligne git de la bande de reproductibilité : sha, propreté, horodatage, encodeur. */
function commitLine(): string {
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== ''
  const when = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date())
  // Sans le mot « commit » en tête : `page.ts` (pied de page) et
  // `verdicts.ts` (copié-collé) le préfixent déjà chacun de son côté — la
  // même chose écrite deux fois lirait « commit commit ad4d957 … ».
  return `${sha} (${dirty ? 'MODIFIÉ' : 'propre'}) · ${when} · encodeur ${encoderName()}`
}

/** Un `splitScreen=… splitMinShotMs=…` compact, un réglage par mot. */
function formatGlobals(g: FramingSettings): string {
  return (Object.keys(g) as (keyof FramingSettings)[]).map((k) => `${k}=${String(g[k])}`).join(' ')
}

/** `label (réglages)` pour `settings`, `label (why)` pour `options` — la seule trace de `why` que la planche porte. */
function formatVariant(v: FramingVariant): string {
  if (v.kind === 'settings') {
    const entries = Object.entries(v.settings)
    return entries.length === 0
      ? `${v.label} (défauts)`
      : `${v.label} (${entries.map(([k, val]) => `${k}=${String(val)}`).join(' ')})`
  }
  return `${v.label} (${v.why})`
}

/**
 * La bande de reproductibilité, en lignes `[libellé, texte]` — la même forme
 * que `BoardSpec.settled`, pour qu'elle s'affiche par le mécanisme existant
 * de « Réglé » et se retrouve donc, sans code de plus, en tête du copié-collé
 * (`verdicts.ts` pousse `settled` juste après la ligne de commit).
 */
function reproducibilityBand(o: {
  spec: BoardSpec
  inputs: readonly BoardInput[]
}): [string, string][] {
  const lines: [string, string][] = []
  for (const input of o.inputs) {
    lines.push([
      'Source',
      `${input.projectId} : ${path.basename(input.decoded.file)}, ${input.decoded.w}x${input.decoded.h}, ` +
        `${input.decoded.videoFps} im/s${input.decoded.fromProxy ? ' (proxy)' : ''}`,
    ])
    lines.push([
      'Analyse',
      `${input.projectId} : ${input.analysis.model ?? 'modèle inconnu'}, grille ${input.analysis.fps} im/s`,
    ])
  }
  const globals = o.inputs[0]?.globals
  if (globals !== undefined) lines.push(['Cadrage', formatGlobals(globals)])
  lines.push(['Variantes', o.spec.variants.map(formatVariant).join(' · ')])
  lines.push(['Classifieur', o.spec.classifier])
  return lines
}

/** `data:image/jpeg;base64,…` — le seul format que `page.ts` sait poser dans un `<img src>`. */
function dataUriOf(jpeg: Buffer): string {
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`
}

function altOf(o: { boardCase: BoardCase; stateLabel: string; variant: FramingVariant; canvas: string }): string {
  return (
    `${o.boardCase.projectId} — état « ${o.stateLabel} », variante « ${o.variant.label} » (${o.canvas}) — ` +
    `cas ${o.boardCase.id}`
  )
}

export async function buildBoard(
  spec: BoardSpec,
  o: { out: string; maxMo?: number; displayWidth?: number },
): Promise<{ path: string; bytes: number; cards: number }> {
  validateSpec(spec)
  // Une planche régénérée en cours d'analyse ne doit jamais relire l'analyse
  // d'avant : `clip-framing.ts` cache par taille+date de fichier, et un build
  // qui tourne pendant qu'`analysis.json` se réécrit y lirait l'ancienne.
  forgetAnalyses()

  const classifier = classifierFor(spec.classifier)
  const displayWidth = o.displayWidth ?? 540
  const maxBytes = (o.maxMo ?? 16) * 1024 * 1024

  const allCases: BoardCase[] = spec.sections.flatMap((s) => s.cases ?? [])
  if (allCases.length === 0) throw new Error('buildBoard : aucun cas dans la spécification.')

  const inputsByProject = new Map<string, BoardInput>()
  async function inputFor(projectId: string): Promise<BoardInput> {
    const cached = inputsByProject.get(projectId)
    if (cached !== undefined) return cached
    const loaded = await loadBoardInput(projectId)
    inputsByProject.set(projectId, loaded)
    return loaded
  }

  const cards: BoardCard[] = []
  const weighed: { label: string; bytes: number }[] = []

  for (const boardCase of allCases) {
    const input = await inputFor(boardCase.projectId)

    // Le plan de référence est toujours celui de l'analyse, jamais celui
    // qu'une variante subdivise : sinon deux variantes du même cas
    // partitionneraient sur des dénominateurs différents, donc deux parts
    // pour la même image.
    const shot = input.analysis.shots.find((s) => s.start <= boardCase.at && boardCase.at < s.end)
    if (shot === undefined) {
      throw new Error(`buildBoard : aucun plan de l'analyse ne couvre l'instant ${boardCase.at} (cas "${boardCase.id}").`)
    }

    const framingByVariant = new Map(
      spec.variants.map((variant) => [variant.id, resolveVariant({ input, case: boardCase, variant })]),
    )

    const partition = partitionShot({
      shot,
      boxes: input.analysis.boxes,
      analysisFps: input.analysis.fps,
      classifier,
    })

    for (const state of partition.states) {
      const images: BoardImage[] = []
      for (const variant of spec.variants) {
        const framing = framingByVariant.get(variant.id)
        if (framing === undefined) throw new Error(`buildBoard : variante "${variant.id}" non résolue.`)
        const output = variant.output ?? 'vertical'

        const request: StillRequest = { input, instant: state.instant, framing, output, shotEnd: shot.end }
        // `stillArgs` calcule `window`/`pieces` sans jamais lire `dst` : ce
        // chemin ne sert qu'à satisfaire le type, aucun fichier n'y est écrit.
        const { pieces } = stillArgs({ ...request, dst: path.join(os.tmpdir(), 'framing-board-metadata.mp4') })
        const piece = pieces[0]
        if (piece === undefined) throw new Error(`buildBoard : aucun morceau rendu pour "${boardCase.id}"/"${variant.id}".`)

        const decision =
          output === 'native'
            ? { ratio: framing.ratio, split: false, cropX: piece.cropXNative, canvas: 'native' as const }
            : { ratio: piece.ratio, split: piece.split !== undefined, cropX: piece.cropX, canvas: 'vertical' as const }

        const jpeg = await renderStill(request, displayWidth)
        weighed.push({ label: `${boardCase.id}#${state.state.id}@${variant.id}`, bytes: jpeg.byteLength })

        images.push({
          variantId: variant.id,
          variantLabel: variant.label,
          dataUri: dataUriOf(jpeg),
          alt: altOf({ boardCase, stateLabel: state.state.label, variant, canvas: decision.canvas }),
          decision,
        })
      }

      cards.push(
        buildCard({
          caseId: boardCase.id,
          projectId: boardCase.projectId,
          shot,
          state,
          instant: state.instant,
          images,
          stake: boardCase.stake,
        }),
      )
    }
  }

  const totalBytes = weighed.reduce((sum, w) => sum + w.bytes, 0)
  if (totalBytes > maxBytes) {
    const heaviest = [...weighed].sort((a, b) => b.bytes - a.bytes).slice(0, 3)
    throw new Error(
      `buildBoard : ${(totalBytes / (1024 * 1024)).toFixed(1)} Mo dépasse le plafond de ` +
        `${(maxBytes / (1024 * 1024)).toFixed(0)} Mo. Les trois images les plus lourdes : ` +
        heaviest.map((h) => `${h.label} (${(h.bytes / 1024).toFixed(0)} Kio)`).join(', ') +
        '.',
    )
  }

  const band = reproducibilityBand({ spec, inputs: [...inputsByProject.values()] })
  const specWithBand: BoardSpec = { ...spec, settled: [...band, ...spec.settled] }

  const board: Board = {
    spec: specWithBand,
    cards,
    commit: commitLine(),
    generatedAt: new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date()),
  }

  const html = renderBoardPage(board)
  fs.mkdirSync(path.dirname(o.out), { recursive: true })
  fs.writeFileSync(o.out, html, 'utf8')
  const bytes = fs.statSync(o.out).size

  return { path: o.out, bytes, cards: cards.length }
}

