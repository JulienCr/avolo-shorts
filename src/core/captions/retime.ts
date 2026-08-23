/**
 * Le recalage des mots sur la timeline du clip.
 *
 * **C'est le piège principal du rendu** (spec §11). Un clip est une liste de
 * segments prélevés dans une émission de trois heures ; une fois les coupes
 * internes faites, les horodatages du transcript ne désignent plus rien de ce
 * que le spectateur voit. Un mot prononcé à 2874,1 s dans la source apparaît à
 * 15,7 s dans un clip dont le premier segment dure 15,7 s.
 *
 * Le défaut que ce module existe pour éviter ne lève aucune erreur, ne casse
 * aucun test d'intégration et ne se voit qu'à l'œil, sur un rendu : un karaoké
 * qui recule d'une seconde au milieu du clip.
 */

import { normalizeSegments, type Segment } from '@/core/edl'
import type { Word } from '@/core/transcript'

/**
 * `sourceTime`, converti sur la timeline du clip.
 *
 * Sert de pont entre `video.currentTime` — qui reste en temps source pendant
 * la lecture d'un clip, `ClipPlayer` sautant les coupes plutôt que de
 * reprojeter le temps — et des cartons déjà produits par
 * `splitIntoCards(retimeWords(...))`.
 *
 * @returns Le nombre de secondes écoulées dans le clip, ou `null` si
 *   `sourceTime` ne tombe dans aucun segment.
 */
export function elapsedInClip(segments: Segment[], sourceTime: number): number | null {
  const segs = normalizeSegments(segments)
  let elapsed = 0
  for (const seg of segs) {
    if (sourceTime >= seg.start && sourceTime < seg.end) return elapsed + (sourceTime - seg.start)
    elapsed += seg.end - seg.start
  }
  return null
}

/**
 * Les mots de `words` qui survivent aux segments, horodatés sur la timeline du
 * clip.
 *
 * **La boucle sur les segments est à l'extérieur, celle sur les mots à
 * l'intérieur**, et c'est tout l'intérêt de la fonction : les mots sortent dans
 * l'ordre des segments, pas dans celui de la source. Écrite dans l'autre sens,
 * elle rendrait pour deux segments distants une sortie qui recule dans le temps —
 * un mot du second segment émis avant un mot du premier — puisque l'ordre de
 * sortie serait celui de la source, où les deux morceaux ne se suivent pas.
 *
 * Trois conséquences du croisement, toutes voulues :
 *
 * - un mot tombé dans une coupe interne **disparaît**, puisqu'aucun segment ne
 *   le recouvre ;
 * - un mot à cheval sur une borne est **rogné** à cette borne ;
 * - un mot qu'une coupe traverse de part en part sort **deux fois**, rogné de
 *   chaque côté. Il s'entend en deux morceaux, il s'affiche en deux morceaux ;
 *   l'avaler serait pire.
 *
 * `elapsed` accumule la **durée** des segments précédents, jamais l'écart entre
 * eux : c'est la différence entre un clip de 20 secondes et un clip dont les
 * sous-titres arrivent avec 90 secondes de retard.
 *
 * Les mots sont triés avant le parcours. Le tri n'est pas de la prudence
 * gratuite : la garantie d'ordre porte sur la sortie, et un tableau arrivé d'un
 * JSON ou de la base n'est pas forcément dans l'ordre du temps. Ni le tableau ni
 * les mots de l'appelant ne sont modifiés — la sortie est faite d'objets neufs.
 */
export function retimeWords(words: Word[], segments: Segment[]): Word[] {
  const segs = normalizeSegments(segments)
  const sorted = [...words].sort((a, b) => a.start - b.start)

  const out: Word[] = []
  let elapsed = 0

  for (const seg of segs) {
    for (const w of sorted) {
      // Bornes ouvertes des deux côtés : un mot qui finit pile au début du
      // segment, ou commence pile à sa fin, n'y est pas.
      if (w.end <= seg.start || w.start >= seg.end) continue
      const start = Math.max(w.start, seg.start)
      const end = Math.min(w.end, seg.end)
      out.push({
        word: w.word,
        start: elapsed + (start - seg.start),
        end: elapsed + (end - seg.start),
      })
    }
    elapsed += seg.end - seg.start
  }
  return out
}
