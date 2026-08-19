/**
 * Le ratio que le cadrage automatique choisit, clip par clip, sur plusieurs
 * émissions — et ce que ses deux réglages d'empan lui coûtent.
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
 * Six sorties :
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
 * 4. **Le balayage du rognage latéral**, avec en regard **ce qui est coupé des
 *    gens**. Les deux moitiés ne se lisent pas séparément : un rognage assez fort
 *    fait basculer n'importe quel plan en 1:1, il suffit de couper les comédiens.
 *    C'est ce balayage qui a posé la part à 0,30 et son plafond à 0,12.
 * 5. **Les plans que la position borne**, et non la largeur : ceux dont toutes
 *    les images tiendraient plus serré, mais qu'aucune position fixe ne sert.
 *    C'est la signature d'une frontière de plan manquée, et ça ne se corrige pas
 *    dans le choix du ratio.
 * 6. **Le tronc contre la boîte corps entier**, sur une analyse qui porte des
 *    points de pose. C'est le balayage de l'issue #69 : ce que chaque définition
 *    de tronc gagne en ratio, ce qu'elle coupe des gens, et ce qu'il reste au
 *    rognage latéral une fois le tronc en place.
 *
 * **Le chiffre qui décide est le temps de montage par ratio, pas le compte de
 * clips.** Depuis que le ratio se choisit par plan, un clip « en 16:9 » est
 * seulement un clip dont le *fichier natif* prend le plus large de ses plans ; ce
 * que la variante 9:16 montre, plan par plan, se mesure en secondes. Les deux
 * lignes sont imprimées côte à côte partout où elles existent.
 *
 * Deux drapeaux changent ce qui est lu et avec quoi :
 *
 * - `--analyse <projet>=<fichier>` lit une autre analyse que celle de
 *   `projects/<projet>/analysis.json`. C'est ce qui permet de comparer deux
 *   détecteurs sans écraser le fichier que le serveur sert.
 * - `--tronc <nom|off>` fixe la définition de tronc des sections 1 à 5, dont le
 *   défaut est celui de `FRAMING_DEFAULTS`.
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
  TORSOS,
  computeFraming,
  isForeground,
  personBounds,
  ratioCoverage,
  requiredWidths,
  torsoBounds,
  trimmedBounds,
} from '@/core/framing'
import type { ClipFraming, TorsoName } from '@/core/framing'
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

/**
 * Les rognages balayés, **plus le défaut en vigueur** — même règle que `MARGES`,
 * et pour la même raison : recopier la valeur du jour la fait disparaître de la
 * sortie le jour où elle bouge.
 *
 * La plage va de zéro — le comportement d'avant le 19 août 2026, qui exige que
 * les boîtes tiennent en entier — jusqu'au delà de ce qui a été retenu, parce
 * que c'est la pente au-delà du défaut qui dit s'il est posé sur une falaise.
 */
const SIDE_TRIMS = [
  ...new Set([0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.325, 0.35, 0.4, FRAMING_DEFAULTS.sideTrim]),
].sort((a, b) => a - b)

/**
 * L'intervalle entre deux images mesurées, en secondes : le worker échantillonne
 * à 2 images par seconde (spec §6).
 *
 * Il sert à convertir un compte d'images en durée, et c'est la seule forme sous
 * laquelle une perte se juge : « huit boîtes sur deux mille » ne dit pas si le
 * spectateur voit quelqu'un sortir du cadre pendant quatre secondes ou pendant
 * un battement de paupières.
 */
const SAMPLE_STEP = 0.5

/**
 * Les définitions de tronc balayées, **plus le repli sans tronc**.
 *
 * `'off'` n'est pas une valeur de plus dans la liste : c'est la ligne de base,
 * celle qui reproduit le cadrage d'avant les points de pose. Sans elle, le
 * tableau dirait ce que chaque tronc vaut par rapport aux autres et jamais ce
 * qu'il vaut par rapport à ce qui tourne aujourd'hui.
 */
const TORSO_NAMES: readonly (TorsoName | 'off')[] = ['off', ...(Object.keys(TORSOS) as TorsoName[])]

/**
 * Les élargissements de tronc balayés, **plus le défaut en vigueur** — même
 * règle que `MARGES` et `ROGNAGES`.
 */
const TORSO_PADS = [...new Set([0, 0.1, 0.15, 0.2, 0.3, FRAMING_DEFAULTS.torsoPad])].sort(
  (a, b) => a - b,
)

/**
 * Les rognages de tronc balayés, **plus le défaut en vigueur**.
 *
 * La plage monte jusqu'à la demi-largeur, où il ne reste du tronc que son
 * milieu — et, la tête servant de plancher, exactement la tête. C'est la borne
 * de l'exercice : au-delà, il n'y a plus rien à abandonner.
 */
const TORSO_TRIMS = [
  ...new Set([0, 0.1, 0.2, 0.3, 0.4, 0.5, FRAMING_DEFAULTS.torsoTrim]),
].sort((a, b) => a - b)

