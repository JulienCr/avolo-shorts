/**
 * L'œil versionné — `docs/agents/ui-loop.md`.
 *
 *     pnpm ui-shot --url <url> --screen clip --label before|after [--out <dir>]
 *     pnpm ui-shot --board <dir-avant> <dir-après> --out tmp/<sujet>.html
 *
 * Un sélecteur introuvable fait échouer la commande, le recouvrement
 * s'imprime paire par paire, le port est vérifié avant toute mesure.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { chargerEnv, quit } from './dev-common'
import { buildUiBoard } from './ui/board'
import { decidePortGuard, resolveHostUrl } from './ui/guard'
import { SCREEN_PAIRS, type OverlapPair } from './ui/pairs'

function value(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

type Viewport = { readonly width: number; readonly height: number }

const DEFAULT_VIEWPORTS: readonly Viewport[] = [
  { width: 2560, height: 1320 },
  { width: 1920, height: 1080 },
  { width: 1024, height: 640 },
]

function parseViewports(raw: string | undefined): Viewport[] {
  if (raw === undefined) return [...DEFAULT_VIEWPORTS]
  return raw.split(',').map((token) => {
    const m = /^(\d+)x(\d+)$/.exec(token.trim())
    if (m === null) throw new Error(`--viewport : "${token}" n'a pas la forme LARGEURxHAUTEUR.`)
    return { width: Number(m[1]), height: Number(m[2]) }
  })
}

function refuseUnderProjects(out: string): void {
  // Même garde que `scripts/framing-board.ts:150` : jamais dans `projects/`,
  // que d'autres processus lisent et purgent au même moment.
  if (out.split(path.sep).includes('projects')) {
    throw new Error(`--out ${out} : "projects/" est réservé aux données du produit.`)
  }
}

function commitLine(): string {
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== ''
  return `${sha}${dirty ? ' (modifié)' : ''}`
}

/**
 * Le PID qui écoute `port`, sans `lsof` : sur cette machine, `lsof` rend un
 * résultat vide et sans erreur pour un port pourtant en écoute — les
 * espaces de noms réseau Docker qu'il tente de lister lui font perdre son
 * cache de sockets (`WARNING: can't stat() nsfs file system
 * /run/docker/netns/…`, mesuré ici même). `/proc/net/tcp{,6}` donne
 * l'inode du socket en écoute, puis un balayage de `/proc/<pid>/fd` donne
 * le PID qui le tient — même information, sans dépendre d'un binaire externe.
 */
function listeningInode(port: number): string {
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const lines = fs.readFileSync(table, 'utf8').split('\n').slice(1)
    for (const line of lines) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10) continue
      const localPort = cols[1].split(':')[1]
      const state = cols[3]
      if (localPort === hex && state === '0A') return cols[9]
    }
  }
  throw new Error(`aucun processus n'écoute le port ${port}.`)
}

