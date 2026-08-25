/**
 * **Le rectangle que le cadrage automatique découperait, dessiné sur l'image.**
 *
 *     pnpm tsx scripts/framing-thumbnails.ts 2025-06-15-cqlp_004655941-004681822
 *     pnpm tsx scripts/framing-thumbnails.ts 2025-06-15-cqlp <clipId> --marge 0.01 --ratio 1:1
 *     pnpm tsx scripts/framing-thumbnails.ts 2025-06-15-cqlp <clipId> --trim 0 --images 3
 *
 * `<projectId>` est optionnel : `<clipId>` le contient (il se construit en
 * `${projectId}_${ms(start)}-${ms(end)}`), donc un seul positionnel suffit quand on
 * n'a que l'identifiant du clip sous la main. Passer les deux reste possible et
 * prioritaire.
 *
 * `vignettes-premier-plan.ts` dessine les **boîtes** : il répond à « qui le
 * détecteur voit-il, et lesquels le filtre écarte ». Celui-ci dessine le **crop**
 * : il répond à « qu'est-ce que le spectateur verrait ». Ce sont deux questions
 * différentes, et la seconde est la seule qui tranche la question de la marge.
 *
 * **Pourquoi elle ne se tranche qu'ici.** `FramingOptions.margin` valait 2 % sans
 * avoir jamais été mesuré — un réglage de confort, posé parce que la boîte du
 * détecteur épouse la silhouette et qu'un crop pile dessus met un coude sur le
 * bord. Elle vaut 1 % depuis le 18 août 2026, et c'est ce script qui a tranché :
 * baisser la marge resserre des clips, ça un tableau le dit ; mais « sans mettre
 * les comédiens au bord » ne se lit pas dans un tableau, il faut voir le
 * rectangle et voir ce qui reste dedans. `FRAMING_DEFAULTS` fait foi sur la
 * valeur du jour ; cette phrase raconte pourquoi elle a bougé. (relevé par Copilot)
 *
 * **Et c'est ici que le rognage latéral s'est tranché**, pour la même raison que
 * la marge : les tableaux disent qu'il resserre des clips, ils ne disent pas si ce
 * qui tombe au bord est une épaule ou une joue. Le cas qui a posé son plafond n'a
 * été vu qu'à l'image — un comédien assis jambes tendues, dont la boîte est large
 * mais dont la tête est à l'extrémité droite.
 *
 * Le crop est **fixe à l'intérieur d'un plan** (spec §10), donc une vignette par
 * plan suffit — et on y choisit l'image qui **sort le plus** du rectangle, pas la
 * plus large. Ce n'est pas la même : un sujet plus étroit posé ailleurs peut
 * déborder pendant que la plus large tient, et le seuil de 90 % autorise
 * justement des images à déborder. Le compte des images débordantes du plan est
 * imprimé à côté, parce qu'une vignette qui tient ne dit rien des autres.
 *
 * `--images N` en tire N, à rangs régulièrement espacés dans le classement : la
 * pire est par construction une exception, et trois copies du même accident ne
 * disent rien du cadrage courant.
 *
 * Cinq couleurs. Trois pour les boîtes, les mêmes que l'autre script — vert
 * gardée, rouge écartée par le filtre du premier plan, gris sous le seuil de
 * confiance —, plus un liseré **cyan** à l'intérieur des vertes qui montre **ce
 * que le cadrage exige vraiment** de cette personne : son tronc quand les points
 * de pose le disent, sa boîte moins ses extrémités sinon. Et **jaune** pour le
 * crop, qui n'est pas une boîte mais une décision.
 *
 * Sur une analyse qui porte des points, un carré **magenta** marque la tête. Il
 * répond à la seule question qui compte quand on regarde un resserrement : le
 * visage est-il dans le rectangle jaune ? La campagne du 19 août a posé le
 * plafond du rognage sur un visage tombé dehors, et elle ne l'a vu qu'en
 * regardant — le carré évite d'avoir à deviner sur une image de 960 pixels.
 *
 * `--analyse <fichier>` lit une autre analyse que celle du projet, ce qui permet
 * de comparer deux détecteurs sans écraser le fichier que le serveur sert.
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
  TORSOS,
  computeFraming,
  cropRect,
  headBounds,
  isForeground,
  personBounds,
  requiredWidths,
} from '@/core/framing'
import type { TorsoName } from '@/core/framing'
import { shotStartMs } from '@/core/shots'
import type { PersonBox } from '@/core/shots'
import { closeDb, getClips, getDb } from '@/server/db'
import { analysisPath, proxyPath } from '@/server/paths'
import { lireAnalysis } from '@/server/steps/analysis'
import { chargerEnv, quit } from './dev-common'

/** Le binaire de `setup.sh`, le même que le reste de la chaîne. */
function ffmpeg(): string {
  return process.env.FFMPEG_BIN || 'ffmpeg'
}

