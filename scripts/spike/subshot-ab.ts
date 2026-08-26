/**
 * **Trois cadrages côte à côte, en vidéo, avec le son — pour que l'œil et
 * l'oreille tranchent ce qu'aucun chiffre de cadrage ne peut trancher.**
 *
 *     pnpm tsx scripts/spike/subshot-ab.ts --json <fichier subshots.json>
 *         [--cases 4] [--seed 1] [--project <id>] [--out <dossier>]
 *
 * `scripts/spike/subshots.ts --json <fichier>` produit le gisement. Ce
 * script-ci le **lit** et ne refait ni la subdivision, ni l'hystérésis, ni
 * `--min-hold`, ni le garde-fou du faux raccord : les frontières et les
 * décisions viennent du fichier, telles qu'elles ont été mesurées.
 *
 * ## Pourquoi il existe
 *
 * Subdiviser un plan fait passer la part du temps de montage dont la sortie
 * verticale **remplit le canevas** de 7,7 % à 41,1 %. Mais le témoin qui choisit
 * **au hasard** laquelle des deux personnes suivre obtient 39,3 %.
 *
 * Ce n'est pas la preuve que le choix ne compte pas, c'est la preuve que **la
 * métrique ne peut pas en juger** : cadrer sur la mauvaise personne remplit le
 * canevas exactement aussi bien que cadrer sur la bonne. Aucun chiffre de
 * cadrage ne verra jamais la différence — on voit qui est cadré, on entend qui
 * parle, et c'est tout ce qui sépare les deux. D'où des vidéos plutôt qu'un
 * tableau.
 *
 * ## Ce qu'une vidéo montre
 *
 * Trois panneaux de 540x960, donc 1620x960, une seule piste son :
 *
 * | panneau | variante |
 * |---|---|
 * | gauche | `today` — le cadrage actuel, un crop fixe par plan |
 * | centre | `candidate` — sous-plans, on suit la personne la plus de face |
 * | droite | `randomWho` — **mêmes frontières**, sujet tiré au sort |
 *
 * Un libellé incrusté en haut, rien d'autre : ni boîte, ni score, ni frontalité.
 * Ce qu'on juge est ce qu'un spectateur verrait.
 *
 * ## Ce n'est pas une démonstration, c'est le rendu de production
 *
 * Chaque panneau sort de `blurredVariantArgs` (`src/core/ffmpeg/args.ts`), par
 * `splitByShot` (`src/core/shot-split.ts`), exactement comme `renderClip`.
 * `buildRender` compose déjà **chaque morceau sur le canevas avant de
 * concaténer**, et son commentaire dit pourquoi : « deux entrées qui se touchent
 * sont les deux moitiés d'un segment coupé sur une frontière de plan, et chacune
 * porte son propre cadre ». Des sous-plans ne sont que des frontières de plus.
 * Un filtergraph écrit pour la démonstration montrerait autre chose que ce que
 * l'export produirait, et c'est précisément ce qu'on ne veut pas montrer.
 *
 * `computeFraming` reste la seule autorité de géométrie ; il n'est appelé que
 * pour la variante `randomWho`, dont le JSON ne porte pas les crops.
 *
 * ## Ce que ce script restitue faute de pouvoir l'importer
 *
 * `subshots.ts` **n'exporte rien** : c'est un point d'entrée, pas un module.
 * Trois choses sont donc reconstruites ici, et aucune n'est une décision de
 * cadrage :
 *
 * 1. **Mulberry32 et FNV-1a**, le générateur pseudo-aléatoire et le décalage de
 *    graine par émission. Sans eux, `randomWho` ne serait pas celui qui a été
 *    mesuré, mais un autre tirage — et le témoin ne témoignerait plus de rien.
 * 2. **Le rang d'une personne dans une image** : score suffisant, pas de premier
 *    plan, tri par l'abscisse du centre de `personBounds`. C'est l'adressage que
 *    `keep: 0 | 1` désigne, pas la règle qui choisit entre les deux.
 * 3. **Quelles boîtes un sous-plan passe à `computeFraming`**, y compris le
 *    repli « le rang n'existe pas dans cette image-là, on garde tout le monde ».
 *
 * **Les trois sont vérifiées, pas supposées.** Le script recalcule le cadrage de
 * `candidate` — dont le JSON porte le `ratio` et le `cropX` — et refuse de
 * produire quoi que ce soit si un seul sous-plan diffère. Si l'adressage des
 * rangs était faux, ou la population de boîtes, ou le réglage sous lequel le
 * JSON a été écrit, ça se verrait là. Le tirage, lui, se recoupe avec la ligne
 * « randomWho y tire l'autre rang sur … s » que `subshots.ts` imprime : ce
 * script la réécrit au même format, pour qu'un œil suffise à comparer.
 *
 * ## Le choix des cas, et il décide de la valeur du script
 *
 * Un cas où les deux variantes suivent la même personne ne montre rien. Les cas
 * sont donc classés sur la **plus longue suite ininterrompue de sous-plans où
 * `candidate` et `randomWho` désignent des rangs opposés**, et il en faut au
 * moins {@link MIN_DISAGREEMENT_SEC} secondes. La suite est préférée au total du
 * plan : « le plus longtemps » se juge à l'écran, et un plan qui accumulerait dix
 * désaccords d'une seconde donnerait un montage haché où l'on ne verrait rien.
 *
 * Plus **un cas de contrôle** où `today` et `candidate` sont identiques — un gros
 * plan à une personne, où la règle ne se déclenche pas et où `randomWho` ne tire
 * rien. Les trois panneaux doivent y être indiscernables ; s'ils ne le sont pas,
 * c'est une trouvaille et le script le dit.
 *
 * Chaque cas est étendu de {@link PAD_SEC} seconde de part et d'autre, pour que
 * l'œil ait le temps de se poser, sans sortir du plan ni empiéter sur un
 * sous-plan qu'aucun segment monté ne couvre — un tel sous-plan n'a pas de cadre
 * mesuré, et `splitByShot` lui donnerait le repli 16:9 centré, qui ne montre
 * aucune des trois politiques.
 *
 * ## Ce qu'il vérifie de sa propre sortie
 *
 * Une concaténation qui perd un morceau ne se signale pas. Chaque sortie est
 * donc mesurée à l'`ffprobe` : durée contre durée demandée, durées des trois
 * panneaux entre elles, et nombre de pistes.
 *
 * Conventions du dépôt : arguments analysés à la main, **valeur illisible
 * refusée et jamais remplacée par le défaut**, sortie dans `--out` ou un
 * `mkdtempSync`, jamais dans `projects/`.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'

import { normalizeSegments } from '@/core/edl'
import type { Ratio, Segment } from '@/core/edl'
import { blurredVariantArgs, type FramedSegment } from '@/core/ffmpeg/args'
import { videoEncodedArgs } from '@/core/ffmpeg/encoder'
import {
  FRAMING_DEFAULTS,
  RATIOS,
  computeFraming,
  cropRect,
  isForeground,
  outputSize,
  personBounds,
  type ShotFraming,
} from '@/core/framing'
import { splitByShot } from '@/core/shot-split'
import { shotStartMs, type PersonBox, type Shot } from '@/core/shots'
import { closeDb, getClips, getDb, getProject } from '@/server/db'
import { encoderName, ffmpegBin, ffprobeBin, produceArtifact, runFfmpeg } from '@/server/ffmpeg'
import { analysisPath, proxyPath } from '@/server/paths'
import { lireAnalysis, type Analysis } from '@/server/steps/analysis'
import { workingInput } from '@/server/steps/ingest'
import { chargerEnv, quit } from '../dev-common'

// ---------------------------------------------------------------------------
// Les constantes de la sélection et de la composition.
// ---------------------------------------------------------------------------

/**
 * La durée minimale de désaccord d'un cas, en secondes.
 *
 * En dessous, la bascule passe avant qu'on ait eu le temps de reconnaître qui
 * est cadré — et le cas coûterait un fichier pour ne rien montrer.
 */
