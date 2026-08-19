/**
 * Un serveur local qui joue le proxy d'un projet avec, en surimpression, les
 * boîtes du détecteur et le rectangle de crop d'un clip.
 *
 *     pnpm apercu-cadrage
 *     pnpm apercu-cadrage --port 4321
 *
 * Serveur au premier plan (`Ctrl-C` arrête proprement, voir le `SIGINT` plus
 * bas) ; en arrière-plan, `pnpm apercu-cadrage:stop` l'arrête par le port
 * qu'il écoute (`PORT=4321` par défaut, comme `--port` ci-dessus).
 *
 * `vignettes-cadrage.ts` répond « qu'est-ce que le spectateur verrait », mais
 * une image à la fois : une vignette par plan, choisie sur son débordement. Ce
 * script répond à la même question en continu, en scrubant dans la vidéo — utile
 * pour repérer *où* dans un plan le crop serre, pas seulement *que* le pire
 * instant du plan déborde.
 *
 * **Le cadre dessiné est celui de `computeFraming`, pas une réimplémentation.**
 * Un sélecteur choisit le projet — donc le proxy —, un second choisit un clip de
 * ce projet, et le crop envoyé au navigateur est celui que ce clip obtiendrait
 * réellement : mêmes réglages, même fonction que `vignettes-cadrage.ts` et que
 * le rendu final. Un rectangle recalculé à la main ici montrerait un cadrage
 * plausible mais qui n'est celui d'aucun chemin réel.
 *
 * La coloration des boîtes (vert gardée, rouge écartée par le filtre du premier
 * plan, gris sous le seuil de confiance) est calculée côté serveur avec
 * `isForeground`, pour la même raison : le navigateur ne doit pas porter une
 * seconde copie de cette règle. Le tronc (cyan) et la tête (magenta) que
 * `vignettes-cadrage.ts` dessine sur les boîtes gardées suivent le même
 * principe : `personBounds` et `headBounds` tournent côté serveur, le
 * navigateur ne reçoit que des rectangles déjà résolus.
 *
 * Serveur `node:http` nu, sans dépendance au reste de Next — ce script tourne
 * aussi bien qu'un projet ait ou non son serveur de développement démarré. Le
 * flux du proxy réutilise `parseRange` (`@/core/range`), le même calcul que la
 * route `GET /api/projects/:id/proxy` : sans réponse aux requêtes partielles, la
 * barre de lecture d'une vidéo d'un gigaoctet ne peut pas sauter.
 */

import { createReadStream } from 'node:fs'
import fs from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Ratio } from '@/core/edl'
import { FRAMING_DEFAULTS, computeFraming, cropRect, headBounds, isForeground, personBounds } from '@/core/framing'
import type { ShotFraming } from '@/core/framing'
import { parseRange } from '@/core/range'
import type { PersonBox } from '@/core/shots'
import { closeDb, getClips, getDb, listProjects } from '@/server/db'
import { analysisPath, proxyPath } from '@/server/paths'
import { lireAnalyse } from '@/server/steps/analysis'
import { chargerEnv, quitter } from './dev-commun'

const PORT_DÉFAUT = 4321

/** Les projets qui ont de quoi être montrés : un proxy, et une analyse. */
function projetsUtilisables(): string[] {
  const db = getDb()
  try {
    return listProjects(db)
      .map((p) => p.id)
      .filter((id) => fs.existsSync(proxyPath(id)) && fs.existsSync(analysisPath(id)))
  } finally {
    closeDb()
  }
}

/** Le sort d'une boîte, à l'identique de `vignettes-cadrage.ts`. */
function couleur(b: PersonBox): 'gray' | 'red' | 'lime' {
  // `!(score >= seuil)` et non `score < seuil` : un score `NaN` doit tomber du
  // côté écarté, pas passer au travers d'une comparaison qui rend toujours faux.
  if (!(b.score >= FRAMING_DEFAULTS.minScore)) return 'gray'
  return isForeground(b) ? 'red' : 'lime'
}

/** Un plan de `cadrage.shots`, réduit à ce que le navigateur dessine. */
type PlanEnvoyé = { start: number; end: number; ratio: Ratio; x: number; y: number; w: number; h: number }

function planEnvoyé(plan: ShotFraming, srcW: number, srcH: number): PlanEnvoyé {
  const rect = cropRect(plan.ratio, plan.cropX, srcW, srcH)
  return {
    start: plan.shot.start,
    end: plan.shot.end,
    ratio: plan.ratio,
    x: rect.x / srcW,
    y: rect.y / srcH,
    w: rect.w / srcW,
    h: rect.h / srcH,
  }
}

