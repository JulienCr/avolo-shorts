/**
 * Le ratio que le cadrage automatique choisit, clip par clip, sur plusieurs
 * émissions — et ce que la marge lui coûte.
 *
 *     pnpm tsx scripts/mesure-ratios.ts 2025-06-15-cqlp 2026-03-08-caro-mdlm
 *
 * **La question à laquelle ce script répond.** Sur `2025-06-15-cqlp`, les dix
 * clips réels sortent tous en 16:9, avant comme après le filtre du public au
 * premier plan. Deux explications coexistaient : ou bien cette émission est le
 * pire cas connu — elle porte un panneau de chat Twitch sur 20 % de la largeur et
 * elle est la seule des vingt dans ce cas —, ou bien **le ratio par clip est
 * large partout**, auquel cas l'itération 1 construirait un crop par plan qui ne
 * se déclenche jamais. Départager demande la répartition des ratios sur une
 * émission sans chat incrusté, et personne ne l'avait mesurée.
 *
 * `scripts/mesure-premier-plan.ts` répond à une autre question — *ce que le
 * filtre écarte* — et compare pour ça trois réglages du filtre sur une seule
 * émission. Celui-ci laisse le filtre à son défaut et compare des **émissions**,
 * puis des **marges**. Les deux se recoupent sur une ligne, la répartition des
 * ratios, et c'est voulu : elle est le point de contrôle commun.
 *
 * Trois sorties :
 *
 * 1. **Le ratio par clip**, avec l'empan résiduel qui l'explique. Les clips sont
 *    ceux du projet, ceux que le repérage a retenus.
 * 2. **La répartition comparée**, clips et fenêtres régulières. Dix clips ne font
 *    pas une distribution ; les fenêtres disent ce qu'un clip quelconque
 *    deviendrait.
 * 3. **Le balayage de la marge.** `FramingOptions.margin` valait 2 % sans avoir
 *    jamais été mesuré : un réglage de confort, posé parce qu'un crop pile sur la
 *    boîte du détecteur met un coude au bord. Elle coûte deux fois sa valeur en
 *    empan — une fois de chaque côté — et arbitre plusieurs clips autour du seuil
 *    du 1:1. C'est ce balayage qui l'a fait tomber à 1 %.
 *
 * Et `--instants N` imprime, par clip, les N images qui **font monter le ratio** :
 * les plus larges après filtrage, une par plan au plus, parce que le crop est
 * fixe à l'intérieur d'un plan et que deux images du même plan ont le même
 * cadrage à expliquer. La ligne à passer à `vignettes-premier-plan.ts` est
 * imprimée avec — un chiffre ne dit pas si les comédiens sont *vraiment* aux deux
 * bords, et sur ce sujet le dépôt s'est déjà trompé une fois en ne regardant que
 * des histogrammes.
 *
 * Rien n'échoue ici : le script imprime des chiffres, et c'est en les lisant
 * qu'on décide.
 */

import fs from 'node:fs'

import {
  FRAMING_DEFAULTS,
  RATIOS,
  computeFraming,
  isForeground,
  ratioCoverage,
  requiredWidths,
} from '@/core/framing'
import type { FramingOptions } from '@/core/framing'
import { normalizeSegments } from '@/core/edl'
import type { Ratio, Segment } from '@/core/edl'
import type { PersonBox } from '@/core/shots'
import { closeDb, getClips, getDb } from '@/server/db'
import { analysisPath } from '@/server/paths'
import { lireAnalyse, type Analyse } from '@/server/steps/analysis'
import { chargerEnv, quitter } from './dev-commun'

/** Les quatre ratios du plus étroit au plus large, déduits de `RATIOS`. */
const DU_PLUS_ÉTROIT_AU_PLUS_LARGE = (Object.keys(RATIOS) as Ratio[]).sort(
  (a, b) => RATIOS[a] - RATIOS[b],
)