/**
 * Les réglages communs à toutes les sections, **posés une fois** depuis la ligne
 * de commande.
 *
 * Un objet mutable de module plutôt qu'un argument passé de fonction en
 * fonction : chaque section a déjà sa propre notion de « ce qui varie », et
 * ajouter un paramètre partout ferait que le jour où quelqu'un en oublie un, une
 * section mesurerait un autre cadrage que ses voisines sous le même en-tête.
 */
const BASE: FramingOptions = {}

/** Les réglages de base, éventuellement surchargés par ce que la section fait varier. */
function opts(extra: FramingOptions = {}): FramingOptions {
  return { ...BASE, ...extra }
}

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

/** Le cadrage complet d'une découpe : le ratio natif, et un cadre par plan. */
function framingOf(découpe: Découpe, analyse: Analyse, options: FramingOptions): ClipFraming {
  return computeFraming({
    ...options,
    segments: découpe.segments,
    shots: analyse.shots,
    people: analyse.boxes,
    srcW: analyse.source.w,
    srcH: analyse.source.h,
    ratio: 'auto',
    cropMode: 'auto',
  })
}

/** Le ratio du fichier natif d'une découpe : le plus large de ses plans. */
function ratioDe(découpe: Découpe, analyse: Analyse, options: FramingOptions): Ratio {
  return framingOf(découpe, analyse, options).ratio
}

/**
 * Les points de tête d'une personne, ceux dont la présence dans le cadre n'est
 * pas négociable : nez, yeux, oreilles.
 *
 * Les cinq et pas seulement le nez — un profil ne montre qu'un œil et qu'une
 * oreille, et un dos n'en montre aucun. La confiance décide, pas le rang.
 */
const HEAD_POINTS = TORSOS.head

/** Ce qu'un cadrage coûte à une découpe, sur les trois grandeurs qui le jugent. */
type Cost = {
  /** Ce qui est coupé de chaque **boîte corps entier**, une valeur par boîte. */
  box: number[]
  /** Ce qui est coupé de chaque **tronc**, quand la personne en a un de lisible. */
  torso: number[]
  /** Le nombre de (personne, image) dont **aucun point de tête** n'est dans le cadre. */
  headsOutside: number
  /** Celles dont un point de tête est dans le cadre mais à moins de 1 % du bord. */
  headsAtEdge: number
  /** Le nombre de personnes-images examinées, pour rapporter les deux précédents. */
  people: number
}

/**
 * Ce que le cadrage retenu **coûte aux gens**, plan par plan.
 *
 * **C'est la mesure de sûreté, et elle ne se déduit d'aucune autre.** La
 * répartition des ratios dit ce qu'on gagne ; celle-ci dit ce qu'on paie. Un
 * réglage qui fait basculer tous les clips en 1:1 en coupant un comédien sur
 * deux n'est pas un progrès.
 *
 * Le cadre mesuré est **celui du plan**, pas celui du natif : c'est le plus
 * serré des deux (le natif prend le plus large des plans), donc le seul qui
 * puisse couper quelqu'un que l'autre garderait.
 *
 * Les images que le seuil de 90 % sacrifie sont **comptées comme les autres**, et
 * c'est tout l'intérêt : rien d'autre ne les regarde. Le choix du ratio les
 * ignore par construction, donc c'est exactement là que se cachent les pertes
 * qu'aucun tableau de ratios ne montre.
 *
 * **`têtesDehors` est l'instrument qui manquait au 19 août.** La campagne du
 * rognage latéral a posé son plafond sur un visage tombé hors cadre, et elle ne
 * l'a vu qu'en regardant une image : « le compteur de pertes ne le signalait
 * pas, il n'avait perdu que 27 % de sa boîte ». Avec des points de pose, la
 * question se pose directement — le nez, les yeux ou les oreilles sont-ils dans
 * le rectangle — et se compte sur l'émission entière au lieu de se chercher à
 * l'œil. Une personne dont aucun point de tête n'est fiable ne compte pas :
 * l'absence de tête détectée n'est pas une tête hors cadre.
 */
