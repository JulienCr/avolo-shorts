/**
 * La première question du spike « qui parle », et la seule qui vaille avant de
 * construire quoi que ce soit : **le mouvement de la région de bouche est-il
 * seulement lié à la parole ?**
 *
 *     pnpm tsx scripts/spike/speaker-probe.ts [projectId…] [--seconds 600]
 *       [--min-shot 6] [--max-window 20] [--seed 20260820] [--plan] [--force]
 *       [--json <fichier>]
 *
 * Sans `projectId`, les quatre émissions du disque (`DEFAULT_SHOW_IDS`).
 * `--plan` s'arrête après le tirage, sans toucher au GPU.
 *
 * **Le corpus fournit sa propre supervision, personne n'étiquette rien.** Sur
 * un plan où **une seule personne est à l'écran**, on sait qui parle sans le
 * demander : s'il y a de la parole dans l'audio à cet instant, c'est elle. La
 * vérité est donc `speech(t)` — un **mot** du transcript couvre-t-il `t` — et
 * non le segment qui le porte : un segment couvre aussi ses silences, et s'en
 * servir noierait la moitié des négatifs dans les positifs.
 *
 * Deux constats, dans cet ordre, et le second est celui qui décide.
 *
 * **C1 — le signal est-il lié à la parole ?** Pour chacune des quatre mesures
 * de `worker/spike_activity.py`, l'AUC pour prédire `speech(t)` et la
 * corrélation de Pearson avec l'enveloppe audio. L'AUC parce qu'elle ne demande
 * aucun seuil : il n'y a rien à régler, donc rien à sur-ajuster. Calculée par
 * le rang de Mann-Whitney et non par une somme de trapèzes sur une grille de
 * seuils — la grille introduit une erreur de discrétisation qui dépend du
 * nombre de points, là où l'identité rang/AUC est exacte.
 *
 * **`noseShift` est le témoin interne.** Ce n'est pas une cinquième mesure de
 * bouche, c'est le bruit de tête. Si le bruit de tête obtient la même AUC que
 * `centerDiff`, alors la mesure de bouche ne mesure pas la bouche : elle mesure
 * que quelqu'un qui parle remue la tête, et un détecteur bâti dessus se
 * tromperait sur exactement les plans qui comptent — deux comédiens qui bougent
 * tous les deux.
 *
 * **C2 — le contrôle négatif, qui décide.** Le même calcul, à l'identique, avec
 * la vérité **décalée** de +10 s, −10 s et +30 s : on décale `speech` et
 * l'enveloppe audio, jamais la vidéo. L'AUC **doit** retomber vers 0,5 et la
 * corrélation vers 0. Si elle ne s'effondre pas, la mesure ne mesure pas la
 * parole et le chiffre de C1 est un artefact — d'une émission qui parle 80 % du
 * temps, d'un plan qui bouge quand ça parle, de n'importe quoi d'autre. Un bon
 * chiffre en C1 sans effondrement en C2 ne vaut rien.
 *
 * **La recherche de décalage est une troisième preuve, gratuite.** La bouche
 * précède le son. Si la corrélation atteint son maximum à un décalage net et
 * proche de zéro, c'est que les deux signaux décrivent le même événement
 * physique ; une courbe plate est un aveu, quel que soit son sommet.
 *
 * **Deux limites, affichées et non cachées.**
 *
 * 1. *La voix peut venir de hors champ.* Un plan à une personne ne garantit pas
 *    que c'est elle qui parle : l'autre comédien peut répondre hors cadre. Ça
 *    **abaisse** l'AUC au lieu de la gonfler — le bruit va contre l'hypothèse,
 *    donc un bon chiffre reste bon — mais la part d'images « personne à l'écran
 *    **et** parole » est affichée, pour qu'on sache de quoi on parle.
 * 2. *Un visage baissé et de profil donne un nez, pas une bouche.* Constaté sur
 *    les PNG de contrôle de `spike_mouth.py`. D'où l'AUC restreinte aux images
 *    où la personne est de face au sens d'`orientationOf`, à côté de l'AUC
 *    générale : si elle monte nettement, c'est une information de conception.
 *
 * **Ce script ne redéfinit aucun filtre de cadrage.** `FRAMING_DEFAULTS.minScore`
 * et `isForeground` sont les seules autorités pour dire qui est à l'écran, ici
 * comme dans `computeFraming` — voir la skill `cadrage`. Un plan « à une
 * personne » est un plan dont le nombre **médian** de personnes par image
 * d'analyse, après ces deux filtres, vaut exactement 1.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { FRAMING_DEFAULTS, isForeground, orientationOf, type Facing } from '@/core/framing'
import type { PersonBox } from '@/core/shots'
import { ffmpegBin } from '@/server/ffmpeg'
import { analysisPath, audioPath, placeSidecar, projectDir, proxyPath } from '@/server/paths'
import { lireAnalysis, type Analysis } from '@/server/steps/analysis'
import { chargerEnv, quit } from '../dev-common'

/** Les quatre émissions du disque, faute de `projectId` sur la ligne de commande. */
const DEFAULT_SHOW_IDS = [
  '2025-06-15-cqlp',
  '2026-03-08-caro-mdlm',
  '2026-05-31-nabla',
  '2026-22-02-entre-nous',
] as const

/** Les quatre mesures de `worker/spike_activity.py`, dans l'ordre d'affichage. */
const MEASURES = ['rawDiff', 'normDiff', 'centerDiff', 'noseShift'] as const
type Measure = (typeof MEASURES)[number]

/** La mesure dont on trace la courbe de décalage — voir la conclusion du rapport. */
const LAG_MEASURE: Measure = 'centerDiff'

/**
 * Les trois décalages du contrôle négatif, en secondes.
 *
 * +10 et −10 encadrent zéro pour qu'un effondrement asymétrique se voie ; +30
 * s'en éloigne assez pour sortir de toute structure locale de la conversation —
 * un tour de parole dure quelques secondes, pas trente.
 */
const CONTROL_SHIFTS_SEC = [10, -10, 30] as const

/** Zéro compris : la référence se calcule exactement comme les trois contrôles. */
const ALL_SHIFTS_SEC = [0, ...CONTROL_SHIFTS_SEC] as const

/** L'amplitude de la recherche de décalage, en images à 30 im/s (±0,27 s). */
const LAG_FRAMES = 8

/** La cadence d'analyse des patchs de bouche, en images par seconde. */
const MOUTH_FPS = 30

/**
 * Les fenêtres audio de `spike_mouth.py` : 160 échantillons à 16 kHz, donc
 * 10 ms. Répétées ici parce que le lecteur de WAV plus bas doit produire
 * **exactement** la même enveloppe pour que la vérification croisée ait un sens.
 */
const AUDIO_RATE = 16000
const AUDIO_WINDOW_SAMPLES = 160
const AUDIO_ENVELOPE_RATE = AUDIO_RATE / AUDIO_WINDOW_SAMPLES

