/**
 * La planche de comparaison de `ui-shot --board` : les paires avant/après
 * d'un même écran et viewport, côte à côte, une question par groupe.
 *
 * Réutilise `STYLE_CSS`/`renderScript` de `scripts/framing/board/template.ts`
 * (gelés, skill `decision-sheet`), jamais `page.ts`/`BOARD_CSS` — propres au
 * cadrage, pas à des captures d'écran.
 */

import fs from 'node:fs'
import path from 'node:path'

import { STYLE_CSS, renderScript } from '../framing/board/template'

export type Shot = { readonly screen: string; readonly label: string; readonly width: number; readonly height: number }

const SHOT_NAME = /^([a-z0-9-]+)-(before|after)-(\d+)x(\d+)\.png$/

/** `clip-before-2560x1320.png` → `{screen, label, width, height}`, ou `null` hors du format. */
export function parseShotFilename(name: string): Shot | null {
  const m = SHOT_NAME.exec(name)
  if (m === null) return null
  return { screen: m[1], label: m[2] as 'before' | 'after', width: Number(m[3]), height: Number(m[4]) }
}

export type ShotPair = {
  readonly screen: string
  readonly width: number
  readonly height: number
  readonly beforeFile: string
  readonly afterFile: string
}

/**
 * Associe les fichiers `--before` et `--after` par écran+viewport. Un
 * fichier sans vis-à-vis est signalé dans `unmatched` plutôt que tu.
 */
