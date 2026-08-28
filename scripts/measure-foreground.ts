/**
 * Ce que le filtre du premier plan écarte, et ce que ça change au ratio.
 *
 *     pnpm tsx scripts/measure-foreground.ts 2025-06-15-cqlp
 *     pnpm tsx scripts/measure-foreground.ts --analyse /chemin/vers/analysis.json
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

import {
  FRAMING_DEFAULTS,
  RATIOS,
  computeFraming,
  isForeground,
  ratioCoverage,
  requiredWidths,
} from '@/core/framing'
import type { FramingOptions } from '@/core/framing'
import type { Ratio, Segment } from '@/core/edl'
import type { PersonBox } from '@/core/shots'
import { getClips, getDb, closeDb } from '@/server/db'
import { analysisPath } from '@/server/paths'
import { lireAnalysis, type Analysis } from '@/server/steps/analysis'
import { chargerEnv, quit } from './dev-common'

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
const VARIANTS = [
  ['sans filtre  ', { foregroundMaxHeight: 0 }],
  ['bord bas seul', { foregroundMaxHeight: 1.01 }],
  ['filtre livré ', {}],
] as const satisfies readonly (readonly [string, FramingOptions])[]

/** Les deux variantes que l'avant/après compare, par leur rang dans `VARIANTS`. */
const I_WITHOUT_FILTER = 0
const I_WITH_FILTER = 2

/** Les quatre ratios du plus étroit au plus large. */
const MORE_NARROW_MORE_WIDE = (Object.keys(RATIOS) as Ratio[]).sort(
  (a, b) => RATIOS[a] - RATIOS[b],
)