/**
 * Les marges balayées : les quatre valeurs de la campagne, **plus le défaut en
 * vigueur**.
 *
 * Le défaut y est par `FRAMING_DEFAULTS.margin` et non recopié — sans quoi le
 * jour où il bouge, le balayage continuerait de viser l'ancienne valeur sans
 * rien signaler. Et les quatre valeurs restent écrites en clair *à côté* de lui,
 * parce que la campagne les compare : les fondre dans le défaut a fait
 * disparaître 0,02 de la sortie à la seconde où il a cessé d'être le défaut,
 * c'est-à-dire à la seconde où la comparaison devenait intéressante.
 */
const MARGES = [...new Set([0, 0.01, 0.02, 0.03, FRAMING_DEFAULTS.margin])].sort((a, b) => a - b)

/** Une découpe à cadrer : un nom et des segments. */
type Découpe = { nom: string; segments: Segment[] }

function médiane(valeurs: number[]): number {
  if (valeurs.length === 0) return Number.NaN
  const triées = [...valeurs].sort((a, b) => a - b)
  const m = triées.length >> 1
  return triées.length % 2 === 1 ? triées[m] : (triées[m - 1] + triées[m]) / 2
}

/**
 * Le percentile `p` (0 à 1), par le rang le plus proche.
 *
 * `p90` est la grandeur qui parle ici, puisque le ratio se choisit sur « 90 % des
 * images tiennent ». **Mais elle ne décide pas** : elle porte sur des largeurs
 * par image, donc elle suppose un crop libre par image, alors que le crop est
 * fixe pour tout le plan. C'est une **borne optimiste** — le ratio réel est ce
 * qu'elle indique ou plus large, jamais plus serré. La spec §10 le dit d'un
 * autre côté : un sujet étroit à gauche puis à droite tient partout image par
 * image et nulle part avec une position fixe.
 */
function percentile(valeurs: number[], p: number): number {
  if (valeurs.length === 0) return Number.NaN
  const triées = [...valeurs].sort((a, b) => a - b)
  const i = Math.min(triées.length - 1, Math.max(0, Math.ceil(p * triées.length) - 1))
  return triées[i]
}

function nombre(n: number, décimales = 3): string {
  return Number.isFinite(n) ? n.toFixed(décimales) : '—'
}

/** Le ratio d'une découpe, avec le filtre du premier plan à son défaut. */
function ratioDe(découpe: Découpe, analyse: Analyse, options: FramingOptions): Ratio {
  return computeFraming({
    ...options,
    segments: découpe.segments,
    shots: analyse.shots,
    people: analyse.boxes,
    srcW: analyse.source.w,
    srcH: analyse.source.h,
    ratio: 'auto',
    cropMode: 'auto',
  }).ratio
}

/**
 * Les empans des images d'une découpe, marge et filtre compris.
 *
 * Les boîtes sont restreintes aux segments montés — c'est ce que `computeFraming`
 * fait, et mesurer sur l'émission entière décrirait un autre clip que celui dont
 * on lit le ratio deux colonnes plus loin. **Fin exclue**, comme `computeFraming`.
 */
function empansDe(découpe: Découpe, analyse: Analyse, options: FramingOptions): number[] {
  const segments = normalizeSegments(découpe.segments)
  const dedans = analyse.boxes.filter((b) =>
    segments.some((s) => b.t >= s.start && b.t < s.end),
  )
  return requiredWidths(dedans, options)
}

/** La répartition des ratios d'une liste de découpes, comptée par ratio. */
function répartition(ratios: Ratio[]): Map<Ratio, number> {
  const compte = new Map<Ratio, number>(DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map((r) => [r, 0]))
  for (const r of ratios) compte.set(r, (compte.get(r) ?? 0) + 1)
  return compte
}

function ligneRépartition(compte: Map<Ratio, number>): string {
  return DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map(
    (r) => `${r} ${String(compte.get(r) ?? 0).padStart(3)}`,
  ).join(' | ')
}