export function pairShots(
  beforeFiles: readonly string[],
  afterFiles: readonly string[],
): { pairs: ShotPair[]; unmatched: string[] } {
  const beforeByKey = new Map<string, string>()
  const unmatched: string[] = []

  for (const file of beforeFiles) {
    const shot = parseShotFilename(file)
    if (shot === null || shot.label !== 'before') {
      unmatched.push(file)
      continue
    }
    beforeByKey.set(`${shot.screen}@${shot.width}x${shot.height}`, file)
  }

  const pairs: ShotPair[] = []
  const seen = new Set<string>()
  for (const file of afterFiles) {
    const shot = parseShotFilename(file)
    if (shot === null || shot.label !== 'after') {
      unmatched.push(file)
      continue
    }
    const key = `${shot.screen}@${shot.width}x${shot.height}`
    const beforeFile = beforeByKey.get(key)
    if (beforeFile === undefined) {
      unmatched.push(file)
      continue
    }
    seen.add(key)
    pairs.push({ screen: shot.screen, width: shot.width, height: shot.height, beforeFile, afterFile: file })
  }

  for (const [key, file] of beforeByKey) {
    if (!seen.has(key)) unmatched.push(file)
  }

  pairs.sort((a, b) => (a.screen === b.screen ? a.width - b.width : a.screen.localeCompare(b.screen)))
  return { pairs, unmatched }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Additif au style gelé — mise en page propre à cette planche, jetons existants uniquement. */
const UI_BOARD_CSS = `/* ===== additive: ui-shot board classes ===== */
.q--ui{max-width:var(--wide)}
.frames{display:flex; flex-wrap:wrap; gap:16px; margin:20px 0 4px}
.variant{flex:1 1 320px; min-width:220px}
.variant img{display:block; width:100%; height:auto; border-radius:8px; border:1px solid var(--line); background:var(--sunk)}
.variant .variant-label{
  display:block; font-family:Archivo,system-ui,sans-serif; font-size:11px; font-weight:600;
  letter-spacing:.06em; text-transform:uppercase; color:var(--ink-3); margin:0 0 8px;
}
`

export type RenderedShotPair = ShotPair & { readonly beforeDataUri: string; readonly afterDataUri: string }

function stringsFor() {
  return {
    progressNoun: 'tranchés',
    copyOutTitle: 'Planche ui-shot',
    settledHeading: 'Réglé',
    undecided: 'sans réponse',
    noteLabel: 'note',
    remarksHeading: 'Remarques',
    copied: 'Copié.',
    copyRefused: 'La copie automatique a été refusée ; sélectionnez le texte à la main.',
    cleared: 'Effacé.',
  }
}

/** Compose la page — pure, testable sans disque ni navigateur. */
export function renderUiBoardPage(o: {
  title: string
  pairs: readonly RenderedShotPair[]
  commit: string
  generatedAt: string
}): string {
  if (o.pairs.length === 0) throw new Error('renderUiBoardPage : aucune paire à afficher.')

  const T = stringsFor()
  const key = `avolo-ui-shot:${o.pairs.map((p) => `${p.screen}@${p.width}x${p.height}`).join(',')}`

  const cardsHtml = o.pairs
    .map((p, i) => {
      const n = i + 1
      const dataKey = `${p.screen}@${p.width}x${p.height}`
      const label = `${p.screen} — ${p.width}×${p.height}`
      return `<section class="q q--ui" data-q="${n}" data-key="${escapeHtml(dataKey)}" data-label="${escapeHtml(label)}">
  <div class="q-head">
    <div class="q-num">Comparaison ${n} / ${o.pairs.length}</div>
    <h3 class="q-title">${escapeHtml(label)}</h3>
  </div>
  <div class="frames">
    <figure class="variant">
      <span class="variant-label">Avant</span>
      <img src="${p.beforeDataUri}" alt="${escapeHtml(`${label} — avant`)}">
    </figure>
    <figure class="variant">
      <span class="variant-label">Après</span>
      <img src="${p.afterDataUri}" alt="${escapeHtml(`${label} — après`)}">
    </figure>
  </div>
  <div class="opts">
    <label class="opt"><input type="radio" name="q${n}" value="garder"><span><span class="opt-t">Garder</span></span></label>
    <label class="opt"><input type="radio" name="q${n}" value="écarter"><span><span class="opt-t">Écarter</span></span></label>
    <label class="opt"><input type="radio" name="q${n}" value="je ne sais pas"><span><span class="opt-t">Je ne sais pas</span></span></label>
  </div>
  <div class="note"><textarea data-note="${n}" placeholder="Remarque"></textarea></div>
</section>`
    })
    .join('\n\n')

  const script = renderScript({ key, commit: o.commit, settled: [], strings: T })

  return `<title>${escapeHtml(o.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=JetBrains+Mono:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">

<style>
${STYLE_CSS}
${UI_BOARD_CSS}
</style>

<div class="bar">
  <div class="bar-in">
    <span class="bar-label" id="prog">0 / ${o.pairs.length} ${T.progressNoun}</span>
    <span class="track"><span class="fill" id="fill"></span></span>
  </div>
</div>

<div class="wrap">
<div class="col">

<header>
  <p class="eyebrow">ui-shot</p>
  <h1>${escapeHtml(o.title)}</h1>
  <p class="lede">${o.pairs.length} comparaison(s) avant/après.</p>
</header>

<section class="settled">
  <h2>${T.settledHeading}</h2>
  <ul></ul>
</section>

${cardsHtml}

<section class="out">
  <h2>Copier la planche</h2>
  <p class="sub">Coche, commente, puis copie le bloc pour le registre.</p>
  <textarea id="remarks" placeholder="Remarques générales"></textarea>
  <div class="actions">
    <button type="button" id="copy">Copier</button>
    <button type="button" class="ghost" id="reset">Effacer</button>
    <span class="status" id="status" role="status" aria-live="polite"></span>
  </div>
  <pre id="preview"></pre>
</section>

<footer>Généré le ${escapeHtml(o.generatedAt)} — commit ${escapeHtml(o.commit)}</footer>

</div>
</div>

<script>
${script}
</script>`
}

function dataUriOf(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

/** Assemble la planche depuis deux dossiers de captures, jusqu'au fichier HTML. */
export function buildUiBoard(o: {
  beforeDir: string
  afterDir: string
  out: string
  title?: string
  maxMo?: number
  commit: string
}): { path: string; bytes: number; pairs: number; unmatched: string[] } {
  const beforeFiles = fs.readdirSync(o.beforeDir)
  const afterFiles = fs.readdirSync(o.afterDir)
  const { pairs, unmatched } = pairShots(beforeFiles, afterFiles)
  if (pairs.length === 0) {
    throw new Error(`buildUiBoard : aucune paire avant/après entre ${o.beforeDir} et ${o.afterDir}.`)
  }

  const rendered: RenderedShotPair[] = pairs.map((p) => ({
    ...p,
    beforeDataUri: dataUriOf(fs.readFileSync(path.join(o.beforeDir, p.beforeFile))),
    afterDataUri: dataUriOf(fs.readFileSync(path.join(o.afterDir, p.afterFile))),
  }))

  const html = renderUiBoardPage({
    title: o.title ?? 'ui-shot — comparaison',
    pairs: rendered,
    commit: o.commit,
    generatedAt: new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date()),
  })

  // Même plafond dans le même esprit que `framing/board/build.ts:121-123` :
  // sur le HTML rendu, pas sur la somme des PNG.
  const maxBytes = (o.maxMo ?? 16) * 1024 * 1024
  const htmlBytes = Buffer.byteLength(html, 'utf8')
  if (htmlBytes > maxBytes) {
    throw new Error(
      `buildUiBoard : ${(htmlBytes / (1024 * 1024)).toFixed(1)} Mo de HTML dépasse le plafond de ` +
        `${(maxBytes / (1024 * 1024)).toFixed(0)} Mo.`,
    )
  }

  fs.mkdirSync(path.dirname(o.out), { recursive: true })
  fs.writeFileSync(o.out, html, 'utf8')
  const bytes = fs.statSync(o.out).size

  return { path: o.out, bytes, pairs: pairs.length, unmatched }
}
