/**
 * Les boîtes dessinées sur le proxy, vert pour ce que le cadrage garde, rouge
 * pour ce que le filtre du premier plan écarte.
 *
 *     pnpm tsx scripts/vignettes-premier-plan.ts 2025-06-15-cqlp 419 470.5 1924
 *     pnpm tsx scripts/vignettes-premier-plan.ts 2025-06-15-cqlp --large 6
 *     pnpm tsx scripts/vignettes-premier-plan.ts 2025-06-15-cqlp --frontiere 8
 *
 * **Ce script existe parce que les chiffres se sont déjà trompés une fois.** Une
 * frontière posée sur la seule hauteur des boîtes paraissait impeccable — 0,8 %
 * de boîtes dans la zone d'incertitude — et jetait deux comédiens assis dans le
 * noir, ce qu'aucun histogramme ne pouvait dire. Sur ce sujet, une frontière ne
 * se valide qu'à l'œil.
 *
 * Les instants s'écrivent en secondes. Deux sélections automatiques évitent d'en
 * chercher à la main :
 *
 * - `--frontiere N` prend N images au voisinage du seuil de hauteur, là où le
 *   filtre hésite. C'est le tirage qui vaut le plus : au milieu d'un mode, tout
 *   le monde a raison.
 * - `--large N` prend N images parmi les plus larges *après* filtrage. Elles
 *   disent ce qui fait encore monter le ratio — et sur `2025-06-15-cqlp`, la
 *   réponse a été « les comédiens, vraiment aux deux bords », pas un résidu.
 *
 * Les vignettes vont dans `--out` (défaut : un dossier temporaire), jamais dans
 * `projects/`, que d'autres processus lisent au même moment.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isForeground } from '@/core/framing'
import type { PersonBox } from '@/core/shots'
import { analysisPath, proxyPath } from '@/server/paths'
import { lireAnalyse } from '@/server/steps/analysis'
import { chargerEnv, quitter } from './dev-commun'

/** Le binaire de `setup.sh`, le même que le reste de la chaîne. */
function ffmpeg(): string {
  return process.env.FFMPEG_BIN || 'ffmpeg'
}

/**
 * Les boîtes d'une image, retrouvées par leur instant arrondi à la milliseconde
 * — la granularité de `detect.py`, et la même clé que `empans`.
 */
function parImage(boxes: PersonBox[]): Map<number, PersonBox[]> {
  const out = new Map<number, PersonBox[]>()
  for (const b of boxes) {
    const clé = Math.round(b.t * 1000)
    const déjà = out.get(clé)
    if (déjà) déjà.push(b)
    else out.set(clé, [b])
  }
  return out
}

/**
 * Une vignette. Le rectangle est tracé par `drawbox`, en pixels du proxy.
 *
 * L'épaisseur est de 2 px : à 1 px, un trait rouge sur une tête sombre au bas
 * d'une image sombre ne se voit pas, et c'est exactement l'endroit qu'on regarde.
 */