/** Le sort d'une boîte, à l'identique de `vignettes-premier-plan.ts`. */
function color(b: PersonBox): string {
  // `!(score >= seuil)` et non `score < seuil`, comme dans `empans` : un score
  // `NaN` doit tomber du côté écarté.
  if (!(b.score >= FRAMING_DEFAULTS.minScore)) return 'gray'
  return isForeground(b) ? 'red' : 'lime'
}

/** Le rectangle de crop en fractions de la source, ses **quatre** composantes. */
type Frame = { x: number; y: number; w: number; h: number }

/**
 * Une vignette : les boîtes de l'image, puis le rectangle de crop par-dessus.
 *
 * Le crop est tracé en dernier et plus épais — c'est lui qu'on regarde, et un
 * trait de 2 px se perd sous une boîte qui l'épouse presque.
 *
 * **Les quatre composantes, pas seulement l'abscisse et la largeur.** Sur une
 * source 16:9 la hauteur est toujours prise en entier et `y` vaut zéro, mais
 * `cropRect` recentre verticalement dès que la source est trop étroite pour le
 * ratio demandé — un 4:3, un portrait. Un rectangle dessiné pleine hauteur y
 * montrerait un cadrage qui n'existe pas, sur la seule figure dont on tire une
 * conclusion. (relevé par Codex)
 */
