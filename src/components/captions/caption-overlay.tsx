import { useEffect, useMemo, useState } from 'react'

import { hookFont } from '@/components/clip/hook-font'
import { captionUnits, MARGIN_SIDE, PLAYRES_Y, type CaptionStyle } from '@/core/captions/ass'
import type { Word } from '@/core/transcript'

/**
 * Le mot actif grossit de 90 % à 108 % en 110 ms, comme `\fscx90\fscy90\t(0,110,\fscx108\fscy108)`
 * dans `renderAss` (`src/core/captions/ass.ts`) — un seul endroit change ces
 * quatre nombres.
 */
const POP_START_PERCENT = 90
const POP_END_PERCENT = 108
const POP_DURATION_MS = 110

/** Le facteur d'échelle du mot actif à `elapsedMs` depuis son début, 0 à 1 valant `POP_DURATION_MS`. */
function popScale(elapsedMs: number): number {
  const clamped = Math.max(0, Math.min(POP_DURATION_MS, elapsedMs))
  return (POP_START_PERCENT + ((POP_END_PERCENT - POP_START_PERCENT) * clamped) / POP_DURATION_MS) / 100
}

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
  const scale = popScale((time - card[activeWord].start) * 1000)

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
          paddingLeft: cqh(MARGIN_SIDE / PLAYRES_Y),
          paddingRight: cqh(MARGIN_SIDE / PLAYRES_Y),
          whiteSpace: 'normal',
        }}
      >
        {card.map((word, i) => (
          <span key={i}>
            {i > 0 && ' '}
            <span
              data-caption={i === activeWord ? 'active' : undefined}
              style={{
                display: i === activeWord ? 'inline-block' : undefined,
                transform: i === activeWord ? `scale(${scale})` : undefined,
                fontSize: cqh(units.sizeUnits / PLAYRES_Y),
                lineHeight: 1.2,
                color: i === activeWord ? style.highlightColor : style.fontColor,
                // libass dilate le contour vers l'extérieur du glyphe ;
                // `-webkit-text-stroke` le centre, donc la moitié mange la
                // lettre. `paint-order` peint le contour d'abord et la
                // couleur par-dessus — la moitié intérieure disparaît, et
                // c'est pourquoi la largeur double pour rendre l'épaisseur
                // extérieure qu'écrit `renderAss`.
                paintOrder: 'stroke fill',
                WebkitTextStroke: `${cqh((2 * units.borderUnits) / PLAYRES_Y)} ${style.borderColor}`,
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

/**
 * `requestVideoFrameCallback` n'est pas dans la bibliothèque DOM de TypeScript.
 * Le type est local, et la présence se contrôle sur le prototype avant l'appel.
 */
type VideoToFrames = HTMLVideoElement & {
  requestVideoFrameCallback: (rappel: () => void) => number
  cancelVideoFrameCallback: (request: number) => void
}

/**
 * L'horloge locale d'un calque de sous-titres : `video.currentTime`,
 * échantillonné à la cadence de la trame plutôt qu'à celle de `timeupdate`
 * (~4 Hz).
 *
 * Un carton peut durer moins que l'intervalle entre deux `timeupdate` — un mot
 * isolé suivi d'un silence en forme un, `splitIntoCards` ne garantit qu'une
 * durée **maximale** — et `timeupdate` seul le saute alors entièrement.
 * `requestVideoFrameCallback` retrouve chaque trame ; `timeupdate`/`seeked`
 * sont le repli sur les navigateurs qui ne l'ont pas (Chrome < 84, Firefox
 * < 110, Safari < 17.4).
 *
 * **Locale à l'appelant, jamais remontée au parent** : un lecteur qui partage
 * son instant avec une autre surface (la bande de couverture, par exemple) le
 * tient à la cadence de `timeupdate` ailleurs, et une horloge à la trame
 * remontée par ce biais forcerait un rendu de toute la vue soixante fois par
 * seconde.
 *
 * **Aucun échantillon avant la première trame ou le premier événement** — pas
 * de lecture immédiate de `currentTime` au montage. Un appelant qui a par
 * ailleurs sa propre source (un instant reçu par prop, par exemple) peut ainsi
 * distinguer « rien n'est encore arrivé ici » de `-1` et s'y replier tant que
 * cette horloge n'a rien à dire — utile sur une vidéo en pause, où aucune
 * trame ni aucun `timeupdate` ne se produit.
 *
 * @param video L'élément dont on suit `currentTime`. `null` tant qu'il n'est
 *   pas monté : le calque n'a alors rien à afficher.
 * @param enabled Faux ferme l'abonnement — pas de calque, pas de trames à suivre.
 * @returns L'instant courant en secondes, ou `-1` avant le premier échantillon
 *   et après chaque désabonnement (changement de `video`, ou `enabled` à faux).
 */
export function useCaptionClock(video: HTMLVideoElement | null, enabled: boolean): number {
  const [time, setTime] = useState(-1)

  useEffect(() => {
    if (video === null || !enabled) return

    const track = () => setTime(video.currentTime)
    video.addEventListener('seeked', track)

    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const source = video as VideoToFrames
      let request = source.requestVideoFrameCallback(function next() {
        track()
        request = source.requestVideoFrameCallback(next)
      })
      return () => {
        source.cancelVideoFrameCallback(request)
        video.removeEventListener('seeked', track)
        // **Remis à `-1` au désabonnement**, pas seulement recalculé au
        // suivant. Sans ça, désactiver les sous-titres pendant une vidéo en
        // pause puis les réactiver ne produit ni `seeked` ni nouvelle trame —
        // rien ne remplace l'échantillon, et le calque réaffiche indéfiniment
        // le carton d'un instant périmé. (relevé par Copilot, PR #126, passe 2)
        setTime(-1)
      }
    }

    video.addEventListener('timeupdate', track)
    return () => {
      video.removeEventListener('timeupdate', track)
      video.removeEventListener('seeked', track)
      setTime(-1)
    }
  }, [video, enabled])

  return time
}