/**
 * Des fenêtres régulières qui couvrent l'émission.
 *
 * Les clips retenus par le repérage ne sont pas un échantillon de l'émission :
 * ce sont ses moments drôles, et ils sont dix. Les fenêtres disent ce qu'un clip
 * quelconque deviendrait, et c'est ce qui rend deux émissions comparables malgré
 * des repérages différents.
 */
function fenêtres(durée: number, longueur: number, pas: number): Découpe[] {
  const out: Découpe[] = []
  for (let t = 0; t + longueur <= durée; t += pas) {
    out.push({ nom: `${t.toFixed(0)}s`, segments: [{ start: t, end: t + longueur }] })
  }
  return out
}

// ---------------------------------------------------------------------------

/** Ce qu'on charge d'un projet avant de mesurer quoi que ce soit. */
type Émission = { id: string; analyse: Analyse; clips: Découpe[]; fenêtres: Découpe[] }

function charger(id: string): Émission | null {
  const fichier = analysisPath(id)
  if (!fs.existsSync(fichier)) {
    console.error(`${id} : pas d'analyse (${fichier}). Lancer : pnpm tsx scripts/dev-run.ts ${id} analysis`)
    return null
  }
  const analyse = lireAnalyse(fichier)
  const db = getDb()
  // **Les écartés ne comptent pas.** Un clip mis au rebut ne sera jamais rendu,
  // donc son ratio ne dit rien de ce que le produit sortira ; l'inclure gonflerait
  // la seule colonne qui décide de la suite de l'itération.
  //
  // **Les vestiges de vérification, si**, et c'est délibéré : la base de `cqlp`
  // porte deux `clip_verif_*` non écartés (`ROADMAP.md`, « Vestiges à nettoyer »),
  // donc ce script en compte dix là où l'émission en a huit de vrais. Les filtrer
  // par leur nom mettrait une convention de nommage dans un script de mesure, où
  // elle se périmerait sans bruit ; ils sont nommés dans la sortie ligne par
  // ligne, et c'est au lecteur — et à `docs/ratios-par-clip.md` — de les écarter.
  // (relevé par Copilot)
  const clips = getClips(db, id)
    .filter((c) => c.status !== 'discarded')
    .map((c) => ({ nom: c.id, segments: c.segments }))
  const durée = analyse.shots.at(-1)?.end ?? 0
  return { id, analyse, clips, fenêtres: fenêtres(durée, 30, 30) }
}

// ---------------------------------------------------------------------------
// 1. Le ratio par clip
// ---------------------------------------------------------------------------

function parClip(émission: Émission): void {
  const { w, h } = émission.analyse.source
  const durée = émission.analyse.shots.at(-1)?.end ?? 0
  console.log(
    `\n=== ${émission.id} — ${émission.clips.length} clips, ${(durée / 60).toFixed(0)} min, ` +
      `${émission.analyse.boxes.length} boîtes ===`,
  )
  console.log(
    `Seuils de couverture : ` +
      DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map((r) => `${r} ${nombre(ratioCoverage(r, w, h))}`).join('  '),
  )
  if (émission.clips.length === 0) {
    console.log('  (aucun clip — le repérage n’a pas tourné sur ce projet)')
    return
  }

  console.log('\n  clip                                  ratio   empan méd.  empan p90  images  durée')
  for (const clip of émission.clips) {
    const empans = empansDe(clip, émission.analyse, {})
    const durée = normalizeSegments(clip.segments).reduce((n, s) => n + (s.end - s.start), 0)
    console.log(
      `  ${clip.nom.padEnd(36)}  ${ratioDe(clip, émission.analyse, {}).padEnd(6)}` +
        `  ${nombre(médiane(empans)).padStart(9)}` +
        `  ${nombre(percentile(empans, 0.9)).padStart(9)}` +
        `  ${String(empans.length).padStart(6)}` +
        `  ${durée.toFixed(0)} s`,
    )
  }
  const tous = émission.clips.flatMap((c) => empansDe(c, émission.analyse, {}))
  console.log(
    `\n  répartition : ${ligneRépartition(répartition(émission.clips.map((c) => ratioDe(c, émission.analyse, {}))))}`,
  )
  console.log(
    `  empan résiduel médian, toutes images des clips confondues : ${nombre(médiane(tous))}` +
      ` (p90 ${nombre(percentile(tous, 0.9))})`,
  )
}

