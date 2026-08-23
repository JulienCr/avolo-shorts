/**
 * Le découpage des mots en cartons — les groupes qui s'affichent ensemble.
 *
 * Porté de `openshorts/subtitles.py:146-195` (`_collect_word_blocks`), dont le
 * rendu fait référence (spec §9). Le filtrage sur la plage du clip, que la
 * version Python fait au même endroit, appartient ici à `retimeWords` : ce
 * module ne voit que des mots déjà recalés sur la timeline du clip.
 */

import type { Word } from '@/core/transcript'

/**
 * Trente-six caractères par carton — **espaces compris**, voir `splitIntoCards`
 * pour ce que « compris » veut dire exactement.
 */
export const MAX_CHARS_DEFAULT = 36

/** Deux secondes cinq par carton, mesurée depuis son premier mot. */
export const MAX_DURATION_DEFAULT = 2.5

/**
 * Groupe les mots en cartons courts, lisibles sur un format vertical.
 *
 * @param words Attendus dans l'ordre du temps — non triés ici, voir `retimeWords`.
 * @param maxChars Compte un espace par mot, séparateur inclus pour le dernier
 *   aussi (`somme(len + 1)`) : ne pas « corriger » ce décompte, le rendu y est réglé.
 * @param maxDuration Mesurée depuis le premier mot du carton, jamais depuis le
 *   mot précédent — sinon un carton ne se refermerait jamais tant que la parole
 *   s'enchaîne. Un mot qui dépasse ce seuil à lui seul tient son propre carton
 *   plutôt que d'être jeté.
 */
export function splitIntoCards(
  words: Word[],
  maxChars = MAX_CHARS_DEFAULT,
  maxDuration = MAX_DURATION_DEFAULT,
): Word[][] {
  const cards: Word[][] = []
  let current: Word[] = []
  let cardStart = 0

  for (const raw of words) {
    const text = raw.word.trim().replace(/\s+/g, ' ')
    if (text === '') continue
    const word: Word = { word: text, start: raw.start, end: raw.end }

    if (current.length === 0) {
      current = [word]
      cardStart = word.start
      continue
    }

    const chars = current.reduce((n, w) => n + w.word.length + 1, 0)
    const duration = word.end - cardStart

    if (chars + word.word.length > maxChars || duration > maxDuration) {
      cards.push(current)
      current = [word]
      cardStart = word.start
    } else {
      current.push(word)
    }
  }

  if (current.length > 0) cards.push(current)
  return cards
}