function costOf(découpe: Découpe, analyse: Analyse, options: FramingOptions): Cost {
  const cadrage = framingOf(découpe, analyse, options)
  const segments = normalizeSegments(découpe.segments)
  const seuil = FRAMING_DEFAULTS.minScore
  // **L'étalon ne bouge pas avec le réglage qu'on juge.** Le tronc et les points
  // de tête sont ici une *mesure*, pas une décision : lus avec les options sous
  // test, la ligne « tronc off » n'aurait aucun tronc à mesurer et la colonne
  // qui compare les deux primitives serait vide sur la seule ligne qui sert de
  // référence. Chaque ligne du balayage se juge donc au même mètre.
  const gauge: FramingOptions = {
    torso: FRAMING_DEFAULTS.torso,
    torsoMinScore: FRAMING_DEFAULTS.torsoMinScore,
    torsoPad: FRAMING_DEFAULTS.torsoPad,
  }
  const pointThreshold = FRAMING_DEFAULTS.torsoMinScore
  const cost: Cost = { box: [], torso: [], headsOutside: 0, headsAtEdge: 0, people: 0 }
  for (const plan of cadrage.shots) {
    const largeur = ratioCoverage(plan.ratio, analyse.source.w, analyse.source.h)
    // Le bord gauche du rectangle, borné dans l'image comme `cropRect` le fait.
    const x = Math.min(Math.max(plan.cropX - largeur / 2, 0), Math.max(0, 1 - largeur))
    for (const b of analyse.boxes) {
      if (!withinInterval(b.t, plan.shot.start, plan.shot.end)) continue
      if (!segments.some((s) => withinInterval(b.t, s.start, s.end))) continue
      if (!(b.score >= seuil) || isForeground(b, options)) continue
      const boxWidth = b.x1 - b.x0
      if (!(boxWidth > 0)) continue
      cost.people += 1
      // **La boîte entière, pas la boîte rognée.** Le rognage est ce qu'on
      // s'autorise à perdre ; ce qu'on perd vraiment se mesure sur la personne.
      const dedans = Math.max(0, Math.min(b.x1, x + largeur) - Math.max(b.x0, x))
      cost.box.push(1 - dedans / boxWidth)

      const torso = torsoBounds(b, gauge)
      if (torso !== null && torso.x1 > torso.x0) {
        const insideTorso = Math.max(0, Math.min(torso.x1, x + largeur) - Math.max(torso.x0, x))
        cost.torso.push(1 - insideTorso / (torso.x1 - torso.x0))
      }

      const k = b.k
      if (k === undefined) continue
      let vue = false
      let inFrame = false
      let atEdge = false
      for (const rang of HEAD_POINTS) {
        const px = k[rang * 3]
        if (!Number.isFinite(px) || !(k[rang * 3 + 2] >= pointThreshold)) continue
        vue = true
        if (px >= x && px <= x + largeur) {
          inFrame = true
          if (px - x < 0.01 || x + largeur - px < 0.01) atEdge = true
        }
      }
      if (!vue) continue
      if (!inFrame) cost.headsOutside += 1
      else if (atEdge) cost.headsAtEdge += 1
    }
  }
  return cost
}

/**
 * `t` tombe-t-il dans l'intervalle ? **Fin exclue**, comme `computeFraming` :
 * une image posée sur une frontière appartient au plan qui suit.
 */