/**
 * Le nombre minimal d'images mesurables pour qu'une fenêtre compte dans la
 * médiane par fenêtre : deux secondes à 30 im/s. En dessous, l'AUC d'une
 * fenêtre est une variable de bruit, et la médiane de quarante-huit bruits
 * reste du bruit.
 */
const MIN_WINDOW_SAMPLES = 60

/** Le pas d'attente quand le GPU est occupé, en millisecondes. */
const GPU_POLL_MS = 15000

// ---------------------------------------------------------------------------
// Le hasard, à graine
// ---------------------------------------------------------------------------

/**
 * Un générateur pseudo-aléatoire à graine, écrit à la main.
 *
 * `Math.random()` n'a pas de graine : le tirage changerait à chaque exécution,
 * et deux passes du même script ne mesureraient pas le même corpus. Or c'est
 * exactement ce qu'il faut pouvoir refaire quand un chiffre surprend.
 *
 * L'algorithme est *mulberry32* : un compteur additif de 32 bits passé dans deux
 * mélanges multiplicatifs. Il n'a aucune qualité cryptographique et n'en a pas
 * besoin — il faut qu'il soit reproductible et sans structure visible sur
 * quelques centaines de tirages.
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

/** Fisher-Yates, sur une copie. Le seul mélange qui soit uniforme. */
function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const out = [...values]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const swap = out[i]
    out[i] = out[j]
    out[j] = swap
  }
  return out
}

// ---------------------------------------------------------------------------
// Les statistiques
// ---------------------------------------------------------------------------

/** La médiane, au sens strict : sur un compte pair, le milieu des deux centrales. */
function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const m = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

/**
 * L'AUC par le rang de Mann-Whitney : la probabilité qu'un positif tiré au
 * hasard porte une valeur plus grande qu'un négatif tiré au hasard.
 *
 * **Les ex æquo reçoivent le rang moyen de leur palier**, et ce n'est pas un
 * détail cosmétique : les mesures d'activité valent souvent exactement 0 sur un
 * patch immobile, donc les ex æquo se comptent par centaines. Leur donner des
 * rangs consécutifs arbitraires fabriquerait un ordre là où il n'y en a pas, et
 * ferait dériver l'AUC dans la direction de l'ordre de lecture des fichiers —
 * un artefact indiscernable d'un signal.
 *
 * `null` quand l'un des deux groupes est vide : sans positif ou sans négatif il
 * n'y a pas de question, et rendre 0,5 dirait « pas de signal » là où il n'y a
 * pas de mesure.
 */
function areaUnderCurve(values: readonly number[], labels: readonly boolean[]): number | null {
  const n = values.length
  let positives = 0
  for (const label of labels) if (label) positives += 1
  const negatives = n - positives
  if (positives === 0 || negatives === 0) return null

  const order = Array.from({ length: n }, (unused, i) => i).sort((a, b) => values[a] - values[b])
  const ranks = new Float64Array(n)
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j += 1
    // Rangs 1-indexés, moyennés sur le palier [i, j].
    const average = (i + j) / 2 + 1
    for (let k = i; k <= j; k += 1) ranks[order[k]] = average
    i = j + 1
  }

  let sumPositive = 0
  for (let k = 0; k < n; k += 1) if (labels[k]) sumPositive += ranks[k]
  return (sumPositive - (positives * (positives + 1)) / 2) / (positives * negatives)
}

/**
 * La corrélation de Pearson. `null` si l'un des deux échantillons est constant —
 * la corrélation n'est alors pas définie, et rendre 0 dirait « pas de lien » là
 * où il n'y a pas de question.
 */
function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length
  if (n < 2 || ys.length !== n) return null
  let sumX = 0
  let sumY = 0
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i]
    sumY += ys[i]
  }
  const meanX = sumX / n
  const meanY = sumY / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX
    const dy = ys[i] - meanY
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (!(sxx > 0) || !(syy > 0)) return null
  return sxy / Math.sqrt(sxx * syy)
}

// ---------------------------------------------------------------------------
// L'affichage
// ---------------------------------------------------------------------------

function number(value: number | null, decimals = 3): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toFixed(decimals)
}

function percent(part: number, total: number): string {
  return total > 0 ? `${((100 * part) / total).toFixed(1)} %` : '—'
}

/** Une durée en secondes, telle qu'on la lit dans un rapport de mesure. */
function seconds(value: number): string {
  return `${value.toFixed(1)} s`
}

/** Un tableau à colonnes alignées, en-têtes compris. */
function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n')
}

// ---------------------------------------------------------------------------
// Les plans éligibles et leur tirage
// ---------------------------------------------------------------------------

type Draw = {
  showId: string
  /** Le rang du plan dans `analysis.shots`, pour qu'on puisse le retrouver. */
  shotIndex: number
  shotStart: number
  shotEnd: number
  /** La fenêtre réellement extraite : le plan, ou son centre si le plan est long. */
  start: number
  end: number
}

/** Les boîtes qui comptent, indexées par image d'analyse. */
function personBoxesByFrame(analysis: Analysis): Map<number, PersonBox[]> {
  const byFrame = new Map<number, PersonBox[]>()
  for (const box of analysis.boxes) {
    if (box.score < FRAMING_DEFAULTS.minScore) continue
    if (isForeground(box)) continue
    const index = Math.round(box.t * analysis.fps)
    const bucket = byFrame.get(index)
    if (bucket === undefined) byFrame.set(index, [box])
    else bucket.push(box)
  }
  return byFrame
}

/**
 * Les plans où une seule personne est à l'écran, au sens du **nombre médian de
 * personnes par image d'analyse**.
 *
 * La médiane et non la moyenne : une image isolée où le détecteur voit deux
 * personnes — un passage, une fausse détection — ne doit pas disqualifier un
 * plan de quarante secondes.
 *
 * **Les images sans personne comptent, et il faut les fabriquer** : elles
 * n'apparaissent pas dans `analysis.boxes`, qui ne liste que des détections. Un
 * plan noir de dix secondes avec deux images à une personne aurait sinon une
 * médiane de 1.
 */
function eligibleShots(analysis: Analysis, showId: string, minShotSec: number): Draw[] {
  const byFrame = personBoxesByFrame(analysis)
  const out: Draw[] = []
  for (const [index, shot] of analysis.shots.entries()) {
    if (shot.end - shot.start < minShotSec) continue
    const first = Math.ceil(shot.start * analysis.fps - 1e-6)
    const last = Math.ceil(shot.end * analysis.fps - 1e-6)
    const counts: number[] = []
    for (let i = first; i < last; i += 1) counts.push(byFrame.get(i)?.length ?? 0)
    if (counts.length === 0) continue
    if (median(counts) !== 1) continue
    out.push({
      showId,
      shotIndex: index,
      shotStart: shot.start,
      shotEnd: shot.end,
      start: shot.start,
      end: shot.end,
    })
  }
  return out
}