function vignette(proxy: string, t: number, boîtes: PersonBox[], W: number, H: number, out: string): void {
  const filtres = boîtes.map((b) => {
    const couleur = isForeground(b) ? 'red' : 'lime'
    const x = Math.round(b.x0 * W)
    const y = Math.round(b.y0 * H)
    const w = Math.max(1, Math.round((b.x1 - b.x0) * W))
    const h = Math.max(1, Math.round((b.y1 - b.y0) * H))
    return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${couleur}:t=2`
  })
  const argumentsFfmpeg = [
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
    // Une image sans boîte se prend quand même : c'est un cas qu'on veut voir.
    ...(filtres.length > 0 ? ['-vf', filtres.join(',')] : []),
    out,
  ]
  execFileSync(ffmpeg(), argumentsFfmpeg, { stdio: ['ignore', 'ignore', 'inherit'] })
}

/** L'empan d'une image, marge comprise, sur les boîtes que le cadrage garde. */
function empanFiltré(boîtes: PersonBox[]): number | null {
  const gardées = boîtes.filter((b) => b.score >= 0.5 && !isForeground(b))
  if (gardées.length === 0) return null
  const g = Math.min(...gardées.map((b) => b.x0))
  const d = Math.max(...gardées.map((b) => b.x1))
  return Math.min(1, d + 0.02) - Math.max(0, g - 0.02)
}

/** N valeurs réparties régulièrement dans une liste, extrémités comprises. */
function étalé<T>(liste: T[], n: number): T[] {
  if (liste.length <= n) return liste
  const pas = (liste.length - 1) / (n - 1)
  return Array.from({ length: n }, (_, i) => liste[Math.round(i * pas)])
}

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const nombreAprès = (drapeau: string, défaut: number): number | null => {
    const i = arguments_.indexOf(drapeau)
    if (i < 0) return null
    const v = Number(arguments_[i + 1])
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : défaut
  }
  const iOut = arguments_.indexOf('--out')
  const dossier =
    iOut >= 0 && arguments_[iOut + 1] !== undefined
      ? arguments_[iOut + 1]
      : fs.mkdtempSync(path.join(os.tmpdir(), 'vignettes-premier-plan-'))

  // Les valeurs des drapeaux ne sont pas des instants : les retirer avant de
  // lire les positionnels, sinon `--large 6` demande la seconde 6.
  const valeursDeDrapeaux = new Set<number>()
  for (const d of ['--large', '--frontiere', '--out']) {
    const i = arguments_.indexOf(d)
    if (i >= 0) valeursDeDrapeaux.add(i + 1)
  }
  const positionnels = arguments_.filter(
    (a, i) => !a.startsWith('--') && !valeursDeDrapeaux.has(i),
  )
  const projectId = positionnels[0]
  if (projectId === undefined) {
    console.error(
      'Usage : pnpm tsx scripts/vignettes-premier-plan.ts <projectId> [instants…] ' +
        '[--frontiere N] [--large N] [--out <dossier>]',
    )
    return 1
  }

  const analyse = lireAnalyse(analysisPath(projectId))
  const proxy = proxyPath(projectId)
  if (!fs.existsSync(proxy)) {
    console.error(`Proxy introuvable : ${proxy}`)
    return 1
  }
  const images = parImage(analyse.boxes)
  const { w: W, h: H } = analyse.proxy

  const instants = positionnels.slice(1).map(Number).filter(Number.isFinite)

  const nFrontière = nombreAprès('--frontiere', 6)
  if (nFrontière !== null) {
    // Les images qui portent une boîte dont la hauteur est près du seuil : ni
    // franchement du public, ni franchement un comédien.
    const près = [...images.entries()]
      .filter(([, bs]) => bs.some((b) => b.y1 >= 0.97 && Math.abs(b.y1 - b.y0 - 0.35) <= 0.08))
      .map(([clé]) => clé / 1000)
      .sort((a, b) => a - b)
    console.log(`${près.length} images au voisinage du seuil de hauteur`)
    instants.push(...étalé(près, nFrontière))
  }

  const nLarge = nombreAprès('--large', 6)
  if (nLarge !== null) {
    const larges = [...images.entries()]
      .map(([clé, bs]) => ({ t: clé / 1000, empan: empanFiltré(bs) }))
      .filter((e): e is { t: number; empan: number } => e.empan !== null)
      .sort((a, b) => b.empan - a.empan)
    console.log(
      `empan résiduel : max ${larges[0]?.empan.toFixed(2) ?? '—'}, ` +
        `médian ${larges[larges.length >> 1]?.empan.toFixed(2) ?? '—'}`,
    )
    instants.push(...étalé(larges, nLarge).map((e) => e.t))
  }

  if (instants.length === 0) {
    console.error('Aucun instant demandé. Donne des secondes, ou --frontiere / --large.')
    return 1
  }

  fs.mkdirSync(dossier, { recursive: true })
  for (const t of [...new Set(instants)].sort((a, b) => a - b)) {
    const boîtes = images.get(Math.round(t * 1000)) ?? []
    const fichier = path.join(dossier, `t${t.toFixed(1).replace('.', '_')}.png`)
    vignette(proxy, t, boîtes, W, H, fichier)
    const écartées = boîtes.filter((b) => isForeground(b)).length
    console.log(
      `${fichier}  ${t.toFixed(1)} s — ${boîtes.length} boîtes, ${écartées} écartée(s) (rouge)`,
    )
  }
  return 0
}

void main().then(quitter, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quitter(1)
})
