/**
 * **Le rectangle que le cadrage automatique découperait, dessiné sur l'image.**
 *
 *     pnpm tsx scripts/vignettes-cadrage.ts 2025-06-15-cqlp 2025-06-15-cqlp_004655941-004681822
 *     pnpm tsx scripts/vignettes-cadrage.ts 2025-06-15-cqlp <clipId> --marge 0.01 --ratio 1:1
 *     pnpm tsx scripts/vignettes-cadrage.ts 2025-06-15-cqlp <clipId> --trim 0 --images 3
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
  isForeground,
  personBounds,
  requiredWidths,
} from '@/core/framing'
import type { TorsoName } from '@/core/framing'
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

/** Le rectangle de crop en fractions de la source, ses **quatre** composantes. */
type Cadre = { x: number; y: number; w: number; h: number }

/**
 * L'étendue des points de tête d'une personne, ou `null` si le squelette n'en
 * porte pas — analyse sans points, ou dos tourné.
 *
 * Les cinq points COCO de la tête, et non le seul nez : un profil ne montre
 * qu'un œil et qu'une oreille.
 */
function headBounds(b: PersonBox): { x0: number; y0: number; x1: number; y1: number } | null {
  const k = b.k
  if (k === undefined) return null
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  let seen = 0
  for (const rank of TORSOS.head) {
    if (!(k[rank * 3 + 2] >= FRAMING_DEFAULTS.torsoMinScore)) continue
    seen += 1
    x0 = Math.min(x0, k[rank * 3])
    x1 = Math.max(x1, k[rank * 3])
    y0 = Math.min(y0, k[rank * 3 + 1])
    y1 = Math.max(y1, k[rank * 3 + 1])
  }
  return seen === 0 ? null : { x0, y0, x1, y1 }
}

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
  boîtes: PersonBox[],
  crop: Cadre,
  W: number,
  H: number,
  out: string,
  trim: number,
  torso: TorsoName | 'off',
): void {
  const filtres = boîtes.map((b) => {
    const x = Math.round(b.x0 * W)
    const y = Math.round(b.y0 * H)
    const w = Math.max(1, Math.round((b.x1 - b.x0) * W))
    const h = Math.max(1, Math.round((b.y1 - b.y0) * H))
    return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${couleur(b)}:t=2`
  })
  // **Ce que le cadrage exige vraiment**, en cyan et à l'intérieur de la boîte :
  // le tronc quand les points de pose le disent, la boîte rognée sinon. C'est la
  // seule chose que le chiffre ne dit pas — un pourcentage ne montre pas si ce
  // qui tombe est une épaule ou une joue.
  for (const b of boîtes) {
    if (couleur(b) !== 'lime') continue
    const { x0, x1 } = personBounds(b, { sideTrim: trim, torso })
    const y = Math.round(b.y0 * H)
    const h = Math.max(1, Math.round((b.y1 - b.y0) * H))
    filtres.push(
      `drawbox=x=${Math.round(x0 * W)}:y=${y}:w=${Math.max(1, Math.round((x1 - x0) * W))}:h=${h}:color=cyan:t=1`,
    )
    // La tête, quand elle est connue. Un carré et non un point : un pixel se
    // perd sur une image de 960 de large, et ce qu'on cherche à voir est de
    // quel côté du trait jaune il tombe.
    const head = headBounds(b)
    if (head === null) continue
    filtres.push(
      `drawbox=x=${Math.round(head.x0 * W)}:y=${Math.round(head.y0 * H)}` +
        `:w=${Math.max(3, Math.round((head.x1 - head.x0) * W))}` +
        `:h=${Math.max(3, Math.round((head.y1 - head.y0) * H))}:color=magenta:t=2`,
    )
  }
  filtres.push(
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
      filtres.join(','),
      out,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
}

/** Une image mesurée : ses boîtes gardées, son empan et ses bornes. */
type Mesurée = { t: number; boîtes: PersonBox[]; empan: number; g: number; d: number; haut: number; bas: number }

/**
 * L'étendue des boîtes **que le cadrage lit** — seuil de confiance et filtre du
 * premier plan appliqués, marge comprise horizontalement.
 *
 * Rend `undefined` quand l'image ne garde aucune boîte : elle ne dit pas que le
 * cadre peut être serré, elle ne dit rien. Les bornes verticales n'ont pas de
 * marge — `empans` n'en met pas non plus, la hauteur n'entre pas dans le choix
 * du ratio.
 */
function étendue(
  boîtes: PersonBox[],
  marge: number,
  trim: number,
  torso: TorsoName | 'off',
): { g: number | undefined; d: number | undefined; haut: number; bas: number } {
  const gardées = boîtes.filter((b) => b.score >= FRAMING_DEFAULTS.minScore && !isForeground(b))
  if (gardées.length === 0) return { g: undefined, d: undefined, haut: 0, bas: 1 }
  const required = gardées.map((b) => personBounds(b, { sideTrim: trim, torso }))
  return {
    g: Math.max(0, Math.min(...required.map((b) => b.x0)) - marge),
    d: Math.min(1, Math.max(...required.map((b) => b.x1)) + marge),
    haut: Math.min(...gardées.map((b) => b.y0)),
    bas: Math.max(...gardées.map((b) => b.y1)),
  }
}

/** De combien l'étendue d'une image sort du rectangle, les deux axes cumulés. */
function débordement(e: { g: number; d: number; haut: number; bas: number }, crop: Cadre): number {
  return (
    Math.max(0, crop.x - e.g) +
    Math.max(0, e.d - (crop.x + crop.w)) +
    Math.max(0, crop.y - e.haut) +
    Math.max(0, e.bas - (crop.y + crop.h))
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
  for (const d of ['--marge', '--out', '--ratio', '--trim', '--images', '--tronc', '--analyse']) {
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
        '[--marge M] [--trim T] [--tronc <nom|off>] [--ratio 9:16|4:5|1:1|16:9] ' +
        '[--images N] [--analyse <fichier>] [--out <dossier>]',
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
  const rawTrim = valeurDe('--trim')
  const trim = rawTrim === undefined ? FRAMING_DEFAULTS.sideTrim : Number(rawTrim)
  // Refusé et non corrigé, pour la même raison que la marge : une vignette qui
  // montre un autre rognage que celui de sa légende est l'image dont on tire une
  // conclusion fausse.
  if (!Number.isFinite(trim) || trim < 0 || trim > 0.5) {
    console.error(`--trim attend un nombre entre 0 et 0,5, reçu « ${String(rawTrim)} ».`)
    return 1
  }
  const rawImages = valeurDe('--images')
  const imageCount = rawImages === undefined ? 1 : Number(rawImages)
  if (!Number.isInteger(imageCount) || imageCount <= 0) {
    console.error(`--images attend un entier \u2265 1, re\u00e7u \u00ab ${String(rawImages)} \u00bb.`)
    return 1
  }
  // Refusé et non corrigé, pour la même raison que la marge : une vignette qui
  // montre un autre tronc que celui de sa légende est l'image dont on tire une
  // conclusion fausse.
  const rawTorso = valeurDe('--tronc')
  const knownTorsos = ['off', ...Object.keys(TORSOS)]
  if (rawTorso !== undefined && !knownTorsos.includes(rawTorso)) {
    console.error(`--tronc attend l'un de ${knownTorsos.join(', ')}, reçu « ${rawTorso} ».`)
    return 1
  }
  const torso = (rawTorso ?? FRAMING_DEFAULTS.torso) as TorsoName | 'off'

  const brutRatio = valeurDe('--ratio')
  if (brutRatio !== undefined && !estRatio(brutRatio)) {
    console.error(`--ratio attend l'un de ${Object.keys(RATIOS).join(', ')}, reçu « ${brutRatio} ».`)
    return 1
  }

  const analyse = lireAnalyse(valeurDe('--analyse') ?? analysisPath(projectId))
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
    sideTrim: trim,
    torso,
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
    `${clipId} — natif ${cadrage.ratio}, marge ${marge}, rognage ${trim}, tronc ${torso}, ` +
      `${cadrage.shots.length} plan(s)` +
      ` — largeur du crop natif ${((RATIOS[cadrage.ratio] * analyse.source.h) / analyse.source.w).toFixed(3)}`,
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
    // **Le ratio du plan, pas celui du natif.** Depuis que le ratio se choisit
    // par plan (spec §10), `plan.cropX` cadre `plan.ratio` et `plan.cropXNative`
    // cadre `cadrage.ratio` ; croiser les deux dessinait un rectangle qui n'est
    // celui d'aucune des deux sorties. C'est le cadre du plan qu'on regarde :
    // c'est le plus serré des deux, donc le seul qui puisse couper quelqu'un.
    const rect = cropRect(plan.ratio, plan.cropX, analyse.source.w, analyse.source.h)
    const crop: Cadre = {
      x: rect.x / analyse.source.w,
      y: rect.y / analyse.source.h,
      w: rect.w / analyse.source.w,
      h: rect.h / analyse.source.h,
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
    const classées = [...parImage.entries()]
      .map(([clé, boîtes]) => {
        const empan = requiredWidths(boîtes, { margin: marge, sideTrim: trim, torso })[0]
        return { t: clé / 1000, boîtes, empan, ...étendue(boîtes, marge, trim, torso) }
      })
      .filter(
        (e): e is Mesurée => e.empan !== undefined && e.g !== undefined && e.d !== undefined,
      )
      .map((e) => ({ ...e, sortie: débordement(e, crop) }))
      // Le plus gros débordement d'abord ; à débordement égal — zéro, le cas
      // courant —, la plus large, qui reste la plus instructive.
      .sort((a, b) => b.sortie - a.sortie || b.empan - a.empan)

    if (classées.length === 0) {
      console.log(`  plan ${shotStartMs(plan.shot)} ms — aucune image mesurée, crop centré`)
      continue
    }

    const débordantes = classées.filter((e) => e.sortie > 1e-9).length
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
              Math.round((i * (classées.length - 1)) / (imageCount - 1)),
            ),
          )]

    for (const rank of ranks) {
      const picked = classées[rank]
      const fichier = path.join(
        dossier,
        `plan${shotStartMs(plan.shot)}_r${rank}_t${picked.t.toFixed(1)}.png`,
      )
      vignette(proxy, picked.t, picked.boîtes, crop, W, H, fichier, trim, torso)

      console.log(
        `  ${fichier}  plan ${shotStartMs(plan.shot)} ms ${plan.ratio}, image ${picked.t.toFixed(1)} s` +
          ` (rang ${rank + 1}/${classées.length})` +
          ` — empan [${picked.g.toFixed(3)} ; ${picked.d.toFixed(3)}] (${picked.empan.toFixed(3)})` +
          `, crop [${crop.x.toFixed(3)} ; ${(crop.x + crop.w).toFixed(3)}]` +
          ` — ${picked.sortie > 1e-9 ? `DÉBORDE de ${picked.sortie.toFixed(3)}` : 'cadrée'}` +
          ` — ${débordantes} image(s) sur ${classées.length} débordent` +
          ` (${((100 * débordantes) / classées.length).toFixed(0)} %)`,
      )
    }
  }

  return 0
}

void main().then(quitter, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quitter(1)
})