const MIN_DISAGREEMENT_SEC = 8

/** Ce qu'on ajoute de chaque côté d'un cas, pour que l'œil se pose. */
const PAD_SEC = 1

/**
 * La durée maximale d'un cas, en secondes.
 *
 * Un désaccord qui dure quarante secondes n'apprend rien de plus qu'un qui en
 * dure vingt, et le fichier double. La fenêtre est alors **centrée** sur le
 * désaccord plutôt que tronquée à sa fin : ce qui compte est de voir la bascule,
 * qui n'est pas au début.
 */
const CASE_MAX_SEC = 20

/** La durée du cas de contrôle, en secondes. Il n'a qu'une chose à montrer. */
const CONTROL_SEC = 12

/**
 * Le plancher de PSNR, en dB, sous lequel deux panneaux du contrôle sont
 * déclarés divergents.
 *
 * Deux flux strictement identiques rendent `inf`. La mesure à la main du 20
 * août 2026 donnait `inf` sur un contrôle sain et 14,3 dB sur un cas où les
 * cadrages diffèrent réellement — l'écart est large, ce seuil n'a pas à être
 * ajusté au dixième de dB.
 */
const CONTROL_PSNR_FLOOR_DB = 40

/** Un panneau. Trois côte à côte font 1620x960 : assez pour juger, assez léger pour s'échanger. */
const PANEL = { w: 540, h: 960 } as const

/** La bande du libellé, en haut de chaque panneau. */
const LABEL = { height: 56, fontPx: 24 } as const

const VARIANT_KEYS = ['today', 'candidate', 'randomWho'] as const
type VariantKey = (typeof VARIANT_KEYS)[number]

/** Ce qu'on incruste en haut de chaque panneau. Rien d'autre n'y est écrit. */
const VARIANT_LABELS: Readonly<Record<VariantKey, string>> = {
  today: "aujourd'hui",
  candidate: 'candidat — le plus de face',
  randomWho: 'témoin — tiré au sort',
}

/**
 * Le repli d'un intervalle qu'aucun plan ne couvre : le cadre le plus large,
 * centré. **La même valeur que `renderClip`** (`src/server/steps/render.ts`), et
 * pour la même raison — on ne sait rien de ce qui s'y passe, et un 9:16 aveugle
 * jetterait 68 % de la largeur sans le dire.
 */
const SPLIT_FALLBACK = { ratio: '16:9', cropX: 0.5, cropXNative: 0.5 } as const

// ---------------------------------------------------------------------------
// Le fichier de `subshots.ts --json` : lu, jamais recalculé.
// ---------------------------------------------------------------------------

/** Qui l'on garde dans un sous-plan : le rang 0 (gauche), le rang 1 (droite), ou tout le monde. */
type Keep = 0 | 1 | 'all'

type JsonSubShot = {
  start: number
  end: number
  inClipSeconds: number
  ratio: Ratio | null
  cropX: number | null
  keep: Keep
  mergedByOverlap: boolean
}

type JsonShot = {
  start: number
  end: number
  inClipSeconds: number
  ratioToday: Ratio | null
  cropXToday: number | null
  subShots: JsonSubShot[]
}

type JsonShow = { editedSeconds: number; shots: JsonShot[] }
type SubShotsData = Record<string, JsonShow>

function isRatio(v: unknown): v is Ratio {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(RATIOS, v)
}

function isRatioOrNull(v: unknown): v is Ratio | null {
  return v === null || isRatio(v)
}

function isNumberOrNull(v: unknown): v is number | null {
  return v === null || typeof v === 'number'
}

function isKeep(v: unknown): v is Keep {
  return v === 0 || v === 1 || v === 'all'
}

/**
 * Lit et valide le JSON de `subshots.ts`. **Une forme inattendue est refusée
 * avec un message qui nomme la commande de régénération**, jamais lue à moitié —
 * le même principe que `lireAnalysis` sur une version d'`analysis.json`
 * inconnue.
 */
function readSubShotsJson(file: string): SubShotsData {
  const regen = `pnpm tsx scripts/spike/subshots.ts --json ${file}`
  if (!fs.existsSync(file)) {
    throw new Error(`${file} est introuvable. Produis-le avec « ${regen} ».`)
  }
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(
      `${file} n'a pas la forme attendue (un objet par émission). Régénère-le avec « ${regen} ».`,
    )
  }

  const out: SubShotsData = {}
  for (const [projectId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`${file} : l'entrée « ${projectId} » n'a pas la forme attendue.`)
    }
    const show = value as { editedSeconds?: unknown; shots?: unknown }
    if (typeof show.editedSeconds !== 'number' || !Array.isArray(show.shots)) {
      throw new Error(
        `${file} : « ${projectId} » ne porte pas editedSeconds/shots. Régénère-le avec « ${regen} ».`,
      )
    }
    const shots: JsonShot[] = show.shots.map((entry, i) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(`${file} : ${projectId}.shots[${i}] n'a pas la forme attendue.`)
      }
      const s = entry as Record<string, unknown>
      const ok =
        typeof s.start === 'number' &&
        typeof s.end === 'number' &&
        typeof s.inClipSeconds === 'number' &&
        isRatioOrNull(s.ratioToday) &&
        isNumberOrNull(s.cropXToday) &&
        Array.isArray(s.subShots)
      if (!ok) {
        throw new Error(
          `${file} : ${projectId}.shots[${i}] ne porte pas les champs attendus.` +
            ` Régénère-le avec « ${regen} ».`,
        )
      }
      const subShots: JsonSubShot[] = (s.subShots as unknown[]).map((sub, j) => {
        if (typeof sub === 'object' && sub !== null) {
          const u = sub as Record<string, unknown>
          const fine =
            typeof u.start === 'number' &&
            typeof u.end === 'number' &&
            typeof u.inClipSeconds === 'number' &&
            isRatioOrNull(u.ratio) &&
            isNumberOrNull(u.cropX) &&
            isKeep(u.keep) &&
            typeof u.mergedByOverlap === 'boolean'
          if (fine) return u as unknown as JsonSubShot
        }
        throw new Error(
          `${file} : ${projectId}.shots[${i}].subShots[${j}] ne porte pas les champs attendus.` +
            ` Régénère-le avec « ${regen} ».`,
        )
      })
      return { ...(s as unknown as JsonShot), subShots }
    })
    out[projectId] = { editedSeconds: show.editedSeconds, shots }
  }
  return out
}

// ---------------------------------------------------------------------------
// Le tirage de `randomWho`, restitué à l'identique.
// ---------------------------------------------------------------------------

/**
 * Mulberry32, **repris trait pour trait de `subshots.ts`**, qui n'exporte rien.
 *
 * Le témoin ne vaut que s'il est celui qui a été mesuré : un autre générateur, ou
 * le même dans un autre ordre, produirait un autre tirage et l'on montrerait
 * alors des vidéos qui n'illustrent aucun chiffre. C'est aussi pourquoi le
 * script recoupe son tirage avec la ligne que `subshots.ts` imprime, au lieu de
 * le tenir pour acquis.
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a sur 32 bits, le décalage de graine par émission de `subshots.ts`. */
function hashOfString(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i += 1) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// Les boîtes d'un plan, image par image.
// ---------------------------------------------------------------------------

