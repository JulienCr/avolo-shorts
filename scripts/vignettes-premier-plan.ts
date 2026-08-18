/**
 * Les boîtes dessinées sur le proxy : **vert** ce que le cadrage garde, **rouge**
 * ce que le filtre du premier plan écarte, **gris** ce que le seuil de confiance
 * écarte avant lui — le détecteur écrit dès 0,25 et le cadrage ne lit qu'à partir
 * de 0,5.
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
 * - `--large N` prend les N moments les plus larges *après* filtrage, **un par
 *   plan au plus** : les images les plus larges d'une émission sont contiguës, et
 *   les six premières du classement montrent six fois la même seconde. Elles
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

import { FRAMING_DEFAULTS, isForeground, requiredWidths } from '@/core/framing'
import { shotStartMs } from '@/core/shots'
import type { PersonBox, Shot } from '@/core/shots'
import { analysisPath, proxyPath } from '@/server/paths'
import { lireAnalyse } from '@/server/steps/analysis'
import { chargerEnv, quitter } from './dev-commun'

/**
 * La demi-largeur de la bande « au voisinage du seuil », en fraction de hauteur.
 *
 * 0,08 de chaque côté de 0,35 couvre tout le creux mesuré (0,32 à 0,40) et
 * mord sur les deux modes qui l'encadrent : le tirage montre donc des cas que le
 * filtre tranche dans les deux sens, ce qui est le seul intérêt de l'exercice.
 */
const VOISINAGE = 0.08

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
 * Le sort d'une boîte dans le cadrage, en trois états et pas deux.
 *
 * **Le détecteur écrit dès 0,25 de confiance** (`worker/detect.py`, `--conf`),
 * et `empans` jette tout ce qui est sous `minScore`, à 0,5, *avant* de regarder
 * la forme. Une vignette à deux couleurs peignait donc en vert des boîtes qui ne
 * participent à aucun cadrage, c'est-à-dire qu'elle mentait exactement sur ce
 * qu'elle est là pour montrer. (relevé par Codex et Copilot)
 */
type Sort = 'gardée' | 'premier-plan' | 'sous-le-seuil'

function sort(b: PersonBox): Sort {
  // `!(score >= seuil)` et non `score < seuil`, comme dans `empans` : un score
  // `NaN` doit tomber du côté écarté.
  if (!(b.score >= FRAMING_DEFAULTS.minScore)) return 'sous-le-seuil'
  return isForeground(b) ? 'premier-plan' : 'gardée'
}

/** Vert ce que le cadrage garde, rouge ce que le filtre écarte, gris ce qu'il ne voit pas. */
const COULEURS: Readonly<Record<Sort, string>> = {
  gardée: 'lime',
  'premier-plan': 'red',
  'sous-le-seuil': 'gray',
}

/**
 * Une vignette. Le rectangle est tracé par `drawbox`, en pixels du proxy.
 *
 * L'épaisseur est de 2 px : à 1 px, un trait rouge sur une tête sombre au bas
 * d'une image sombre ne se voit pas, et c'est exactement l'endroit qu'on regarde.
 */