// ---------------------------------------------------------------------------
// 2. La répartition comparée
// ---------------------------------------------------------------------------

function comparaison(émissions: Émission[], quoi: 'clips' | 'fenêtres'): void {
  console.log(`\n${quoi === 'clips' ? 'Clips du repérage' : 'Fenêtres de 30 s tous les 30 s'}`)
  const entête = émissions.map((e) => e.id.padStart(22)).join(' ')
  console.log(`  ${''.padEnd(8)} ${entête}`)
  const comptes = émissions.map((e) =>
    répartition(e[quoi].map((d) => ratioDe(d, e.analyse, {}))),
  )
  for (const r of DU_PLUS_ÉTROIT_AU_PLUS_LARGE) {
    const cellules = comptes
      .map((c, i) => {
        const n = c.get(r) ?? 0
        const total = émissions[i][quoi].length
        const part = total === 0 ? '—' : `${((100 * n) / total).toFixed(0)} %`
        return `${n} (${part})`.padStart(22)
      })
      .join(' ')
    console.log(`  ${r.padEnd(8)} ${cellules}`)
  }
  console.log(
    `  ${'total'.padEnd(8)} ${émissions.map((e) => String(e[quoi].length).padStart(22)).join(' ')}`,
  )
}

// ---------------------------------------------------------------------------
// 3. Le balayage de la marge
// ---------------------------------------------------------------------------

/**
 * Ce que la marge change à la répartition, et ce qu'elle coûte en empan.
 *
 * L'empan y est le médian sur toutes les images mesurées de l'émission, tous
 * clips confondus : c'est la grandeur qui varie linéairement avec la marge — deux
 * fois sa valeur, une fois de chaque côté — et qui rend le tableau lisible à côté
 * des seuils de couverture.
 */