function json(res: ServerResponse, corps: unknown, statut = 200): void {
  const texte = JSON.stringify(corps)
  res.writeHead(statut, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(texte),
  })
  res.end(texte)
}

function texte(res: ServerResponse, contenu: string, type: string, statut = 200): void {
  res.writeHead(statut, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(contenu),
  })
  res.end(contenu)
}

/**
 * Le proxy d'un projet, en requêtes partielles.
 *
 * Même logique que `GET /api/projects/:id/proxy` (Next) : sans `Range`, le
 * fichier entier avec `Accept-Ranges` posé pour annoncer que le navigateur
 * *peut* en demander des morceaux ; avec, la plage demandée en 206, ou un 416 si
 * `parseRange` la refuse.
 */
function servirProxy(req: IncomingMessage, res: ServerResponse, chemin: string): void {
  let taille: number
  try {
    taille = fs.statSync(chemin).size
  } catch {
    res.writeHead(404).end()
    return
  }

  const enTête = req.headers.range ?? null
  if (enTête === null) {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': taille,
      'Accept-Ranges': 'bytes',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(chemin).pipe(res)
    return
  }

  const plage = parseRange(enTête, taille)
  if (plage === null) {
    res.writeHead(416, {
      'Content-Range': `bytes */${taille}`,
      'Accept-Ranges': 'bytes',
    })
    res.end()
    return
  }

  res.writeHead(206, {
    'Content-Type': 'video/mp4',
    'Content-Length': plage.end - plage.start + 1,
    'Content-Range': `bytes ${plage.start}-${plage.end}/${taille}`,
    'Accept-Ranges': 'bytes',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(chemin, { start: plage.start, end: plage.end }).pipe(res)
}

const PAGE = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Aperçu du cadrage</title>
<style>
  body { background: #111; color: #eee; font-family: sans-serif; margin: 0; padding: 16px; }
  #wrap { position: relative; display: inline-block; max-width: 100%; }
  video { display: block; max-width: 100%; height: auto; }
  canvas { position: absolute; top: 0; left: 0; pointer-events: none; width: 100%; height: 100%; }
  #controls { margin: 12px 0; display: flex; gap: 20px; align-items: center; flex-wrap: wrap; font-size: 14px; }
  label { display: flex; gap: 6px; align-items: center; }
  select { background: #222; color: #eee; border: 1px solid #444; padding: 4px; }
  button { background: #222; color: #eee; border: 1px solid #444; padding: 4px 10px; cursor: pointer; }
  button:hover { background: #333; }
  #status { color: #8f8; }
  legend { display: flex; gap: 16px; font-size: 13px; margin-top: 4px; }
  legend span { display: inline-flex; align-items: center; gap: 4px; }
  legend i { width: 12px; height: 12px; display: inline-block; border-radius: 2px; }
</style>
</head>
<body>
<div id="controls">
  <label>Proxy <select id="project"></select></label>
  <label>Cadre du clip <select id="clip"><option value="">(toute la vidéo, auto)</option></select></label>
  <label><input id="showBoxes" type="checkbox" checked> boîtes</label>
  <button id="copyImage" type="button">Copier l'image</button>
  <span id="copyStatus"></span>
  <button id="copyDebug" type="button">Copier le debug</button>
  <span id="debugStatus"></span>
  <span id="status"></span>
</div>
<div id="wrap">
  <video id="video" controls></video>
  <canvas id="overlay"></canvas>
</div>
<p class="legend">
  <span><i style="background:lime"></i> gardée</span>
  <span><i style="background:red"></i> premier plan écarté</span>
  <span><i style="background:gray"></i> sous le seuil de confiance</span>
  <span><i style="background:cyan"></i> tronc exigé par le cadrage</span>
  <span><i style="background:magenta"></i> tête / regard</span>
  <span><i style="background:yellow"></i> crop du clip choisi</span>
</p>

<script>
const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const projectSel = document.getElementById('project');
const clipSel = document.getElementById('clip');
const showBoxes = document.getElementById('showBoxes');
const copyImageBtn = document.getElementById('copyImage');
const copyStatusEl = document.getElementById('copyStatus');
const copyDebugBtn = document.getElementById('copyDebug');
const debugStatusEl = document.getElementById('debugStatus');
const statusEl = document.getElementById('status');

let boxesByTime = new Map();
let sortedTimes = [];
let sampleFps = 2;
let plans = [];
let currentProxy = '';
let currentNativeRatio = null;

function findNearestTimeIndex(t) {
  if (sortedTimes.length === 0) return -1;
  let lo = 0, hi = sortedTimes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTimes[mid] < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(sortedTimes[lo - 1] - t) < Math.abs(sortedTimes[lo] - t)) lo -= 1;
  return lo;
}

function planPourInstant(t) {
  // Recherche linéaire : quelques centaines de plans au plus, largement sous
  // le coût d'une frame à 30 im/s.
  return plans.find((p) => t >= p.start && t < p.end);
}

function draw() {
  requestAnimationFrame(draw);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const t = video.currentTime;
  const w = canvas.width, h = canvas.height;

  const plan = planPourInstant(t);
  if (plan) {
    ctx.strokeStyle = 'yellow';
    ctx.lineWidth = 4;
    ctx.strokeRect(plan.x * w, plan.y * h, plan.w * w, plan.h * h);
  }

  if (showBoxes.checked && sortedTimes.length > 0) {
    const idx = findNearestTimeIndex(t);
    const nearestT = sortedTimes[idx];
    if (Math.abs(nearestT - t) <= 1 / sampleFps) {
      for (const b of boxesByTime.get(nearestT) || []) {
        ctx.strokeStyle = b.c;
        ctx.lineWidth = 2;
        ctx.strokeRect(b.x0 * w, b.y0 * h, (b.x1 - b.x0) * w, (b.y1 - b.y0) * h);
        // Ce que le cadrage exige vraiment de cette personne, déjà résolu
        // côté serveur (personBounds / headBounds) — voir le docstring en
        // tête de fichier. Absents sur gris/rouge, comme dans
        // vignettes-cadrage.ts.
        if (b.torso) {
          ctx.strokeStyle = 'cyan';
          ctx.lineWidth = 1;
          ctx.strokeRect(b.torso.x0 * w, b.y0 * h, (b.torso.x1 - b.torso.x0) * w, (b.y1 - b.y0) * h);
        }
        if (b.head) {
          ctx.strokeStyle = 'magenta';
          ctx.lineWidth = 2;
          ctx.strokeRect(b.head.x0 * w, b.head.y0 * h, (b.head.x1 - b.head.x0) * w, (b.head.y1 - b.head.y0) * h);
        }
      }
    }
  }
}

/**
 * La vidéo et la surimpression sont deux éléments distincts (\`video\` et
 * \`canvas\`) : la capture les recompose sur un troisième canvas avant de la
 * copier, sinon un \`drawImage(video, ...)\` seul perdrait les boîtes.
 */
function composerCapture() {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const octx = out.getContext('2d');
  octx.drawImage(video, 0, 0, out.width, out.height);
  octx.drawImage(canvas, 0, 0, out.width, out.height);
  return new Promise((résoudre) => out.toBlob(résoudre, 'image/png'));
}

/**
 * Le blob part en promesse dans \`ClipboardItem\`, jamais attendu avant l'appel
 * de \`write\` : Chrome exige que la copie démarre pendant le geste utilisateur
 * qui l'a déclenchée, et un \`await\` du \`toBlob\` avant \`write\` perdrait cette
 * fenêtre d'activation.
 */
async function copierImage() {
  copyStatusEl.textContent = 'copie...';
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': composerCapture() })]);
    copyStatusEl.textContent = 'copié dans le presse-papier';
  } catch (e) {
    copyStatusEl.textContent = 'échec de la copie : ' + (e && e.message ? e.message : String(e));
  }
  setTimeout(() => { copyStatusEl.textContent = ''; }, 3000);
}

copyImageBtn.addEventListener('click', copierImage);

/**
 * Ce qu'un rapport de bug demande en premier — le fichier lu, l'instant, la
 * détection qui s'y trouvait, la décision de cadrage qui en sort — assemblé en
 * JSON plutôt qu'à la main dans un message, avec les points de pose bruts
 * (\`k\`) pour rejouer le calcul sans capture d'écran.
 */
function assemblerDebug() {
  const t = video.currentTime;
  const idx = findNearestTimeIndex(t);
  const nearestT = sortedTimes[idx];
  const proche = idx >= 0 && Math.abs(nearestT - t) <= 1 / sampleFps;
  return {
    proxy: currentProxy,
    project: projectSel.value,
    clip: clipSel.value || null,
    t,
    fps: sampleFps,
    // L'instant réellement échantillonné peut différer de \`t\` : le
    // scrubbing n'est pas calé sur la cadence d'analyse.
    sampledT: proche ? nearestT : null,
    boxes: proche ? boxesByTime.get(nearestT) || [] : [],
    plan: planPourInstant(t) || null,
    nativeRatio: currentNativeRatio,
  };
}

async function copierDebug() {
  debugStatusEl.textContent = 'copie...';
  try {
    await navigator.clipboard.writeText(JSON.stringify(assemblerDebug(), null, 2));
    debugStatusEl.textContent = 'copié dans le presse-papier';
  } catch (e) {
    debugStatusEl.textContent = 'échec de la copie : ' + (e && e.message ? e.message : String(e));
  }
  setTimeout(() => { debugStatusEl.textContent = ''; }, 3000);
}

copyDebugBtn.addEventListener('click', copierDebug);

async function chargerProjets() {
  const projets = await (await fetch('/api/projects')).json();
  projectSel.innerHTML = projets.map((p) => \`<option value="\${p}">\${p}</option>\`).join('');
  if (projets.length > 0) await choisirProjet(projets[0]);
}

async function choisirProjet(id) {
  video.src = \`/api/projects/\${encodeURIComponent(id)}/proxy\`;
  boxesByTime = new Map();
  sortedTimes = [];
  plans = [];
  const clips = await (await fetch(\`/api/projects/\${encodeURIComponent(id)}/clips\`)).json();
  clipSel.innerHTML = '<option value="">(toute la vidéo, auto)</option>' +
    clips.map((c) => \`<option value="\${c.id}">\${c.title || c.id}</option>\`).join('');
  await chargerCadre(id, '');
}

async function chargerCadre(projectId, clipId) {
  statusEl.textContent = 'chargement...';
  const url = clipId
    ? \`/api/projects/\${encodeURIComponent(projectId)}/cadrage/\${encodeURIComponent(clipId)}\`
    : \`/api/projects/\${encodeURIComponent(projectId)}/cadrage\`;
  const data = await (await fetch(url)).json();
  sampleFps = data.fps || 2;
  boxesByTime = new Map();
  for (const b of data.boxes) {
    if (!boxesByTime.has(b.t)) boxesByTime.set(b.t, []);
    boxesByTime.get(b.t).push(b);
  }
  sortedTimes = Array.from(boxesByTime.keys()).sort((a, b) => a - b);
  plans = data.shots;
  currentProxy = data.proxy || '';
  currentNativeRatio = data.nativeRatio || null;
  statusEl.textContent = \`\${data.boxes.length} boîtes, \${data.shots.length} plan(s) cadré(s)\` +
    (data.nativeRatio ? \` — natif \${data.nativeRatio}\` : '');
}

projectSel.addEventListener('change', () => choisirProjet(projectSel.value));
clipSel.addEventListener('change', () => chargerCadre(projectSel.value, clipSel.value));

video.addEventListener('loadedmetadata', () => {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
});

chargerProjets();
requestAnimationFrame(draw);
</script>
</body>
</html>
`

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const iPort = arguments_.indexOf('--port')
  const port = iPort >= 0 ? Number(arguments_[iPort + 1]) : PORT_DÉFAUT
  if (!Number.isInteger(port) || port <= 0) {
    console.error(`--port attend un entier > 0, reçu « ${String(arguments_[iPort + 1])} ».`)
    return 1
  }

  const server = createServer((req, res) => {
    void gérer(req, res).catch((erreur: unknown) => {
      console.error(erreur)
      if (!res.headersSent) res.writeHead(500)
      res.end(erreur instanceof Error ? erreur.message : String(erreur))
    })
  })

  await new Promise<void>((résoudre) => server.listen(port, résoudre))
  console.log(`Aperçu du cadrage : http://localhost:${port}/`)
  console.log('Ctrl-C pour arrêter.')

  await new Promise<void>((résoudre) => {
    process.on('SIGINT', () => {
      server.close(() => résoudre())
    })
  })

  return 0
}

async function gérer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const segments = url.pathname.split('/').filter(Boolean)

  if (segments.length === 0) {
    texte(res, PAGE, 'text/html; charset=utf-8')
    return
  }

  if (segments[0] !== 'api' || segments[1] !== 'projects') {
    res.writeHead(404).end()
    return
  }

  if (segments.length === 2) {
    json(res, projetsUtilisables())
    return
  }

  const projectId = decodeURIComponent(segments[2])

  // `proxy.ts` (Next) porte déjà toute la logique d'erreurs sur un identifiant
  // hors de `PROJECTS_DIR` ; ce script est un outil de développement lancé à la
  // main sur cette machine, la même garde vaut ici sans être répétée : un
  // identifiant qui ne peut nommer aucun chemin devient un 404, comme un projet
  // absent.
  let chemin: string
  try {
    chemin = proxyPath(projectId)
  } catch {
    res.writeHead(404).end()
    return
  }

  const reste = segments.slice(3)

  if (reste.length === 1 && reste[0] === 'proxy') {
    servirProxy(req, res, chemin)
    return
  }

  if (reste.length === 1 && reste[0] === 'clips') {
    const db = getDb()
    try {
      const clips = getClips(db, projectId)
      json(
        res,
        clips.map((c) => ({ id: c.id, title: c.title, ratio: c.ratio })),
      )
    } finally {
      closeDb()
    }
    return
  }

  if (reste.length === 1 && reste[0] === 'cadrage') {
    envoyerCadrage(res, projectId, undefined)
    return
  }

  if (reste.length === 2 && reste[0] === 'cadrage') {
    envoyerCadrage(res, projectId, decodeURIComponent(reste[1]))
    return
  }

  res.writeHead(404).end()
}

/**
 * Les boîtes de la source, colorées, et le crop que `computeFraming` en tire
 * par plan — celui d'un clip réel si `clipId` en désigne un, sinon celui de la
 * source entière aux réglages par défaut.
 *
 * **Les deux appellent la même fonction, avec des segments différents.** Un
 * clip ne couvre que ce qu'il monte (`clip.segments`) et prend son ratio
 * réellement choisi ; sans clip, les « segments » couvrent toute la source d'un
 * bout à l'autre et le ratio reste `'auto'` — c'est la décision que
 * l'automatique prendrait plan par plan s'il fallait tout garder, la même
 * lecture que permet `vignettes-cadrage.ts` en pointant un clip qui couvre
 * l'émission entière.
 */
function envoyerCadrage(res: ServerResponse, projectId: string, clipId: string | undefined): void {
  let analyse: ReturnType<typeof lireAnalyse>
  try {
    analyse = lireAnalyse(analysisPath(projectId))
  } catch (erreur) {
    json(res, { error: erreur instanceof Error ? erreur.message : String(erreur) }, 404)
    return
  }

  // Rappelé ici plutôt que transmis depuis `gérer` : `envoyerCadrage` doit
  // pouvoir répondre seule, et `proxyPath` est une simple validation de chemin
  // déjà repassée sans effet de bord.
  const proxy = proxyPath(projectId)

  const boxes = analyse.boxes.map((b) => {
    const c = couleur(b)
    // Tronc et tête ne se calculent que sur ce que le cadrage retient
    // vraiment — même restriction que le liseré cyan et le carré magenta de
    // `vignettes-cadrage.ts`, pas de calcul superflu sur gris/rouge.
    const torso = c === 'lime' ? personBounds(b) : undefined
    const head = c === 'lime' ? headBounds(b) : null
    return {
      t: b.t,
      x0: b.x0,
      x1: b.x1,
      y0: b.y0,
      y1: b.y1,
      score: b.score,
      c,
      torso,
      head: head ?? undefined,
      // Les points bruts, pour le débogage (bouton « Copier le debug ») : la
      // seule façon de vérifier `torso`/`head` sans relancer le calcul à la
      // main sur une capture.
      k: b.k,
    }
  })

  let segments: { start: number; end: number }[]
  let ratio: Ratio | 'auto'

  if (clipId === undefined) {
    // Toute la source, un seul segment de sa première à sa dernière frontière
    // de plan — les bornes que `analyse.shots` porte déjà, donc sans dépendre
    // d'une durée que `Analyse` ne donne pas ailleurs.
    if (analyse.shots.length === 0) {
      json(res, { fps: analyse.fps, boxes, shots: [], proxy })
      return
    }
    segments = [{ start: analyse.shots[0].start, end: analyse.shots[analyse.shots.length - 1].end }]
    ratio = 'auto'
  } else {
    const db = getDb()
    let clip
    try {
      clip = getClips(db, projectId).find((c) => c.id === clipId)
    } finally {
      closeDb()
    }
    if (clip === undefined) {
      json(res, { error: `Clip inconnu : ${clipId}` }, 404)
      return
    }
    segments = clip.segments
    ratio = clip.ratio
  }

  // Mêmes réglages que `vignettes-cadrage.ts` sans drapeau : les défauts de
  // `FRAMING_DEFAULTS`. `ratio: 'auto'` laisse `computeFraming` décider comme le
  // ferait le rendu ; un clip choisi passe le sien.
  const cadrage = computeFraming({
    segments,
    shots: analyse.shots,
    people: analyse.boxes,
    srcW: analyse.source.w,
    srcH: analyse.source.h,
    ratio,
    cropMode: 'auto',
  })

  json(res, {
    fps: analyse.fps,
    boxes,
    nativeRatio: cadrage.ratio,
    shots: cadrage.shots.map((s) => planEnvoyé(s, analyse.source.w, analyse.source.h)),
    proxy,
  })
}

void main().then(quitter, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quitter(1)
})