function pidHoldingInode(inode: string): number {
  const target = `socket:[${inode}]`
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    let fds: string[]
    try {
      fds = fs.readdirSync(`/proc/${entry}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      let link: string
      try {
        link = fs.readlinkSync(`/proc/${entry}/fd/${fd}`)
      } catch {
        continue
      }
      if (link === target) return Number(entry)
    }
  }
  throw new Error(`aucun processus trouvé pour le socket en écoute (inode ${inode}).`)
}

function listeningPid(port: string): number {
  return pidHoldingInode(listeningInode(Number(port)))
}

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
}

/** Guarantee 3 : le serveur mesuré doit tourner depuis ce dépôt. */
function verifyPort(url: string, force: boolean): void {
  const port = new URL(url).port
  if (port === '') throw new Error(`--url ${url} : aucun port explicite, impossible de vérifier le serveur.`)
  const pid = listeningPid(port)
  const procCwd = fs.readlinkSync(`/proc/${pid}/cwd`)
  const decision = decidePortGuard({ procCwd, repoRoot: repoRoot(), force })
  if (!decision.ok) throw new Error(decision.message)
}

type PairRow = { readonly viewport: string } & OverlapPair & { overlap: number | null; aFound: boolean; bFound: boolean }

async function measurePairs(page: import('playwright').Page, screen: string, viewportLabel: string): Promise<PairRow[]> {
  const pairs = SCREEN_PAIRS[screen] ?? []
  if (pairs.length === 0) return []
  const results = await page.evaluate((pairsArg: readonly OverlapPair[]) => {
    return pairsArg.map((pair) => {
      const a = document.querySelector(pair.a)
      const b = document.querySelector(pair.b)
      if (a === null || b === null) {
        return { name: pair.name, a: pair.a, b: pair.b, aFound: a !== null, bFound: b !== null, overlap: null }
      }
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      const overlap = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top))
      return { name: pair.name, a: pair.a, b: pair.b, aFound: true, bFound: true, overlap }
    })
  }, pairs)
  return results.map((r) => ({ ...r, viewport: viewportLabel }))
}

async function runScreenshot(args: string[]): Promise<number> {
  const rawUrl = value(args, '--url')
  const screen = value(args, '--screen')
  const label = value(args, '--label')
  if (rawUrl === undefined || screen === undefined || label === undefined) {
    console.error('--url, --screen et --label sont requis.')
    return 1
  }
  if (label !== 'before' && label !== 'after') {
    console.error(`--label attend "before" ou "after", reçu "${label}".`)
    return 1
  }

  const { url, rewritten } = resolveHostUrl(rawUrl)
  if (rewritten) console.error(`--url : "127.0.0.1" réécrit en "localhost" (403 sur l'adresse littérale ici).`)

  const force = hasFlag(args, '--force')
  verifyPort(url, force)

  const viewports = parseViewports(value(args, '--viewport'))
  const outDir = value(args, '--out') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shot-'))
  refuseUnderProjects(outDir)
  fs.mkdirSync(outDir, { recursive: true })

  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  const rows: PairRow[] = []
  const files: string[] = []
  try {
    for (const { width, height } of viewports) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
      const page = await context.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(3500)

      const file = path.join(outDir, `${screen}-${label}-${width}x${height}.png`)
      await page.screenshot({ path: file, fullPage: true })
      files.push(file)

      rows.push(...(await measurePairs(page, screen, `${width}x${height}`)))
      await context.close()
    }
  } finally {
    await browser.close()
  }

  for (const file of files) console.log(`Capture : ${file}`)

  if (rows.length > 0) {
    console.log(`\nRecouvrement vertical (px), écran "${screen}" :`)
    for (const row of rows) {
      const text =
        row.overlap === null
          ? `ERREUR — sélecteur introuvable (${!row.aFound ? row.a : row.b})`
          : `${row.overlap.toFixed(1)} px`
      console.log(`  [${row.viewport}] ${row.name} : ${text}`)
    }
  }

  const failures = rows.filter((r) => r.overlap === null)
  if (failures.length > 0) {
    console.error('\nPaire(s) non résolue(s) :')
    for (const f of failures) {
      console.error(`  "${f.name}" — ${!f.aFound ? `sélecteur a introuvable : ${f.a}` : `sélecteur b introuvable : ${f.b}`}`)
    }
    return 1
  }

  return 0
}

async function runBoard(args: string[], boardIndex: number): Promise<number> {
  const beforeDir = args[boardIndex + 1]
  const afterDir = args[boardIndex + 2]
  const out = value(args, '--out')
  if (beforeDir === undefined || afterDir === undefined || out === undefined) {
    console.error('Usage : pnpm ui-shot --board <dir-avant> <dir-après> --out <fichier.html> [--titre <texte>] [--max-mo N]')
    return 1
  }
  refuseUnderProjects(out)

  const rawMaxMo = value(args, '--max-mo')
  const maxMo = rawMaxMo === undefined ? undefined : Number(rawMaxMo)
  if (maxMo !== undefined && (!Number.isFinite(maxMo) || maxMo <= 0)) {
    console.error(`--max-mo attend un nombre > 0, reçu « ${rawMaxMo} ».`)
    return 1
  }

  const result = buildUiBoard({
    beforeDir,
    afterDir,
    out,
    title: value(args, '--titre'),
    maxMo,
    commit: commitLine(),
  })

  if (result.unmatched.length > 0) {
    console.error(`Fichier(s) sans vis-à-vis, ignoré(s) : ${result.unmatched.join(', ')}`)
  }
  console.log(`Planche écrite : ${result.path} (${(result.bytes / (1024 * 1024)).toFixed(2)} Mo, ${result.pairs} paire(s)).`)
  return 0
}

async function main(): Promise<number> {
  await chargerEnv()
  const args = process.argv.slice(2)

  const boardIndex = args.indexOf('--board')
  if (boardIndex !== -1) return runBoard(args, boardIndex)
  return runScreenshot(args)
}

void main().then(quit, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quit(1)
})
