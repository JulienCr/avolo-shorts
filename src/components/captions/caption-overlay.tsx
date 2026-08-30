import { useEffect, useMemo, useState } from 'react'

import { createDomMeasure, useFontReady } from '@/components/captions/use-text-measure'
import { hookFont } from '@/components/clip/hook-font'
import {
  captionLines,
  captionOutlineFractions,
  captionUnits,
  MARGIN_SIDE,
  PLAYRES_X,
  PLAYRES_Y,
  type CaptionStyle,
} from '@/core/captions/ass'
import { ASS_FONTSIZE_TO_EM, CSS_HALF_LEADING_OVER_EM } from '@/core/captions/font-metrics'
import type { Word } from '@/core/transcript'

/** Le nombre de points de l'anneau `text-shadow` qui approxime le contour — voir `outlineRingShadow`. */
const OUTLINE_RING_SAMPLES = 16

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
  const family = hookFont.style.fontFamily
  const ready = useFontReady(family)
  const index = useMemo(() => activeCardIndex(cards, time), [cards, time])
  const units = captionUnits(style)
  const measure = useMemo(
    () => (ready ? createDomMeasure(family, units.sizeUnits, { bold: true }) : null),
    [ready, family, units.sizeUnits],
  )
  const card = index === -1 ? null : cards[index]
  const lines = useMemo(
    () => (card === null || measure === null ? [] : captionLines(card, style, measure)),
    [card, style, measure],
  )

  // Pas de calque tant qu'Anton n'est pas confirmée chargée : mesurer avant
  // rendrait des métriques de repli sans rien signaler (`useFontReady`).
  if (!ready || card === null) return null

  const activeWord = activeWordIndex(card, time)
  const scale = popScale((time - card[activeWord].start) * 1000)
  const outline = captionOutlineFractions(units.borderUnits)

  // `Fontsize` ASS mesure une hauteur de ligne, pas un cadratin — voir
  // `font-metrics.ts`. L'interligne réel est donc l'ancien `fontSize`.
  const fontSizeFraction = ASS_FONTSIZE_TO_EM * (units.sizeUnits / PLAYRES_Y)
  const lineHeightFraction = units.sizeUnits / PLAYRES_Y
  // libass ancre le BAS du glyphe, CSS celui de la boîte de ligne — d'où
  // `CSS_HALF_LEADING_OVER_EM`, en `marginBottom` et non `paddingBottom` :
  // elle peut dépasser `marginUnits` (légal à 0), qu'un `padding` écrêterait.
  const paddingBottomFraction = units.marginUnits / PLAYRES_Y
  const halfLeadingCorrectionFraction = CSS_HALF_LEADING_OVER_EM * fontSizeFraction
  const paddingSideFraction = MARGIN_SIDE / PLAYRES_X

  let wordIndex = -1

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
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          maxWidth: '100%',
          fontSize: cqh(fontSizeFraction),
          lineHeight: cqh(lineHeightFraction),
          paddingBottom: cqh(paddingBottomFraction),
          marginBottom: cqh(-halfLeadingCorrectionFraction),
          paddingLeft: cqw(paddingSideFraction),
          paddingRight: cqw(paddingSideFraction),
        }}
      >
        {/* Une boîte par ligne, celles que `captionLines` a déjà décidées —
            plus le navigateur qui recoupe librement. */}
        {lines.map((line, li) => (
          <div key={li} style={{ textAlign: 'center', whiteSpace: 'pre' }}>
            {line.map((wordText, wi) => {
              wordIndex++
              const active = wordIndex === activeWord
              return (
                <span key={wi}>
                  {wi > 0 && ' '}
                  <span
                    data-caption={active ? 'active' : undefined}
                    style={{
                      display: active ? 'inline-block' : undefined,
                      transform: active ? `scale(${scale})` : undefined,
                      color: active ? style.highlightColor : style.fontColor,
                      textShadow: outlineRingShadow(
                        style.borderColor,
                        outline.widthFraction,
                        outline.heightFraction,
                        OUTLINE_RING_SAMPLES,
                      ),
                    }}
                  >
                    {wordText}
                  </span>
                </span>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * L'anneau de `samples` décalages `text-shadow` qui approxime le contour
 * anisotrope de libass — mesuré le 30 août 2026 : 5,50 px d'épaisseur
 * horizontale contre 13,00 px verticale sur le même mot, que
 * `-webkit-text-stroke` (isotrope) ne peut pas rendre. Voir `docs/lessons.md`.
 */
export function outlineRingShadow(
  color: string,
  widthFraction: number,
  heightFraction: number,
  samples: number,
): string {
  const offsets: string[] = []
  for (let i = 0; i < samples; i++) {
    const theta = (2 * Math.PI * i) / samples
    offsets.push(`${cqw(widthFraction * Math.cos(theta))} ${cqh(heightFraction * Math.sin(theta))} 0 ${color}`)
  }
  return offsets.join(', ')
}

/** `u`, une fraction (0 à 1) de la largeur du conteneur, en `cqw`. */
function cqw(fraction: number): string {
  return `calc(${fraction * 100}cqw)`
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
