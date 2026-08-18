/**
 * La logique d'édition de la surface transcript — pure, donc testée.
 *
 * **La surface d'édition est le transcript, pas une timeline** (spec §13). Tout
 * ce que fait l'écran de clip se ramène donc à traduire un geste sur des *mots*
 * en un appel sur la *liste de segments* de `src/core/edl.ts`. Cette traduction
 * est l'endroit où les erreurs se logent — un mot pris pour son voisin, une
 * sélection à l'envers, une borne affichée avant d'avoir été relue — et c'est
 * pourquoi elle vit ici, hors des composants, plutôt que dans un gestionnaire
 * d'événement.
 *
 * Ce fichier n'est pas dans `src/core/` : il ne décide rien du produit, il
 * adapte une interface à des fonctions qui, elles, y sont. Il en dépend par
 * `@/core/edl`, jamais l'inverse.
 */

import {
  moveBoundary,
  normalizeSegments,
  removeRange,
  type Segment,
} from '@/core/edl'
import type { Word } from '@/core/transcript'

/**
 * Une réplique du transcript : une phrase et ses mots.
 *
 * C'est l'unité qu'on virtualise. Virtualiser les mots un à un obligerait à
 * mesurer chaque mot pour composer des lignes ; virtualiser les phrases laisse
 * le navigateur faire la mise en page du texte, ce qu'il fait mieux et pour
 * rien.
 */
export type TranscriptLine = { id: string; start: number; end: number; words: Word[] }

/**
 * Un mot, situé dans la liste plate et sachant s'il est monté.
 *
 * `index` indexe la liste plate de *tous* les mots affichés, phrases confondues.
 * Une sélection s'exprime en deux `index`, ce qui la rend indépendante des
 * phrases qu'elle traverse.
 */
export type ClipWord = Word & { index: number; kept: boolean }

/** Une phrase, réduite à ce qu'il faut pour retrouver ses mots dans la liste plate. */
export type IndexedLine = { id: string; start: number; end: number; from: number; to: number }

/** Le transcript de l'écran de clip, aplati une fois pour toutes. */
export type IndexedTranscript = { words: ClipWord[]; lines: IndexedLine[] }

/**
 * Un mot est monté s'il **chevauche** un segment, pas s'il y est contenu.
 *
 * Le chevauchement plutôt que l'inclusion : une borne posée au milieu d'un mot
 * — ce que produit `moveBoundary` appelé sur une position quelconque — laisse un
 * mot à cheval, qu'on rend alors comme monté puisqu'on l'entendra. L'inclusion
 * le rendrait barré alors qu'il s'entend dans le clip, ce qui est le pire des
 * deux affichages : celui qui ment.
 */
export function isWordKept(word: Word, segments: Segment[]): boolean {
  return segments.some((s) => word.end > s.start && word.start < s.end)
}

/**
 * Aplatit les phrases en une liste plate indexée, et marque chaque mot.
 *
 * Une seule source pour les deux vues — la liste plate que la sélection indexe,
 * et les phrases que le virtualiseur pose. Les dériver séparément, c'est
 * s'exposer à ce que le même index désigne deux mots différents le jour où un
 * filtre diverge d'un cran.
 */
export function indexTranscript(lines: TranscriptLine[], segments: Segment[]): IndexedTranscript {
  const words: ClipWord[] = []
  const indexed: IndexedLine[] = []

  for (const line of lines) {
    const from = words.length
    for (const w of line.words) {
      words.push({ ...w, index: words.length, kept: isWordKept(w, segments) })
    }
    indexed.push({ id: line.id, start: line.start, end: line.end, from, to: words.length })
  }

  return { words, lines: indexed }
}

/**
 * Les bornes d'un retrait, depuis une sélection de deux mots.
 *
 * **Les deux index arrivent dans n'importe quel ordre** : on sélectionne aussi
 * souvent de la fin vers le début, et une soustraction naïve rendrait alors un
 * intervalle inversé que `removeRange` traiterait comme vide — la phrase
 * resterait, sans erreur et sans trace.
 *
 * Le retrait va du **début du premier mot** à la **fin du dernier** : prendre
 * `start` des deux couperait le dernier mot en son milieu et le laisserait
 * s'entendre à moitié.
 *
 * Rend `null` quand la sélection ne désigne rien — liste vide, index hors
 * bornes. C'est un cas d'interface normal (un clic qui rate), pas une erreur.
 */
export function selectionBounds(
  words: Word[],
  a: number,
  b: number,
): { from: number; to: number } | null {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null
  if (lo < 0 || hi >= words.length) return null

  const from = words[lo].start
  const to = words[hi].end
  if (!(to > from)) return null
  return { from, to }
}

/** Retire de la liste de segments les mots sélectionnés. Sans sélection utile, rien ne bouge. */
export function removeSelection(segments: Segment[], words: Word[], a: number, b: number): Segment[] {
  const bounds = selectionBounds(words, a, b)
  if (!bounds) return normalizeSegments(segments)
  return removeRange(segments, bounds.from, bounds.to)
}

/**
 * Le plus grand silence qu'on accepte de reprendre avec un mot, en secondes.
 *
 * Un blanc entre deux mots d'une même phrase se compte en centièmes, une
 * respiration entre deux phrases en dixièmes. Au-delà d'une seconde, ce n'est
 * plus une liaison : c'est une scène qui se termine, et personne n'a demandé à
 * la remonter en cliquant un mot.
 */
export const PONT_MAX = 1

