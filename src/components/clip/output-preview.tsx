'use client'

import { useCallback, useEffect, useRef } from 'react'

import { isComputedFraming, effectiveRatio, useCurrentShot } from '@/components/clip/framing'
import type { Ratio } from '@/core/edl'
import { RATIOS, cropRect, outputSize } from '@/core/framing'
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
 * **La géométrie est celle du rendu, pas une approximation.** `cropRect` est la
 * fonction que ffmpeg suivra : l'aperçu montre donc le cadre exact, pas un
 * cadre qui lui ressemble.
 */
export function paintOutput(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  { ratio, cropX, width, hauteur }: { ratio: Ratio; cropX: number; width: number; hauteur: number },
): void {
  const { videoWidth, videoHeight } = video
  // Le proxy se charge en requêtes partielles : le premier rendu tombe avant les
  // métadonnées, et `drawImage` sur une source de 0x0 lève une `InvalidStateError`.
  if (videoWidth <= 0 || videoHeight <= 0 || width <= 0 || hauteur <= 0) return

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
  frame,
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
   * La boîte du téléphone, dimensionnée par l'appelant.
   *
   * **Elle existe pour que les deux aperçus aient exactement la même hauteur.**
   * Cet aperçu était bridé à `max-w-40` pendant que la source prenait la largeur
   * restante : la différence de ratio devenait une différence de poids visuel,
   * et la sortie — la seule des deux qui montre le résultat — passait pour
   * l'illustration de l'autre. La hauteur se donne donc au même endroit pour les
   * deux, et chacun en déduit sa largeur.
   */
  frame?: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  // Le plan sous la lecture : le cadre saute à ses frontières, ici comme dans le
  // rendu. Le `hook` rend un index, donc ce composant ne se re-rend qu'aux
  // frontières et non à chaque `timeupdate`.
  const shot = useCurrentShot(framing)
  const position = isComputedFraming(framing) ? (shot?.cropX ?? 0.5) : cropX
  const effective = effectiveRatio(shot, ratio)
  const { width, hauteur } = canvasSize(effective)
  const part = lScreenPart(effective)
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
    paintOutput(ctx, video, { ratio: effective, cropX: position, width, hauteur })
  }, [video, effective, position, width, hauteur])

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

  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      {/* **La légende est au-dessus, et pas sous l'image.** Les deux aperçus
          doivent avoir la même hauteur visuelle : une légende sous l'un et
          au-dessus de l'autre décalerait leurs cadres d'une ligne, ce qui est
          exactement la différence de poids qu'on cherche à supprimer.

          **Et elle nomme la sortie qu'elle montre.** C'est la variante 9:16,
          celle dont le cadre change de plan en plan et que personne ne règle ; le
          fichier natif, lui, garde un ratio unique et se choisit au sélecteur.
          Sans ce mot, l'aperçu qui bouge donne à croire que c'est lui qu'on
          pilote — et le sélecteur de ratio l'énonce en toutes lettres.

          Elle reste **plus courte que la boîte n'est large**, et ce n'est pas de
          la coquetterie : la figure prend la largeur du plus large de ses
          enfants, donc une légende bavarde élargit la colonne et décolle
          l'aperçu de la source d'à côté. */}
      <figcaption className="text-[0.75rem] text-muted-foreground">
        {isVariant ? 'variante 9:16' : 'fichier natif 9:16'} ·{' '}
        <span className="font-mono tabular-nums">{Math.round(part * 100)} %</span> · cadre{' '}
        <span className="font-mono">{effective}</span>
      </figcaption>

      {/* Le cadre du téléphone. C'est lui qui donne l'échelle : le canvas y
          occupe la part que le ratio lui laisse, et rien d'autre ne le dit. */}
      {/* **`self-center`, et ce n'est pas un réglage d'esthétique.** Cette boîte
          est l'enfant d'un conteneur `flex-col`, donc étirée en largeur par
          défaut : la largeur imposée l'emportait sur `aspect-ratio`, qui en
          déduisait la hauteur, et le « 9:16 » n'était plus un 9:16 — l'aperçu
          mentait sur la seule chose qu'il existe pour montrer. Désétirée par `self-start`,
          sa largeur redevient automatique et se déduit de la hauteur et du
          rapport — et les deux aperçus s'alignent par le haut *et* par la gauche,
          comme deux vues qui se valent. La légende suit le même bord : centrée,
          elle flottait au-dessus d'une boîte alignée à gauche. */}
      <div
        className={cn(
          'relative flex shrink-0 self-start overflow-hidden rounded-lg bg-zinc-950 ring-1 ring-border',
          'items-center justify-center',
          frame ?? 'w-40',
        )}
        style={{ aspectRatio: String(RATIOS['9:16']) }}
      >
        <canvas
          ref={canvas}
          width={width}
          height={hauteur}
          aria-hidden
          className="w-full"
          style={{ height: `${part * 100}%` }}
        />
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