/** `t` tombe-t-il dans l'intervalle ? **Fin exclue**, comme `computeFraming`. */
function inInterval(t: number, start: number, end: number): boolean {
  return t >= start && t < end
}

/**
 * La grille réelle d'échantillonnage sur `[start, end)`, en secondes, arrondie
 * au même pas que `worker/detect.py` (3 décimales).
 *
 * Issue #174 : une image sans détection n'a aucune entrée dans `analysis.boxes`,
 * donc un regroupement qui n'énumère que les boîtes la rend invisible plutôt
 * que nulle. Énumérer `k / fps` couvre les trous.
 */
function gridTimestamps(start: number, end: number, fps: number): number[] {
  if (!(fps > 0) || !(end > start)) return []
  // Bornes en `k` élargies d'un cran : une frontière de plan tombant pile sur
  // un pas de grille peut voir `k / fps` s'arrondir de l'autre côté que le `t`
  // stocké dans `analysis.boxes` ; la membership se décide donc sur `t` arrondi.
  const firstK = Math.floor(start * fps) - 1
  const lastK = Math.ceil(end * fps) + 1
  const out: number[] = []
  for (let k = Math.max(0, firstK); k <= lastK; k += 1) {
    const t = Math.round((k / fps) * 1000) / 1000
    if (t >= start && t < end) out.push(t)
  }
  return out
}

/** L'abscisse du centre de `personBounds` — le repère sur lequel le rang se départage. */
function centerOf(box: PersonBox): number {
  const bounds = personBounds(box)
  return (bounds.x0 + bounds.x1) / 2
}

/** Une image du plan : toutes ses boîtes, et celles qui portent un rang. */
type Frame = {
  t: number
  /** Toutes les boîtes de cette image, sans filtre — ce que « garder tout le monde » passe au cadrage. */
  all: PersonBox[]
  /**
   * Les boîtes **retenues** (score et premier plan filtrés), triées par l'abscisse
   * du centre de `personBounds`, croissante. C'est ce que `keep: 0 | 1` indexe.
   */
  ranked: PersonBox[]
}

/** Le premier indice dont `t` atteint `value`, dans une liste triée par `t`. */
function lowerBound(boxes: readonly PersonBox[], value: number): number {
  let low = 0
  let high = boxes.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (boxes[middle].t < value) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * Les images d'un plan, dans l'ordre du temps.
 *
 * Le filtre et le tri sont ceux de `subshots.ts` : `score >= minScore`, pas de
 * premier plan, tri par abscisse du centre du tronc. C'est l'**adressage** des
 * rangs, pas la règle qui choisit entre eux — celle-là est dans le JSON.
 */
function framesOfShot(sortedBoxes: readonly PersonBox[], shot: Shot, fps: number): Frame[] {
  const byFrame = new Map<number, PersonBox[]>()
  for (let i = lowerBound(sortedBoxes, shot.start); i < sortedBoxes.length; i += 1) {
    const box = sortedBoxes[i]
    if (box.t >= shot.end) break
    const key = Math.round(box.t * 1000)
    const already = byFrame.get(key)
    if (already) already.push(box)
    else byFrame.set(key, [box])
  }

  const out: Frame[] = []
  for (const t of gridTimestamps(shot.start, shot.end, fps)) {
    const all = byFrame.get(Math.round(t * 1000)) ?? []
    out.push({
      t,
      all,
      ranked: all
        .filter((b) => b.score >= FRAMING_DEFAULTS.minScore && !isForeground(b))
        .sort((x, y) => centerOf(x) - centerOf(y)),
    })
  }
  return out.sort((a, b) => a.t - b.t)
}

/**
 * Les boîtes qu'un sous-plan garde, pour une image donnée.
 *
 * Le repli est celui de `subshots.ts` et il compte : quand le rang n'existe pas
 * dans cette image-là, on garde tout le monde plutôt que rien. Une image vidée ne
 * dit pas que le cadre peut être serré, elle ne dit rien.
 */
function keptBoxesOf(frame: Frame, keep: Keep): PersonBox[] {
  if (keep === 'all') return frame.all
  return keep < frame.ranked.length ? [frame.ranked[keep]] : frame.all
}

// ---------------------------------------------------------------------------
// Le cadrage d'un plan subdivisé, par `computeFraming` et par lui seul.
// ---------------------------------------------------------------------------

/** Un plan préparé : ses images, ses segments montés, et ses sous-plans du JSON. */
type ShotWork = {
  projectId: string
  index: number
  shot: Shot
  json: JsonShot
  frames: Frame[]
  /** Les segments montés qui touchent ce plan — le reste ne changerait rien au cadrage. */
  segments: Segment[]
}

/**
 * Le cadrage des sous-plans d'un plan sous une suite de décisions donnée,
 * **indexé par la borne de début du sous-plan**.
 *
 * Les boîtes passées sont celles que chaque sous-plan garde ; tout le reste — le
 * seuil de score, le filtre du premier plan, le tronc, la marge, le choix du
 * ratio et la position — appartient à `computeFraming`. Un sous-plan qu'aucun
 * segment monté ne touche n'apparaît pas dans la sortie : `shotsForSegments` ne
 * le retient pas, et son `ratio` vaut `null` dans le JSON.
 */
function framingOfKeeps(
  work: ShotWork,
  keeps: readonly Keep[],
  analysis: Analysis,
): Map<number, ShotFraming> {
  const subShots = work.json.subShots
  const people: PersonBox[] = []
  for (const frame of work.frames) {
    const index = subShots.findIndex((s) => inInterval(frame.t, s.start, s.end))
    if (index < 0) continue
    for (const box of keptBoxesOf(frame, keeps[index])) people.push(box)
  }

  const framing = computeFraming({
    segments: work.segments,
    shots: subShots.map((s) => ({ start: s.start, end: s.end })),
    people,
    srcW: analysis.source.w,
    srcH: analysis.source.h,
    cropMode: 'auto',
    ratio: 'auto',
  })

  const byStart = new Map<number, ShotFraming>()
  for (const s of framing.shots) byStart.set(s.shot.start, s)
  return byStart
}

// ---------------------------------------------------------------------------
// Une émission chargée.
// ---------------------------------------------------------------------------

type Show = {
  id: string
  analysis: Analysis
  /** Le fichier qu'on décode, et ses dimensions réelles. */
  source: { file: string; w: number; h: number; isProxy: boolean }
  works: ShotWork[]
  /** Le tirage de `randomWho`, sous-plan par sous-plan, aligné sur `works`. */
  drawn: Keep[][]
}

/**
 * Le fichier à décoder, **par le même choix que la production**, le proxy en
 * dernier recours.
 *
 * `workingInput` et pas un `existsSync` sur la copie : il écarte en plus une
 * copie dont la taille ne décrit plus la source. Sans lui, une copie tronquée
 * mais présente servirait l'A/B pendant que le rendu retomberait sur l'original
 * — et l'A/B ne montrerait plus ce que le rendu produit, ce pour quoi seul il
 * existe. (relevé par Copilot)
 *
 * Le proxy est un repli assumé et signalé : il fait 960x540, donc un 9:16 y est
 * agrandi 1,78x pour tenir dans le canevas. Le cadrage se juge quand même — la
 * géométrie est en fractions de largeur, pas en pixels — mais l'image est molle,
 * et mieux vaut le lire dans le journal que le découvrir à l'écran.
 */
function sourceFileOf(projectId: string): { file: string; isProxy: boolean } {
  const db = getDb()
  const project = getProject(db, projectId)
  if (project !== undefined) {
    const chosen = workingInput(project)
    if (fs.existsSync(chosen.path)) return { file: chosen.path, isProxy: false }
  }
  const proxy = proxyPath(projectId)
  if (fs.existsSync(proxy)) return { file: proxy, isProxy: true }
  throw new Error(
    `${projectId} : ni original, ni copie de travail, ni proxy sur le disque.` +
      ' Rien à décoder — le montage du Drive est peut-être tombé.',
  )
}

/**
 * Les champs d'une piste, **lus par leur nom**.
 *
 * `-of default=nw=1` garde les clés, et c'est tout l'intérêt : ffprobe rend les
 * champs dans l'ordre de sa propre structure, **jamais dans celui de
 * `-show_entries`**. Lus par position, `duration,nb_frames,r_frame_rate` sort en
 * `r_frame_rate,duration,nb_frames` — chaque valeur atterrit dans la mauvaise
 * variable, `parseFloat('30/1')` rend 30, et le contrôle de durée annonce alors
 * une sortie de 30 s là où elle en fait 20. Vu le 20 août 2026, sur ce
 * script-ci : un échec qui n'échoue pas, exactement la famille que `CLAUDE.md`
 * met en garde.
 */
function probeFields(file: string, entries: string): Map<string, string> {
  const lines = execFileSync(
    ffprobeBin(),
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'default=nw=1', file],
    { encoding: 'utf8' },
  ).split('\n')
  const out = new Map<string, string>()
  for (const line of lines) {
    const at = line.indexOf('=')
    if (at > 0) out.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  return out
}

/** Les dimensions réelles du fichier décodé. `cropRect` les veut, pas celles de l'analyse. */
function probeDimensions(file: string): { w: number; h: number } {
  const fields = probeFields(file, 'stream=width,height')
  const w = Number.parseInt(fields.get('width') ?? '', 10)
  const h = Number.parseInt(fields.get('height') ?? '', 10)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`ffprobe n'a pas rendu de dimensions lisibles pour ${file}.`)
  }
  return { w, h }
}