function withinInterval(t: number, début: number, fin: number): boolean {
  return t >= début && t < fin
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

/**
 * Le **temps de montage** de chaque ratio, en secondes.
 *
 * **C'est le chiffre qui décrit ce que la variante 9:16 montre**, et il ne se
 * déduit pas du compte de clips. Un clip est étiqueté par le ratio de son
 * fichier natif, qui est le plus large de ses plans : un clip de trente secondes
 * dont vingt-huit tiennent en 1:1 et deux exigent le 16:9 compte pour un clip en
 * 16:9, alors que la variante verticale y montre vingt-huit secondes de 1:1. Un
 * tableau de clips masque donc exactement ce que le ratio par plan a gagné.
 *
 * Le temps compté est l'intersection du plan avec les segments montés, pas la
 * durée du plan dans la source : le clip ne montre pas le reste.
 */
function timePerRatio(
  découpes: Découpe[],
  analyse: Analyse,
  options: FramingOptions,
): Map<Ratio, number> {
  const temps = new Map<Ratio, number>(DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map((r) => [r, 0]))
  for (const découpe of découpes) {
    const segments = normalizeSegments(découpe.segments)
    for (const plan of framingOf(découpe, analyse, options).shots) {
      const durée = segments.reduce(
        (n, s) =>
          n + Math.max(0, Math.min(plan.shot.end, s.end) - Math.max(plan.shot.start, s.start)),
        0,
      )
      temps.set(plan.ratio, (temps.get(plan.ratio) ?? 0) + durée)
    }
  }
  return temps
}

/** La part du temps de montage qui sort au ratio le plus large, en pourcentage. */
function shareInSixteenNine(temps: Map<Ratio, number>): number {
  const total = [...temps.values()].reduce((a, b) => a + b, 0)
  const large = temps.get(DU_PLUS_ÉTROIT_AU_PLUS_LARGE[DU_PLUS_ÉTROIT_AU_PLUS_LARGE.length - 1]) ?? 0
  return total === 0 ? Number.NaN : (100 * large) / total
}

function timeLine(temps: Map<Ratio, number>): string {
  return (
    DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map((r) => `${(temps.get(r) ?? 0).toFixed(0).padStart(6)}`).join(
      ' ',
    ) + `   16:9 = ${nombre(shareInSixteenNine(temps), 0).padStart(3)} %`
  )
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

function charger(id: string, overrides: Map<string, string>): Émission | null {
  // **Un fichier nommé à la main court-circuite `analysisPath`**, et c'est ce
  // qui permet de comparer deux détecteurs sur la même émission sans écraser
  // celui que le serveur de développement sert en direct.
  const fichier = overrides.get(id) ?? analysisPath(id)
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
    const empans = empansDe(clip, émission.analyse, opts())
    const durée = normalizeSegments(clip.segments).reduce((n, s) => n + (s.end - s.start), 0)
    console.log(
      `  ${clip.nom.padEnd(36)}  ${ratioDe(clip, émission.analyse, opts()).padEnd(6)}` +
        `  ${nombre(médiane(empans)).padStart(9)}` +
        `  ${nombre(percentile(empans, 0.9)).padStart(9)}` +
        `  ${String(empans.length).padStart(6)}` +
        `  ${durée.toFixed(0)} s`,
    )
  }
  const tous = émission.clips.flatMap((c) => empansDe(c, émission.analyse, opts()))
  console.log(
    `\n  répartition : ${ligneRépartition(répartition(émission.clips.map((c) => ratioDe(c, émission.analyse, opts()))))}`,
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
    répartition(e[quoi].map((d) => ratioDe(d, e.analyse, opts()))),
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

  // **Le temps, sous le compte, et jamais à sa place.** Le compte décrit le
  // fichier natif, qui garde un ratio d'un bout à l'autre ; le temps décrit la
  // variante 9:16, qui pose chaque plan au sien. Les deux sont vrais et ne
  // répondent pas à la même question — celui qui ne lirait que le premier
  // conclurait qu'un clip « en 16:9 » sort entièrement en 16:9.
  console.log(`\n  temps de montage par ratio, en secondes`)
  const temps = émissions.map((e) => timePerRatio(e[quoi], e.analyse, opts()))
  for (const [i, e] of émissions.entries()) {
    console.log(`  ${e.id.padEnd(24)} ${timeLine(temps[i])}`)
  }
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

  const référence = découpes.map((d) => ratioDe(d, émission.analyse, opts()))
  for (const marge of MARGES) {
    const options = opts({ margin: marge })
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
// 4. Le balayage du rognage latéral
// ---------------------------------------------------------------------------

/**
 * Ce que le rognage change à la répartition, **et ce qu'il coupe des gens**.
 *
 * Les deux moitiés vont ensemble et une ligne sans l'autre ne décide rien.
 * L'histoire du dépôt sur ce point : un filtre qui montait la part du 1:1 à
 * 90,4 % a été écarté parce qu'il vidait 64 % des images de toute détection —
 * une part calculée sur ce qui reste ne dit rien. Ici le piège est symétrique :
 * un rognage assez fort fait basculer n'importe quel plan en 1:1, il suffit de
 * couper les comédiens.
 *
 * Les colonnes de droite se lisent donc en premier :
 *
 * - `p99` et `max` : la fraction de sa propre largeur qu'une personne perd, au
 *   centile 99 et au pire ;
 * - `> 1/3` et `> 1/2` : combien de secondes de clip montrent quelqu'un amputé
 *   d'un tiers, puis de la moitié. La seconde est le seuil au-delà duquel un
 *   visage peut tomber, et c'est la ligne rouge posée par Julien.
 */
function sweepSideTrim(émission: Émission, quoi: 'clips' | 'fenêtres'): void {
  const découpes = émission[quoi]
  if (découpes.length === 0) return
  console.log(`\n  ${émission.id} — ${découpes.length} ${quoi}`)
  console.log(
    `  rognage  ${DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map((r) => r.padStart(6)).join(' ')}` +
      `  16:9 tps   coupé d'une boîte : p90    p99   > 1/3    > 1/2   coupé du tronc p99   têtes dehors`,
  )

  const référence = découpes.map((d) => ratioDe(d, émission.analyse, opts({ sideTrim: 0 })))
  for (const trim of SIDE_TRIMS) {
    const options = opts({ sideTrim: trim })
    const ratios = découpes.map((d) => ratioDe(d, émission.analyse, options))
    const compte = répartition(ratios)
    const temps = timePerRatio(découpes, émission.analyse, options)
    const costs = découpes.map((d) => costOf(d, émission.analyse, options))
    const losses = costs.flatMap((c) => c.box)
    const dehors = costs.reduce((n, c) => n + c.headsOutside, 0)
    const secondes = (n: number): string => `${(n * SAMPLE_STEP).toFixed(1)} s`
    const élargis = ratios.filter((r, i) => RATIOS[r] > RATIOS[référence[i]]).length
    const défaut = trim === FRAMING_DEFAULTS.sideTrim ? ' ←' : '  '
    console.log(
      `  ${trim.toFixed(3)}${défaut}` +
        DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map((r) => String(compte.get(r) ?? 0).padStart(6)).join(' ') +
        `  ${nombre(shareInSixteenNine(temps), 0).padStart(6)} %` +
        `   ${nombre(percentile(losses, 0.9)).padStart(24)}` +
        ` ${nombre(percentile(losses, 0.99)).padStart(6)}` +
        ` ${secondes(losses.filter((v) => v > 1 / 3).length).padStart(8)}` +
        ` ${secondes(losses.filter((v) => v > 0.5).length).padStart(8)}` +
        ` ${nombre(percentile(costs.flatMap((c) => c.torso), 0.99)).padStart(19)}` +
        ` ${`${dehors} (${secondes(dehors)})`.padStart(14)}` +
        (élargis > 0 ? `   ${élargis} ÉLARGI(S)` : ''),
    )
  }
}

// ---------------------------------------------------------------------------
// 5. Les plans que la position borne, et non la largeur
// ---------------------------------------------------------------------------

/**
 * Les plans dont le ratio monte **alors que leurs images tiendraient toutes dans
 * un cadre plus serré** — c'est-à-dire ceux qu'aucune position fixe ne sert.
 *
 * **C'est la signature d'une frontière de plan manquée**, et il faut savoir la
 * distinguer d'un plan réellement large, parce que les deux se soignent à des
 * endroits opposés. Le cas qui a fait écrire cette section :
 * `2026-22-02-entre-nous`, plan 3 234 → 3 297 s, **89 images sur 89 tiennent dans
 * un 1:1** et le ratio retenu est pourtant le 16:9. L'action y alterne entre
 * `[0,12 ; 0,55]` et `[0,39 ; 0,91]` : deux axes de caméra dans un même « plan ».
 * Vérifié à l'image sur le plan voisin — la coupe existe bel et bien à 2 953,2 s,
 * son score de scène vaut 0,366, et le seuil du détecteur est à 0,40.
 *
 * Le compte se lit en **temps**, pas en plans : un plan borné de deux secondes ne
 * coûte pas ce que coûte un plan de quarante.
 *
 * La borne comparée est **optimiste** : elle suppose un crop libre par image, ce
 * que le crop fixe par plan n'est pas. Un plan qui la dépasse est donc borné par
 * la position **à coup sûr**, jamais par accident d'arrondi.
 */
function boundedByPosition(émission: Émission): void {
  const { w, h } = émission.analyse.source
  let plans = 0
  let bornés = 0
  let secondes = 0
  let secondesBornées = 0
  const lignes: string[] = []

  for (const clip of émission.clips) {
    const cadrage = framingOf(clip, émission.analyse, opts())
    const segments = normalizeSegments(clip.segments)
    for (const plan of cadrage.shots) {
      const dedans = émission.analyse.boxes.filter(
        (b) =>
          withinInterval(b.t, plan.shot.start, plan.shot.end) &&
          segments.some((s) => withinInterval(b.t, s.start, s.end)),
      )
      const mesures = requiredWidths(dedans, opts())
      if (mesures.length === 0) continue
      // Le plus petit ratio que 90 % des images atteindraient si chacune pouvait
      // se cadrer pour elle-même.
      let libre: Ratio = DU_PLUS_ÉTROIT_AU_PLUS_LARGE[DU_PLUS_ÉTROIT_AU_PLUS_LARGE.length - 1]
      for (const r of DU_PLUS_ÉTROIT_AU_PLUS_LARGE) {
        const couverture = ratioCoverage(r, w, h)
        if (mesures.filter((m) => m <= couverture + 1e-9).length * 10 >= mesures.length * 9) {
          libre = r
          break
        }
      }
      const durée = segments.reduce(
        (n, s) =>
          n + Math.max(0, Math.min(plan.shot.end, s.end) - Math.max(plan.shot.start, s.start)),
        0,
      )
      plans++
      secondes += durée
      if (RATIOS[plan.ratio] <= RATIOS[libre]) continue
      bornés++
      secondesBornées += durée
      lignes.push(
        `    ${plan.shot.start.toFixed(1)} → ${plan.shot.end.toFixed(1)}` +
          `  ${durée.toFixed(1)} s  ${libre} possible, ${plan.ratio} retenu  ${clip.nom}`,
      )
    }
  }

  if (plans === 0) return
  const part = secondes === 0 ? 0 : (100 * secondesBornées) / secondes
  console.log(
    `\n  ${émission.id} : ${bornés} plans sur ${plans}, ` +
      `${secondesBornées.toFixed(0)} s sur ${secondes.toFixed(0)} s (${part.toFixed(0)} %)`,
  )
  for (const l of lignes) console.log(l)
}

// ---------------------------------------------------------------------------
// 6. Le tronc contre la boîte corps entier
// ---------------------------------------------------------------------------

/**
 * Ce que chaque définition de tronc change, **et ce qu'elle coûte**.
 *
 * L'issue #69 nomme la cause : on détecte des corps, donc une boîte suit des
 * jambes tendues jusqu'à un bord que la tête n'atteint pas, et l'empan mesuré —
 * donc le ratio — est décidé par des jambes que personne ne regarde. Le rognage
 * latéral du 19 août borne ce que ça peut coûter sans savoir ce qu'il abandonne ;
 * les points de pose disent où est la tête.
 *
 * **Les colonnes de droite se lisent en premier**, comme au balayage du rognage,
 * et pour la même raison : n'importe quel resserrement fait basculer n'importe
 * quel plan en 1:1, il suffit de couper les gens. `têtes` est la colonne qui
 * décide — le nombre de personnes-images dont aucun point de tête n'est dans le
 * rectangle. C'est le compteur qui manquait à la campagne précédente, qui n'a vu
 * son visage tombé qu'en regardant une image.
 */
function sweepTorso(émission: Émission, quoi: 'clips' | 'fenêtres'): void {
  const découpes = émission[quoi]
  if (découpes.length === 0) return
  console.log(`\n  ${émission.id} — ${découpes.length} ${quoi}`)
  console.log(
    `  tronc             ${DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map((r) => r.padStart(5)).join(' ')}` +
      `  16:9 tps  empan méd.   coupé boîte p99   coupé tronc p99   têtes dehors  au bord`,
  )

  for (const torso of TORSO_NAMES) {
    const options = opts({ torso })
    const compte = répartition(découpes.map((d) => ratioDe(d, émission.analyse, options)))
    const temps = timePerRatio(découpes, émission.analyse, options)
    const empans = découpes.flatMap((d) => empansDe(d, émission.analyse, options))
    const costs = découpes.map((d) => costOf(d, émission.analyse, options))
    const box = costs.flatMap((c) => c.box)
    const torsos = costs.flatMap((c) => c.torso)
    const dehors = costs.reduce((n, c) => n + c.headsOutside, 0)
    const atEdge = costs.reduce((n, c) => n + c.headsAtEdge, 0)
    const défaut = torso === FRAMING_DEFAULTS.torso ? ' ←' : '  '
    console.log(
      `  ${torso.padEnd(16)}${défaut}` +
        DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map((r) => String(compte.get(r) ?? 0).padStart(5)).join(' ') +
        `  ${nombre(shareInSixteenNine(temps), 0).padStart(6)} %` +
        `  ${nombre(médiane(empans)).padStart(9)}` +
        `  ${nombre(percentile(box, 0.99)).padStart(16)}` +
        `  ${nombre(percentile(torsos, 0.99)).padStart(16)}` +
        `  ${`${dehors} (${(SAMPLE_STEP * dehors).toFixed(1)} s)`.padStart(13)}` +
        `  ${String(atEdge).padStart(7)}`,
    )
  }
}

/**
 * L'empan que chaque primitive demande, **boîte contre tronc**, une valeur par
 * personne et une par image.
 *
 * C'est la mesure qui dit d'où vient le gain, avant tout choix de ratio : de
 * combien le tronc est plus étroit que la boîte, et sur quelle part des
 * personnes il existe. Une part faible ferait du tronc un raffinement qui ne
 * s'applique jamais — c'est exactement ce que le filtre du premier plan a failli
 * être ailleurs que sur `cqlp`.
 */
function torsoVersusBox(émission: Émission): void {
  const options = opts({ torso: FRAMING_DEFAULTS.torso })
  const seuil = FRAMING_DEFAULTS.minScore
  const gardées = émission.analyse.boxes.filter((b) => b.score >= seuil && !isForeground(b, options))
  const boxWidths: number[] = []
  const trimmedWidths: number[] = []
  const largeursTronc: number[] = []
  let avecTronc = 0
  for (const b of gardées) {
    boxWidths.push(b.x1 - b.x0)
    const rognée = trimmedBounds(b, options)
    trimmedWidths.push(rognée.x1 - rognée.x0)
    const torso = torsoBounds(b, options)
    if (torso === null) continue
    avecTronc += 1
    largeursTronc.push(torso.x1 - torso.x0)
  }
  if (gardées.length === 0) return
  console.log(
    `\n  ${émission.id} — ${gardées.length} boîtes gardées, ` +
      `${avecTronc} avec un tronc lisible (${((100 * avecTronc) / gardées.length).toFixed(0)} %)` +
      `${émission.analyse.keypoints === undefined ? ' — analyse sans points de pose' : ''}`,
  )
  console.log('                     médiane      p90      p99')
  for (const [nom, valeurs] of [
    ['boîte corps entier', boxWidths],
    ['boîte rognée', trimmedWidths],
    [`tronc « ${FRAMING_DEFAULTS.torso} »`, largeursTronc],
  ] as const) {
    console.log(
      `  ${nom.padEnd(18)} ${nombre(médiane(valeurs)).padStart(7)}` +
        ` ${nombre(percentile(valeurs, 0.9)).padStart(8)}` +
        ` ${nombre(percentile(valeurs, 0.99)).padStart(8)}`,
    )
  }
}

/**
 * Ce que le **rembourrage** du tronc change.
 *
 * Les points d'épaule sont les centres des articulations : à zéro, le tronc
 * passe au milieu de chaque épaule, et le crop coupe une demi-épaule à chacun
 * sans que la colonne « tête » s'en émeuve. Le balayage dit où s'arrête le
 * bénéfice et où commence la dépense.
 */
function sweepTorsoPadding(
  émission: Émission,
  quoi: 'clips' | 'fenêtres',
  whatVaries: 'torsoPad' | 'torsoTrim',
): void {
  const découpes = émission[quoi]
  if (découpes.length === 0) return
  console.log(`\n  ${émission.id} — ${découpes.length} ${quoi}`)
  const valeurs = whatVaries === 'torsoPad' ? TORSO_PADS : TORSO_TRIMS
  const défautDu = whatVaries === 'torsoPad' ? FRAMING_DEFAULTS.torsoPad : FRAMING_DEFAULTS.torsoTrim
  console.log(
    `  ${whatVaries === 'torsoPad' ? 'rembourrage' : 'rognage    '}  ${DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map((r) => r.padStart(5)).join(' ')}` +
      `  16:9 tps  empan méd.   coupé boîte p99   coupé tronc p99   têtes dehors`,
  )
  for (const pad of valeurs) {
    const options = opts(whatVaries === 'torsoPad' ? { torsoPad: pad } : { torsoTrim: pad })
    const compte = répartition(découpes.map((d) => ratioDe(d, émission.analyse, options)))
    const temps = timePerRatio(découpes, émission.analyse, options)
    const empans = découpes.flatMap((d) => empansDe(d, émission.analyse, options))
    const costs = découpes.map((d) => costOf(d, émission.analyse, options))
    const box = costs.flatMap((c) => c.box)
    const torsos = costs.flatMap((c) => c.torso)
    const dehors = costs.reduce((n, c) => n + c.headsOutside, 0)
    const défaut = pad === défautDu ? ' ←' : '  '
    console.log(
      `  ${pad.toFixed(2)}${défaut}         ` +
        DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map((r) => String(compte.get(r) ?? 0).padStart(5)).join(' ') +
        `  ${nombre(shareInSixteenNine(temps), 0).padStart(6)} %` +
        `  ${nombre(médiane(empans)).padStart(9)}` +
        `  ${nombre(percentile(box, 0.99)).padStart(16)}` +
        `  ${nombre(percentile(torsos, 0.99)).padStart(16)}` +
        `  ${`${dehors} (${(SAMPLE_STEP * dehors).toFixed(1)} s)`.padStart(13)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 7. Où regarder
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
  //
  // **Par `cadrageDe`, donc par `opts()`**, et pas par un `computeFraming` à
  // soi : cette section était la seule à ignorer `--tronc` par omission, si bien
  // qu'un balayage lancé avec un autre tronc désignait des images calculées avec
  // celui par défaut. La section 6 l'ignore aussi, mais parce qu'elle le balaie —
  // ce n'est pas la même chose, et c'est pourquoi elle reste seule à le faire.
  // (relevé par Aristarque)
  const cadrage = framingOf(découpe, analyse, opts())
  const largeur = ratioCoverage(cadrage.ratio, analyse.source.w, analyse.source.h)

  // Par image, en passant par `requiredWidths` plutôt qu'en refaisant le calcul :
  // le seuil de confiance, la marge et le filtre du premier plan y sont déjà, et
  // une seconde copie de ces trois réglages finirait par diverger de celle qui
  // décide vraiment. Les bornes, elles, se relisent sur les boîtes gardées —
  // **par `personBounds`**, comme l'empan.
  //
  // C'est ce qui a divergé : depuis que `requiredWidths` lit le tronc ou la
  // boîte rognée, relire `b.x0` / `b.x1` bruts mesurait un débordement que le
  // critère ne regarde plus. Une image dont les boîtes débordent mais dont les
  // troncs tiennent remontait en tête du classement, et la section 7 envoyait
  // regarder les mauvaises images — sans jamais se contredire, puisque c'est
  // elle qui dit où regarder. (relevé par Aristarque)
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
      const empan = requiredWidths(boîtes, opts())[0]
      const gardées = boîtes.filter(
        (b) => b.score >= FRAMING_DEFAULTS.minScore && !isForeground(b, opts()),
      )
      if (empan === undefined || gardées.length === 0) return undefined
      const required = gardées.map((b) => personBounds(b, opts()))
      const g = Math.max(0, Math.min(...required.map((e) => e.x0)) - marge)
      const d = Math.min(1, Math.max(...required.map((e) => e.x1)) + marge)
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
  // Les valeurs qui suivent un drapeau ne sont pas des identifiants de projet :
  // les retirer avant de lire les positionnels, sinon `--instants 3` demande un
  // projet nommé « 3 » et va lire une analyse qui n'existe pas.
  const suiveuses = new Set<number>()
  for (const [i, a] of arguments_.entries()) {
    if (a === '--instants' || a === '--tronc' || a === '--analyse') suiveuses.add(i + 1)
  }
  const ids = arguments_.filter((a, i) => !a.startsWith('--') && !suiveuses.has(i))
  if (ids.length === 0) {
    console.error(
      'Usage : pnpm tsx scripts/mesure-ratios.ts <projectId…> [--instants N] ' +
        '[--tronc <nom|off>] [--analyse <projet>=<fichier>]…',
    )
    return 1
  }

  // **Un fichier d'analyse nommé à la main, par projet.** Répétable, parce que
  // la comparaison qui vaut est celle de deux détecteurs sur la même émission,
  // et qu'on ne l'obtient qu'en lisant deux fichiers.
  const overrides = new Map<string, string>()
  for (const [i, a] of arguments_.entries()) {
    if (a !== '--analyse') continue
    const brut = arguments_[i + 1]
    const séparateur = brut === undefined ? -1 : brut.indexOf('=')
    if (brut === undefined || séparateur <= 0) {
      console.error(`--analyse attend <projet>=<fichier>, reçu « ${String(brut)} ».`)
      return 1
    }
    overrides.set(brut.slice(0, séparateur), brut.slice(séparateur + 1))
  }

  // Un tronc inconnu est **refusé**, pas remplacé par le défaut : une faute de
  // frappe qui mesurerait silencieusement le tronc par défaut est exactement la
  // sortie dont on tirerait une conclusion fausse — même règle que `--marge` et
  // `--trim` de `vignettes-cadrage.ts`.
  const iTronc = arguments_.indexOf('--tronc')
  if (iTronc >= 0) {
    const brut = arguments_[iTronc + 1]
    if (brut === undefined || !TORSO_NAMES.some((t) => t === brut)) {
      console.error(`--tronc attend l'un de ${TORSO_NAMES.join(', ')}, reçu « ${String(brut)} ».`)
      return 1
    }
    BASE.torso = brut as TorsoName | 'off'
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
    const émissions = ids
      .map((id) => charger(id, overrides))
      .filter((e): e is Émission => e !== null)
    if (émissions.length === 0) return 1

    console.log(
      `Réglages par défaut : y1 ≥ ${FRAMING_DEFAULTS.bottomEdge}, ` +
        `hauteur < ${FRAMING_DEFAULTS.foregroundMaxHeight}, score ≥ ${FRAMING_DEFAULTS.minScore}, ` +
        `marge ${FRAMING_DEFAULTS.margin}, rognage ${FRAMING_DEFAULTS.sideTrim} ` +
        `plafonné à ${FRAMING_DEFAULTS.sideTrimMax}, tronc « ${FRAMING_DEFAULTS.torso} » ` +
        `points ≥ ${FRAMING_DEFAULTS.torsoMinScore} rembourré de ${FRAMING_DEFAULTS.torsoPad}`,
    )
    if (BASE.torso !== undefined) {
      console.log(`Sections 1 à 5 et 7 forcées sur le tronc « ${BASE.torso} » ; la 6 le balaie.`)
    }
    for (const e of émissions) {
      const source = overrides.get(e.id)
      console.log(
        `  ${e.id} : ${source ?? analysisPath(e.id)}` +
          ` — version ${e.analyse.version}, ${e.analyse.model ?? 'modèle inconnu'}` +
          `, ${e.analyse.keypoints ?? 'sans points de pose'}`,
      )
    }

    console.log('\n=== 1. Le ratio par clip ===')
    for (const e of émissions) parClip(e)

    console.log('\n=== 2. La répartition comparée ===')
    comparaison(émissions, 'clips')
    comparaison(émissions, 'fenêtres')

    console.log('\n=== 3. Le balayage de la marge ===')
    console.log('  (« déplacés » se compte par rapport à la marge par défaut)')
    for (const e of émissions) balayage(e, 'clips')
    for (const e of émissions) balayage(e, 'fenêtres')

    console.log('\n=== 4. Le balayage du rognage latéral ===')
    console.log('  (« coupé » se mesure sur le cadre du plan, boîtes entières, images sacrifiées comprises)')
    for (const e of émissions) sweepSideTrim(e, 'clips')
    for (const e of émissions) sweepSideTrim(e, 'fenêtres')

    console.log('\n=== 5. Les plans que la position borne, et non la largeur ===')
    console.log('  (leurs images tiendraient plus serré ; aucune position fixe ne les sert)')
    for (const e of émissions) boundedByPosition(e)

    console.log('\n=== 6. Le tronc contre la boîte corps entier ===')
    console.log("  (l'empan que chaque primitive demande, avant tout choix de ratio)")
    for (const e of émissions) torsoVersusBox(e)
    console.log('\n  Ce que chaque définition de tronc change')
    console.log('  (« têtes dehors » : personnes-images dont aucun point de tête n’est dans le crop)')
    for (const e of émissions) sweepTorso(e, 'clips')
    for (const e of émissions) sweepTorso(e, 'fenêtres')
    console.log('\n  Le rembourrage du tronc')
    for (const e of émissions) sweepTorsoPadding(e, 'clips', 'torsoPad')
    for (const e of émissions) sweepTorsoPadding(e, 'fenêtres', 'torsoPad')
    console.log('\n  Le rognage du tronc, tête exceptée')
    for (const e of émissions) sweepTorsoPadding(e, 'clips', 'torsoTrim')
    for (const e of émissions) sweepTorsoPadding(e, 'fenêtres', 'torsoTrim')

    if (nInstants !== null) {
      console.log('\n=== 7. Où regarder — les images qui font monter le ratio ===')
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
