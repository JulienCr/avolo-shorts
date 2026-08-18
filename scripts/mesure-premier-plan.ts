/**
 * Ce que le filtre du premier plan écarte, et ce que ça change au ratio.
 *
 *     pnpm tsx scripts/mesure-premier-plan.ts 2025-06-15-cqlp
 *     pnpm tsx scripts/mesure-premier-plan.ts --analyse /chemin/vers/analysis.json
 *
 * **Ce n'est pas un contrôle, c'est une mesure.** Rien n'échoue ici : le script
 * imprime des chiffres, et c'est en les lisant qu'on décide. Il existe parce que
 * la question « à quelle hauteur couper » n'a pas de réponse a priori — il a
 * fallu compter deux populations et regarder si la frontière tombait dans un
 * creux ou en plein milieu d'un mode. Le détail est dans
 * `docs/premier-plan.md`, et ce script est ce qui le reproduit.
 *
 * Trois mesures, dans cet ordre :
 *
 * 1. **Les deux populations.** L'histogramme de la hauteur des boîtes, conditionné
 *    au contact du bord bas. C'est lui qui montre le creux où le seuil se pose.
 * 2. **L'empan.** La largeur qu'il faut pour contenir tout le monde, image par
 *    image, avant et après le filtre — et la part des images qui tient dans
 *    chaque ratio.
 * 3. **Le ratio des clips.** `computeFraming` sur les clips réels du projet, et
 *    sur des fenêtres régulières qui couvrent l'émission entière : onze clips ne
 *    font pas une distribution.
 *
 * L'avant/après ne passe pas par deux versions du code : `foregroundMaxHeight: 0`
 * désactive le filtre, puisqu'aucune boîte n'est plus courte que zéro.
 */

import fs from 'node:fs'

import { RATIOS, computeFraming, isForeground, ratioCoverage, requiredWidths } from '@/core/framing'
import type { FramingOptions } from '@/core/framing'
import type { Ratio, Segment } from '@/core/edl'
import type { PersonBox } from '@/core/shots'
import { getClips, getDb, closeDb } from '@/server/db'
import { analysisPath } from '@/server/paths'
import { lireAnalyse, type Analyse } from '@/server/steps/analysis'
import { chargerEnv, quitter } from './dev-commun'

/**
 * Les trois lectures qu'on compare, et pourquoi la deuxième est là.
 *
 * `bord bas seul` est le filtre naïf : jeter toute boîte qui touche le bas de
 * l'image. Il fait bouger le plus de clips et c'est justement le piège — il jette
 * aussi 76 % des comédiens, qui jouent debout et dont les pieds sont au bas du
 * cadre. Le garder dans la sortie évite de recommencer la démonstration.
 *
 * `0` désactive le filtre : aucune boîte n'est plus courte que zéro. `1.01`
 * l'ouvre en grand : aucune boîte n'est plus haute que l'image.
 */
const VARIANTES = [
  ['sans filtre  ', { foregroundMaxHeight: 0 }],
  ['bord bas seul', { foregroundMaxHeight: 1.01 }],
  ['filtre livré ', {}],
] as const satisfies readonly (readonly [string, FramingOptions])[]

/** Les deux variantes que l'avant/après compare, par leur rang dans `VARIANTES`. */
const I_SANS_FILTRE = 0
const I_AVEC_FILTRE = 2

/** Les quatre ratios du plus étroit au plus large. */
const DU_PLUS_ÉTROIT_AU_PLUS_LARGE = (Object.keys(RATIOS) as Ratio[]).sort(
  (a, b) => RATIOS[a] - RATIOS[b],
)

function pourcent(n: number, total: number): string {
  return total === 0 ? '—' : `${((100 * n) / total).toFixed(1)} %`
}

function médiane(valeurs: number[]): number {
  if (valeurs.length === 0) return Number.NaN
  const triées = [...valeurs].sort((a, b) => a - b)
  const m = triées.length >> 1
  return triées.length % 2 === 1 ? triées[m] : (triées[m - 1] + triées[m]) / 2
}

// ---------------------------------------------------------------------------
// 1. Les deux populations
// ---------------------------------------------------------------------------

/**
 * L'histogramme de la hauteur, séparé selon que la boîte touche le bord bas.
 *
 * **Le conditionnement est tout le sujet.** Sur la population entière, les deux
 * modes se recouvrent assez pour qu'aucun seuil ne soit défendable ; une fois
 * réduit aux boîtes tronquées par le bord bas, le creux est net et le seuil s'y
 * pose au lieu d'être choisi.
 */