/**
 * La piste **vidéo** d'un fichier : sa durée, son nombre d'images, sa cadence.
 *
 * **La piste vidéo et jamais le conteneur**, et l'écart n'est pas anecdotique :
 * une trame AAC porte 1 024 échantillons, soit 21,3 ms à 48 kHz, et l'encodeur
 * ajoute son délai d'amorçage. La durée du conteneur, qui est celle de la plus
 * longue de ses pistes, dépasse donc systématiquement la durée demandée de 17 à
 * 67 ms — mesuré sur les cinq sorties du 20 août 2026, où la piste vidéo tombait
 * chaque fois **exactement** juste (1 070 images en 60 im/s pour 17,833 s, 600 en
 * 30 im/s pour 20 s). Contrôler le conteneur ferait crier au morceau perdu à
 * chaque rendu, et il n'y a pas de pire garde-fou que celui qui crie toujours.
 */
function probeVideoStream(file: string): { duration: number; frames: number; fps: number } {
  const fields = probeFields(file, 'stream=duration,nb_frames,r_frame_rate')
  const duration = Number.parseFloat(fields.get('duration') ?? '')
  if (!Number.isFinite(duration)) {
    throw new Error(`ffprobe n'a pas rendu de durée de piste vidéo pour ${file}.`)
  }
  const [numerator, denominator] = (fields.get('r_frame_rate') ?? '')
    .split('/')
    .map((n) => Number.parseFloat(n))
  const fps =
    Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
      ? numerator / denominator
      : Number.NaN
  return { duration, frames: Number.parseInt(fields.get('nb_frames') ?? '', 10), fps }
}

/** La durée du conteneur, informative : elle porte le rembourrage de l'AAC. */
function probeContainerDuration(file: string): number {
  const raw = execFileSync(
    ffprobeBin(),
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  ).trim()
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`ffprobe n'a pas rendu de durée lisible pour ${file} (« ${raw} »).`)
  }
  return value
}