function balayage(émission: Émission, quoi: 'clips' | 'fenêtres'): void {
  const découpes = émission[quoi]
  if (découpes.length === 0) return
  console.log(`\n  ${émission.id} — ${découpes.length} ${quoi}`)
  console.log(`  marge    ${DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map((r) => r.padStart(6)).join(' ')}   empan méd.  déplacés`)

  const référence = découpes.map((d) => ratioDe(d, émission.analyse, {}))
  for (const marge of MARGES) {
    const options: FramingOptions = { margin: marge }
    const ratios = découpes.map((d) => ratioDe(d, émission.analyse, options))
    const compte = répartition(ratios)
    const empans = découpes.flatMap((d) => empansDe(d, émission.analyse, options))
    const déplacés = découpes
      .map((d, i) => ({ nom: d.nom, avant: référence[i], après: ratios[i] }))
      .filter((e) => e.avant !== e.après)
    const resserrés = déplacés.filter((e) => RATIOS[e.après] < RATIOS[e.avant]).length
    const défaut = marge === FRAMING_DEFAULTS.margin ? ' ←' : '  '
    console.log(
      `  ${marge.toFixed(2)}${défaut}   ` +
        DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map((r) => String(compte.get(r) ?? 0).padStart(6)).join(' ') +
        `   ${nombre(médiane(empans)).padStart(9)}` +
        `   ${resserrés} resserré(s), ${déplacés.length - resserrés} élargi(s)`,
    )
    // **Nommés sur les clips, comptés sur les fenêtres.** Un clip qui bascule est
    // une décision qu'on ira vérifier à l'image ; deux cents fenêtres nommées
    // noieraient le tableau qu'elles sont censées expliquer.
    if (quoi !== 'clips') continue
    for (const e of déplacés) {
      console.log(`           ${e.nom} : ${e.avant} → ${e.après}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Où regarder
// ---------------------------------------------------------------------------

/**
 * Les instants qui font monter le ratio d'un clip : ceux que **le crop retenu ne
 * cadre pas**, une image par plan au plus.
 *
 * **Pas les plus larges, et la différence n'est pas cosmétique.** Une largeur par
 * image suppose un crop libre par image, alors que le crop est fixe pour tout le
 * plan : un sujet étroit posé à gauche puis à droite donne des images toutes
 * étroites qu'aucune position fixe ne cadre, et c'est *ce* cas qui fait monter le
 * ratio. Un classement par largeur y désigne des images sans intérêt et laisse
 * croire, quand elles tiennent, que tout le plan tient. C'est exactement le
 * raisonnement de `chooseRatio`, en plus court. (relevé par Codex et Copilot)
 *
 * Une image par plan au plus, parce que les images voisines partagent le même
 * crop et racontent donc la même chose ; même règle que `--large` de
 * `vignettes-premier-plan.ts`, pour la même raison.
 */
function instantsQuiÉlargissent(découpe: Découpe, analyse: Analyse, n: number): number[] {
  const segments = normalizeSegments(découpe.segments)
  const dedans = analyse.boxes.filter((b) => segments.some((s) => b.t >= s.start && b.t < s.end))

  // Le cadrage réellement retenu pour ce clip : c'est lui qui dit ce qui déborde.
  const cadrage = computeFraming({
    segments: découpe.segments,
    shots: analyse.shots,
    people: analyse.boxes,
    srcW: analyse.source.w,
    srcH: analyse.source.h,
    ratio: 'auto',
    cropMode: 'auto',
  })
  const largeur = ratioCoverage(cadrage.ratio, analyse.source.w, analyse.source.h)

  // Par image, en passant par `requiredWidths` plutôt qu'en refaisant le calcul :
  // le seuil de confiance, la marge et le filtre du premier plan y sont déjà, et
  // une seconde copie de ces trois réglages finirait par diverger de celle qui
  // décide vraiment. Les bornes, elles, se relisent sur les boîtes gardées.
  const parImage = new Map<number, PersonBox[]>()
  for (const b of dedans) {
    const clé = Math.round(b.t * 1000)
    const déjà = parImage.get(clé)
    if (déjà) déjà.push(b)
    else parImage.set(clé, [b])
  }

  const marge = FRAMING_DEFAULTS.margin
  const classées = [...parImage.entries()]
    .map(([clé, boîtes]) => {
      const t = clé / 1000
      const empan = requiredWidths(boîtes)[0]
      const gardées = boîtes.filter(
        (b) => b.score >= FRAMING_DEFAULTS.minScore && !isForeground(b),
      )
      if (empan === undefined || gardées.length === 0) return undefined
      const g = Math.max(0, Math.min(...gardées.map((b) => b.x0)) - marge)
      const d = Math.min(1, Math.max(...gardées.map((b) => b.x1)) + marge)
      // Le crop de *son* plan : à défaut de plan, le centre, comme `computeFraming`.
      const plan = cadrage.shots.find((p) => t >= p.shot.start && t < p.shot.end)
      const centre = plan?.cropX ?? 0.5
      const x = Math.min(Math.max(centre - largeur / 2, 0), Math.max(0, 1 - largeur))
      const sortie = Math.max(0, x - g) + Math.max(0, d - (x + largeur))
      return { t, empan, sortie }
    })
    .filter((e): e is { t: number; empan: number; sortie: number } => e !== undefined)
    // Ce qui déborde le plus d'abord ; à débordement égal — zéro, le cas courant
    // quand le ratio est confortable —, la plus large, qui reste la plus
    // instructive.
    .sort((a, b) => b.sortie - a.sortie || b.empan - a.empan)

  const vus = new Set<number>()
  const out: number[] = []
  for (const e of classées) {
    if (out.length >= n) break
    const plan = analyse.shots.find((p) => e.t >= p.start && e.t < p.end)
    const clé = plan === undefined ? -Math.round(e.t * 1000) - 1 : Math.round(plan.start * 1000)
    if (vus.has(clé)) continue
    vus.add(clé)
    out.push(e.t)
  }
  return out.sort((a, b) => a - b)
}

function oùRegarder(émission: Émission, n: number): void {
  console.log(`\n  ${émission.id}`)
  const tous: number[] = []
  for (const clip of émission.clips) {
    const instants = instantsQuiÉlargissent(clip, émission.analyse, n)
    if (instants.length === 0) continue
    tous.push(...instants)
    console.log(`    ${clip.nom} : ${instants.map((t) => t.toFixed(1)).join(' ')}`)
  }
  if (tous.length === 0) return
  console.log(
    `\n    pnpm tsx scripts/vignettes-premier-plan.ts ${émission.id} ` +
      `${tous.map((t) => t.toFixed(1)).join(' ')} --out <dossier>`,
  )
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const iInstants = arguments_.indexOf('--instants')
  // La valeur qui suit `--instants` n'est pas un identifiant de projet : la
  // retirer avant de lire les positionnels, sinon `--instants 3` demande un
  // projet nommé « 3 » et va lire une analyse qui n'existe pas.
  const ids = arguments_.filter(
    (a, i) => !a.startsWith('--') && !(iInstants >= 0 && i === iInstants + 1),
  )
  if (ids.length === 0) {
    console.error('Usage : pnpm tsx scripts/mesure-ratios.ts <projectId…> [--instants N]')
    return 1
  }
  // Un compte illisible est **refusé**, pas remplacé par le défaut : `--instants 0`
  // qui imprimerait trois instants est le genre de silence qui fait chercher le
  // défaut ailleurs.
  const brutInstants = iInstants >= 0 ? arguments_[iInstants + 1] : undefined
  const nInstants =
    iInstants < 0
      ? null
      : brutInstants === undefined || brutInstants.startsWith('--')
        ? 3
        : Number(brutInstants)
  if (nInstants !== null && (!Number.isInteger(nInstants) || nInstants <= 0)) {
    console.error(`--instants attend un entier ≥ 1, reçu « ${String(brutInstants)} ».`)
    return 1
  }

  try {
    const émissions = ids.map(charger).filter((e): e is Émission => e !== null)
    if (émissions.length === 0) return 1

    console.log(
      `Filtre du premier plan à son défaut : y1 ≥ ${FRAMING_DEFAULTS.bottomEdge}, ` +
        `hauteur < ${FRAMING_DEFAULTS.foregroundMaxHeight}, score ≥ ${FRAMING_DEFAULTS.minScore}, ` +
        `marge ${FRAMING_DEFAULTS.margin}`,
    )

    console.log('\n=== 1. Le ratio par clip ===')
    for (const e of émissions) parClip(e)

    console.log('\n=== 2. La répartition comparée ===')
    comparaison(émissions, 'clips')
    comparaison(émissions, 'fenêtres')

    console.log('\n=== 3. Le balayage de la marge ===')
    console.log('  (« déplacés » se compte par rapport à la marge par défaut)')
    for (const e of émissions) balayage(e, 'clips')
    for (const e of émissions) balayage(e, 'fenêtres')

    if (nInstants !== null) {
      console.log('\n=== 4. Où regarder — les images qui font monter le ratio ===')
      for (const e of émissions) oùRegarder(e, nInstants)
    }

    return 0
  } finally {
    closeDb()
  }
}

void main().then(quitter, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quitter(1)
})