function vignette(
  proxy: string,
  t: number,
  boxes: PersonBox[],
  crop: Frame,
  W: number,
  H: number,
  out: string,
  trim: number,
  torso: TorsoName | 'off',
): void {
  const filters = boxes.map((b) => {
    const x = Math.round(b.x0 * W)
    const y = Math.round(b.y0 * H)
    const w = Math.max(1, Math.round((b.x1 - b.x0) * W))
    const h = Math.max(1, Math.round((b.y1 - b.y0) * H))
    return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color(b)}:t=2`
  })
  // **Ce que le cadrage exige vraiment**, en cyan et à l'intérieur de la boîte :
  // le tronc quand les points de pose le disent, la boîte rognée sinon. C'est la
  // seule chose que le chiffre ne dit pas — un pourcentage ne montre pas si ce
  // qui tombe est une épaule ou une joue.
  for (const b of boxes) {
    if (color(b) !== 'lime') continue
    const { x0, x1 } = personBounds(b, { sideTrim: trim, torso })
    const y = Math.round(b.y0 * H)
    const h = Math.max(1, Math.round((b.y1 - b.y0) * H))
    filters.push(
      `drawbox=x=${Math.round(x0 * W)}:y=${y}:w=${Math.max(1, Math.round((x1 - x0) * W))}:h=${h}:color=cyan:t=1`,
    )
    // La tête, quand elle est connue. Un carré et non un point : un pixel se
    // perd sur une image de 960 de large, et ce qu'on cherche à voir est de
    // quel côté du trait jaune il tombe.
    const head = headBounds(b)
    if (head === null) continue
    filters.push(
      `drawbox=x=${Math.round(head.x0 * W)}:y=${Math.round(head.y0 * H)}` +
        `:w=${Math.max(3, Math.round((head.x1 - head.x0) * W))}` +
        `:h=${Math.max(3, Math.round((head.y1 - head.y0) * H))}:color=magenta:t=2`,
    )
  }
  filters.push(
    `drawbox=x=${Math.round(crop.x * W)}:y=${Math.round(crop.y * H)}` +
      `:w=${Math.round(crop.w * W)}:h=${Math.round(crop.h * H)}:color=yellow:t=4`,
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
      filters.join(','),
      out,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
}

/** Une image mesurée : ses boîtes gardées, son empan et ses bornes. */
type Measured = { t: number; boxes: PersonBox[]; span: number; g: number; d: number; top: number; bottom: number }

/**
 * L'étendue des boîtes **que le cadrage lit** — seuil de confiance et filtre du
 * premier plan appliqués, marge comprise horizontalement.
 *
 * Rend `undefined` quand l'image ne garde aucune boîte : elle ne dit pas que le
 * cadre peut être serré, elle ne dit rien. Les bornes verticales n'ont pas de
 * marge — `empans` n'en met pas non plus, la hauteur n'entre pas dans le choix
 * du ratio.
 */
function extent(
  boxes: PersonBox[],
  margin: number,
  trim: number,
  torso: TorsoName | 'off',
): { g: number | undefined; d: number | undefined; top: number; bottom: number } {
  const kept = boxes.filter((b) => b.score >= FRAMING_DEFAULTS.minScore && !isForeground(b))
  if (kept.length === 0) return { g: undefined, d: undefined, top: 0, bottom: 1 }
  const required = kept.map((b) => personBounds(b, { sideTrim: trim, torso }))
  // **Les deux bornes dans [0, 1] des deux côtés**, comme `empans` de
  // `framing.ts`. Depuis que `personBounds` lit des points de pose, l'étendue
  // peut sortir de l'image en entier : borner chacune de son seul côté donnait
  // `g = 0` avec `d < 0`, donc un empan retourné et un débordement gonflé pour
  // une personne qui n'est plus là. Le jumeau de ce défaut a été corrigé dans
  // `framing.ts` et celui-ci n'avait pas suivi. (relevé par Aristarque)
  const bound = (n: number): number => Math.min(Math.max(n, 0), 1)
  return {
    g: bound(Math.min(...required.map((b) => b.x0)) - margin),
    d: bound(Math.max(...required.map((b) => b.x1)) + margin),
    top: Math.min(...kept.map((b) => b.y0)),
    bottom: Math.max(...kept.map((b) => b.y1)),
  }
}

/** De combien l'étendue d'une image sort du rectangle, les deux axes cumulés. */
function overflow(e: { g: number; d: number; top: number; bottom: number }, crop: Frame): number {
  return (
    Math.max(0, crop.x - e.g) +
    Math.max(0, e.d - (crop.x + crop.w)) +
    Math.max(0, crop.y - e.top) +
    Math.max(0, e.bottom - (crop.y + crop.h))
  )
}

function estRatio(a: string): a is Ratio {
  return Object.prototype.hasOwnProperty.call(RATIOS, a)
}

/**
 * Le projet contenu dans un identifiant de clip — `clipId` de
 * `src/core/gemini/parse.ts` le construit en `${projectId}_${ms(start)}-${ms(end)}`,
 * donc l'un se retrouve dans l'autre sans jamais interroger la base.
 */
function projectIdFromClipId(clipId: string): string | undefined {
  const m = /^(.+)_\d{9}-\d{9}$/.exec(clipId)
  return m?.[1]
}

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const value = (flag: string): string | undefined => {
    const i = arguments_.indexOf(flag)
    if (i < 0) return undefined
    const raw = arguments_[i + 1]
    return raw === undefined || raw.startsWith('--') ? undefined : raw
  }
  const flagsWithValue = new Set<number>()
  for (const d of ['--marge', '--out', '--ratio', '--trim', '--images', '--tronc', '--analyse']) {
    const i = arguments_.indexOf(d)
    if (i >= 0) flagsWithValue.add(i + 1)
  }
  const positional = arguments_.filter(
    (a, i) => !a.startsWith('--') && !flagsWithValue.has(i),
  )
  // Le projet est optionnel : `clipId` le contient (`projectIdFromClipId`), donc
  // un seul positionnel suffit — `pnpm tsx scripts/framing-thumbnails.ts <clipId>`.
  let projectId: string | undefined
  let clipId: string | undefined
  if (positional.length >= 2) {
    ;[projectId, clipId] = positional
  } else {
    clipId = positional[0]
    projectId = clipId === undefined ? undefined : projectIdFromClipId(clipId)
  }
  if (projectId === undefined || clipId === undefined) {
    console.error(
      'Usage : pnpm tsx scripts/framing-thumbnails.ts [<projectId>] <clipId> ' +
        '[--marge M] [--trim T] [--tronc <nom|off>] [--ratio 9:16|4:5|1:1|16:9] ' +
        '[--images N] [--analyse <fichier>] [--out <dossier>]\n' +
        `<projectId> est optionnel : déduit de <clipId> quand un seul positionnel est passé.`,
    )
    return 1
  }

  const rawMargin = value('--marge')
  const margin = rawMargin === undefined ? FRAMING_DEFAULTS.margin : Number(rawMargin)
  // Une marge illisible est **refusée**. `réglage` la remplacerait silencieusement
  // par le défaut dans `framing.ts`, et la vignette montrerait le cadrage de la
  // marge par défaut sous une légende annonçant l'autre — exactement l'image dont
  // on tirerait une conclusion fausse.
  if (!Number.isFinite(margin) || margin < 0) {
    console.error(`--marge attend un nombre ≥ 0, reçu « ${String(rawMargin)} ».`)
    return 1
  }
  const rawTrim = value('--trim')
  const trim = rawTrim === undefined ? FRAMING_DEFAULTS.sideTrim : Number(rawTrim)
  // Refusé et non corrigé, pour la même raison que la marge : une vignette qui
  // montre un autre rognage que celui de sa légende est l'image dont on tire une
  // conclusion fausse.
  if (!Number.isFinite(trim) || trim < 0 || trim > 0.5) {
    console.error(`--trim attend un nombre entre 0 et 0,5, reçu « ${String(rawTrim)} ».`)
    return 1
  }
  const rawImages = value('--images')
  const imageCount = rawImages === undefined ? 1 : Number(rawImages)
  if (!Number.isInteger(imageCount) || imageCount <= 0) {
    console.error(`--images attend un entier \u2265 1, re\u00e7u \u00ab ${String(rawImages)} \u00bb.`)
    return 1
  }
  // Refusé et non corrigé, pour la même raison que la marge : une vignette qui
  // montre un autre tronc que celui de sa légende est l'image dont on tire une
  // conclusion fausse.
  const rawTorso = value('--tronc')
  const knownTorsos = ['off', ...Object.keys(TORSOS)]
  if (rawTorso !== undefined && !knownTorsos.includes(rawTorso)) {
    console.error(`--tronc attend l'un de ${knownTorsos.join(', ')}, reçu « ${rawTorso} ».`)
    return 1
  }
  const torso = (rawTorso ?? FRAMING_DEFAULTS.torso) as TorsoName | 'off'

  const rawRatio = value('--ratio')
  if (rawRatio !== undefined && !estRatio(rawRatio)) {
    console.error(`--ratio attend l'un de ${Object.keys(RATIOS).join(', ')}, reçu « ${rawRatio} ».`)
    return 1
  }

  const analysis = lireAnalysis(value('--analyse') ?? analysisPath(projectId))
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

  const framing = computeFraming({
    margin: margin,
    sideTrim: trim,
    torso,
    segments: clip.segments,
    shots: analysis.shots,
    people: analysis.boxes,
    srcW: analysis.source.w,
    srcH: analysis.source.h,
    ratio: rawRatio ?? 'auto',
    cropMode: 'auto',
  })

  const folder = value('--out') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cadrage-'))
  fs.mkdirSync(folder, { recursive: true })

  const segments = normalizeSegments(clip.segments)
  const { w: W, h: H } = analysis.proxy
  console.log(
    `${clipId} — natif ${framing.ratio}, marge ${margin}, rognage ${trim}, tronc ${torso}, ` +
      `${framing.shots.length} plan(s)` +
      ` — largeur du crop natif ${((RATIOS[framing.ratio] * analysis.source.h) / analysis.source.w).toFixed(3)}`,
  )

  for (const shot of framing.shots) {
    // Les images du plan **qui sont montées** : le cadrage ne mesure que
    // celles-là, donc les vignettes doivent regarder les mêmes. Fin exclue, comme
    // `computeFraming`.
    const inside = analysis.boxes.filter(
      (b) =>
        b.t >= shot.shot.start &&
        b.t < shot.shot.end &&
        segments.some((s) => b.t >= s.start && b.t < s.end),
    )
    const byImage = new Map<number, PersonBox[]>()
    for (const b of inside) {
      const key = Math.round(b.t * 1000)
      const already = byImage.get(key)
      if (already) already.push(b)
      else byImage.set(key, [b])
    }
    // **Le ratio du plan, pas celui du natif.** Depuis que le ratio se choisit
    // par plan (spec §10), `plan.cropX` cadre `plan.ratio` et `plan.cropXNative`
    // cadre `cadrage.ratio` ; croiser les deux dessinait un rectangle qui n'est
    // celui d'aucune des deux sorties. C'est le cadre du plan qu'on regarde :
    // c'est le plus serré des deux, donc le seul qui puisse couper quelqu'un.
    const rect = cropRect(shot.ratio, shot.cropX, analysis.source.w, analysis.source.h)
    const crop: Frame = {
      x: rect.x / analysis.source.w,
      y: rect.y / analysis.source.h,
      w: rect.w / analysis.source.w,
      h: rect.h / analysis.source.h,
    }

    // **Classées par débordement, pas par largeur** — et c'est tout le sujet du
    // script. L'image la plus large n'est pas celle qui met le crop en défaut :
    // un sujet plus étroit posé ailleurs peut sortir du rectangle pendant que la
    // plus large y tient, et le seuil de 90 % autorise justement des images à
    // déborder. Une vignette choisie sur la largeur pouvait donc s'étiqueter
    // « cadrée » et faire croire que tout le plan l'était. (relevé par Codex)
    //
    // Le débordement se mesure **sur les deux axes** : sur une source 16:9 le
    // crop est pleine hauteur et le terme vertical est nul, mais il ne l'est plus
    // dès que `cropRect` recentre verticalement.
    const sorted = [...byImage.entries()]
      .map(([key, boxes]) => {
        const span = requiredWidths(boxes, { margin: margin, sideTrim: trim, torso })[0]
        return { t: key / 1000, boxes, span, ...extent(boxes, margin, trim, torso) }
      })
      .filter(
        (e): e is Measured => e.span !== undefined && e.g !== undefined && e.d !== undefined,
      )
      .map((e) => ({ ...e, sortie: overflow(e, crop) }))
      // Le plus gros débordement d'abord ; à débordement égal — zéro, le cas
      // courant —, la plus large, qui reste la plus instructive.
      .sort((a, b) => b.sortie - a.sortie || b.span - a.span)

    if (sorted.length === 0) {
      console.log(`  plan ${shotStartMs(shot.shot)} ms — aucune image mesurée, crop centré`)
      continue
    }

    const overflowing = sorted.filter((e) => e.sortie > 1e-9).length
    // **Des rangs régulièrement espacés dans le classement, pas les N pires.**
    // La pire image est par construction une exception — c'est celle que le
    // seuil de 90 % accepte de sacrifier —, donc trois copies du même accident
    // ne disent rien du cadrage courant. Un pas régulier de la pire à la
    // meilleure montre l'accident *et* le cas normal, qui est la seule
    // comparaison qui tranche.
    const ranks =
      imageCount === 1
        ? [0]
        : [...new Set(
            Array.from({ length: imageCount }, (_, i) =>
              Math.round((i * (sorted.length - 1)) / (imageCount - 1)),
            ),
          )]

    for (const rank of ranks) {
      const picked = sorted[rank]
      const file = path.join(
        folder,
        `plan${shotStartMs(shot.shot)}_r${rank}_t${picked.t.toFixed(1)}.png`,
      )
      vignette(proxy, picked.t, picked.boxes, crop, W, H, file, trim, torso)

      console.log(
        `  ${file}  plan ${shotStartMs(shot.shot)} ms ${shot.ratio}, image ${picked.t.toFixed(1)} s` +
          ` (rang ${rank + 1}/${sorted.length})` +
          ` — empan [${picked.g.toFixed(3)} ; ${picked.d.toFixed(3)}] (${picked.span.toFixed(3)})` +
          `, crop [${crop.x.toFixed(3)} ; ${(crop.x + crop.w).toFixed(3)}]` +
          ` — ${picked.sortie > 1e-9 ? `DÉBORDE de ${picked.sortie.toFixed(3)}` : 'cadrée'}` +
          ` — ${overflowing} image(s) sur ${sorted.length} débordent` +
          ` (${((100 * overflowing) / sorted.length).toFixed(0)} %)`,
      )
    }
  }

  return 0
}

void main().then(quit, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quit(1)
})