/**
 * La fenêtre extraite d'un plan : le plan entier, ou son centre si le plan
 * dépasse `maxWindowSec`.
 *
 * **Un plafond, parce que le budget GPU se dépense mieux en diversité qu'en
 * durée.** `2025-06-15-cqlp` porte des plans à une personne de 135 s ; deux
 * d'entre eux consommeraient la part entière de l'émission et la mesure ne
 * parlerait plus que de deux moments. Le centre plutôt qu'un bout : le début
 * d'un plan porte souvent la fin du mouvement de caméra qui l'a amené.
 */
function windowOf(draw: Draw, maxWindowSec: number): Draw {
  const duration = draw.shotEnd - draw.shotStart
  if (duration <= maxWindowSec) return draw
  const middle = (draw.shotStart + draw.shotEnd) / 2
  return { ...draw, start: middle - maxWindowSec / 2, end: middle + maxWindowSec / 2 }
}

/**
 * Le tirage : équilibré entre émissions, déterministe à graine, et **honnête
 * quand une émission n'a pas de quoi tenir sa part**.
 *
 * `2026-03-08-caro-mdlm` n'offre que quelques plans éligibles, une quarantaine
 * de secondes en tout. Lui demander un quart de 600 s n'a pas de sens ; insister
 * en abaissant le seuil de durée pour elle seule en aurait encore moins — ce
 * serait mesurer sur des plans plus courts *parce que* le résultat manquait. On
 * lui prend donc tout ce qu'elle a, et sa part non consommée se redistribue
 * entre les émissions qui ont encore de la matière.
 */
function drawWindows(
  perShow: Map<string, Draw[]>,
  totalSec: number,
  maxWindowSec: number,
  random: () => number,
): { draws: Draw[]; allocations: Map<string, number> } {
  const capacity = new Map<string, number>()
  for (const [showId, shots] of perShow) {
    capacity.set(
      showId,
      shots.reduce((sum, s) => sum + Math.min(s.shotEnd - s.shotStart, maxWindowSec), 0),
    )
  }

  // La redistribution, par tours : tant qu'une émission ne peut pas tenir la
  // part égale, on lui donne sa capacité et on repartage le reste entre celles
  // qui restent. Converge en au plus une passe par émission.
  const allocations = new Map<string, number>()
  let pool = [...perShow.keys()]
  let remaining = totalSec
  while (pool.length > 0) {
    const share = remaining / pool.length
    const short = pool.filter((id) => (capacity.get(id) ?? 0) < share)
    if (short.length === 0) {
      for (const id of pool) allocations.set(id, share)
      break
    }
    for (const id of short) {
      const available = capacity.get(id) ?? 0
      allocations.set(id, available)
      remaining -= available
    }
    pool = pool.filter((id) => !short.includes(id))
  }

  const draws: Draw[] = []
  for (const [showId, shots] of perShow) {
    const budget = allocations.get(showId) ?? 0
    let taken = 0
    for (const shot of shuffled(shots, random)) {
      if (taken >= budget) break
      const window = windowOf(shot, maxWindowSec)
      draws.push(window)
      taken += window.end - window.start
    }
  }
  return { draws, allocations }
}

// ---------------------------------------------------------------------------
// Le transcript : la vérité, sans humain
// ---------------------------------------------------------------------------

/** Les intervalles de parole, fusionnés et triés — un par **mot**, jamais par segment. */
type Speech = {
  starts: Float64Array
  ends: Float64Array
  /** Les mots sans instants, comptés pour être dits plutôt que passés sous silence. */
  timeless: number
  words: number
}

function readSpeech(file: string): Speech {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  const segments = (raw as { segments?: unknown }).segments
  if (!Array.isArray(segments)) {
    throw new Error(`${file} ne porte pas de champ \`segments\` : ce n'est pas un transcript.`)
  }
  const intervals: [number, number][] = []
  let timeless = 0
  let words = 0
  for (const segment of segments as { words?: unknown }[]) {
    const list = segment.words
    if (!Array.isArray(list)) continue
    for (const word of list as { start?: unknown; end?: unknown }[]) {
      words += 1
      const start = word.start
      const end = word.end
      if (typeof start !== 'number' || typeof end !== 'number' || !(end > start)) {
        // WhisperX laisse quelques mots sans instants — des nombres, surtout.
        // Les inventer en interpolant fabriquerait de la vérité ; les ignorer ne
        // fait que retirer quelques positifs, ce qui va contre l'hypothèse.
        timeless += 1
        continue
      }
      intervals.push([start, end])
    }
  }
  intervals.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const interval of intervals) {
    const last = merged[merged.length - 1]
    if (last !== undefined && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1])
    else merged.push([interval[0], interval[1]])
  }
  return {
    starts: Float64Array.from(merged.map((i) => i[0])),
    ends: Float64Array.from(merged.map((i) => i[1])),
    timeless,
    words,
  }
}

/** `t` est-il couvert par un mot ? Recherche dichotomique sur les intervalles fusionnés. */
function speaks(speech: Speech, t: number): boolean {
  let low = 0
  let high = speech.starts.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (speech.starts[mid] > t) high = mid - 1
    else low = mid + 1
  }
  // `high` est le dernier intervalle qui commence avant ou à `t`.
  if (high < 0) return false
  return t < speech.ends[high]
}

// ---------------------------------------------------------------------------
// L'enveloppe audio, relue ici pour les décalages
// ---------------------------------------------------------------------------

/**
 * Pourquoi ce lecteur de WAV existe alors que `spike_activity.py` écrit déjà une
 * enveloppe.
 *
 * L'enveloppe du JSON ne couvre **que la fenêtre extraite**. Le contrôle négatif
 * demande l'audio de `t + 30 s`, qui est hors de cette fenêtre : sans lecture
 * directe du WAV, il faudrait replier l'enveloppe sur elle-même — un contrôle
 * circulaire, où un décalage de +30 s sur une fenêtre de 20 s revient à un
 * décalage de +10 s, donc où deux des trois lignes du tableau C2 seraient la
 * même mesure écrite deux fois.
 *
 * **Ce n'est pas une seconde source de vérité**, et le script le prouve plutôt
 * que de l'affirmer : au décalage 0, il compare cette enveloppe à celle du JSON
 * et affiche l'écart maximal. Deux chemins qui calculent la même chose doivent
 * tomber sur la même valeur, sans quoi l'un des deux est faux — et on veut le
 * savoir ici, pas en interprétant un tableau.
 */
type Wav = { fd: number; rate: number; dataOffset: number; frames: number }