function populations(boxes: PersonBox[], bordBas: number): void {
  const collées = boxes.filter((b) => b.y1 >= bordBas)
  const détachées = boxes.filter((b) => b.y1 < bordBas)
  console.log(`\nBoîtes : ${boxes.length}`)
  console.log(
    `  collées au bord bas (y1 ≥ ${bordBas}) : ${collées.length} (${pourcent(collées.length, boxes.length)})`,
  )
  console.log(
    `  détachées du bord bas               : ${détachées.length} (${pourcent(détachées.length, boxes.length)})`,
  )

  const hauteur = (b: PersonBox): number => b.y1 - b.y0
  console.log('\nHauteur des boîtes collées au bord bas, par centièmes (le creux cherché) :')
  histogramme(collées.map(hauteur), 0.2, 0.6, 40)
  console.log('\nHauteur des boîtes détachées du bord bas (aucune n’est filtrée) :')
  histogramme(détachées.map(hauteur), 0, 1, 20)

  const premierPlan = boxes.filter((b) => isForeground(b))
  console.log(
    `\nÉcartées par le filtre : ${premierPlan.length} (${pourcent(premierPlan.length, boxes.length)})`,
  )
  // Ce qu'un filtre sur la seule hauteur aurait jeté et que celui-ci garde. Posé
  // comme une différence entre deux réglages du **même** filtre, jamais comme une
  // copie du seuil : une copie viserait l'ancienne valeur le jour où il bouge.
  const sauvées = boxes.filter((b) => isForeground(b, { bottomEdge: 0 }) && !isForeground(b))
  console.log(`Sauvées par la condition de bord (courtes mais détachées) : ${sauvées.length}`)
}

function histogramme(valeurs: number[], min: number, max: number, cases: number): void {
  if (valeurs.length === 0) {
    console.log('  (aucune valeur)')
    return
  }
  const pas = (max - min) / cases
  const compte = new Array<number>(cases).fill(0)
  for (const v of valeurs) {
    const i = Math.min(cases - 1, Math.max(0, Math.floor((v - min) / pas)))
    compte[i] += 1
  }
  const plafond = Math.max(...compte, 1)
  for (const [i, n] of compte.entries()) {
    const barre = '#'.repeat(Math.round((50 * n) / plafond))
    console.log(`  ${(min + i * pas).toFixed(2)} ${String(n).padStart(6)} ${barre}`)
  }
}

// ---------------------------------------------------------------------------
// 2. L'empan
// ---------------------------------------------------------------------------

/**
 * L'empan par image et la part des images que chaque ratio couvre.
 *
 * **Une part par image, pas une part du temps de rendu.** Les images sont
 * échantillonnées à intervalle régulier par le worker, donc leur compte est
 * proportionnel au temps ; c'est ce qui rend le chiffre comparable au « 33 % à
 * 64 % » de la spec §2.
 */
function empans(boxes: PersonBox[], analyse: Analyse): void {
  const { w, h } = analyse.source
  for (const [nom, options] of VARIANTES) {
    const largeurs = requiredWidths(boxes, options)
    const couvertures = DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map(
      (r) => [r, ratioCoverage(r, w, h)] as const,
    )
    const parts = couvertures.map(
      ([r, c]) => `${r} ${pourcent(largeurs.filter((l) => l <= c + 1e-9).length, largeurs.length)}`,
    )
    console.log(
      `  ${nom} : ${largeurs.length} images mesurées, empan médian ${médiane(largeurs).toFixed(3)}`,
    )
    console.log(`    part des images qui tient dans — ${parts.join(' | ')}`)
  }
}

// ---------------------------------------------------------------------------
// 3. Le ratio des clips
// ---------------------------------------------------------------------------

