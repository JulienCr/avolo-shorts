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
 * Seize caractères par carton — **espaces compris**, voir `splitIntoCards` pour
 * ce que « compris » veut dire exactement.
 */
export const MAX_CHARS_DEFAULT = 16

/** Une seconde quatre par carton, mesurée depuis son premier mot. */
export const MAX_DURATION_DEFAULT = 1.4

/**
 * Groupe les mots en cartons courts, lisibles sur un format vertical.
 *
 * Un carton se referme sur le mot qui ferait dépasser l'une des deux limites, et
 * ce mot ouvre le suivant.
 *
 * **Le décompte de caractères compte un espace par mot** : `somme(len + 1)`,
 * séparateur inclus pour le dernier mot aussi. « 16 caractères » vaut donc 16
 * espaces compris, soit à peu près trois mots français. C'est le décompte de la
 * version d'origine, et le rendu a été réglé dessus — le corriger en un décompte
 * « juste » rallongerait tous les cartons d'un mot.
 *
 * **La durée se mesure depuis le début du carton**, pas depuis le mot précédent.
 * Mesurée d'un mot à l'autre, elle ne dépasserait jamais le seuil tant que la
 * parole s'enchaîne — c'est-à-dire dans le cas courant — et un carton ne se
 * refermerait que sur la longueur.
 *
 * Les blancs autour d'un mot sont normalisés et un jeton sans texte est écarté :
 * certains transcripts portent le séparateur dans le jeton lui-même, ce qui
 * fausserait le décompte et doublerait l'espace au rendu. Ni le tableau ni les
 * mots de l'appelant ne sont modifiés.
 *
 * Deux réserves sur la sortie :
 *
 * - **les mots sont attendus dans l'ordre du temps**, ce que rend `retimeWords`,
 *   le seul appelant du pipeline. Aucun tri ici : ce serait trier deux fois le
 *   même tableau, et sur un tableau désordonné la durée d'un carton — mesurée
 *   depuis son premier mot — n'aurait de toute façon plus de sens ;
 * - un mot **plus long que `maxDuration`** tient un carton à lui seul, au-delà
 *   du seuil : le premier mot ouvre le carton sans condition, et le jeter parce
 *   qu'il dure trop serait pire que l'afficher trop longtemps.
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