function openWav(file: string): Wav {
  const fd = fs.openSync(file, 'r')
  const header = Buffer.alloc(4096)
  const read = fs.readSync(fd, header, 0, header.length, 0)
  if (
    read < 12 ||
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    fs.closeSync(fd)
    throw new Error(`${file} n'est pas un WAV RIFF.`)
  }
  let offset = 12
  let rate = 0
  let channels = 0
  let bits = 0
  let dataOffset = -1
  let dataSize = 0
  while (offset + 8 <= read) {
    const id = header.toString('ascii', offset, offset + 4)
    const size = header.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      channels = header.readUInt16LE(offset + 10)
      rate = header.readUInt32LE(offset + 12)
      bits = header.readUInt16LE(offset + 22)
    } else if (id === 'data') {
      dataOffset = offset + 8
      dataSize = size
      break
    }
    offset += 8 + size + (size % 2)
  }
  if (dataOffset < 0 || rate !== AUDIO_RATE || channels !== 1 || bits !== 16) {
    fs.closeSync(fd)
    throw new Error(
      `${file} n'est pas un WAV ${AUDIO_RATE} Hz mono PCM s16 : trouvé ${channels} canal/canaux, ` +
        `${bits} bits, ${rate} Hz.`,
    )
  }
  return { fd, rate, dataOffset, frames: Math.floor(dataSize / 2) }
}

/**
 * L'enveloppe RMS de `[start, end]` par fenêtres de 10 ms — la même définition,
 * au découpage près, que `read_audio_envelope` de `spike_mouth.py`.
 *
 * `null` si l'intervalle sort du fichier : un décalage de +30 s à trois secondes
 * de la fin n'a pas d'audio, et le compléter de zéros dirait « silence » là où
 * il n'y a rien du tout.
 */
function envelopeOf(wav: Wav, start: number, end: number): Float64Array | null {
  const first = Math.round(start * wav.rate)
  const last = Math.round(end * wav.rate)
  if (first < 0 || last > wav.frames || last <= first) return null
  const buffer = Buffer.alloc((last - first) * 2)
  // Une boucle, pas un seul `readSync` : un appel système peut rendre moins que
  // demandé, et un tampon partiellement rempli passerait pour du silence.
  let filled = 0
  while (filled < buffer.length) {
    const got = fs.readSync(wav.fd, buffer, filled, buffer.length - filled, wav.dataOffset + first * 2 + filled)
    if (got <= 0) return null
    filled += got
  }
  const count = Math.floor((last - first) / AUDIO_WINDOW_SAMPLES)
  const out = new Float64Array(count)
  for (let w = 0; w < count; w += 1) {
    let sum = 0
    const base = w * AUDIO_WINDOW_SAMPLES
    for (let s = 0; s < AUDIO_WINDOW_SAMPLES; s += 1) {
      const sample = buffer.readInt16LE((base + s) * 2) / 32768
      sum += sample * sample
    }
    out[w] = Math.sqrt(sum / AUDIO_WINDOW_SAMPLES)
  }
  return out
}

/**
 * L'enveloppe à la cadence vidéo — la même moyenne centrée que
 * `resample_envelope` de `spike_activity.py`, pour que la vérification croisée
 * porte sur les deux étapes et non sur la seule lecture du WAV.
 */
function resampleEnvelope(envelope: Float64Array, relatives: readonly number[]): (number | null)[] {
  const half = 0.5 / MOUTH_FPS
  return relatives.map((relative) => {
    const first = Math.max(Math.floor((relative - half) * AUDIO_ENVELOPE_RATE), 0)
    const last = Math.min(Math.ceil((relative + half) * AUDIO_ENVELOPE_RATE), envelope.length)
    if (last <= first) return null
    let sum = 0
    for (let i = first; i < last; i += 1) sum += envelope[i]
    return sum / (last - first)
  })
}

// ---------------------------------------------------------------------------
// L'extraction : le GPU
// ---------------------------------------------------------------------------