function percent(n: number, total: number): string {
  return total === 0 ? '—' : `${((100 * n) / total).toFixed(1)} %`
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const m = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
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
function populations(boxes: PersonBox[], edgeBottom: number): void {
  const attached = boxes.filter((b) => b.y1 >= edgeBottom)
  const detached = boxes.filter((b) => b.y1 < edgeBottom)
  console.log(`\nBoîtes : ${boxes.length}`)
  console.log(
    `  collées au bord bas (y1 ≥ ${edgeBottom}) : ${attached.length} (${percent(attached.length, boxes.length)})`,
  )
  console.log(
    `  détachées du bord bas               : ${detached.length} (${percent(detached.length, boxes.length)})`,
  )

  const hauteur = (b: PersonBox): number => b.y1 - b.y0
  console.log('\nHauteur des boîtes collées au bord bas, par centièmes (le creux cherché) :')
  histogram(attached.map(hauteur), 0.2, 0.6, 40)
  console.log('\nHauteur des boîtes détachées du bord bas (aucune n’est filtrée) :')
  histogram(detached.map(hauteur), 0, 1, 20)

  const firstShot = boxes.filter((b) => isForeground(b))
  console.log(
    `\nÉcartées par le filtre : ${firstShot.length} (${percent(firstShot.length, boxes.length)})`,
  )
  // Ce qu'un filtre sur la seule hauteur aurait jeté et que celui-ci garde. Posé
  // comme une différence entre deux réglages du **même** filtre, jamais comme une
  // copie du seuil : une copie viserait l'ancienne valeur le jour où il bouge.
  const saved = boxes.filter((b) => isForeground(b, { bottomEdge: 0 }) && !isForeground(b))
  console.log(`Sauvées par la condition de bord (courtes mais détachées) : ${saved.length}`)
}

/**
 * Un histogramme sur `[min, max[`, **avec ses deux débordements comptés à part**.
 *
 * Les rabattre dans les cases extrêmes est le piège de ce genre de sortie, et il
 * s'est réellement tendu ici : sur `cqlp`, la case étiquetée `0,20` affichait
 * 9 723 boîtes là où l'intervalle `[0,20 ; 0,21[` en contient 510. Toutes les
 * boîtes plus courtes y étaient tombées, l'échelle était fixée par ce faux mode,
 * et l'histogramme ne montrait plus les intervalles qu'il étiquetait — sur la
 * figure même dont on tire la position du seuil. (relevé par Copilot)
 *
 * Les débordements sont **hors barème** : c'est la forme du creux qu'on lit ici,
 * et deux modes de dix mille écraseraient les vingt-neuf boîtes qui comptent.
 */
function histogram(values: number[], min: number, max: number, cells: number): void {
  if (values.length === 0) {
    console.log('  (aucune valeur)')
    return
  }
  const not = (max - min) / cells
  const count = new Array<number>(cells).fill(0)
  let dessous = 0
  let dessus = 0
  for (const v of values) {
    if (v < min) {
      dessous += 1
      continue
    }
    const i = Math.floor((v - min) / not)
    if (i >= cells) {
      dessus += 1
      continue
    }
    count[i] += 1
  }
  const cap = Math.max(...count, 1)
  console.log(`  < ${min.toFixed(2)} ${String(dessous).padStart(6)}  (hors barème)`)
  for (const [i, n] of count.entries()) {
    const bar = '#'.repeat(Math.round((50 * n) / cap))
    console.log(`  ${(min + i * not).toFixed(2)} ${String(n).padStart(6)} ${bar}`)
  }
  console.log(`  ≥ ${max.toFixed(2)} ${String(dessus).padStart(6)}  (hors barème)`)
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
function spans(boxes: PersonBox[], analysis: Analysis): void {
  const { w, h } = analysis.source
  for (const [name, options] of VARIANTS) {
    const widths = requiredWidths(boxes, options)
    const coverage = MORE_NARROW_MORE_WIDE.map(
      (r) => [r, ratioCoverage(r, w, h)] as const,
    )
    const parts = coverage.map(
      ([r, c]) => `${r} ${percent(widths.filter((l) => l <= c + 1e-9).length, widths.length)}`,
    )
    console.log(
      `  ${name} : ${widths.length} images mesurées, empan médian ${median(widths).toFixed(3)}`,
    )
    console.log(`    part des images qui tient dans — ${parts.join(' | ')}`)
  }
}

// ---------------------------------------------------------------------------
// 3. Le ratio des clips
// ---------------------------------------------------------------------------

function distribution(
  name: string,
  cuts: { name: string; segments: Segment[] }[],
  analysis: Analysis,
): void {
  console.log(`\n${name} — ${cuts.length} découpes`)

  // Un cadrage par découpe et par variante, calculé une fois : le détail
  // ci-dessous relit les mêmes ratios que la répartition, donc aucun risque
  // qu'ils divergent, et une émission de trois heures ne paie pas deux fois.
  const ratios = VARIANTS.map(([, options]) =>
    cuts.map(
      (d) =>
        computeFraming({
          ...options,
          segments: d.segments,
          shots: analysis.shots,
          people: analysis.boxes,
          srcW: analysis.source.w,
          srcH: analysis.source.h,
          ratio: 'auto',
          cropMode: 'auto',
        }).ratio,
    ),
  )

  for (const [i, [tag]] of VARIANTS.entries()) {
    const count = new Map<Ratio, number>(MORE_NARROW_MORE_WIDE.map((r) => [r, 0]))
    for (const r of ratios[i]) count.set(r, (count.get(r) ?? 0) + 1)
    const detail = MORE_NARROW_MORE_WIDE.map((r) => `${r} ${count.get(r) ?? 0}`).join('  ')
    console.log(`  ${tag} : ${detail}`)
  }

  // Le détail par découpe : une répartition qui bouge peut cacher des
  // déplacements dans les deux sens, et c'est exactement ce qu'on veut voir.
  const withoutFilter = ratios[I_WITHOUT_FILTER]
  const withFilter = ratios[I_WITH_FILTER]
  const moved = cuts
    .map((d, i) => ({ d, avant: withoutFilter[i], après: withFilter[i] }))
    .filter((e) => e.avant !== e.après)
  const widened = moved.filter((e) => RATIOS[e.après] > RATIOS[e.avant]).length
  console.log(
    `  déplacés : ${moved.length} / ${cuts.length}` +
      ` (${moved.length - widened} resserrés, ${widened} élargis)`,
  )
  for (const e of moved.slice(0, 40)) {
    const direction = RATIOS[e.après] < RATIOS[e.avant] ? 'resserré' : 'ÉLARGI'
    console.log(`    ${e.d.name} : ${e.avant} → ${e.après} (${direction})`)
  }
}

/**
 * Des fenêtres régulières qui couvrent l'émission.
 *
 * Onze clips ne font pas une distribution, et ceux-là ont été retenus par le
 * repérage : ils ne sont pas un échantillon de l'émission, ils en sont les
 * moments drôles. Les fenêtres disent ce qu'un clip *quelconque* deviendrait.
 */
function windows(duration: number, length: number, not: number): { name: string; segments: Segment[] }[] {
  const out: { name: string; segments: Segment[] }[] = []
  for (let t = 0; t + length <= duration; t += not) {
    out.push({ name: `${t.toFixed(0)}s`, segments: [{ start: t, end: t + length }] })
  }
  return out
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const iAnalysis = arguments_.indexOf('--analyse')
  // Le chemin qui suit `--analyse` n'est pas un identifiant de projet, et il
  // faut l'écarter *avant* de chercher celui-ci : sans ce retrait, la première
  // forme d'appel voit le chemin comme un projet et va lire un `analysis.json`
  // qui n'est pas celui qu'on lui a désigné.
  const positional = arguments_.filter(
    (a, i) => !a.startsWith('--') && !(iAnalysis >= 0 && i === iAnalysis + 1),
  )
  const projectId = positional[0]
  const file =
    iAnalysis >= 0
      ? arguments_[iAnalysis + 1]
      : projectId !== undefined
        ? analysisPath(projectId)
        : undefined

  if (file === undefined) {
    console.error(
      'Usage : pnpm tsx scripts/measure-foreground.ts <projectId> | --analyse <analysis.json>',
    )
    return 1
  }
  if (!fs.existsSync(file)) {
    console.error(`Introuvable : ${file}`)
    return 1
  }

  const analysis = lireAnalysis(file)
  const duration = analysis.shots.at(-1)?.end ?? 0
  console.log(`Analyse : ${file}`)
  console.log(
    `Source ${analysis.source.w}x${analysis.source.h}, ${analysis.shots.length} plans, ` +
      `${analysis.boxes.length} boîtes, ${(duration / 60).toFixed(0)} min`,
  )

  console.log('\n=== 1. Les deux populations ===')
  populations(analysis.boxes, FRAMING_DEFAULTS.bottomEdge)

  console.log('\n=== 2. L’empan par image ===')
  spans(analysis.boxes, analysis)

  console.log('\n=== 3. Le ratio ===')
  if (projectId !== undefined) {
    const db = getDb()
    try {
      const clips = getClips(db, projectId).filter((c) => c.status !== 'discarded')
      if (clips.length > 0) {
        distribution(
          'Les clips du projet',
          clips.map((c) => ({ name: c.id, segments: c.segments })),
          analysis,
        )
      }
    } finally {
      closeDb()
    }
  }
  distribution('Fenêtres de 30 s tous les 30 s', windows(duration, 30, 30), analysis)

  return 0
}

void main().then(quit, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quit(1)
})
