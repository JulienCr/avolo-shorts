'use client'

import { Pause, Play, VideoOff } from 'lucide-react'
import { useCallback, useEffect, useRef, type ReactNode } from 'react'

import type { Segment } from '@/core/edl'
import { usePlayback } from '@/components/clip/playback'
import { playbackAction } from '@/lib/editing'
import { formatTimecode } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * Ce qu'il faut d'un lecteur pour le piloter.
 *
 * Un type structurel plutôt que `HTMLVideoElement` : les deux fonctions
 * ci-dessous portent les règles du montage, et se testent alors sans monter un
 * élément que jsdom n'implémente qu'à moitié — `play()` y lève.
 */
export type Player = {
  currentTime: number
  paused: boolean
  play: () => Promise<void> | void
  pause: () => void
}

/**
 * Lecture ou pause, en tenant compte des passages retirés.
 *
 * Une coupe faite pendant la pause peut avoir retiré le passage sous la tête de
 * lecture. On reprend alors au segment suivant, pas au début du clip : revenir
 * au début à chaque reprise obligerait à réécouter tout ce qu'on vient de
 * valider.
 *
 * **Exportée parce que `Espace` la déclenche depuis l'écran**, et qu'un
 * raccourci qui appellerait `play()` directement perdrait cette règle.
 */
export function togglePlayback(player: Player | null, segments: Segment[]): void {
  if (player === null || segments.length === 0) return
  if (!player.paused) {
    player.pause()
    return
  }
  const action = playbackAction(segments, player.currentTime)
  if (action.kind === 'seek') player.currentTime = action.to
  else if (action.kind === 'end') player.currentTime = segments[0].start
  void player.play()
}

/**
 * Place la tête de lecture, en la ramenant dans le montage.
 *
 * C'est ce que fait un clic sur un mot. La position demandée peut tomber dans un
 * passage retiré — un mot barré au milieu du clip — et l'y laisser ferait
 * repartir la lecture d'un endroit qu'elle quitterait aussitôt, donc un à-coup
 * que personne n'a demandé.
 */
export function placePlayback(
  player: Player | null,
  segments: Segment[],
  position: number,
): void {
  if (player === null) return
  player.currentTime = position
  if (segments.length === 0) return
  const action = playbackAction(segments, position)
  if (action.kind === 'seek') player.currentTime = action.to
  else if (action.kind === 'end') player.currentTime = segments[0].start
}

/**
 * Le lecteur : le proxy, et le saut des passages retirés.
 *
 * À chaque `timeupdate`, si la position est sortie du segment courant, on saute
 * au début du suivant. Spec §16 : cela produit un à-coup à chaque saut,
 * acceptable pour juger un montage, pas pour valider un rendu — celui-ci sort de
 * ffmpeg (tâche 14), qui recolle vraiment les morceaux.
 *
 * **La position ne vit plus ici.** Elle change quatre fois par seconde et le
 * transcript en a besoin dans l'autre colonne : gardée en état local, elle
 * rendait le lecteur et sa superposition de cadrage à cette cadence, et le
 * surlignage du mot en cours aurait étendu le rendu à tout l'écran. Elle part
 * dans `usePlayback`, où seuls ses abonnés la lisent — ici, l'horloge et rien
 * d'autre.
 *
 * Le proxy n'existe pas tant que la tâche 11 ne le sert pas. L'emplacement est
 * tenu, au bon rapport d'aspect, et **le cadrage reste réglable sans lui** :
 * c'est ce que fait la superposition passée en `overlay`.
 *
 * **Ne rend que l'image, plus le transport en dessous.** Il portait les deux
 * jusqu'à l'établi (spec du 23 août, §3.3) : l'aperçu de sortie n'a pas de
 * transport, et empiler les deux dans la même rangée aurait rendu les deux
 * colonnes inégales — stables à la même hauteur totale, leurs images, elles,
 * n'auraient plus la même. `ClipTransport` porte maintenant le bouton et la
 * position, à partir du même élément vidéo, levé par `onVideo`.
 */
