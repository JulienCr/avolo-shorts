'use client'

import { useCallback, useEffect, useRef } from 'react'

import {
  isComputedFraming,
  effectiveRatio,
  useCurrentShot,
  activeSplit,
} from '@/components/clip/framing'
import { HookOverlay } from '@/components/clip/hook-overlay'
import { CaptionOverlay, useCaptionClock } from '@/components/captions/caption-overlay'
import type { CaptionStyle } from '@/core/captions/ass'
import { elapsedInClip } from '@/core/captions/retime'
import type { Word } from '@/core/transcript'
import type { Ratio, Segment } from '@/core/edl'
import { RATIOS, cropRect, outputSize, splitCellRect, type Cell } from '@/core/framing'
import type { ResolvedHook } from '@/core/hook'
import type { PublishedFraming } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Le canevas de sortie : **ce qu'on aura**, à côté de ce qu'on garde.
 *
 * L'aperçu de l'itération 0 montre la source 16:9 avec un rectangle et deux
 * bandes assombries — donc ce qu'on **retire** de la source. C'est le bon outil
 * de *position*. Ce n'est pas l'outil de *décision* : ce que le choix du ratio
 * décide, c'est la part de l'écran du téléphone que le contenu occupera, et
 * arbitrer entre un 1:1 et un 4:5 en comparant deux rectangles larges sur une
 * image couchée cache exactement la différence qu'on cherche à voir.
 *
 * D'où ce second aperçu, **à l'échelle où il sera vu**. Et ce n'est plus une
 * illustration : la sortie est en 9:16, et le cadre du plan courant y occupe
 * exactement cette part — 100 % en 9:16, 70,3 % en 4:5, 56,3 % en 1:1, 31,6 % en
 * 16:9, le fond flouté remplissant le reste. Comme le ratio se choisit par plan,
 * cette part change en cours de lecture, et c'est ce que le fichier fera.
 *
 * **Un seul `<video>` décode.** Le canevas se peint à partir de celui du lecteur,
 * par `drawImage`. Deux éléments sur la même source seraient plus courts à
 * écrire et décoderaient deux fois le même flux, sur un proxy que la page lit
 * déjà en requêtes partielles.
 */

/** Le petit côté du canevas, en pixels. Un quart du rendu : la décision se voit à cette taille. */
const PETIT_SIDE = 270

/**
 * La part de la hauteur d'un écran 9:16 qu'occupe un contenu de ce ratio.
 *
 * C'est le chiffre que le sélecteur de ratio demandait d'imaginer, et il n'est
 * pas intuitif : passer de 1:1 à 4:5 gagne un quart d'écran de plus, alors que
 * les deux rectangles se ressemblent sur une image couchée.
 */
export function lScreenPart(ratio: Ratio): number {
  return RATIOS['9:16'] / RATIOS[ratio]
}

/**
 * Peint une image du canevas de sortie.
 *
 * **La géométrie est celle du rendu, pas une approximation.** `cropRect` et
 * `splitCellRect` sont les fonctions que ffmpeg suit : l'aperçu montre donc le
 * cadre exact, pas un cadre qui lui ressemble.
 *
 * `split`, quand il est posé, ignore `ratio`/`cropX` — même règle que
 * `src/core/ffmpeg/args.ts` : une entrée splittée remplit tout le canevas de
 * ses deux cellules empilées, sans crop unique ni fond.
 */
export function paintOutput(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  {
    ratio,
    cropX,
    width,
    hauteur,
    split,
  }: { ratio: Ratio; cropX: number; width: number; hauteur: number; split?: [Cell, Cell] },
): void {
  const { videoWidth, videoHeight } = video
  // Le proxy se charge en requêtes partielles : le premier rendu tombe avant les
  // métadonnées, et `drawImage` sur une source de 0x0 lève une `InvalidStateError`.
  if (videoWidth <= 0 || videoHeight <= 0 || width <= 0 || hauteur <= 0) return

  if (split !== undefined) {
    const cellHeight = hauteur / 2
    split.forEach((cell, i) => {
      const r = splitCellRect(cell, videoWidth, videoHeight)
      ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, i * cellHeight, width, cellHeight)
    })
    return
  }

  const frame = cropRect(ratio, cropX, videoWidth, videoHeight)
  ctx.drawImage(video, frame.x, frame.y, frame.w, frame.h, 0, 0, width, hauteur)
}