function vignette(proxy: string, t: number, boîtes: PersonBox[], W: number, H: number, out: string): void {
  const filtres = boîtes.map((b) => {
    const couleur = COULEURS[sort(b)]
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

/**
 * L'empan d'une image, tel que le cadrage le voit.
 *
 * Passe par `requiredWidths` plutôt que de refaire le calcul : le seuil de
 * confiance, la marge et le filtre y sont déjà, et une seconde copie de ces trois
 * réglages finirait par diverger de celle qui décide vraiment. Rend `null` quand
 * l'image ne garde aucune boîte — elle ne dit pas que le cadre peut être serré,
 * elle ne dit rien.
 */
function empanFiltré(boîtes: PersonBox[]): number | null {
  return requiredWidths(boîtes)[0] ?? null
}

/**
 * La médiane, au sens strict : sur un nombre pair de valeurs, le milieu des deux
 * centrales. La même que `src/core/framing.ts` et que l'autre script — un
 * diagnostic qui explique une mesure doit calculer comme elle. (relevé par Copilot)
 */
function médiane(valeurs: number[]): number | null {
  if (valeurs.length === 0) return null
  const triées = [...valeurs].sort((a, b) => a - b)
  const m = triées.length >> 1
  return triées.length % 2 === 1 ? triées[m] : (triées[m - 1] + triées[m]) / 2
}

/**
 * N valeurs réparties régulièrement dans une liste, extrémités comprises.
 *
 * **Le cas `n === 1` a son embranchement**, et pas par prudence : `(len - 1) / 0`
 * vaut `Infinity`, `0 * Infinity` vaut `NaN`, et `liste[NaN]` rend `undefined`.
 * Le tableau avait alors la bonne longueur et le mauvais contenu, ce qu'aucun
 * type ne dit — `T[]` promet des `T`. `--frontiere 1` plantait plus loin, sur un
 * `toFixed` d'`undefined`, à un endroit qui ne nommait pas la cause.
 * (relevé par Codex et Copilot)
 */
function étalé<T>(liste: T[], n: number): T[] {
  if (n <= 0 || liste.length === 0) return []
  if (liste.length <= n) return liste
  if (n === 1) return [liste[0]]
  const pas = (liste.length - 1) / (n - 1)
  return Array.from({ length: n }, (_, i) => liste[Math.round(i * pas)])
}

/**
 * Les N moments les plus larges, **un par plan au plus**.
 *
 * Prendre la tête du classement tout court ne marche pas : les images les plus
 * larges d'une émission sont contiguës — sur `2025-06-15-cqlp`, les dix premières
 * tiennent en quatre secondes du même plan et montrent dix fois la même chose. Un
 * plan par entrée est la bonne granularité parce que **le crop est fixe à
 * l'intérieur d'un plan** : deux images du même plan ont le même cadrage à
 * expliquer. (relevé par Codex et Copilot)
 */
function lesPlusLarges(
  classées: { t: number; empan: number }[],
  shots: Shot[],
  n: number,
): { t: number; empan: number }[] {
  const vus = new Set<number>()
  const out: { t: number; empan: number }[] = []
  for (const e of classées) {
    if (out.length >= n) break
    const plan = shots.find((p) => e.t >= p.start && e.t < p.end)
    // Une image qui ne tombe dans aucun plan garde sa propre clé : elle ne peut
    // faire doublon avec personne, et l'écarter cacherait un trou dans les plans.
    const clé = plan === undefined ? -Math.round(e.t * 1000) - 1 : shotStartMs(plan)
    if (vus.has(clé)) continue
    vus.add(clé)
    out.push(e)
  }
  return out
}

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  // Un compte illisible est **refusé**, pas remplacé par le défaut : `--large 0`
  // qui produit six vignettes est le genre de silence qui fait chercher le défaut
  // ailleurs. Même doctrine que `--scene-threshold` du détecteur, qui refuse une
  // valeur sous son plancher au lieu de l'ignorer.
  const mauvaisCompte: string[] = []
  const nombreAprès = (drapeau: string, défaut: number): number | null => {
    const i = arguments_.indexOf(drapeau)
    if (i < 0) return null
    const brut = arguments_[i + 1]
    // Rien derrière le drapeau, ou le positionnel suivant : c'est le défaut.
    if (brut === undefined || brut.startsWith('--')) return défaut
    const v = Number(brut)
    if (!Number.isInteger(v) || v <= 0) {
      mauvaisCompte.push(`${drapeau} ${brut}`)
      return défaut
    }
    return v
  }
  const iOut = arguments_.indexOf('--out')
  // Résolu tard : créer le dossier temporaire avant le contrôle d'usage laisserait
  // un dossier vide derrière chaque appel mal formé.
  const demandé = iOut >= 0 ? arguments_[iOut + 1] : undefined
  // `--out` exige un chemin. En fin de ligne il retombait sur le dossier
  // temporaire sans le dire, et `--out --large 6` créait un dossier nommé
  // `--large`. (relevé par Copilot)
  const outSansChemin = iOut >= 0 && (demandé === undefined || demandé.startsWith('--'))

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

  if (outSansChemin) {
    console.error('--out attend un chemin de dossier.')
    return 1
  }

  // Les deux comptes se lisent avant tout travail : refuser après avoir imprimé
  // « 272 images au voisinage du seuil » ferait croire que le tirage a eu lieu.
  const nFrontière = nombreAprès('--frontiere', 6)
  const nLarge = nombreAprès('--large', 6)
  if (mauvaisCompte.length > 0) {
    console.error(
      `Compte de vignettes invalide : ${mauvaisCompte.join(', ')}. Attendu un entier ≥ 1.`,
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

  if (nFrontière !== null) {
    // Les images qui portent une boîte dont la hauteur est près du seuil : ni
    // franchement du public, ni franchement un comédien. Les seuils viennent du
    // module, pas d'une copie — sinon le tirage viserait l'ancien seuil le jour
    // où celui qui décide bouge.
    // Le seuil de confiance d'abord : une boîte que `empans` ne lit jamais ne peut
    // pas faire hésiter le filtre, et dépenser une vignette dessus est une
    // vignette perdue sur une frontière que la production n'évalue pas.
    const hésite = (b: PersonBox): boolean =>
      b.score >= FRAMING_DEFAULTS.minScore &&
      b.y1 >= FRAMING_DEFAULTS.bottomEdge &&
      Math.abs(b.y1 - b.y0 - FRAMING_DEFAULTS.foregroundMaxHeight) <= VOISINAGE
    const près = [...images.entries()]
      .filter(([, bs]) => bs.some(hésite))
      .map(([clé]) => clé / 1000)
      .sort((a, b) => a - b)
    console.log(`${près.length} images au voisinage du seuil de hauteur`)
    instants.push(...étalé(près, nFrontière))
  }

  if (nLarge !== null) {
    const larges = [...images.entries()]
      .map(([clé, bs]) => ({ t: clé / 1000, empan: empanFiltré(bs) }))
      .filter((e): e is { t: number; empan: number } => e.empan !== null)
      .sort((a, b) => b.empan - a.empan)
    console.log(
      `empan résiduel : max ${larges[0]?.empan.toFixed(2) ?? '—'}, ` +
        `médian ${médiane(larges.map((e) => e.empan))?.toFixed(2) ?? '—'}`,
    )
    instants.push(...lesPlusLarges(larges, analyse.shots, nLarge).map((e) => e.t))
  }

  if (instants.length === 0) {
    console.error('Aucun instant demandé. Donne des secondes, ou --frontiere / --large.')
    return 1
  }

  const dossier = demandé ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vignettes-premier-plan-'))
  fs.mkdirSync(dossier, { recursive: true })
  let échecs = 0
  for (const t of [...new Set(instants)].sort((a, b) => a - b)) {
    const boîtes = images.get(Math.round(t * 1000)) ?? []
    // La milliseconde, pas le dixième : les instants se donnent à la main et les
    // clés de détection sont au millième. `419.01` et `419.04` écrivaient le même
    // fichier, et la seconde vignette écrasait la première sans rien dire.
    // (relevé par Copilot)
    const fichier = path.join(dossier, `t${t.toFixed(3).replace('.', '_')}.png`)
    // Une extraction ratée — un instant au-delà de la fin du proxy, un fichier
    // tronqué — ne doit pas emporter les vignettes suivantes : c'est un outil de
    // mesure, et perdre neuf images sur dix pour une seule serait une punition
    // absurde.
    try {
      vignette(proxy, t, boîtes, W, H, fichier)
    } catch (e) {
      échecs += 1
      console.error(`${t.toFixed(3)} s : ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    const compte = (état: Sort): number => boîtes.filter((b) => sort(b) === état).length
    console.log(
      `${fichier}  ${t.toFixed(3)} s — ${compte('gardée')} gardée(s) vert, ` +
        `${compte('premier-plan')} écartée(s) rouge, ${compte('sous-le-seuil')} hors seuil gris`,
    )
  }
  return échecs > 0 ? 1 : 0
}

void main().then(quitter, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quitter(1)
})