/** Les types de pistes d'un fichier, dans l'ordre : `['video', 'audio']` pour une sortie saine. */
function probeStreamKinds(file: string): string[] {
  return execFileSync(
    ffprobeBin(),
    ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  )
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Le PSNR le plus bas rencontré, image par image, entre deux panneaux — le
 * pire, pas la moyenne : une seule image divergente au milieu d'un plan de
 * douze secondes ne doit pas se noyer dans la moyenne des images identiques.
 *
 * Passe par `stats_file` plutôt que par la ligne de résumé du filtre : cette
 * dernière n'est écrite par ffmpeg que sur son flux d'erreur, dans un format
 * pensé pour l'œil, pas pour être analysé de façon fiable.
 */
function worstPsnr(a: string, b: string): number {
  // Comparées avant le filtre : le framesync de ffmpeg tronque ou répète un
  // flux plutôt que d'échouer, ce qui laisserait passer une image d'écart
  // sous couvert d'une comparaison « image par image ».
  const framesA = probeVideoStream(a).frames
  const framesB = probeVideoStream(b).frames
  if (framesA !== framesB) {
    throw new Error(
      `psnr entre ${a} (${framesA} images) et ${b} (${framesB} images) : nombre d'images différent.`,
    )
  }
  const statsFile = path.join(os.tmpdir(), `psnr-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
  try {
    try {
      execFileSync(
        ffmpegBin(),
        ['-y', '-i', a, '-i', b, '-lavfi', `psnr=stats_file=${statsFile}`, '-f', 'null', '-'],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
    } catch (err) {
      // stderr, capturé plutôt qu'ignoré : sans lui l'échec remonte comme
      // « Command failed: ffmpeg … » sans dire lequel des deux fichiers pose
      // problème.
      const stderr = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : ''
      throw new Error(`psnr entre ${a} et ${b} : ffmpeg a échoué.\n${stderr}`)
    }
    const lines = fs.readFileSync(statsFile, 'utf8').trim().split('\n').filter((l) => l.length > 0)
    let worst = Number.POSITIVE_INFINITY
    let matched = 0
    for (const line of lines) {
      const match = /psnr_avg:(inf|[\d.]+)/.exec(line)
      if (match === null) continue
      matched += 1
      const value = match[1] === 'inf' ? Number.POSITIVE_INFINITY : Number.parseFloat(match[1])
      if (value < worst) worst = value
    }
    if (matched === 0) throw new Error(`psnr : aucune valeur psnr_avg reconnue entre ${a} et ${b}.`)
    if (matched !== framesA) {
      throw new Error(
        `psnr entre ${a} et ${b} : ${matched} paire(s) comparée(s) sur ${framesA} attendue(s).`,
      )
    }
    return worst
  } finally {
    fs.rmSync(statsFile, { force: true })
  }
}

function loadShow(projectId: string, show: JsonShow, seed: number): Show {
  const file = analysisPath(projectId)
  if (!fs.existsSync(file)) {
    throw new Error(`${projectId} : pas d'analyse (${file}).`)
  }
  const analysis = lireAnalysis(file)
  const sortedBoxes = [...analysis.boxes].sort((a, b) => a.t - b.t)

  const db = getDb()
  // Filtré par statut, jamais par nom : `subshots.ts` documente déjà les deux
  // `clip_verif_*` de `2025-06-15-cqlp`, qui appartiennent bel et bien à cette
  // émission.
  const clips = getClips(db, projectId).filter((c) => c.status !== 'discarded')
  const editedSegments = normalizeSegments(clips.flatMap((c) => c.segments))

  const works: ShotWork[] = show.shots.map((json, index) => {
    const shot: Shot = { start: json.start, end: json.end }
    return {
      projectId,
      index,
      shot,
      json,
      frames: framesOfShot(sortedBoxes, shot, analysis.fps),
      segments: editedSegments.filter(
        (s) => Math.min(shot.end, s.end) > Math.max(shot.start, s.start),
      ),
    }
  })

  // **L'ordre du tirage est celui de `subshots.ts`** : une graine décalée par le
  // nom de l'émission, puis, plan par plan dans l'ordre du fichier, un tirage
  // par sous-plan qui suit un rang. Les sous-plans qui gardent tout le monde
  // n'ont pas deux rangs entre lesquels tirer et n'en consomment aucun.
  const random = createRandom((seed + hashOfString(projectId)) >>> 0)
  const drawn = works.map((work) =>
    work.json.subShots.map((s) => (s.keep === 'all' ? 'all' : random() < 0.5 ? 0 : 1)),
  )

  const source = sourceFileOf(projectId)
  const dimensions = probeDimensions(source.file)
  return { id: projectId, analysis, source: { ...source, ...dimensions }, works, drawn }
}

// ---------------------------------------------------------------------------
// La vérification : retrouve-t-on le cadrage que le JSON porte ?
// ---------------------------------------------------------------------------

type FramingCheck = { compared: number; mismatches: string[]; worstCropDelta: number }

/**
 * Recalcule le cadrage de `candidate` et le compare, sous-plan par sous-plan, à
 * celui du JSON.
 *
 * **C'est le contrôle qui fonde tout le reste.** `randomWho` n'a pas de crop dans
 * le JSON : il faut le calculer, donc restituer l'adressage des rangs et la
 * population de boîtes de `subshots.ts`. Si cette restitution était fausse — un
 * tri à l'envers, un filtre oublié, un réglage sous lequel le JSON a été écrit et
 * qu'on ignore — le panneau du témoin montrerait un cadrage qui n'a jamais été
 * mesuré, et rien ne le dirait. Le seul endroit où ça se voit est là où le JSON
 * porte la réponse.
 */
function checkCandidateFraming(show: Show): FramingCheck {
  const check: FramingCheck = { compared: 0, mismatches: [], worstCropDelta: 0 }
  for (const work of show.works) {
    const keeps = work.json.subShots.map((s) => s.keep)
    const byStart = framingOfKeeps(work, keeps, show.analysis)
    for (const sub of work.json.subShots) {
      if (sub.ratio === null || sub.cropX === null) continue
      check.compared += 1
      const framed = byStart.get(sub.start)
      const where = `${show.id} ${sub.start.toFixed(3)} → ${sub.end.toFixed(3)}`
      if (framed === undefined) {
        if (check.mismatches.length < 10) check.mismatches.push(`${where} : aucun cadre recalculé`)
        continue
      }
      const delta = Math.abs(framed.cropX - sub.cropX)
      check.worstCropDelta = Math.max(check.worstCropDelta, delta)
      if (framed.ratio !== sub.ratio || delta > 0) {
        if (check.mismatches.length < 10) {
          check.mismatches.push(
            `${where} : JSON ${sub.ratio} @ ${sub.cropX} — recalculé ${framed.ratio} @ ${framed.cropX}`,
          )
        }
      }
    }
  }
  return check
}

/**
 * Le temps de désaccord d'une émission, **au format exact de `subshots.ts`**.
 *
 * Les deux lignes doivent se lire côte à côte sans conversion : c'est le seul
 * moyen de constater que le tirage restitué est celui qui a été mesuré, plutôt
 * que de le supposer.
 */
function disagreementLine(show: Show): string {
  let followed = 0
  let disagreed = 0
  for (const [i, work] of show.works.entries()) {
    for (const [j, sub] of work.json.subShots.entries()) {
      if (sub.keep === 'all') continue
      followed += sub.inClipSeconds
      if (show.drawn[i][j] !== sub.keep) disagreed += sub.inClipSeconds
    }
  }
  const share = followed > 0 ? `${((100 * disagreed) / followed).toFixed(1)} %` : '—'
  return (
    `le candidat suit une seule personne sur ${followed.toFixed(0)} s ;` +
    ` randomWho y tire l'autre rang sur ${disagreed.toFixed(0)} s (${share})`
  )
}

// ---------------------------------------------------------------------------
// Le choix des cas.
// ---------------------------------------------------------------------------

type Case = {
  kind: 'disagreement' | 'control'
  show: Show
  work: ShotWork
  /** L'intervalle rendu, bornes comprises dans le plan. */
  interval: Segment
  /** La plus longue suite de sous-plans où les deux variantes désignent des rangs opposés. */
  runSeconds: number
  /** Le total du plan, pondéré par le temps monté — la grandeur de `subshots.ts`. */
  totalDisagreementSeconds: number
  name: string
}

/** Un sous-plan porte-t-il un cadre mesuré ? Sans ça, `splitByShot` lui donnerait le repli. */
function isFramed(sub: JsonSubShot): boolean {
  return sub.ratio !== null && sub.cropX !== null
}

/**
 * La plus longue suite ininterrompue de sous-plans où `candidate` et `randomWho`
 * suivent des personnes différentes, et dont les deux portent un cadre mesuré.
 */
function longestDisagreementRun(
  work: ShotWork,
  drawn: readonly Keep[],
): { from: number; to: number; seconds: number } | null {
  const subShots = work.json.subShots
  let best: { from: number; to: number; seconds: number } | null = null
  let from = -1
  for (let i = 0; i <= subShots.length; i += 1) {
    const disagrees =
      i < subShots.length &&
      subShots[i].keep !== 'all' &&
      drawn[i] !== subShots[i].keep &&
      isFramed(subShots[i])
    if (disagrees) {
      if (from < 0) from = i
      continue
    }
    if (from >= 0) {
      const seconds = subShots[i - 1].end - subShots[from].start
      if (best === null || seconds > best.seconds) best = { from, to: i - 1, seconds }
      from = -1
    }
  }
  return best
}

/** Le total du désaccord d'un plan, pondéré par le temps monté. */
function totalDisagreementOf(work: ShotWork, drawn: readonly Keep[]): number {
  return work.json.subShots.reduce(
    (n, s, i) => (s.keep !== 'all' && drawn[i] !== s.keep ? n + s.inClipSeconds : n),
    0,
  )
}

/**
 * L'intervalle rendu autour d'une suite de sous-plans.
 *
 * Étendu de `PAD_SEC` de chaque côté, mais jamais au-delà d'un voisin sans cadre
 * mesuré : `splitByShot` y poserait le repli 16:9 centré, qui n'illustre aucune
 * des trois politiques et se lirait comme un défaut du candidat.
 */
function intervalAround(work: ShotWork, from: number, to: number): Segment {
  const subShots = work.json.subShots
  const lowLimit = from > 0 && isFramed(subShots[from - 1]) ? subShots[from - 1].start : subShots[from].start
  const highLimit =
    to + 1 < subShots.length && isFramed(subShots[to + 1]) ? subShots[to + 1].end : subShots[to].end

  let start = Math.max(subShots[from].start - PAD_SEC, lowLimit, work.shot.start)
  let end = Math.min(subShots[to].end + PAD_SEC, highLimit, work.shot.end)
  if (end - start > CASE_MAX_SEC) {
    const middle = (start + end) / 2
    start = middle - CASE_MAX_SEC / 2
    end = middle + CASE_MAX_SEC / 2
  }
  return { start, end }
}

/** Les cas de désaccord de tout le gisement, du plus long au plus court. */
function collectDisagreementCases(shows: readonly Show[]): Case[] {
  const out: Case[] = []
  for (const show of shows) {
    for (const [i, work] of show.works.entries()) {
      if (work.json.ratioToday === null || work.json.cropXToday === null) continue
      const run = longestDisagreementRun(work, show.drawn[i])
      if (run === null || run.seconds < MIN_DISAGREEMENT_SEC) continue
      const interval = intervalAround(work, run.from, run.to)
      // Nommé sur l'intervalle rendu et non sur le plan : un plan peut durer
      // quatre minutes, et c'est l'instant qu'on retrouve dans le proxy qui
      // permet d'aller revoir la scène.
      out.push({
        kind: 'disagreement',
        show,
        work,
        interval,
        runSeconds: run.seconds,
        totalDisagreementSeconds: totalDisagreementOf(work, show.drawn[i]),
        name: `${show.id}_${Math.round(interval.start)}s`,
      })
    }
  }
  // À durée égale, l'ordre du gisement départage : arbitraire, mais déterministe.
  return out.sort((a, b) => b.runSeconds - a.runSeconds)
}

/** La médiane, au sens strict — dupliquée comme dans `subshots.ts` et `framing.ts`. */
function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const m = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

/**
 * Le cas de contrôle : un gros plan à une personne, où `today` et `candidate`
 * sont le même cadre et où `randomWho` ne tire rien.
 *
 * Les trois panneaux doivent y être indiscernables. C'est le contrôle négatif de
 * toute la chaîne — s'ils diffèrent, ce n'est pas la politique qu'on regarde,
 * c'est un défaut du rendu ou de la composition.
 *
 * « Gros plan » se lit ici sur le ratio : un plan dont le cadre le plus serré est
 * un 9:16 remplit le canevas vertical. Faute d'un tel plan, le plus étroit
 * disponible, et le journal le dit.
 */
function pickControlCase(shows: readonly Show[]): Case | null {
  type Candidate = { c: Case; ratio: Ratio }
  const candidates: Candidate[] = []
  for (const show of shows) {
    for (const work of show.works) {
      const subShots = work.json.subShots
      if (subShots.length !== 1) continue
      const only = subShots[0]
      if (only.keep !== 'all' || !isFramed(only)) continue
      if (work.json.ratioToday !== only.ratio || work.json.cropXToday !== only.cropX) continue
      if (only.inClipSeconds < MIN_DISAGREEMENT_SEC) continue
      // Une personne à l'écran, prise sur la médiane des images du plan : une
      // image isolée à deux boîtes ne fait pas un plan à deux.
      const people = work.frames.map((f) => f.ranked.length)
      if (people.length === 0 || median(people) !== 1) continue

      // Centré sur la plus longue intersection du plan avec le montage : c'est
      // là que le cadre a été mesuré, et le reste du plan n'est pas publié.
      const overlaps = work.segments.map((s) => ({
        start: Math.max(s.start, work.shot.start),
        end: Math.min(s.end, work.shot.end),
      }))
      const longest = overlaps.reduce<Segment | null>(
        (a, s) => (a === null || s.end - s.start > a.end - a.start ? s : a),
        null,
      )
      if (longest === null) continue
      const span = Math.min(CONTROL_SEC, longest.end - longest.start)
      const middle = (longest.start + longest.end) / 2
      const interval = { start: middle - span / 2, end: middle + span / 2 }
      candidates.push({
        c: {
          kind: 'control',
          show,
          work,
          interval,
          runSeconds: 0,
          totalDisagreementSeconds: 0,
          name: `controle_${show.id}_${Math.round(interval.start)}s`,
        },
        ratio: only.ratio as Ratio,
      })
    }
  }
  if (candidates.length === 0) return null
  // Le plus serré d'abord — un 9:16 est le gros plan qu'on cherche —, puis le
  // plus long, pour avoir de quoi regarder.
  candidates.sort(
    (a, b) =>
      RATIOS[a.ratio] - RATIOS[b.ratio] ||
      b.c.interval.end - b.c.interval.start - (a.c.interval.end - a.c.interval.start),
  )
  return candidates[0].c
}

// ---------------------------------------------------------------------------
// Le rendu d'un panneau — par le chemin de production, pas par un graphe à part.
// ---------------------------------------------------------------------------

/** Les plans cadrés d'une variante, tels que `splitByShot` les attend. */
function shotFramingsOf(work: ShotWork, variant: VariantKey, show: Show): ShotFraming[] {
  if (variant === 'today') {
    const { ratioToday, cropXToday } = work.json
    if (ratioToday === null || cropXToday === null) return []
    return [
      {
        shot: work.shot,
        key: shotStartMs(work.shot),
        ratio: ratioToday,
        cropX: cropXToday,
        cropXNative: cropXToday,
        source: 'auto',
      },
    ]
  }

  if (variant === 'candidate') {
    return work.json.subShots.flatMap((sub) => {
      if (sub.ratio === null || sub.cropX === null) return []
      const shot: Shot = { start: sub.start, end: sub.end }
      return [
        {
          shot,
          key: shotStartMs(shot),
          ratio: sub.ratio,
          cropX: sub.cropX,
          cropXNative: sub.cropX,
          source: 'auto' as const,
        },
      ]
    })
  }

  // `randomWho` : mêmes frontières, autre sujet — donc un autre cadrage, que le
  // JSON ne porte pas. Il se recalcule par `computeFraming`, seule autorité de
  // géométrie, sur la population de boîtes du rang tiré.
  const byStart = framingOfKeeps(work, show.drawn[work.index], show.analysis)
  return work.json.subShots.flatMap((sub) => {
    const framed = byStart.get(sub.start)
    return framed === undefined ? [] : [framed]
  })
}

/**
 * Un panneau : le canevas 9:16 tel que l'export le produirait, par
 * `splitByShot` puis `blurredVariantArgs`.
 */
async function renderPanel(
  o: { show: Show; work: ShotWork; variant: VariantKey; interval: Segment; dst: string },
): Promise<{ pieces: number; fallbacks: number }> {
  const shots = shotFramingsOf(o.work, o.variant, o.show)
  const pieces = splitByShot([o.interval], shots, SPLIT_FALLBACK)
  const fallbacks = pieces.filter(
    (p) => !shots.some((s) => s.shot.start <= (p.start + p.end) / 2 && (p.start + p.end) / 2 < s.shot.end),
  ).length

  const framed: FramedSegment[] = pieces.map((p) => ({
    start: p.start,
    end: p.end,
    ratio: p.ratio,
    crop: cropRect(p.ratio, p.cropX, o.show.source.w, o.show.source.h),
  }))

  await produceArtifact({
    dst: o.dst,
    force: true,
    durationSec: o.interval.end - o.interval.start,
    what: `panneau ${o.variant}`,
    args: (destination) =>
      blurredVariantArgs({
        src: o.show.source.file,
        dst: destination,
        segments: framed,
        out: outputSize('9:16'),
        encoder: encoderName(),
      }),
  })
  return { pieces: pieces.length, fallbacks }
}

// ---------------------------------------------------------------------------
// Le libellé, et l'assemblage des trois panneaux.
// ---------------------------------------------------------------------------

/**
 * Le libellé d'un panneau, en PNG transparent à la taille du panneau.
 *
 * Un PNG plutôt qu'un `drawtext` : `drawtext` veut une police résolue par
 * fontconfig ou nommée en dur, et le rendu dépend alors de la machine. Le
 * canevas est déjà une dépendance du dépôt, et c'est aussi ce que fait le hook
 * (`src/server/hook-image.ts`) pour la même raison.
 */
function writeLabelImage(text: string, dst: string): void {
  const canvas = createCanvas(PANEL.w, LABEL.height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'rgba(0, 0, 0, 0.62)'
  ctx.fillRect(0, 0, PANEL.w, LABEL.height)
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${LABEL.fontPx}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, PANEL.w / 2, LABEL.height / 2)
  fs.writeFileSync(dst, canvas.toBuffer('image/png'))
}

/**
 * Les trois panneaux côte à côte, **une seule piste son**.
 *
 * Le son est le même sur les trois — c'est le même intervalle de la même source,
 * normalisé par le même `loudnorm`. En garder trois les superposerait à
 * l'oreille, et l'oreille est la moitié de ce qu'on demande à Julien de juger.
 */
function stackArgs(o: { panels: string[]; labels: string[]; dst: string }): string[] {
  const graph: string[] = []
  o.panels.forEach((_, i) => {
    graph.push(`[${i}:v]scale=${PANEL.w}:${PANEL.h}:flags=lanczos,setsar=1[s${i}]`)
    graph.push(`[s${i}][${o.panels.length + i}:v]overlay=x=0:y=0[p${i}]`)
  })
  graph.push(`${o.panels.map((_, i) => `[p${i}]`).join('')}hstack=inputs=${o.panels.length}[v]`)

  return [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'warning', '-stats',
    ...o.panels.flatMap((file) => ['-i', file]),
    ...o.labels.flatMap((file) => ['-i', file]),
    '-filter_complex', graph.join(';'),
    '-map', '[v]',
    // Le son du premier panneau, et de lui seul.
    '-map', '0:a',
    ...videoEncodedArgs(encoderName(), 'quality'),
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '--', o.dst,
  ]
}

/** Une image prise au milieu d'une vidéo — ce qu'on regarde avant de la livrer. */
async function extractMiddleFrame(video: string, dst: string, duration: number): Promise<void> {
  await runFfmpeg(
    [
      '-hide_banner', '-nostdin', '-y', '-loglevel', 'warning',
      '-ss', (duration / 2).toFixed(3),
      '-i', video,
      '-map', '0:v:0',
      '-an',
      '-frames:v', '1',
      '-q:v', '2',
      '-update', '1',
      '--', dst,
    ],
    { what: 'image du milieu' },
  )
}

// ---------------------------------------------------------------------------
// Ligne de commande.
// ---------------------------------------------------------------------------

const VALUE_FLAGS = ['--json', '--cases', '--seed', '--project', '--out'] as const

function usage(): string {
  return (
    'pnpm tsx scripts/spike/subshot-ab.ts --json <fichier subshots.json>\n' +
    '    [--cases 4] [--seed 1] [--project <id>] [--out <dossier>]'
  )
}

/** Un drapeau à valeur : présent ou non, et sa valeur brute si présent. */
function flagValue(args: string[], name: string): { present: boolean; raw: string | undefined } {
  const i = args.indexOf(name)
  return i < 0 ? { present: false, raw: undefined } : { present: true, raw: args[i + 1] }
}

/**
 * Un entier, ou `undefined` — jamais `Number(raw)` seul, qui vaut 0 pour la
 * chaîne vide et lit `"0x10"` comme seize. **Une valeur illisible est refusée,
 * jamais remplacée par le défaut en silence.**
 */
function integerSetting(
  args: string[],
  name: string,
  defaultValue: number,
  accept: (n: number) => boolean,
): number | undefined {
  const flag = flagValue(args, name)
  if (!flag.present) return defaultValue
  if (flag.raw === undefined || !/^\d+$/.test(flag.raw.trim())) return undefined
  const parsed = Number(flag.raw.trim())
  return accept(parsed) ? parsed : undefined
}

/** Une valeur textuelle : refusée si absente ou si elle ressemble au drapeau suivant. */
function textSetting(args: string[], name: string): { present: boolean; value: string | undefined } {
  const flag = flagValue(args, name)
  if (!flag.present) return { present: false, value: undefined }
  if (flag.raw === undefined || flag.raw.startsWith('--') || flag.raw.length === 0) {
    return { present: true, value: undefined }
  }
  return { present: true, value: flag.raw }
}

function number(n: number, decimals = 1): string {
  return Number.isFinite(n) ? n.toFixed(decimals) : '—'
}

/** Le poids d'un fichier, en mébioctets — l'unité des fichiers qu'on s'échange. */
function weight(file: string): string {
  return `${(fs.statSync(file).size / 1024 ** 2).toFixed(1)} Mio`
}

async function main(): Promise<number> {
  await chargerEnv()

  const args = process.argv.slice(2)
  const unknown = args.filter(
    (a, i) =>
      a.startsWith('--') &&
      !(VALUE_FLAGS as readonly string[]).includes(a) &&
      !(i > 0 && (VALUE_FLAGS as readonly string[]).includes(args[i - 1])),
  )
  if (unknown.length > 0) {
    console.error(`Drapeau inconnu : ${unknown.join(', ')}.\n${usage()}`)
    return 1
  }

  const json = textSetting(args, '--json')
  if (!json.present || json.value === undefined) {
    console.error(`--json attend un chemin de fichier.\n${usage()}`)
    return 1
  }

  const cases = integerSetting(args, '--cases', 4, (n) => n >= 1)
  if (cases === undefined) {
    console.error(`--cases attend un entier ≥ 1, reçu « ${String(flagValue(args, '--cases').raw)} ».`)
    return 1
  }
  const seed = integerSetting(args, '--seed', 1, (n) => n >= 0)
  if (seed === undefined) {
    console.error(`--seed attend un entier ≥ 0, reçu « ${String(flagValue(args, '--seed').raw)} ».`)
    return 1
  }

  const project = textSetting(args, '--project')
  if (project.present && project.value === undefined) {
    console.error(`--project attend un identifiant d'émission, reçu « ${String(flagValue(args, '--project').raw)} ».`)
    return 1
  }
  const out = textSetting(args, '--out')
  if (out.present && out.value === undefined) {
    console.error(`--out attend un chemin de dossier, reçu « ${String(flagValue(args, '--out').raw)} ».`)
    return 1
  }

  const outDir = out.value ?? fs.mkdtempSync(path.join(os.tmpdir(), 'subshot-ab-'))
  fs.mkdirSync(outDir, { recursive: true })

  try {
    const data = readSubShotsJson(json.value)
    const ids = Object.keys(data).filter((id) => project.value === undefined || id === project.value)
    if (ids.length === 0) {
      console.error(
        `Aucune émission à traiter. Le JSON porte ${Object.keys(data).join(', ')}` +
          `${project.value === undefined ? '' : `, et --project demande « ${project.value} »`}.`,
      )
      return 1
    }

    console.log(`Graine ${seed}, ${cases} cas demandé(s), sortie dans ${outDir}`)
    const shows = ids.map((id) => loadShow(id, data[id], seed))
    for (const show of shows) {
      console.log(
        `  ${show.id.padEnd(24)} ${show.works.length} plans montés,` +
          ` source ${path.basename(show.source.file)} en ${show.source.w}x${show.source.h}` +
          `${show.source.isProxy ? ' (PROXY — image molle, géométrie juste)' : ''}`,
      )
    }

    console.log('\n=== 1. Le tirage restitué — à comparer avec la sortie de subshots.ts ===')
    for (const show of shows) console.log(`  ${show.id.padEnd(24)} ${disagreementLine(show)}`)

    console.log('\n=== 2. Le cadrage recalculé contre celui du JSON ===')
    let framingOk = true
    for (const show of shows) {
      const check = checkCandidateFraming(show)
      const verdict =
        check.mismatches.length === 0
          ? `${check.compared} sous-plans, identiques`
          : `${check.mismatches.length} ECART(S) sur ${check.compared}`
      console.log(
        `  ${show.id.padEnd(24)} ${verdict}, écart max de cropX ${check.worstCropDelta.toExponential(1)}`,
      )
      for (const m of check.mismatches) console.log(`      ${m}`)
      if (check.mismatches.length > 0) framingOk = false
    }
    if (!framingOk) {
      console.error(
        '\nLe cadrage recalculé ne retrouve pas celui du JSON. Le panneau du témoin serait donc ' +
          'calculé sur une population de boîtes ou un réglage qui ne sont pas ceux de la mesure — ' +
          "et il montrerait un cadrage qui n'a jamais existé. Rien n'est rendu.",
      )
      return 1
    }

    const pool = collectDisagreementCases(shows)
    const picked = pool.slice(0, cases)
    console.log(
      `\n=== 3. Les cas retenus — ${picked.length}/${cases} demandé(s),` +
        ` sur ${pool.length} plan(s) à ${MIN_DISAGREEMENT_SEC} s de désaccord ininterrompu ou plus ===`,
    )
    const control = pickControlCase(shows)
    if (control === null) {
      console.error(
        '  Aucun cas de contrôle : pas de gros plan à une personne où today et candidate coïncident.',
      )
    } else {
      picked.push(control)
    }
    if (picked.length === 0) {
      console.error('Rien à rendre.')
      return 1
    }
    for (const c of picked) {
      console.log(
        `  ${c.name.padEnd(34)} ${c.kind === 'control' ? 'CONTRÔLE' : 'désaccord'}` +
          `  ${number(c.interval.start).padStart(8)} → ${number(c.interval.end).padStart(8)} s` +
          `  (${number(c.interval.end - c.interval.start)} s)` +
          `  suite ${number(c.runSeconds)} s (source),` +
          ` désaccord monté ${number(c.totalDisagreementSeconds)} s`,
      )
    }

    const labels = VARIANT_KEYS.map((key) => {
      const file = path.join(outDir, `libelle-${key}.png`)
      writeLabelImage(VARIANT_LABELS[key], file)
      return file
    })

    console.log('\n=== 4. Le rendu ===')
    type Produced = { c: Case; file: string; panels: string[] }
    const produced: Produced[] = []
    for (const c of picked) {
      const panels: string[] = []
      for (const variant of VARIANT_KEYS) {
        const dst = path.join(outDir, `${c.name}.${variant}.mp4`)
        const { pieces, fallbacks } = await renderPanel({
          show: c.show,
          work: c.work,
          variant,
          interval: c.interval,
          dst,
        })
        if (fallbacks > 0) {
          console.log(
            `  ATTENTION ${c.name} / ${variant} : ${fallbacks} morceau(x) sans plan, cadre de repli 16:9.`,
          )
        }
        console.log(`  ${c.name} / ${variant.padEnd(10)} ${pieces} morceau(x) → ${path.basename(dst)}`)
        panels.push(dst)
      }
      const file = path.join(outDir, `${c.name}.ab.mp4`)
      await runFfmpeg(stackArgs({ panels, labels, dst: file }), {
        what: `assemblage ${c.name}`,
        durationSec: c.interval.end - c.interval.start,
      })
      produced.push({ c, file, panels })
    }

    console.log('\n=== 5. Les vérifications de sortie ===')
    console.log(
      '  Les durées sont celles de la PISTE VIDÉO. Le conteneur est plus long de quelques' +
        " dizaines de millisecondes : c'est le rembourrage de l'AAC, pas un morceau perdu.",
    )
    console.log(
      '  cas                                 demandé   vidéo     écart  images  panneaux (durées vidéo)      pistes',
    )
    let soundOk = true
    for (const { c, file, panels } of produced) {
      const wanted = c.interval.end - c.interval.start
      const video = probeVideoStream(file)
      const panelVideos = panels.map((p) => probeVideoStream(p))
      const kinds = probeStreamKinds(file)
      const audioTracks = kinds.filter((k) => k === 'audio').length
      const videoTracks = kinds.filter((k) => k === 'video').length
      const durations = panelVideos.map((v) => v.duration)
      const spread = Math.max(...durations) - Math.min(...durations)
      // Une image de tolérance, et pas plus : c'est ce que l'arrondi d'un `-t` à
      // une frontière d'image peut coûter. Un morceau perdu vaut des secondes.
      const tolerance = Number.isFinite(video.fps) && video.fps > 0 ? 1 / video.fps : 0.05
      const faults: string[] = []
      if (Math.abs(video.duration - wanted) > tolerance) faults.push('DUREE')
      if (spread > tolerance) faults.push('DESYNC')
      if (audioTracks !== 1 || videoTracks !== 1) faults.push('PISTES')
      if (faults.length > 0) soundOk = false
      console.log(
        `  ${c.name.padEnd(34)} ${number(wanted, 3).padStart(8)} ${number(video.duration, 3).padStart(8)}` +
          ` ${number(video.duration - wanted, 3).padStart(9)}` +
          ` ${String(video.frames).padStart(6)}` +
          `   ${durations.map((d) => number(d, 3)).join(' / ')}` +
          `   ${videoTracks} v + ${audioTracks} a` +
          `${faults.length > 0 ? `   ← ${faults.join(', ')}` : ''}`,
      )
    }
    console.log(
      soundOk
        ? '  Durées conformes à l’image près, panneaux synchrones, une seule piste son par sortie.'
        : '  DEFAUT(S) ci-dessus — ne pas juger un cadrage sur une sortie qui ne tient pas ses durées.',
    )

    console.log('\n=== 5bis. Le contrôle négatif — ses trois panneaux doivent être indiscernables ===')
    const controlEntry = produced.find(({ c }) => c.kind === 'control')
    let controlOk = false
    if (controlEntry === undefined) {
      console.log(
        '  Pas de cas de contrôle rendu — le contrôle négatif annoncé par ce script n’a pas pu être vérifié.',
      )
    } else {
      controlOk = true
      const [today, candidate, randomWho] = controlEntry.panels
      const pairs: [string, string, string][] = [
        ['aujourd’hui / candidat', today, candidate],
        ['aujourd’hui / randomWho', today, randomWho],
      ]
      for (const [label, a, b] of pairs) {
        const psnr = worstPsnr(a, b)
        const ok = psnr >= CONTROL_PSNR_FLOOR_DB
        if (!ok) controlOk = false
        console.log(
          `  ${label.padEnd(26)} PSNR minimal ${Number.isFinite(psnr) ? psnr.toFixed(1) : 'inf'} dB` +
            `${ok ? '' : `   ← DIVERGENCE (< ${CONTROL_PSNR_FLOOR_DB} dB)`}`,
        )
      }
      console.log(
        controlOk
          ? '  Panneaux indiscernables : la reconstruction de candidate et randomWho tient.'
          : "  DEFAUT — le contrôle négatif est censé montrer trois panneaux identiques, et ce n'est pas le cas.",
      )
    }

    console.log('\n=== 6. Ce qu\'on livre ===')
    for (const { c, file } of produced) {
      const duration = probeContainerDuration(file)
      const still = path.join(outDir, `${c.name}.milieu.jpg`)
      await extractMiddleFrame(file, still, duration)
      console.log(`  ${file}  ${number(duration)} s  ${weight(file)}`)
      console.log(`      image du milieu : ${still}`)
    }

    return soundOk && controlOk ? 0 : 1
  } finally {
    closeDb()
  }
}

void main().then(quit, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quit(1)
})
