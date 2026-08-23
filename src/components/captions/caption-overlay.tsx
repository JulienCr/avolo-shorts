import { useMemo } from 'react'

import { hookFont } from '@/components/clip/hook-font'
import { captionUnits, PLAYRES_Y, type CaptionStyle } from '@/core/captions/ass'
import type { Word } from '@/core/transcript'

/**
 * Le calque de preview des sous-titres, sur le modèle de `HookOverlay` : un
 * calque DOM en unités `cqh`, jamais peint dans le canevas.
 *
 * @param cards Les cartons de `splitIntoCards`, sur la timeline choisie par l'appelant.
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
 * @returns Un index de `cards`, par recherche binaire — les cartons sont
 *   disjoints et croissants dans le temps.
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

/** L'index du mot actif dans un carton, mêmes bornes que `renderAss`. */
function activeWordIndex(card: readonly Word[], time: number): number {
  for (let i = card.length - 1; i >= 0; i--) {
    if (time >= card[i].start) return i
  }
  return 0
}
