/**
 * Le découpage d'un montage **par plan**, la pièce qui manquait entre le cadrage
 * et le rendu.
 *
 * `computeFraming` rend un ratio et un `cropX` par plan de la source.
 * `renderArgs` veut une liste de morceaux à décoder, chacun avec son cadre.
 * Entre les deux, il faut couper les segments du montage aux frontières de
 * plans : un segment qui traverse cinq plans devient cinq entrées, et le cadre
 * saute là où une coupe existe déjà — donc là où le saut est invisible
 * (spec §10).
 *
 * Pur, et testé sans ffmpeg.
 */

import { normalizeSegments } from '@/core/edl'
import type { Ratio, Segment } from '@/core/edl'
import { MIN_PIECE_SEC, sameCell, type Cell, type ShotFraming } from '@/core/framing'

/**
 * Un morceau à décoder et le cadre qui lui revient, **pour les deux sorties**.
 *
 * Le natif garde un seul ratio pour tout le clip et n'a besoin que de
 * `cropXNative` ; la variante 9:16 pose chaque plan à son propre ratio et lit
 * `ratio` et `cropX`. Un découpage unique les sert tous les deux : les bornes
 * sont les mêmes, et c'est ce qui garantit que les deux fichiers montrent les
 * mêmes images aux mêmes instants.
 */
export type ShotPiece = Segment & {
  ratio: Ratio
  cropX: number
  cropXNative: number
  /** Les deux cellules du split-screen, `[haut, bas]`, quand le plan en pose un. */
  split?: [Cell, Cell]
}

/**
 * Découpe les segments aux frontières de plans, et attribue à chaque morceau la
 * position de crop du plan qui le porte.
 *
 * **La couverture est exacte par construction.** Les morceaux d'un segment
 * partent de sa borne de début, finissent sur sa borne de fin, et se suivent
 * bout à bout : la somme de leurs durées vaut celle du segment, au bit près,
 * puisque les bornes intermédiaires sont recopiées et non recalculées. C'est
 * l'invariant dont dépend le recalage des sous-titres, qui additionne les durées
 * dans l'ordre.
 *
 * **Un intervalle qu'aucun plan ne couvre prend `fallback`** plutôt que de
 * disparaître ou d'ouvrir un trou. Le cas est atteignable même sous un
 * `analysis.json` valide, dont les plans partitionnent la durée du *proxy* : la
 * source peut finir quelques images plus loin.
 *
 * `framedShots` n'a pas besoin d'être trié ni contigu.
 */
export function splitByShot(
  segments: readonly Segment[],
  shots: readonly ShotFraming[],
  /** Le cadre d'un intervalle qu'aucun plan ne couvre. */
  fallback: { ratio: Ratio; cropX: number; cropXNative: number; split?: [Cell, Cell] },
): ShotPiece[] {
  // Le montage se normalise ici, une fois : trié, sans chevauchement, sans
  // segment vide. Ce qui sort, en revanche, ne se normalise plus jamais — deux
  // morceaux adjacents portent deux crops différents, et les fusionner ferait
  // cadrer le second avec le rectangle du premier.
  const normalized = normalizeSegments(segments as Segment[])

  const sorted: ShotFraming[] = shots
    .filter((p) => Number.isFinite(p.shot.start) && Number.isFinite(p.shot.end))
    .slice()
    .sort((a, b) => a.shot.start - b.shot.start)

  // Toutes les frontières, dans l'ordre : le début et la fin de chaque plan. Un
  // plan commence là où le précédent finit, mais rien n'oblige la liste à être
  // contiguë — et `analysis.json` peut se relire après un réglage du détecteur.
  const boundaries = [...new Set(sorted.flatMap((p) => [p.shot.start, p.shot.end]))].sort(
    (a, b) => a - b,
  )

  const pieces: ShotPiece[] = []
  for (const segment of normalized) {
    // Les coupures retenues à l'intérieur du segment. Une frontière est écartée
    // quand elle laisserait un morceau plus court qu'une image, de l'un ou de
    // l'autre côté : le plan voisin l'absorbe, ce qui coûte quelques
    // millisecondes de cadrage et évite une entrée qui ne rend rien.
    const cuts: number[] = []
    for (const f of boundaries) {
      if (f - segment.start < MIN_PIECE_SEC) continue
      if (segment.end - f < MIN_PIECE_SEC) break
      const lastCut = cuts.length === 0 ? segment.start : cuts[cuts.length - 1]
      if (f - lastCut < MIN_PIECE_SEC) continue
      cuts.push(f)
    }

    const bounds = [segment.start, ...cuts, segment.end]
    for (let i = 0; i + 1 < bounds.length; i += 1) {
      const from = bounds[i]
      const to = bounds[i + 1]
      const frame = frameAtMidpoint(sorted, from, to, fallback)

      // **Deux plans consécutifs au même cadre ne valent qu'une entrée.** C'est
      // le cas courant et non l'exception : sur `2026-22-02-entre-nous`, quatre
      // des cinq plans d'un clip sortent en 16:9 pleine largeur, donc au même
      // rectangle exactement. Les garder séparés ouvrirait un décodeur par
      // frontière pour ne rien changer à l'image — et le graphe est mesuré bon
      // jusqu'à une dizaine d'entrées.
      //
      // **Et ça resserre le recalage plutôt que de le desserrer.** Chaque coupe
      // interne est un endroit où la durée demandée s'arrondit à l'image ; en
      // retirer une retire un arrondi. La fusion ne peut avoir lieu qu'entre
      // deux morceaux **contigus** au **même cadre**, donc les images produites
      // sont exactement les mêmes.
      const previous = pieces[pieces.length - 1]
      if (
        previous !== undefined &&
        previous.end === from &&
        previous.ratio === frame.ratio &&
        previous.cropX === frame.cropX &&
        previous.cropXNative === frame.cropXNative &&
        sameCell(previous.split?.[0], frame.split?.[0]) &&
        sameCell(previous.split?.[1], frame.split?.[1])
      ) {
        previous.end = to
        continue
      }

      pieces.push({
        start: from,
        end: to,
        ratio: frame.ratio,
        cropX: frame.cropX,
        cropXNative: frame.cropXNative,
        split: frame.split,
      })
    }
  }
  return pieces
}

/**
 * Le cadre du plan qui contient le **milieu** du morceau.
 *
 * Le milieu et non le début : une borne de segment peut tomber exactement sur
 * une frontière, et `start` appartiendrait alors au plan qui se termine là
 * plutôt qu'à celui qui commence — le morceau prendrait le cadrage du plan
 * d'avant, sur toute sa durée. Le milieu est à l'intérieur d'un seul plan par
 * construction, dès lors que le morceau ne dure pas zéro.
 */
function frameAtMidpoint(
  sorted: readonly ShotFraming[],
  from: number,
  to: number,
  fallback: { ratio: Ratio; cropX: number; cropXNative: number; split?: [Cell, Cell] },
): { ratio: Ratio; cropX: number; cropXNative: number; split?: [Cell, Cell] } {
  const midpoint = (from + to) / 2
  const found = sorted.find((p) => p.shot.start <= midpoint && midpoint < p.shot.end)
  return found === undefined
    ? fallback
    : { ratio: found.ratio, cropX: found.cropX, cropXNative: found.cropXNative, split: found.split }
}