/** La taille du canevas, dans le rapport du rendu et au quart de sa définition. */
function canvasSize(ratio: Ratio): { width: number; hauteur: number } {
  const { w, h } = outputSize(ratio)
  const scale = PETIT_SIDE / Math.min(w, h)
  return { width: Math.round(w * scale), hauteur: Math.round(h * scale) }
}

export function PreviewOutput({
  video,
  framing,
  ratio,
  cropX,
  hook,
  frame,
  figureClassName,
  captionCards,
  captionStyle,
  segments,
}: {
  /** L'élément du lecteur. `null` tant qu'il n'y a pas de proxy. */
  video: HTMLVideoElement | null
  /** Le cadrage que le serveur publie : ratio résolu, crop par plan. */
  framing: PublishedFraming
  /** Le ratio en cours d'édition. */
  ratio: Ratio | 'auto'
  /** Le cadrage manuel en cours d'édition. Ignoré quand le cadrage est calculé. */
  cropX: number
  /**
   * Le hook résolu (globaux + surcharge du clip), à peindre en calque —
   * **jamais dans le canvas**, voir `HookOverlay`. `undefined` tant que les
   * réglages globaux n'ont pas chargé : aucun calque ne se peint, plutôt que
   * d'en peindre un sur des valeurs qui ne sont pas les vraies.
   */
  hook?: ResolvedHook
  /**
   * La boîte du téléphone, dimensionnée par l'appelant.
   *
   * **Elle existe pour que les deux aperçus aient exactement la même hauteur —
   * et depuis l'établi (spec du 23 août, §3.3), c'est la hauteur du volet
   * gauche, pas une constante.** `clip-screen.tsx` calcule une seule classe et
   * la passe telle quelle à `ClipPlayer` et à celui-ci : deux frères qui
   * s'étirent tous les deux sur la hauteur de leur rangée est une garantie plus
   * forte qu'une constante partagée, parce qu'aucune retouche future ne peut
   * donner une largeur à l'un et une hauteur à l'autre sans casser visiblement
   * la rangée elle-même.
   *
   * **Pas de `max-width` ici, et c'est la condition de recette du lot.** Un
   * `max-width` posé à côté d'un `aspect-ratio` fait recalculer la hauteur
   * depuis la largeur clampée plutôt que l'inverse — mesuré : la boîte 16:9
   * retombait à 202 px là où on lui en demandait 272, et l'égalité des deux
   * aperçus tombait avec. La hauteur seule se donne, en pixels ou en `flex-1` ;
   * la largeur se déduit de `aspect-ratio` et ne se borne jamais.
   */
  frame?: string
  /**
   * Le poids de la figure racine dans la rangée des deux aperçus.
   *
   * **`clip-screen.tsx` le pose en `flex-grow`/`flex-shrink` fixes, sous
   * `workbench:` seulement** (16:9 pour la figure jumelle, 9:16 pour
   * celle-ci — le rapport du cadre du téléphone, pas celui du plan en
   * cours) plutôt que de laisser `flex-basis: auto` répartir la largeur
   * d'après le contenu : une boîte à `aspect-ratio` imbriquée dans un
   * enfant `flex-1` se mesure à une valeur indéterminée pendant la passe
   * intrinsèque de la rangée, et la légende ("variante 9:16 · …") pesait
   * alors sur la largeur à sa place — la figure de sortie retombait plus
   * étroite que sa propre boîte, rognée par `overflow-hidden` du volet.
   * Non conditionné à `workbench:` une première fois, ce même poids cassait
   * le repli sous le seuil : les boîtes y reviennent à une taille fixe
   * (`h-72`) sous `flex-wrap`, et un poids `flex` sans base les faisait
   * chevaucher au lieu de passer à la ligne. (relevé par Codex, les deux
   * fois)
   */
  figureClassName?: string
  /** Cartons de `splitIntoCards(retimeWords(mots, segments))` — fidèle au rendu (spec §9). `undefined` ferme le calque. */
  captionCards?: readonly Word[][]
  /** Le preset appliqué aux sous-titres. Ignoré si `captionCards` est `undefined`. */
  captionStyle?: CaptionStyle
  /** Les segments, en temps source (unité de `video.currentTime`) — pour `elapsedInClip`. */
  segments?: Segment[]
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  // Le plan sous la lecture : le cadre saute à ses frontières, ici comme dans le
  // rendu. Le `hook` rend un index, donc ce composant ne se re-rend qu'aux
  // frontières et non à chaque `timeupdate`.
  const shot = useCurrentShot(framing)
  const position = isComputedFraming(framing) ? (shot?.cropX ?? 0.5) : cropX
  const effective = effectiveRatio(shot, ratio)
  // Le split (spec du 25 août) n'existe que sur la variante 9:16 : ses deux
  // cellules remplissent tout le canevas, `effective`/`position` n'y servent
  // plus. Le natif, lui, garde `ratio`/`cropXNative` sans jamais lire `split`.
  const split = activeSplit(shot, framing, ratio) ? shot?.split : undefined
  const { width, hauteur } = canvasSize(split !== undefined ? '9:16' : effective)
  const part = split !== undefined ? 1 : lScreenPart(effective)
  /**
   * Le canevas vertical **n'est pas toujours la variante**.
   *
   * Quand le natif vaut déjà 9:16, le serveur ne produit **aucune** variante
   * (`src/server/steps/render.ts`) : ce canevas est alors le fichier natif
   * lui-même. La légende annonçait « variante 9:16 » dans les deux cas, pendant
   * que le sélecteur de ratio disait deux lignes plus bas qu'il n'y en aurait
   * pas — deux informations contradictoires sur le même écran.
   * (relevé par Copilot)
   */
  const nativeRatio = ratio === 'auto' ? framing.ratio : ratio
  const isVariant = nativeRatio !== '9:16'

  const paint = useCallback(() => {
    const target = canvas.current
    if (target === null || video === null) return
    const ctx = target.getContext('2d')
    if (ctx === null) return
    paintOutput(ctx, video, { ratio: effective, cropX: position, width, hauteur, split })
  }, [video, effective, position, width, hauteur, split])

  // **Le premier des deux déclencheurs, et le plus important.** Tout changement
  // de crop ou de ratio repeint sur l'image courante : le geste réel est « on
  // met en pause, on regarde, on ajuste », et une vidéo en pause ne produit
  // aucune image, donc aucun `requestVideoFrameCallback`. Ne câbler que le
  // callback livrerait un aperçu qui ne bouge pas quand on déplace le rectangle,
  // sur l'écran dont c'est la seule raison d'être. (relevé par Aristarque)
  useEffect(() => {
    paint()
  }, [paint])

  // Le second : la lecture. `requestVideoFrameCallback` n'existe pas avant
  // Chrome 84, Firefox 110 et Safari 17.4 — sans conséquence sur une machine
  // fixe et un seul navigateur, mais la garde évite un échec silencieux et le
  // repli sur `timeupdate` tient l'aperçu à quatre images par seconde plutôt
  // qu'à zéro.
  // La fonction de peinture change à chaque déplacement du cadre. Passée en
  // dépendance de l'effet ci-dessous, elle ferait défaire et refaire
  // l'abonnement aux trames soixante fois par seconde pendant un glissé — donc
  // annuler la trame en vol à chaque frappe. Une référence la tient à jour sans
  // toucher à l'abonnement.
  const paintRef = useRef(paint)
  useEffect(() => {
    paintRef.current = paint
  }, [paint])

  useEffect(() => {
    if (video === null) return
    const paintNow = () => paintRef.current()

    // `loadeddata` et `seeked` valent pour les deux chemins : la première image
    // arrive après le montage, et un déplacement de la tête de lecture en pause
    // ne produit ni `timeupdate` utile ni trame.
    video.addEventListener('loadeddata', paintNow)
    video.addEventListener('seeked', paintNow)

    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const source = video as VideoToFrames
      let request = source.requestVideoFrameCallback(function next() {
        paintNow()
        request = source.requestVideoFrameCallback(next)
      })
      return () => {
        source.cancelVideoFrameCallback(request)
        video.removeEventListener('loadeddata', paintNow)
        video.removeEventListener('seeked', paintNow)
      }
    }

    video.addEventListener('timeupdate', paintNow)
    return () => {
      video.removeEventListener('timeupdate', paintNow)
      video.removeEventListener('loadeddata', paintNow)
      video.removeEventListener('seeked', paintNow)
    }
  }, [video])

  const time = useCaptionClock(video, captionCards !== undefined)

  return (
    <figure className={cn('flex min-h-0 min-w-0 flex-col gap-1.5', figureClassName)}>
      {/* **La légende est au-dessus, et pas sous l'image.** Les deux aperçus
          doivent avoir la même hauteur visuelle : une légende sous l'un et
          au-dessus de l'autre décalerait leurs cadres d'une ligne, ce qui est
          exactement la différence de poids qu'on cherche à supprimer.

          **Et elle nomme la sortie qu'elle montre.** C'est la variante 9:16,
          celle dont le cadre change de plan en plan et que personne ne règle ; le
          fichier natif, lui, garde un ratio unique et se choisit au sélecteur.
          Sans ce mot, l'aperçu qui bouge donne à croire que c'est lui qu'on
          pilote — et le sélecteur de ratio l'énonce en toutes lettres.

          **Une seule ligne, toujours.** `whitespace-nowrap` n'est pas de
          l'esthétique : les deux aperçus doivent avoir exactement la même
          hauteur, et une légende qui passerait à deux lignes sur l'un des deux
          déciderait seule laquelle des deux boîtes cadre est la plus haute. */}
      <figcaption className="shrink-0 truncate text-[0.75rem] text-muted-foreground">
        {isVariant ? 'variante 9:16' : 'fichier natif 9:16'} ·{' '}
        <span className="font-mono tabular-nums">{Math.round(part * 100)} %</span> · cadre{' '}
        <span className="font-mono">{split !== undefined ? 'split' : effective}</span>
      </figcaption>

      {/* Le cadre du téléphone. C'est lui qui donne l'échelle : le canvas y
          occupe la part que le ratio lui laisse, et rien d'autre ne le dit.

          **`self-start` reste, et c'est mesuré, pas recopié de l'ancien
          code.** La hauteur vient de `frame` (celle du volet, ou
          `PREVIEW_FRAME`'s repli en dessous du seuil `workbench`), et
          `aspect-ratio` en déduit la largeur — mais seulement si l'axe
          transversal (la largeur, ici, puisque la figure est en colonne)
          n'est pas étiré. Sans `self-start`, mesuré dans un vrai Chrome :
          `align-items: stretch` l'emportait sur `aspect-ratio`, la largeur
          valait la largeur du volet entier quelle que soit la hauteur, et
          `aspect-ratio` en déduisait la hauteur *depuis cette largeur-là* —
          exactement le sens inverse de celui voulu, et invisible tant qu'on
          ne mesure pas les deux dimensions à la fois. Aucun `max-width`
          n'entre en jeu : c'est la condition de recette du lot, tenue. */}
      <div
        className={cn(
          'relative flex min-h-0 self-start overflow-hidden rounded-lg bg-zinc-950 ring-1 ring-border',
          'items-center justify-center',
          frame ?? 'w-40',
        )}
        // **`containerType: 'size'` sur cette boîte, pas ailleurs.** C'est le
        // contexte de requête de conteneur que `HookOverlay` lit pour ses
        // unités `cqw`/`cqh` : le calque doit couvrir le 9:16 complet, pas la
        // part que le canvas occupe, donc son repère est cette boîte-ci et
        // non le canvas lui-même.
        style={{ aspectRatio: String(RATIOS['9:16']), containerType: 'size' }}
      >
        <canvas
          ref={canvas}
          width={width}
          height={hauteur}
          aria-hidden
          className="w-full"
          style={{ height: `${part * 100}%` }}
        />
        {/* **Calque frère du canvas, jamais peint dedans.** Le canvas ne
            porte que l'image vidéo cadrée — `part * 100 %` de cette boîte —
            alors que le hook s'incruste sur le 9:16 complet, bandes floutées
            comprises. Le peindre dans le canvas l'enfermerait dans la bande
            centrale et le ferait sauter de place à chaque changement de
            ratio. */}
        {hook !== undefined && <HookOverlay hook={hook} />}
        {captionCards !== undefined && captionStyle !== undefined && segments !== undefined && (
          <CaptionOverlay
            cards={captionCards}
            time={elapsedInClip(segments, time) ?? -1}
            style={captionStyle}
          />
        )}
      </div>
    </figure>
  )
}

/**
 * `requestVideoFrameCallback` n'est pas dans la bibliothèque DOM de TypeScript.
 * Le type est local, et la présence se contrôle sur le prototype avant l'appel.
 */
type VideoToFrames = HTMLVideoElement & {
  requestVideoFrameCallback: (rappel: () => void) => number
  cancelVideoFrameCallback: (request: number) => void
}
