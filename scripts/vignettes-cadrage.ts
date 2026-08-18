/**
 * **Le rectangle que le cadrage automatique découperait, dessiné sur l'image.**
 *
 *     pnpm tsx scripts/vignettes-cadrage.ts 2025-06-15-cqlp 2025-06-15-cqlp_004655941-004681822
 *     pnpm tsx scripts/vignettes-cadrage.ts 2025-06-15-cqlp <clipId> --marge 0.01 --ratio 1:1
 *
 * `vignettes-premier-plan.ts` dessine les **boîtes** : il répond à « qui le
 * détecteur voit-il, et lesquels le filtre écarte ». Celui-ci dessine le **crop**
 * : il répond à « qu'est-ce que le spectateur verrait ». Ce sont deux questions
 * différentes, et la seconde est la seule qui tranche la question de la marge.
 *
 * **Pourquoi elle ne se tranche qu'ici.** `FramingOptions.margin` vaut 2 % et
 * n'a jamais été mesuré : c'est un réglage de confort, posé parce que la boîte du
 * détecteur épouse la silhouette et qu'un crop pile dessus met un coude sur le
 * bord. Baisser la marge resserre des clips — ça, un tableau le dit. Mais « sans
 * mettre les comédiens au bord » ne se lit pas dans un tableau : il faut voir le
 * rectangle et voir ce qui reste dedans.
 *
 * Le crop est **fixe à l'intérieur d'un plan** (spec §10), donc une vignette par
 * plan suffit — et on choisit dans chaque plan l'image la plus large, celle qui
 * contraint le plus. Si les comédiens tiennent là, ils tiennent partout dans ce
 * plan.
 *
 * Trois couleurs, les mêmes que l'autre script pour les boîtes — vert gardée,
 * rouge écartée par le filtre du premier plan, gris sous le seuil de confiance —
 * et **jaune** pour le crop, qui n'est pas une boîte mais une décision.
 *
 * Les vignettes vont dans `--out` (défaut : un dossier temporaire), jamais dans
 * `projects/`, que d'autres processus lisent au même moment.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { normalizeSegments } from '@/core/edl'
import type { Ratio } from '@/core/edl'
import {
  FRAMING_DEFAULTS,
  RATIOS,
  computeFraming,
  cropRect,
  isForeground,
  requiredWidths,
} from '@/core/framing'
import { shotStartMs } from '@/core/shots'
import type { PersonBox } from '@/core/shots'
import { closeDb, getClips, getDb } from '@/server/db'
import { analysisPath, proxyPath } from '@/server/paths'
import { lireAnalyse } from '@/server/steps/analysis'
import { chargerEnv, quitter } from './dev-commun'

/** Le binaire de `setup.sh`, le même que le reste de la chaîne. */
function ffmpeg(): string {
  return process.env.FFMPEG_BIN || 'ffmpeg'
}

/** Le sort d'une boîte, à l'identique de `vignettes-premier-plan.ts`. */
function couleur(b: PersonBox): string {
  // `!(score >= seuil)` et non `score < seuil`, comme dans `empans` : un score
  // `NaN` doit tomber du côté écarté.
  if (!(b.score >= FRAMING_DEFAULTS.minScore)) return 'gray'
  return isForeground(b) ? 'red' : 'lime'
}

/**
 * Une vignette : les boîtes de l'image, puis le rectangle de crop par-dessus.
 *
 * Le crop est tracé en dernier et plus épais — c'est lui qu'on regarde, et un
 * trait de 2 px se perd sous une boîte qui l'épouse presque.
 */