/**
 * Les bornes à réinsérer pour rendre un mot barré.
 *
 * On ne réinsère pas seulement `[mot.start, mot.end]` : on rejoint le voisin
 * quand il est **assez proche**, ce qui évite deux défauts jumeaux :
 *
 * - si le voisin est monté, l'intervalle le *touche*, donc `normalizeSegments`
 *   fusionne. Sans ça, chaque mot rendu ajoutait un segment séparé d'un silence
 *   de quelques centièmes — un décodeur ffmpeg de plus (tâche 5) pour un trou
 *   que personne n'a demandé, et une respiration coupée à l'oreille ;
 * - si le voisin est barré, on rend un peu de silence qui sera recouvert quand
 *   ce voisin sera rendu à son tour : les deux intervalles se touchent alors et
 *   fusionnent aussi.
 *
 * **`PONT_MAX` est la correction d'un défaut trouvé en review.** Sans plafond,
 * le premier mot d'après un silence se rejoignait au dernier mot d'avant, quel
 * que soit l'écart : sur un transcript où deux catégories sont séparées de sept
 * minutes, un seul clic ajoutait sept minutes de silence au clip. Au-delà du
 * plafond, le mot se rend seul.
 *
 * Les `min`/`max` couvrent le chevauchement de mots que WhisperX produit parfois
 * en parole rapide, où la fin d'un mot dépasse le début du suivant.
 */
export function restoreBounds(words: Word[], index: number): { from: number; to: number } | null {
  if (!Number.isInteger(index) || index < 0 || index >= words.length) return null

  const word = words[index]
  const prev = words[index - 1]
  const next = words[index + 1]

  const from = prev && word.start - prev.end <= PONT_MAX ? Math.min(prev.end, word.start) : word.start
  const to = next && next.start - word.end <= PONT_MAX ? Math.max(next.start, word.end) : word.end
  if (!(to > from)) return null
  return { from, to }
}

/** Remonte un mot barré. Un clic, pas de boîte de dialogue. */
export function restoreWord(segments: Segment[], words: Word[], index: number): Segment[] {
  const bounds = restoreBounds(words, index)
  if (!bounds) return normalizeSegments(segments)
  return normalizeSegments([...segments, { start: bounds.from, end: bounds.to }])
}

/**
 * Pose la borne de début ou de fin du clip **sur un mot**.
 *
 * `'start'` se pose au début du mot, `'end'` à sa fin : dans les deux cas la
 * borne encadre le mot désigné plutôt que de le trancher.
 */
export function moveBoundaryToWord(
  segments: Segment[],
  words: Word[],
  index: number,
  edge: 'start' | 'end',
): Segment[] {
  if (!Number.isInteger(index) || index < 0 || index >= words.length) {
    return normalizeSegments(segments)
  }
  const word = words[index]
  return moveBoundary(segments, edge, edge === 'start' ? word.start : word.end)
}

/**
 * Les bornes réelles du clip, **relues dans la liste rendue**.
 *
 * `moveBoundary` documente la réserve et elle vise exactement cet écran : quand
 * la borne demandée tombe dans un trou entre deux segments, il n'y a rien à
 * monter entre elle et le segment voisin, et la borne obtenue est celle du
 * voisin. Afficher la valeur demandée montrerait alors un clip qui n'existe
 * pas. Donc jamais la demande, toujours le résultat.
 */
export function clipBounds(segments: Segment[]): { start: number; end: number } | null {
  const segs = normalizeSegments(segments)
  if (segs.length === 0) return null
  return { start: segs[0].start, end: segs[segs.length - 1].end }
}

/**
 * Le segment qui contient `position`, ou le premier qui commence après elle.
 *
 * C'est ce dont le lecteur a besoin pour sauter les passages retirés : à
 * `timeupdate`, si la position n'est dans aucun segment, il faut aller au début
 * du suivant. Rend `null` quand il n'y a plus rien après — la lecture est finie.
 */
export function segmentAt(segments: Segment[], position: number): Segment | null {
  for (const s of normalizeSegments(segments)) {
    if (position < s.end) return s
  }
  return null
}

/**
 * Ce que le lecteur doit faire à la position courante.
 *
 * Trois cas et pas deux : continuer, sauter au segment suivant, ou s'arrêter
 * parce qu'il n'y a plus rien après. Un `number | null` confondrait « tout va
 * bien » et « c'est fini », qui appellent pourtant des gestes opposés.
 */
export type PlaybackAction = { kind: 'play' } | { kind: 'seek'; to: number } | { kind: 'end' }

/**
 * Le saut des passages retirés, décidé hors du composant.
 *
 * Le seuil `epsilon` évite la boucle de sauts : `timeupdate` se déclenche
 * plusieurs fois par seconde et le `currentTime` obtenu après un saut n'est
 * jamais exactement celui demandé — le navigateur se cale sur une image clé.
 * Sans marge, chaque saut en déclencherait un autre au même endroit.
 *
 * Spec §16 : le saut produit un à-coup à l'image. C'est bon pour juger un
 * montage, pas pour valider un rendu — celui-ci sort de ffmpeg (tâche 14).
 */
export function playbackAction(
  segments: Segment[],
  position: number,
  epsilon = 0.25,
): PlaybackAction {
  const seg = segmentAt(segments, position)
  if (!seg) return { kind: 'end' }
  if (position >= seg.start - epsilon) return { kind: 'play' }
  return { kind: 'seek', to: seg.start }
}
