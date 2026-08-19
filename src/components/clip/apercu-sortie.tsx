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
const PETIT_CÔTÉ = 270

/**
 * La part de la hauteur d'un écran 9:16 qu'occupe un contenu de ce ratio.
 *
 * C'est le chiffre que le sélecteur de ratio demandait d'imaginer, et il n'est
 * pas intuitif : passer de 1:1 à 4:5 gagne un quart d'écran de plus, alors que
 * les deux rectangles se ressemblent sur une image couchée.
 */
export function partDeLEcran(ratio: Ratio): number {
  return RATIOS['9:16'] / RATIOS[ratio]
}

/**
 * Peint une image du canevas de sortie.
 *
 * **La géométrie est celle du rendu, pas une approximation.** `cropRect` est la
 * fonction que ffmpeg suivra : l'aperçu montre donc le cadre exact, pas un
 * cadre qui lui ressemble.
 */
export function peindreSortie(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  { ratio, cropX, largeur, hauteur }: { ratio: Ratio; cropX: number; largeur: number; hauteur: number },
): void {
  const { videoWidth, videoHeight } = video
  // Le proxy se charge en requêtes partielles : le premier rendu tombe avant les
  // métadonnées, et `drawImage` sur une source de 0x0 lève une `InvalidStateError`.
  if (videoWidth <= 0 || videoHeight <= 0 || largeur <= 0 || hauteur <= 0) return

  const cadre = cropRect(ratio, cropX, videoWidth, videoHeight)
  ctx.drawImage(video, cadre.x, cadre.y, cadre.w, cadre.h, 0, 0, largeur, hauteur)
}

/** La taille du canevas, dans le rapport du rendu et au quart de sa définition. */
function tailleDuCanevas(ratio: Ratio): { largeur: number; hauteur: number } {
  const { w, h } = outputSize(ratio)
  const échelle = PETIT_CÔTÉ / Math.min(w, h)
  return { largeur: Math.round(w * échelle), hauteur: Math.round(h * échelle) }
}

export function ApercuSortie({
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
  const plan = useCurrentShot(framing)
  const position = isComputedFraming(framing) ? (plan?.cropX ?? 0.5) : cropX
  const effectif = effectiveRatio(plan, ratio)
  const { largeur, hauteur } = tailleDuCanevas(effectif)
  const part = partDeLEcran(effectif)

  const peindre = useCallback(() => {
    const cible = canvas.current
    if (cible === null || video === null) return
    const ctx = cible.getContext('2d')
    if (ctx === null) return
    peindreSortie(ctx, video, { ratio: effectif, cropX: position, largeur, hauteur })
  }, [video, effectif, position, largeur, hauteur])

  // **Le premier des deux déclencheurs, et le plus important.** Tout changement
  // de crop ou de ratio repeint sur l'image courante : le geste réel est « on
  // met en pause, on regarde, on ajuste », et une vidéo en pause ne produit
  // aucune image, donc aucun `requestVideoFrameCallback`. Ne câbler que le
  // callback livrerait un aperçu qui ne bouge pas quand on déplace le rectangle,
  // sur l'écran dont c'est la seule raison d'être. (relevé par Aristarque)
  useEffect(() => {
    peindre()
  }, [peindre])

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
  const peindreRef = useRef(peindre)
  useEffect(() => {
    peindreRef.current = peindre
  }, [peindre])

  useEffect(() => {
    if (video === null) return
    const peindreMaintenant = () => peindreRef.current()

    // `loadeddata` et `seeked` valent pour les deux chemins : la première image
    // arrive après le montage, et un déplacement de la tête de lecture en pause
    // ne produit ni `timeupdate` utile ni trame.
    video.addEventListener('loadeddata', peindreMaintenant)
    video.addEventListener('seeked', peindreMaintenant)

    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const source = video as VideoÀTrames
      let demande = source.requestVideoFrameCallback(function suivante() {
        peindreMaintenant()
        demande = source.requestVideoFrameCallback(suivante)
      })
      return () => {
        source.cancelVideoFrameCallback(demande)
        video.removeEventListener('loadeddata', peindreMaintenant)
        video.removeEventListener('seeked', peindreMaintenant)
      }
    }

    video.addEventListener('timeupdate', peindreMaintenant)
    return () => {
      video.removeEventListener('timeupdate', peindreMaintenant)
      video.removeEventListener('loadeddata', peindreMaintenant)
      video.removeEventListener('seeked', peindreMaintenant)
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
      <figcaption className="text-center text-[0.75rem] text-muted-foreground">
        variante 9:16 · <span className="font-mono tabular-nums">{Math.round(part * 100)} %</span> ·
        cadre <span className="font-mono">{effectif}</span>
      </figcaption>

      {/* Le cadre du téléphone. C'est lui qui donne l'échelle : le canvas y
          occupe la part que le ratio lui laisse, et rien d'autre ne le dit. */}
      {/* **`self-center`, et ce n'est pas un réglage d'esthétique.** Cette boîte
          est l'enfant d'un conteneur `flex-col`, donc étirée en largeur par
          défaut : la largeur imposée l'emportait sur `aspect-ratio`, qui en
          déduisait la hauteur, et le « 9:16 » n'était plus un 9:16 — l'aperçu
          mentait sur la seule chose qu'il existe pour montrer. Désétirée, sa largeur
          redevient automatique et se déduit de la hauteur et du rapport — et les
          deux aperçus s'alignent par le haut, comme deux vues qui se valent. */}
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
          width={largeur}
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
type VideoÀTrames = HTMLVideoElement & {
  requestVideoFrameCallback: (rappel: () => void) => number
  cancelVideoFrameCallback: (demande: number) => void
}