function vignette(
  proxy: string,
  t: number,
  boîtes: PersonBox[],
  crop: { x: number; w: number },
  W: number,
  H: number,
  out: string,
): void {
  const filtres = boîtes.map((b) => {
    const x = Math.round(b.x0 * W)
    const y = Math.round(b.y0 * H)
    const w = Math.max(1, Math.round((b.x1 - b.x0) * W))
    const h = Math.max(1, Math.round((b.y1 - b.y0) * H))
    return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${couleur(b)}:t=2`
  })
  filtres.push(
    `drawbox=x=${Math.round(crop.x * W)}:y=0:w=${Math.round(crop.w * W)}:h=${H}:color=yellow:t=4`,
  )
  execFileSync(
    ffmpeg(),
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
      '-vf',
      filtres.join(','),
      out,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
}

function estRatio(a: string): a is Ratio {
  return Object.prototype.hasOwnProperty.call(RATIOS, a)
}

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const valeurDe = (drapeau: string): string | undefined => {
    const i = arguments_.indexOf(drapeau)
    if (i < 0) return undefined
    const brut = arguments_[i + 1]
    return brut === undefined || brut.startsWith('--') ? undefined : brut
  }
  const drapeauxAvecValeur = new Set<number>()
  for (const d of ['--marge', '--out', '--ratio']) {
    const i = arguments_.indexOf(d)
    if (i >= 0) drapeauxAvecValeur.add(i + 1)
  }
  const positionnels = arguments_.filter(
    (a, i) => !a.startsWith('--') && !drapeauxAvecValeur.has(i),
  )
  const [projectId, clipId] = positionnels
  if (projectId === undefined || clipId === undefined) {
    console.error(
      'Usage : pnpm tsx scripts/vignettes-cadrage.ts <projectId> <clipId> ' +
        '[--marge M] [--ratio 9:16|4:5|1:1|16:9] [--out <dossier>]',
    )
    return 1
  }

  const brutMarge = valeurDe('--marge')
  const marge = brutMarge === undefined ? FRAMING_DEFAULTS.margin : Number(brutMarge)
  // Une marge illisible est **refusée**. `réglage` la remplacerait silencieusement
  // par le défaut dans `framing.ts`, et la vignette montrerait le cadrage de la
  // marge par défaut sous une légende annonçant l'autre — exactement l'image dont
  // on tirerait une conclusion fausse.
  if (!Number.isFinite(marge) || marge < 0) {
    console.error(`--marge attend un nombre ≥ 0, reçu « ${String(brutMarge)} ».`)
    return 1
  }
  const brutRatio = valeurDe('--ratio')
  if (brutRatio !== undefined && !estRatio(brutRatio)) {
    console.error(`--ratio attend l'un de ${Object.keys(RATIOS).join(', ')}, reçu « ${brutRatio} ».`)
    return 1
  }

  const analyse = lireAnalyse(analysisPath(projectId))
  const proxy = proxyPath(projectId)
  if (!fs.existsSync(proxy)) {
    console.error(`Proxy introuvable : ${proxy}`)
    return 1
  }

  const db = getDb()
  const clip = getClips(db, projectId).find((c) => c.id === clipId)
  closeDb()
  if (clip === undefined) {
    console.error(`Clip inconnu sur ${projectId} : ${clipId}`)
    return 1
  }

  const cadrage = computeFraming({
    margin: marge,
    segments: clip.segments,
    shots: analyse.shots,
    people: analyse.boxes,
    srcW: analyse.source.w,
    srcH: analyse.source.h,
    ratio: brutRatio ?? 'auto',
    cropMode: 'auto',
  })

  const dossier = valeurDe('--out') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cadrage-'))
  fs.mkdirSync(dossier, { recursive: true })

  const segments = normalizeSegments(clip.segments)
  const { w: W, h: H } = analyse.proxy
  console.log(
    `${clipId} — ratio ${cadrage.ratio}, marge ${marge}, ${cadrage.shots.length} plan(s)` +
      ` — largeur du crop ${((RATIOS[cadrage.ratio] * analyse.source.h) / analyse.source.w).toFixed(3)}`,
  )

  for (const plan of cadrage.shots) {
    // Les images du plan **qui sont montées** : le cadrage ne mesure que
    // celles-là, donc les vignettes doivent regarder les mêmes. Fin exclue, comme
    // `computeFraming`.
    const dedans = analyse.boxes.filter(
      (b) =>
        b.t >= plan.shot.start &&
        b.t < plan.shot.end &&
        segments.some((s) => b.t >= s.start && b.t < s.end),
    )
    const parImage = new Map<number, PersonBox[]>()
    for (const b of dedans) {
      const clé = Math.round(b.t * 1000)
      const déjà = parImage.get(clé)
      if (déjà) déjà.push(b)
      else parImage.set(clé, [b])
    }
    // L'image la plus large du plan : celle qui contraint le crop. Si les
    // comédiens tiennent là, ils tiennent partout dans ce plan — le crop ne bouge
    // pas à l'intérieur d'un plan.
    const classées = [...parImage.entries()]
      .map(([clé, boîtes]) => ({ t: clé / 1000, boîtes, empan: requiredWidths(boîtes, { margin: marge })[0] }))
      .filter((e): e is { t: number; boîtes: PersonBox[]; empan: number } => e.empan !== undefined)
      .sort((a, b) => b.empan - a.empan)
    const pire = classées[0]
    if (pire === undefined) {
      console.log(`  plan ${shotStartMs(plan.shot)} ms — aucune image mesurée, crop centré`)
      continue
    }

    const rect = cropRect(cadrage.ratio, plan.cropX, analyse.source.w, analyse.source.h)
    const crop = { x: rect.x / analyse.source.w, w: rect.w / analyse.source.w }
    const fichier = path.join(dossier, `plan${shotStartMs(plan.shot)}_t${pire.t.toFixed(1)}.png`)
    vignette(proxy, pire.t, pire.boîtes, crop, W, H, fichier)

    // « Cadrée » au sens de `chooseRatio` : l'empan **entier** tient dans le
    // rectangle. C'est le critère qui décide, pas une appréciation à l'œil.
    const gardées = pire.boîtes.filter((b) => b.score >= FRAMING_DEFAULTS.minScore && !isForeground(b))
    const g = Math.max(0, Math.min(...gardées.map((b) => b.x0)) - marge)
    const d = Math.min(1, Math.max(...gardées.map((b) => b.x1)) + marge)
    const cadrée = g >= crop.x - 1e-9 && d <= crop.x + crop.w + 1e-9
    console.log(
      `  ${fichier}  plan ${shotStartMs(plan.shot)} ms, image la plus large ${pire.t.toFixed(1)} s` +
        ` — empan [${g.toFixed(3)} ; ${d.toFixed(3)}] (${pire.empan.toFixed(3)})` +
        `, crop [${crop.x.toFixed(3)} ; ${(crop.x + crop.w).toFixed(3)}]` +
        ` — ${cadrée ? 'cadrée' : 'DÉBORDE'}`,
    )
  }

  return 0
}

void main().then(quitter, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quitter(1)
})
