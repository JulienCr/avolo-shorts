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
import type { ShotFraming } from '@/core/framing'

/**
 * Un morceau à décoder et le cadre qui lui revient, **pour les deux sorties**.
 *
 * Le natif garde un seul ratio pour tout le clip et n'a besoin que de
 * `cropXNatif` ; la variante 9:16 pose chaque plan à son propre ratio et lit
 * `ratio` et `cropX`. Un découpage unique les sert tous les deux : les bornes
 * sont les mêmes, et c'est ce qui garantit que les deux fichiers montrent les
 * mêmes images aux mêmes instants.
 */
export type MorceauCadré = Segment & { ratio: Ratio; cropX: number; cropXNatif: number }

/**
 * La durée minimale d'un morceau, en secondes.
 *
 * **Une frontière qui tombe à trois millisecondes du bord d'un segment ne vaut
 * pas une entrée.** Un morceau plus court qu'une image ouvre un décodeur qui ne
 * rend rien, ou une image de trop : dans les deux cas la somme des durées
 * demandées cesse de décrire ce que le fichier contient, et **les sous-titres,
 * qui sont recalés sur cette somme, glissent** — sans qu'aucun test de durée ne
 * le voie, puisque la durée totale, elle, ne bouge pas.
 *
 * 40 ms est une image à 25 im/s, un peu plus d'une à 30, deux et demie à 60.
 * C'est un ordre de grandeur, pas une mesure : ce qui compte est qu'aucun
 * morceau ne puisse être plus court qu'une image, et que le seuil reste très en
 * deçà de la plus courte frontière utile — les plans de ces émissions se
 * comptent en secondes, médiane 5,3 s sur la plus découpée des trois.
 */
export const DURÉE_MINIMALE_MORCEAU = 0.04

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
 * **Un intervalle qu'aucun plan ne couvre prend `cropParDéfaut`** plutôt que de
 * disparaître ou d'ouvrir un trou. Le cas est atteignable même sous un
 * `analysis.json` valide, dont les plans partitionnent la durée du *proxy* : la
 * source peut finir quelques images plus loin.
 *
 * `shots` n'a pas besoin d'être trié ni contigu.
 */
export function découperParPlan(
  segments: readonly Segment[],
  shots: readonly ShotFraming[],
  /** Le cadre d'un intervalle qu'aucun plan ne couvre. */
  défaut: { ratio: Ratio; cropX: number; cropXNatif: number },
): MorceauCadré[] {
  // Le montage se normalise ici, une fois : trié, sans chevauchement, sans
  // segment vide. Ce qui sort, en revanche, ne se normalise plus jamais — deux
  // morceaux adjacents portent deux crops différents, et les fusionner ferait
  // cadrer le second avec le rectangle du premier.
  const segs = normalizeSegments(segments as Segment[])

  const plans: ShotFraming[] = shots
    .filter((p) => Number.isFinite(p.shot.start) && Number.isFinite(p.shot.end))
    .slice()
    .sort((a, b) => a.shot.start - b.shot.start)

  // Toutes les frontières, dans l'ordre : le début et la fin de chaque plan. Un
  // plan commence là où le précédent finit, mais rien n'oblige la liste à être
  // contiguë — et `analysis.json` peut se relire après un réglage du détecteur.
  const frontières = [...new Set(plans.flatMap((p) => [p.shot.start, p.shot.end]))].sort(
    (a, b) => a - b,
  )

  const morceaux: MorceauCadré[] = []
  for (const segment of segs) {
    // Les coupures retenues à l'intérieur du segment. Une frontière est écartée
    // quand elle laisserait un morceau plus court qu'une image, de l'un ou de
    // l'autre côté : le plan voisin l'absorbe, ce qui coûte quelques
    // millisecondes de cadrage et évite une entrée qui ne rend rien.
    const coupures: number[] = []
    for (const f of frontières) {
      if (f - segment.start < DURÉE_MINIMALE_MORCEAU) continue
      if (segment.end - f < DURÉE_MINIMALE_MORCEAU) break
      const dernière = coupures.length === 0 ? segment.start : coupures[coupures.length - 1]
      if (f - dernière < DURÉE_MINIMALE_MORCEAU) continue
      coupures.push(f)
    }

    const bornes = [segment.start, ...coupures, segment.end]
    for (let i = 0; i + 1 < bornes.length; i += 1) {
      const début = bornes[i]
      const fin = bornes[i + 1]
      const cadre = cadreDuMilieu(plans, début, fin, défaut)

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
      const dernier = morceaux[morceaux.length - 1]
      if (
        dernier !== undefined &&
        dernier.end === début &&
        dernier.ratio === cadre.ratio &&
        dernier.cropX === cadre.cropX &&
        dernier.cropXNatif === cadre.cropXNatif
      ) {
        dernier.end = fin
        continue
      }

      morceaux.push({
        start: début,
        end: fin,
        ratio: cadre.ratio,
        cropX: cadre.cropX,
        cropXNatif: cadre.cropXNatif,
      })
    }
  }
  return morceaux
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
function cadreDuMilieu(
  plans: readonly ShotFraming[],
  début: number,
  fin: number,
  défaut: { ratio: Ratio; cropX: number; cropXNatif: number },
): { ratio: Ratio; cropX: number; cropXNatif: number } {
  const milieu = (début + fin) / 2
  const trouvé = plans.find((p) => p.shot.start <= milieu && milieu < p.shot.end)
  return trouvé === undefined
    ? défaut
    : { ratio: trouvé.ratio, cropX: trouvé.cropX, cropXNatif: trouvé.cropXNatif }
}
