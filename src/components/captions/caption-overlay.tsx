import { useMemo } from 'react'

import { hookFont } from '@/components/clip/hook-font'
import { captionUnits, PLAYRES_Y, type CaptionStyle } from '@/core/captions/ass'
import type { Word } from '@/core/transcript'

/**
 * Le calque de preview des sous-titres, sur le modèle exact de `HookOverlay`.
 *
 * **Un calque DOM, frère du canevas, jamais peint dedans**, en unités `cqh`
 * sur un conteneur `containerType: 'size'` posé par l'appelant. Sa géométrie
 * — taille de police et marge basse — vient de `captionUnits`
 * (`@/core/captions/ass`), la même fonction que `renderAss` : diviser ses
 * champs par `PLAYRES_Y` donne la fraction de hauteur qu'écrit ce calque, donc
 * l'aperçu et le rendu ne peuvent pas diverger sur ces deux nombres sans que
 * `tests/core/captions.test.ts` ne le voie.
 *
 * **Exact sur la position, les couleurs et la taille, approché sur la largeur
 * de boîte** — même limite honnête que `HookOverlay` : le moteur de mise en
 * page du navigateur n'est pas `measureText`, donc un carton qui reviendrait à
 * la ligne autrement dans les deux moteurs peut différer de quelques pixels.
 *
 * @param cards Les cartons de `splitIntoCards`, sur la timeline que
 *   l'appelant a choisie — voir la doc de chaque point de montage.
 * @param time L'instant courant, en secondes, sur cette même timeline.
 * @param style Le preset de sous-titres appliqué au rendu.
 */
export function CaptionOverlay({
  cards,
  time,
  style,
}: {
  cards: readonly Word[][]
  time: number
  style: CaptionStyle
}) {
  const index = useMemo(() => activeCardIndex(cards, time), [cards, time])
  if (index === -1) return null

  const card = cards[index]
  const activeWord = activeWordIndex(card, time)
  const units = captionUnits(style)

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-end"
      style={{ overflow: 'hidden' }}
    >
      <div
        data-caption="card"
        className={hookFont.className}
        style={{
          maxWidth: '100%',
          textAlign: 'center',
          paddingBottom: cqh(units.marginUnits / PLAYRES_Y),
          paddingLeft: cqh(units.marginUnits / PLAYRES_Y),
          paddingRight: cqh(units.marginUnits / PLAYRES_Y),
          whiteSpace: 'normal',
        }}
      >
        {card.map((word, i) => (
          <span key={i}>
            {i > 0 && ' '}
            <span
              data-caption={i === activeWord ? 'active' : undefined}
              style={{
                fontSize: cqh(units.sizeUnits / PLAYRES_Y),
                lineHeight: 1.2,
                color: i === activeWord ? style.highlightColor : style.fontColor,
                WebkitTextStroke: `${cqh(units.borderUnits / PLAYRES_Y)} ${style.borderColor}`,
              }}
            >
              {display(word.word, style.uppercase)}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

function display(word: string, uppercase: boolean): string {
  return uppercase ? word.toUpperCase() : word
}

/** `u`, une fraction (0 à 1) de la hauteur du conteneur, en `cqh`. */
function cqh(fraction: number): string {
  return `calc(${fraction * 100}cqh)`
}

/**
 * L'index du carton actif à `time`, ou `-1` si aucun ne le couvre.
 *
 * **Recherche binaire, pas un `find` linéaire** : `cards` peut porter
 * plusieurs milliers de mots sur le transcript entier d'une émission, et
 * cette recherche s'exécute à chaque `timeupdate`. Les cartons sont
 * disjoints et croissants dans le temps — c'est la garantie de
 * `splitIntoCards` — donc la comparaison à un seul point par carton suffit.
 */
export function activeCardIndex(cards: readonly Word[][], time: number): number {
  let lo = 0
  let hi = cards.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const card = cards[mid]
    const start = card[0].start
    const end = card[card.length - 1].end
    if (time < start) hi = mid - 1
    else if (time >= end) lo = mid + 1
    else return mid
  }
  return -1
}

/**
 * L'index du mot actif dans un carton, **sur le même calcul de bornes que
 * `renderAss`** : un mot est actif depuis son propre `start` jusqu'au `start`
 * du suivant, le dernier tenant jusqu'à la fin du carton.
 */
function activeWordIndex(card: readonly Word[], time: number): number {
  for (let i = card.length - 1; i >= 0; i--) {
    if (time >= card[i].start) return i
  }
  return 0
}