/** Les processus de calcul en cours sur le GPU, une ligne chacun. */
function gpuBusy(): string[] {
  const result = spawnSync(
    'nvidia-smi',
    ['--query-compute-apps=pid,used_memory,process_name', '--format=csv,noheader'],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) return []
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * Attend que le GPU se libère plutôt que d'insister.
 *
 * **Les étapes GPU de ce dépôt ne tournent jamais en parallèle** — c'est une
 * règle du `CLAUDE.md`, pas une précaution : WhisperX large-v3 prend une
 * vingtaine de gigaoctets, et deux travaux qui se disputent 24 Go échouent tous
 * les deux au lieu d'être lents.
 */
async function waitForGpu(): Promise<void> {
  let announced = false
  for (;;) {
    const busy = gpuBusy()
    if (busy.length === 0) {
      if (announced) console.log('   GPU libre, on reprend.')
      return
    }
    if (!announced) {
      console.log("GPU occupé, on attend plutôt que d'insister :")
      for (const line of busy) console.log(`   ${line}`)
      announced = true
    }
    await new Promise((resolve) => setTimeout(resolve, GPU_POLL_MS))
  }
}

function run(command: string, args: readonly string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, [...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    const tail: string[] = []
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (piece: string) => {
      for (const line of piece.split(/\r\n|[\r\n]/)) {
        if (line.trim() === '') continue
        tail.push(line)
        if (tail.length > 20) tail.shift()
      }
    })
    proc.on('error', (cause) => reject(new Error(`${label} n'a pas pu démarrer : ${String(cause)}`)))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} a échoué (code ${code}) :\n${tail.join('\n')}`))
    })
  })
}

// ---------------------------------------------------------------------------
// Les échantillons
// ---------------------------------------------------------------------------

/** Une image utilisable : une personne identifiée, ses mesures, et la vérité. */
type Sample = {
  showId: string
  /** Le rang de la fenêtre extraite d'où vient cette image — voir `windowRows`. */
  window: number
  t: number
  /** L'enveloppe audio du JSON, à la cadence vidéo. */
  audio: number | null
  facing: Facing
  /** `null` si et seulement si `facing` vaut `'unknown'` — voir `orientationOf`. */
  frontality: number | null
  values: Record<Measure, number | null>
}

type ActivityBox = { x0: number; x1: number; y0: number; y1: number; score: number } | null

type Activity = {
  frames: number
  people: number
  t: (number | null)[]
  audioEnv: (number | null)[]
  person: {
    present: boolean[]
    mouth: boolean[]
    box: ActivityBox[]
    rawDiff: (number | null)[]
    normDiff: (number | null)[]
    centerDiff: (number | null)[]
    noseShift: (number | null)[]
  }[]
}

/**
 * Le rang de **la** personne du plan, image par image, ou `null` quand il y a
 * ambiguïté.
 *
 * `spike_mouth.py` garde jusqu'à quatre détections par image, rangées de gauche
 * à droite et **sans aucun suivi** : le rang 0 d'une image n'est pas forcément
 * celui de la suivante. Les filtres du cadrage (`minScore`, `isForeground`)
 * ramènent en général ça à une seule personne — c'est la définition même du plan
 * tiré — mais pas toujours : un spectateur au premier plan que le filtre ne
 * rattrape pas, une fausse détection sur un fauteuil.
 *
 * **Zéro ou deux candidats donnent `null`, jamais « le plus confiant ».** Choisir
 * sous ambiguïté, ici, ce serait décider *qui* on mesure sur la foi d'un
 * départage arbitraire ; le prix d'un `null` est quelques images perdues sur
 * dix-huit mille.
 */
function chosenRanks(activity: Activity): (number | null)[] {
  const out: (number | null)[] = []
  for (let f = 0; f < activity.frames; f += 1) {
    let chosen: number | null = null
    let count = 0
    for (let r = 0; r < activity.people; r += 1) {
      const person = activity.person[r]
      if (person === undefined || !person.present[f]) continue
      const box = person.box[f]
      if (box === null || box === undefined) continue
      if (box.score < FRAMING_DEFAULTS.minScore) continue
      if (isForeground({ t: 0, ...box })) continue
      count += 1
      chosen = r
    }
    out.push(count === 1 ? chosen : null)
  }
  return out
}

/**
 * L'orientation de la personne, lue sur l'image d'analyse **la plus proche**.
 *
 * `orientationOf` a besoin des dix-sept points COCO, que `analysis.json` porte en
 * version 2. On y va plutôt qu'aux points du `.npz` parce que c'est la lecture
 * qu'un futur détecteur de locuteur ferait : `analysis.json` est ce qui existe en
 * production, à 2 im/s, donc au plus 0,25 s de l'image mesurée.
 *
 * Quand plusieurs personnes qualifient à cet instant, on prend celle dont le
 * centre horizontal est le plus proche de la boîte mesurée : c'est la seule
 * façon de ne pas lire l'orientation de quelqu'un d'autre.
 */
function facingAt(
  byFrame: Map<number, PersonBox[]>,
  fps: number,
  t: number,
  centerX: number,
): { facing: Facing; frontality: number | null } {
  const base = Math.round(t * fps)
  for (const offset of [0, -1, 1, -2, 2]) {
    const candidates = byFrame.get(base + offset)
    if (candidates === undefined || candidates.length === 0) continue
    let best = candidates[0]
    let bestDistance = Number.POSITIVE_INFINITY
    for (const box of candidates) {
      const distance = Math.abs((box.x0 + box.x1) / 2 - centerX)
      if (distance < bestDistance) {
        bestDistance = distance
        best = box
      }
    }
    const orientation = orientationOf(best)
    return { facing: orientation.facing, frontality: orientation.frontality }
  }
  return { facing: 'unknown', frontality: null }
}

// ---------------------------------------------------------------------------
// Les deux chiffres, sur un sous-ensemble d'échantillons
// ---------------------------------------------------------------------------

type Row = { auc: number | null; correlation: number | null; n: number; nAudio: number }

/**
 * L'AUC et la corrélation d'une mesure sur les indices donnés.
 *
 * `speech` et `audio` sont indexés comme `samples`, pas comme `indices` : c'est
 * ce qui permet de rejouer le même calcul avec une vérité décalée sans recopier
 * les échantillons.
 */
function measureRow(
  samples: readonly Sample[],
  indices: readonly number[],
  measure: Measure,
  speech: readonly boolean[],
  audio: readonly (number | null)[],
): Row {
  const values: number[] = []
  const labels: boolean[] = []
  const pairsX: number[] = []
  const pairsY: number[] = []
  for (const i of indices) {
    const value = samples[i].values[measure]
    if (value === null) continue
    values.push(value)
    labels.push(speech[i] === true)
    const level = audio[i]
    if (level !== null && level !== undefined) {
      pairsX.push(value)
      pairsY.push(level)
    }
  }
  return {
    auc: areaUnderCurve(values, labels),
    correlation: pearson(pairsX, pairsY),
    n: values.length,
    nAudio: pairsX.length,
  }
}

// ---------------------------------------------------------------------------

type Options = {
  showIds: string[]
  totalSec: number
  minShotSec: number
  maxWindowSec: number
  seed: number
  plan: boolean
  force: boolean
  json: string | null
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    showIds: [],
    totalSec: 600,
    minShotSec: 6,
    maxWindowSec: 20,
    seed: 20260820,
    plan: false,
    force: false,
    json: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = (): string => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} attend une valeur.`)
      i += 1
      return value
    }
    if (arg === '--seconds') options.totalSec = Number(next())
    else if (arg === '--min-shot') options.minShotSec = Number(next())
    else if (arg === '--max-window') options.maxWindowSec = Number(next())
    else if (arg === '--seed') options.seed = Number(next())
    else if (arg === '--plan') options.plan = true
    else if (arg === '--force') options.force = true
    else if (arg === '--json') options.json = next()
    else if (arg.startsWith('--')) throw new Error(`Option inconnue : ${arg}`)
    else options.showIds.push(arg)
  }
  if (options.showIds.length === 0) options.showIds = [...DEFAULT_SHOW_IDS]
  for (const [name, value] of [
    ['--seconds', options.totalSec],
    ['--min-shot', options.minShotSec],
    ['--max-window', options.maxWindowSec],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} doit être un nombre > 0.`)
  }
  if (!Number.isFinite(options.seed)) throw new Error('--seed doit être un nombre.')
  return options
}

/** L'interpréteur du venv de détection — même convention que `steps/analysis.ts`. */
function pythonDetection(): string {
  return process.env.DETECT_PYTHON || path.join(process.cwd(), 'worker', 'venv', 'bin', 'python')
}

/** Les poids YOLO de pose — même convention que `steps/analysis.ts`. */
function templateDetection(): string {
  return process.env.DETECT_MODEL || path.join(process.cwd(), 'worker', 'models', 'yolo11m-pose.pt')
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  await chargerEnv()

  // --- 1. Les plans éligibles, par émission ---------------------------------
  const analyses = new Map<string, Analysis>()
  const perShow = new Map<string, Draw[]>()
  console.log('=== Les plans à une personne ===\n')
  const eligibleRows: string[][] = []
  for (const showId of options.showIds) {
    const analysis = lireAnalysis(analysisPath(showId))
    analyses.set(showId, analysis)
    const shots = eligibleShots(analysis, showId, options.minShotSec)
    perShow.set(showId, shots)
    const total = shots.reduce((sum, s) => sum + (s.shotEnd - s.shotStart), 0)
    eligibleRows.push([showId, String(shots.length), seconds(total)])
  }
  console.log(table(['émission', 'plans', 'durée'], eligibleRows))

  // --- 2. Le tirage ---------------------------------------------------------
  const random = createRandom(options.seed)
  const { draws, allocations } = drawWindows(perShow, options.totalSec, options.maxWindowSec, random)
  console.log(
    `\n=== Le tirage (graine ${options.seed}, cible ${seconds(options.totalSec)}, ` +
      `fenêtre max ${seconds(options.maxWindowSec)}) ===\n`,
  )
  console.log(
    table(
      ['émission', 'plan', 'fenêtre (s source)', 'extrait', 'plan entier'],
      draws.map((d) => [
        d.showId,
        `#${d.shotIndex}`,
        `${d.start.toFixed(2)} -> ${d.end.toFixed(2)}`,
        seconds(d.end - d.start),
        seconds(d.shotEnd - d.shotStart),
      ]),
    ),
  )
  const perShowDrawn = new Map<string, number>()
  for (const d of draws) {
    perShowDrawn.set(d.showId, (perShowDrawn.get(d.showId) ?? 0) + (d.end - d.start))
  }
  console.log()
  console.log(
    table(
      ['émission', 'part visée', 'tiré', 'fenêtres'],
      options.showIds.map((id) => [
        id,
        seconds(allocations.get(id) ?? 0),
        seconds(perShowDrawn.get(id) ?? 0),
        String(draws.filter((d) => d.showId === id).length),
      ]),
    ),
  )
  const totalDrawn = draws.reduce((sum, d) => sum + (d.end - d.start), 0)
  console.log(
    `\n${draws.length} fenêtres, ${seconds(totalDrawn)} au total, ` +
      `soit ~${Math.round(totalDrawn * MOUTH_FPS)} images.`,
  )
  if (options.plan) {
    console.log("\n--plan : on s'arrête avant le GPU.")
    return
  }

  // --- 3. L'extraction ------------------------------------------------------
  console.log("\n=== L'extraction ===\n")
  await waitForGpu()
  const python = pythonDetection()
  const model = templateDetection()
  const extracted: { draw: Draw; file: string }[] = []
  const started = Date.now()
  for (const [i, draw] of draws.entries()) {
    const analysis = analyses.get(draw.showId)
    if (analysis === undefined) throw new Error(`Analyse manquante pour ${draw.showId}.`)
    const dir = path.join(projectDir(draw.showId), 'spike', 'speaker')
    fs.mkdirSync(dir, { recursive: true })
    const stem = path.join(dir, `${draw.start.toFixed(2)}-${draw.end.toFixed(2)}`)
    const npz = `${stem}.mouth.npz`
    const json = `${stem}.activity.json`
    const label =
      `[${i + 1}/${draws.length}] ${draw.showId} ` +
      `${draw.start.toFixed(2)} -> ${draw.end.toFixed(2)}`
    if (!options.force && fs.existsSync(json)) {
      console.log(`${label} — déjà là`)
      extracted.push({ draw, file: json })
      continue
    }
    process.stdout.write(`${label} … `)
    const t0 = Date.now()
    if (options.force || !fs.existsSync(npz)) {
      await run(
        python,
        [
          '-u',
          path.join('worker', 'spike_mouth.py'),
          '--proxy', proxyPath(draw.showId),
          '--audio', audioPath(draw.showId),
          '--start', String(draw.start),
          '--end', String(draw.end),
          '--out', npz,
          '--fps', String(MOUTH_FPS),
          '--model', model,
          '--ffmpeg', ffmpegBin(),
        ],
        'spike_mouth.py',
      )
    }
    await run(
      python,
      [
        '-u',
        path.join('worker', 'spike_activity.py'),
        '--npz', npz,
        '--out', json,
        '--proxy-size', `${analysis.proxy.w}x${analysis.proxy.h}`,
      ],
      'spike_activity.py',
    )
    console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s`)
    extracted.push({ draw, file: json })
  }
  console.log(`\nExtraction terminée en ${seconds((Date.now() - started) / 1000)}.`)

  // --- 4. La vérité et les échantillons -------------------------------------
  console.log('\n=== Les échantillons ===\n')
  const speeches = new Map<string, Speech>()
  const wavs = new Map<string, Wav>()
  const framesByShow = new Map<string, Map<number, PersonBox[]>>()
  for (const showId of options.showIds) {
    const analysis = analyses.get(showId)
    if (analysis === undefined) continue
    const placement = placeSidecar(`${showId}.mp4`, showId)
    if (!fs.existsSync(placement.transcript)) {
      throw new Error(`Transcript introuvable pour ${showId} : ${placement.transcript}`)
    }
    speeches.set(showId, readSpeech(placement.transcript))
    wavs.set(showId, openWav(audioPath(showId)))
    framesByShow.set(showId, personBoxesByFrame(analysis))
  }

  const samples: Sample[] = []
  /** `speech(t + décalage)` et l'enveloppe à `t + décalage`, indexés comme `samples`. */
  const shiftedSpeech = new Map<number, boolean[]>()
  const shiftedAudio = new Map<number, (number | null)[]>()
  for (const shift of ALL_SHIFTS_SEC) {
    shiftedSpeech.set(shift, [])
    shiftedAudio.set(shift, [])
  }
  // La courbe de décalage travaille en images à l'intérieur d'une fenêtre : les
  // couples se construisent extrait par extrait, jamais d'un extrait à l'autre.
  const lagPairs = new Map<number, { x: number[]; y: number[] }>()
  for (let d = -LAG_FRAMES; d <= LAG_FRAMES; d += 1) lagPairs.set(d, { x: [], y: [] })

  let framesTotal = 0
  let framesAmbiguous = 0
  let crossCheck = 0
  let timeDrift = 0
  for (const [windowIndex, { draw, file }] of extracted.entries()) {
    const activity = JSON.parse(fs.readFileSync(file, 'utf8')) as Activity
    const chosen = chosenRanks(activity)
    const speech = speeches.get(draw.showId)
    const wav = wavs.get(draw.showId)
    const byFrame = framesByShow.get(draw.showId)
    const analysis = analyses.get(draw.showId)
    if (speech === undefined || wav === undefined || byFrame === undefined || analysis === undefined) {
      throw new Error(`Matière manquante pour ${draw.showId}.`)
    }

    // Les instants, **reconstruits en float32 plutôt que relus du JSON**.
    //
    // `spike_mouth.py` range `t` en float32 ; vers 5000 s, ce type ne distingue
    // plus que des pas de 0,5 ms, et `spike_activity.py` a rééchantillonné
    // l'enveloppe sur ces valeurs-là. Relire le JSON (arrondi à quatre
    // décimales par-dessus) suffit à faire basculer une borne de fenêtre audio
    // sur environ une image sur dix, et la vérification croisée ci-dessous
    // affichait alors un écart de 2e-2 — sur des valeurs qui plafonnent à 0,3,
    // c'est-à-dire un désaccord réel entre les deux chemins, pas du bruit.
    // `Math.fround` reproduit exactement la troncature de numpy, donc les deux
    // enveloppes redeviennent comparables et la vérification dit ce qu'elle
    // prétend dire.
    const times = Array.from({ length: activity.frames }, (unused, f) =>
      Math.fround(draw.start + f / MOUTH_FPS),
    )
    for (const [f, written] of activity.t.entries()) {
      if (written === null || f >= times.length) continue
      timeDrift = Math.max(timeDrift, Math.abs(times[f] - written))
    }
    const relatives = times.map((t) => t - draw.start)
    const audioByShift = new Map<number, (number | null)[]>()
    for (const shift of ALL_SHIFTS_SEC) {
      const envelope = envelopeOf(wav, draw.start + shift, draw.end + shift)
      audioByShift.set(
        shift,
        envelope === null ? times.map(() => null) : resampleEnvelope(envelope, relatives),
      )
    }
    // La vérification croisée annoncée dans le commentaire d'`openWav`.
    const reference = audioByShift.get(0) ?? []
    for (const [f, value] of reference.entries()) {
      const written = activity.audioEnv[f]
      if (value === null || written === null || written === undefined) continue
      crossCheck = Math.max(crossCheck, Math.abs(value - written))
    }

    for (let f = 0; f < activity.frames; f += 1) {
      framesTotal += 1
      const rank = chosen[f]
      if (rank === null || rank === undefined) {
        framesAmbiguous += 1
        continue
      }
      // Une mesure compare deux images : le rang doit désigner la même personne
      // aux deux, sinon la différence compare deux visages.
      if (f === 0 || chosen[f - 1] !== rank) continue
      const person = activity.person[rank]
      if (person === undefined) continue
      const values: Record<Measure, number | null> = {
        rawDiff: person.rawDiff[f] ?? null,
        normDiff: person.normDiff[f] ?? null,
        centerDiff: person.centerDiff[f] ?? null,
        noseShift: person.noseShift[f] ?? null,
      }
      if (MEASURES.every((m) => values[m] === null)) continue
      const box = person.box[f]
      const t = times[f]
      const orientation =
        box === null || box === undefined
          ? { facing: 'unknown' as Facing, frontality: null }
          : facingAt(byFrame, analysis.fps, t, (box.x0 + box.x1) / 2)
      samples.push({
        showId: draw.showId,
        window: windowIndex,
        t,
        audio: activity.audioEnv[f] ?? null,
        facing: orientation.facing,
        frontality: orientation.frontality,
        values,
      })
      for (const shift of ALL_SHIFTS_SEC) {
        shiftedSpeech.get(shift)?.push(speaks(speech, t + shift))
        shiftedAudio.get(shift)?.push(audioByShift.get(shift)?.[f] ?? null)
      }
      // La courbe de décalage, à l'intérieur de cette fenêtre.
      const lagValue = values[LAG_MEASURE]
      if (lagValue === null) continue
      for (let d = -LAG_FRAMES; d <= LAG_FRAMES; d += 1) {
        const level = activity.audioEnv[f + d]
        if (level === null || level === undefined) continue
        const pair = lagPairs.get(d)
        if (pair === undefined) continue
        pair.x.push(lagValue)
        pair.y.push(level)
      }
    }
  }
  for (const wav of wavs.values()) fs.closeSync(wav.fd)

  const truthSpeech = shiftedSpeech.get(0) ?? []
  const jsonAudio = samples.map((s) => s.audio)
  const all = samples.map((unused, i) => i)
  const frontal = all.filter((i) => samples[i].facing === 'frontal')
  const profile = all.filter((i) => samples[i].facing === 'profile')
  const unknownFacing = all.filter((i) => samples[i].facing === 'unknown')
  const speaking = all.filter((i) => truthSpeech[i])

  console.log(
    table(
      ['grandeur', 'valeur'],
      [
        ['images décodées', String(framesTotal)],
        ['images mesurables (une personne identifiée)', `${samples.length} (${percent(samples.length, framesTotal)})`],
        ['images écartées pour ambiguïté', `${framesAmbiguous} (${percent(framesAmbiguous, framesTotal)})`],
        ["dont personne à l'écran ET parole", `${speaking.length} (${percent(speaking.length, samples.length)})`],
        ['de face (orientationOf)', `${frontal.length} (${percent(frontal.length, samples.length)})`],
        ['de profil', `${profile.length} (${percent(profile.length, samples.length)})`],
        ['orientation inconnue', `${unknownFacing.length} (${percent(unknownFacing.length, samples.length)})`],
        ['écart max enveloppe TS vs Python', crossCheck.toExponential(2)],
        ['écart max instants reconstruits vs JSON', timeDrift.toExponential(2)],
      ],
    ),
  )
  for (const showId of options.showIds) {
    const speech = speeches.get(showId)
    if (speech !== undefined && speech.timeless > 0) {
      console.log(`   ${showId} : ${speech.timeless} mots sans instants sur ${speech.words}, ignorés.`)
    }
  }

  // --- 5. C1 ----------------------------------------------------------------
  console.log('\n=== C1 — AUC (parole) et corrélation (enveloppe audio) ===\n')
  const c1Rows: string[][] = []
  for (const measure of MEASURES) {
    for (const showId of options.showIds) {
      const indices = all.filter((i) => samples[i].showId === showId)
      const row = measureRow(samples, indices, measure, truthSpeech, jsonAudio)
      c1Rows.push([measure, showId, String(row.n), number(row.auc), number(row.correlation)])
    }
    const row = measureRow(samples, all, measure, truthSpeech, jsonAudio)
    c1Rows.push([measure, 'CORPUS', String(row.n), number(row.auc), number(row.correlation)])
  }
  console.log(table(['mesure', 'émission', 'n', 'AUC', 'Pearson'], c1Rows))

  // --- 5 bis. Le même calcul fenêtre par fenêtre ----------------------------
  //
  // **Un chiffre poolé sur quarante-huit extraits peut mentir dans les deux
  // sens, et il faut le vérifier plutôt que le supposer.** Les quatre mesures
  // n'ont pas la même échelle d'un plan à l'autre — l'éclairage du plateau
  // change entre les jeux, la personne est plus ou moins loin, donc son patch
  // plus ou moins contrasté. Mettre bout à bout les valeurs de quarante-huit
  // fenêtres peut *fabriquer* une corrélation (deux fenêtres où tout est haut
  // face à deux fenêtres où tout est bas) comme en *masquer* une (un lien net
  // à l'intérieur de chaque fenêtre, noyé par les écarts entre fenêtres).
  // La médiane des chiffres par fenêtre ne souffre ni de l'un ni de l'autre :
  // chaque fenêtre y est comparée à elle-même.
  const windowRows: string[][] = []
  for (const measure of MEASURES) {
    const aucs: number[] = []
    const correlations: number[] = []
    for (let w = 0; w < extracted.length; w += 1) {
      const indices = all.filter((i) => samples[i].window === w)
      const row = measureRow(samples, indices, measure, truthSpeech, jsonAudio)
      if (row.n >= MIN_WINDOW_SAMPLES && row.auc !== null) aucs.push(row.auc)
      if (row.nAudio >= MIN_WINDOW_SAMPLES && row.correlation !== null) {
        correlations.push(row.correlation)
      }
    }
    windowRows.push([
      measure,
      String(aucs.length),
      number(median(aucs)),
      `${number(Math.min(...aucs))} … ${number(Math.max(...aucs))}`,
      number(median(correlations)),
    ])
  }
  console.log('\n=== C1 bis — le même calcul fenêtre par fenêtre, puis médiane ===\n')
  console.log(
    table(['mesure', 'fenêtres', 'AUC médiane', 'AUC min … max', 'Pearson médian'], windowRows),
  )

  // --- 6. C2 ----------------------------------------------------------------
  console.log('\n=== C2 — le contrôle négatif : la vérité décalée ===\n')
  const c2Rows: string[][] = []
  for (const measure of MEASURES) {
    for (const shift of ALL_SHIFTS_SEC) {
      const row = measureRow(
        samples,
        all,
        measure,
        shiftedSpeech.get(shift) ?? [],
        shiftedAudio.get(shift) ?? [],
      )
      c2Rows.push([
        measure,
        shift === 0 ? 'aucun (référence)' : `${shift > 0 ? '+' : ''}${shift} s`,
        String(row.n),
        String(row.nAudio),
        number(row.auc),
        number(row.correlation),
      ])
    }
  }
  console.log(table(['mesure', 'décalage', 'n', 'n audio', 'AUC', 'Pearson'], c2Rows))
  console.log(
    "\nL'audio des quatre lignes est relu du WAV, y compris celle de référence : un écart entre\n" +
      "elles ne peut donc pas venir d'un changement de source.",
  )

  // --- 7. La courbe de décalage --------------------------------------------
  console.log(`\n=== La recherche de décalage (${LAG_MEASURE} contre l'enveloppe audio) ===\n`)
  const lagRows: string[][] = []
  let bestLag: { d: number; r: number } | null = null
  for (let d = -LAG_FRAMES; d <= LAG_FRAMES; d += 1) {
    const pair = lagPairs.get(d) ?? { x: [], y: [] }
    const r = pearson(pair.x, pair.y)
    lagRows.push([
      `${d > 0 ? '+' : ''}${d}`,
      `${((1000 * d) / MOUTH_FPS).toFixed(0)} ms`,
      String(pair.x.length),
      number(r, 4),
    ])
    if (r !== null && (bestLag === null || r > bestLag.r)) bestLag = { d, r }
  }
  console.log(table(['décalage (images)', 'soit', 'n', 'Pearson'], lagRows))
  if (bestLag !== null) {
    console.log(
      `\nMaximum à ${bestLag.d > 0 ? '+' : ''}${bestLag.d} image(s) ` +
        `(${((1000 * bestLag.d) / MOUTH_FPS).toFixed(0)} ms), r = ${number(bestLag.r, 4)}. ` +
        'Un décalage positif veut dire que la bouche précède le son.',
    )
  }

  // --- 8. Les visages de face ----------------------------------------------
  console.log("\n=== L'AUC restreinte à l'orientation ===\n")
  //
  // **`facing` seul ne discrimine presque rien sur ce corpus**, et il faut le
  // dire plutôt que de publier une colonne vide de sens : `ORIENTATION_DEFAULTS`
  // pose `frontalThreshold` à 0,35, valeur que sa propre documentation annonce
  // comme « de départ, à mesurer », et 97,7 % des images retenues tombent du
  // côté `'frontal'`. La quatrième colonne est donc la restriction qui a une
  // chance de dire quelque chose : le quart des images dont la `frontality` est
  // la plus haute, seuil lu sur les données plutôt que posé d'avance.
  const ranked = all
    .map((i) => samples[i].frontality)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b)
  const frontalityP75 =
    ranked.length > 0 ? ranked[Math.min(Math.floor(0.75 * ranked.length), ranked.length - 1)] : null
  const mostFrontal =
    frontalityP75 === null
      ? []
      : all.filter((i) => {
          const value = samples[i].frontality
          return value !== null && value >= frontalityP75
        })
  const facingRows: string[][] = []
  for (const measure of MEASURES) {
    const general = measureRow(samples, all, measure, truthSpeech, jsonAudio)
    const front = measureRow(samples, frontal, measure, truthSpeech, jsonAudio)
    const side = measureRow(samples, profile, measure, truthSpeech, jsonAudio)
    const most = measureRow(samples, mostFrontal, measure, truthSpeech, jsonAudio)
    facingRows.push([
      measure,
      `${number(general.auc)} (n=${general.n})`,
      `${number(front.auc)} (n=${front.n})`,
      `${number(side.auc)} (n=${side.n})`,
      `${number(most.auc)} (n=${most.n})`,
    ])
  }
  console.log(
    table(
      ['mesure', 'toutes images', 'de face', 'de profil', 'quart le plus de face'],
      facingRows,
    ),
  )

  // --- 8 bis. Le diagnostic : et si la tête bougeait moins ? -----------------
  //
  // **Ce n'est pas un correctif, c'est une question posée aux chiffres.** Le
  // patch de bouche est accroché à la tête : quand la tête bouge, tout son
  // contenu défile, et cette translation domine le mouvement propre des lèvres.
  // Si les mesures de bouche remontent nettement sur le tiers d'images où la
  // tête est la plus immobile, alors le signal existe et il est simplement
  // enseveli — ce qui désigne le prochain chantier (compenser le mouvement de
  // tête avant de mesurer). Si elles ne remontent pas, l'ensevelissement n'est
  // pas l'explication.
  const stillness = all
    .map((i) => samples[i].values.noseShift)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b)
  const stillThreshold = stillness.length > 0 ? stillness[Math.floor(stillness.length / 3)] : null
  const still =
    stillThreshold === null
      ? []
      : all.filter((i) => {
          const shift = samples[i].values.noseShift
          return shift !== null && shift <= stillThreshold
        })
  console.log(
    `\n=== Diagnostic : le tiers d'images ou la tete bouge le moins ` +
      `(noseShift <= ${number(stillThreshold, 3)} px) ===\n`,
  )
  const stillRows = MEASURES.map((measure) => {
    const general = measureRow(samples, all, measure, truthSpeech, jsonAudio)
    const quiet = measureRow(samples, still, measure, truthSpeech, jsonAudio)
    return [
      measure,
      `${number(general.auc)} (n=${general.n})`,
      `${number(quiet.auc)} (n=${quiet.n})`,
      number(general.correlation),
      number(quiet.correlation),
    ]
  })
  console.log(
    table(
      ['mesure', 'AUC toutes', 'AUC tete immobile', 'Pearson toutes', 'Pearson tete immobile'],
      stillRows,
    ),
  )

  // --- 9. Le JSON ----------------------------------------------------------
  if (options.json !== null) {
    const payload = {
      seed: options.seed,
      draws,
      frames: { decoded: framesTotal, usable: samples.length, ambiguous: framesAmbiguous },
      speechRate: speaking.length / Math.max(samples.length, 1),
      crossCheck,
      c1: c1Rows,
      c1PerWindow: windowRows,
      c2: c2Rows,
      lag: lagRows,
      facing: facingRows,
      stillHead: stillRows,
    }
    const target = path.resolve(options.json)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(payload, null, 2))
    console.log(`\nÉcrit ${target}.`)
  }
}

main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause))
  quit(1)
})