export function ClipPlayer({
  proxyUrl,
  segments,
  overlay,
  onVideo,
  frame,
}: {
  proxyUrl: string | null
  segments: Segment[]
  /** Superposé à l'image, en coordonnées de l'image. Le rectangle de cadrage. */
  overlay?: ReactNode
  /**
   * La boîte de l'image, dimensionnée par l'appelant.
   *
   * **Elle existe pour que les deux aperçus aient exactement la même hauteur.**
   * La source et la sortie doivent se valoir — voir la note de tête de
   * `output-preview.tsx`, qui porte la même prop pour la même raison, et qui
   * garde le détail de ce qu'un `max-width` casserait ici.
   */
  frame?: string
  /**
   * L'élément décodant, rendu à la page.
   *
   * **Un seul `<video>` décode** : le canevas de sortie se peint sur celui-ci
   * par `drawImage`, et `ClipTransport` pilote la lecture sur ce même élément.
   * Deux éléments sur la même source seraient plus courts à écrire et
   * décoderaient deux fois le même flux.
   */
  onVideo?: (video: HTMLVideoElement | null) => void
}) {
  const video = useRef<HTMLVideoElement>(null)

  // La position courante peut se retrouver hors du montage après une coupe :
  // on la ramène au début du clip plutôt que de laisser le lecteur sur un
  // passage qui n'existe plus.
  const onTime = useCallback(() => {
    const v = video.current
    if (!v) return
    const action = playbackAction(segments, v.currentTime)
    if (action.kind === 'seek') v.currentTime = action.to
    else if (action.kind === 'end') {
      v.pause()
      if (segments.length > 0) v.currentTime = segments[0].start
    }
    usePlayback.getState().definePosition(v.currentTime)
  }, [segments])

  // Une coupe doit se voir tout de suite — **même en pause**. Sans cette
  // seconde condition, la tête de lecture restait affichée au milieu d'un
  // passage qu'on venait de retirer jusqu'à la reprise : le lecteur se recalait
  // bien, mais le nombre affiché mentait entre-temps.
  useEffect(() => {
    onTime()
  }, [onTime])

  // **Rendu à la page par un effet, pas par la fonction de référence.** Sans
  // proxy il n'y a pas d'élément du tout, et une référence qui n'est jamais
  // posée ne s'annule jamais non plus : la page garderait l'élément du clip
  // précédent et le canevas peindrait la mauvaise vidéo.
  useEffect(() => {
    onVideo?.(video.current)
    return () => onVideo?.(null)
  }, [onVideo, proxyUrl])

  return (
    // **`self-start`, mesuré et retenu.** La figure qui enveloppe cette boîte
    // est en colonne ; sans `self-start`, `align-items: stretch` fixe la
    // largeur à celle de la figure quelle que soit la hauteur, et
    // `aspect-ratio` en déduit alors la hauteur *depuis cette largeur-là* —
    // le sens inverse de ce que `frame` demande. Voir la même note, avec les
    // chiffres, sur la boîte jumelle de `output-preview.tsx`.
    <div
      className={cn(
        'relative aspect-video self-start overflow-hidden rounded-lg bg-zinc-950',
        frame ?? 'w-full',
      )}
    >
      {proxyUrl ? (
        <video
          ref={video}
          src={proxyUrl}
          className="size-full object-contain"
          onTimeUpdate={onTime}
          onSeeked={onTime}
          onPlay={() => usePlayback.getState().definePlayback(true)}
          onPause={() => usePlayback.getState().definePlayback(false)}
          playsInline
        />
      ) : (
        <div className="flex size-full items-center justify-center text-zinc-700">
          <VideoOff className="size-6" aria-hidden />
        </div>
      )}

      {overlay}
    </div>
  )
}

/**
 * Le transport : lecture, position, ce que la lecture saute.
 *
 * **Séparé de `ClipPlayer`** (spec du 23 août, §3.3) : l'image est dans la
 * rangée qui se dimensionne sur la hauteur du volet, le transport est en
 * dessous, de hauteur propre. `video` est l'élément que `ClipPlayer` a levé
 * par `onVideo` — le même que le canevas de sortie peint.
 */
export function ClipTransport({
  video,
  proxyUrl,
  segments,
}: {
  video: Player | null
  proxyUrl: string | null
  segments: Segment[]
}) {
  const inPlayback = usePlayback((state) => state.inPlayback)
  const cuts = Math.max(0, segments.length - 1)

  // Sans proxy, pas de transport : un bouton désactivé et une position à
  // `0:00:00` prétendraient qu'il y a quelque chose à lire.
  if (!proxyUrl) {
    return (
      <p className="text-[0.75rem] text-muted-foreground">
        Le proxy n’a pas encore été construit. Le cadrage se règle quand même : le rectangle
        suit le ratio choisi.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Button
          size="icon-sm"
          variant="outline"
          onClick={() => togglePlayback(video, segments)}
          disabled={segments.length === 0}
          aria-label={inPlayback ? 'Mettre en pause' : 'Lire'}
        >
          {inPlayback ? <Pause aria-hidden /> : <Play aria-hidden />}
        </Button>

        <Position />
      </div>

      {/* La durée n'est pas répétée ici : elle vit dans les faits de montage,
          là où les coupes se font. Deux fois le même nombre, c'est un de trop. */}
      {cuts > 0 && (
        <p className="text-[0.75rem] text-muted-foreground">
          {cuts === 1
            ? 'La lecture saute le passage retiré'
            : `La lecture saute les ${cuts} passages retirés`}{' '}
          — l’à-coup est normal ici, il n’existe pas au rendu.
        </p>
      )}
    </div>
  )
}

/**
 * L'horloge, **seule abonnée à la position**.
 *
 * Un composant à part pour que les quatre changements par seconde ne rendent que
 * ces quelques caractères, et pas le lecteur, sa superposition de cadrage et ce
 * qui les entoure.
 */
function Position() {
  const position = usePlayback((state) => state.position)
  return (
    <span className="font-mono text-[0.75rem] text-muted-foreground tabular-nums">
      {formatTimecode(position)}
    </span>
  )
}