function répartition(
  nom: string,
  découpes: { nom: string; segments: Segment[] }[],
  analyse: Analyse,
): void {
  console.log(`\n${nom} — ${découpes.length} découpes`)

  // Un cadrage par découpe et par variante, calculé une fois : le détail
  // ci-dessous relit les mêmes ratios que la répartition, donc aucun risque
  // qu'ils divergent, et une émission de trois heures ne paie pas deux fois.
  const ratios = VARIANTES.map(([, options]) =>
    découpes.map(
      (d) =>
        computeFraming({
          ...options,
          segments: d.segments,
          shots: analyse.shots,
          people: analyse.boxes,
          srcW: analyse.source.w,
          srcH: analyse.source.h,
          ratio: 'auto',
          cropMode: 'auto',
        }).ratio,
    ),
  )

  for (const [i, [étiquette]] of VARIANTES.entries()) {
    const compte = new Map<Ratio, number>(DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map((r) => [r, 0]))
    for (const r of ratios[i]) compte.set(r, (compte.get(r) ?? 0) + 1)
    const détail = DU_PLUS_ÉTROIT_AU_PLUS_LARGE.map((r) => `${r} ${compte.get(r) ?? 0}`).join('  ')
    console.log(`  ${étiquette} : ${détail}`)
  }

  // Le détail par découpe : une répartition qui bouge peut cacher des
  // déplacements dans les deux sens, et c'est exactement ce qu'on veut voir.
  const sansFiltre = ratios[I_SANS_FILTRE]
  const avecFiltre = ratios[I_AVEC_FILTRE]
  const déplacés = découpes
    .map((d, i) => ({ d, avant: sansFiltre[i], après: avecFiltre[i] }))
    .filter((e) => e.avant !== e.après)
  const élargis = déplacés.filter((e) => RATIOS[e.après] > RATIOS[e.avant]).length
  console.log(
    `  déplacés : ${déplacés.length} / ${découpes.length}` +
      ` (${déplacés.length - élargis} resserrés, ${élargis} élargis)`,
  )
  for (const e of déplacés.slice(0, 40)) {
    const sens = RATIOS[e.après] < RATIOS[e.avant] ? 'resserré' : 'ÉLARGI'
    console.log(`    ${e.d.nom} : ${e.avant} → ${e.après} (${sens})`)
  }
}

/**
 * Des fenêtres régulières qui couvrent l'émission.
 *
 * Onze clips ne font pas une distribution, et ceux-là ont été retenus par le
 * repérage : ils ne sont pas un échantillon de l'émission, ils en sont les
 * moments drôles. Les fenêtres disent ce qu'un clip *quelconque* deviendrait.
 */
function fenêtres(durée: number, longueur: number, pas: number): { nom: string; segments: Segment[] }[] {
  const out: { nom: string; segments: Segment[] }[] = []
  for (let t = 0; t + longueur <= durée; t += pas) {
    out.push({ nom: `${t.toFixed(0)}s`, segments: [{ start: t, end: t + longueur }] })
  }
  return out
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const iAnalyse = arguments_.indexOf('--analyse')
  // Le chemin qui suit `--analyse` n'est pas un identifiant de projet, et il
  // faut l'écarter *avant* de chercher celui-ci : sans ce retrait, la première
  // forme d'appel voit le chemin comme un projet et va lire un `analysis.json`
  // qui n'est pas celui qu'on lui a désigné.
  const positionnels = arguments_.filter(
    (a, i) => !a.startsWith('--') && !(iAnalyse >= 0 && i === iAnalyse + 1),
  )
  const projectId = positionnels[0]
  const fichier =
    iAnalyse >= 0
      ? arguments_[iAnalyse + 1]
      : projectId !== undefined
        ? analysisPath(projectId)
        : undefined

  if (fichier === undefined) {
    console.error(
      'Usage : pnpm tsx scripts/mesure-premier-plan.ts <projectId> | --analyse <analysis.json>',
    )
    return 1
  }
  if (!fs.existsSync(fichier)) {
    console.error(`Introuvable : ${fichier}`)
    return 1
  }

  const analyse = lireAnalyse(fichier)
  const durée = analyse.shots.at(-1)?.end ?? 0
  console.log(`Analyse : ${fichier}`)
  console.log(
    `Source ${analyse.source.w}x${analyse.source.h}, ${analyse.shots.length} plans, ` +
      `${analyse.boxes.length} boîtes, ${(durée / 60).toFixed(0)} min`,
  )

  console.log('\n=== 1. Les deux populations ===')
  populations(analyse.boxes, 0.97)

  console.log('\n=== 2. L’empan par image ===')
  empans(analyse.boxes, analyse)

  console.log('\n=== 3. Le ratio ===')
  if (projectId !== undefined) {
    const db = getDb()
    try {
      const clips = getClips(db, projectId).filter((c) => c.status !== 'discarded')
      if (clips.length > 0) {
        répartition(
          'Les clips du projet',
          clips.map((c) => ({ nom: c.id, segments: c.segments })),
          analyse,
        )
      }
    } finally {
      closeDb()
    }
  }
  répartition('Fenêtres de 30 s tous les 30 s', fenêtres(durée, 30, 30), analyse)

  return 0
}

void main().then(quitter, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quitter(1)
})
