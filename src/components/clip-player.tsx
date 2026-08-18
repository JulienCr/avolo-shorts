'use client'

import { Pause, Play, VideoOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { Segment } from '@/core/edl'
import { clipDuration } from '@/core/edl'
import { playbackAction } from '@/lib/editing'
import { formatDuration, formatTimecode } from '@/lib/format'
import { Button } from '@/components/ui/button'

/**
 * Le lecteur : le proxy, et le saut des passages retirés.
 *
 * À chaque `timeupdate`, si la position est sortie du segment courant, on saute
 * au début du suivant. Spec §16 : cela produit un à-coup à chaque saut,
 * acceptable pour juger un montage, pas pour valider un rendu — celui-ci sort de
 * ffmpeg (tâche 14), qui recolle vraiment les morceaux.
 *
 * Le proxy n'existe pas tant que la tâche 11 ne le sert pas. L'emplacement est
 * tenu, au bon rapport d'aspect, et **le cadrage reste réglable sans lui** :
 * c'est ce que fait la superposition passée en `overlay`.
 */
export function ClipPlayer({
  proxyUrl,
  segments,
  overlay,
}: {
  proxyUrl: string | null
  segments: Segment[]
  /** Superposé à l'image, en coordonnées de l'image. Le rectangle de cadrage. */
  overlay?: ReactNode
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [position, setPosition] = useState(segments[0]?.start ?? 0)
  const [enLecture, setEnLecture] = useState(false)

  const duree = clipDuration(segments)
  const debut = segments[0]?.start ?? 0

  // La position courante peut se retrouver hors du montage après une coupe :
  // on la ramène au début du clip plutôt que de laisser le lecteur sur un
  // passage qui n'existe plus.
  const surTemps = useCallback(() => {
    const v = video.current
    if (!v) return
    const action = playbackAction(segments, v.currentTime)
    if (action.kind === 'seek') v.currentTime = action.to
    else if (action.kind === 'end') {
      v.pause()
      if (segments.length > 0) v.currentTime = debut
    }
    setPosition(v.currentTime)
  }, [segments, debut])

  // Une coupe faite pendant la lecture doit se voir tout de suite.
  useEffect(() => {
    if (enLecture) surTemps()
  }, [enLecture, surTemps])

  function basculer() {
    const v = video.current
    if (!v) return
    if (v.paused) {
      if (playbackAction(segments, v.currentTime).kind !== 'play') v.currentTime = debut
      void v.play()
    } else {
      v.pause()
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-zinc-950">
        {proxyUrl ? (
          <video
            ref={video}
            src={proxyUrl}
            className="size-full object-contain"
            onTimeUpdate={surTemps}
            onPlay={() => setEnLecture(true)}
            onPause={() => setEnLecture(false)}
            playsInline
          />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-zinc-600">
            <VideoOff className="size-6" aria-hidden />
            <p className="text-xs">Le proxy n’a pas encore été construit.</p>
            <p className="max-w-[24rem] text-center text-[0.7rem] text-zinc-700">
              Le cadrage se règle quand même : le rectangle ci-dessous suit le ratio choisi.
            </p>
          </div>
        )}

        {overlay}
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="icon-sm"
          variant="outline"
          onClick={basculer}
          disabled={!proxyUrl || segments.length === 0}
          aria-label={enLecture ? 'Mettre en pause' : 'Lire'}
        >
          {enLecture ? <Pause aria-hidden /> : <Play aria-hidden />}
        </Button>

        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {formatTimecode(position)}
        </span>

        <span className="ml-auto flex items-baseline gap-1.5">
          <span className="text-[0.7rem] text-muted-foreground">durée</span>
          <span className="font-mono text-base font-medium text-stage-foreground tabular-nums">
            {formatDuration(duree)}
          </span>
        </span>
      </div>

      {segments.length > 1 && (
        <p className="text-[0.7rem] text-muted-foreground">
          La lecture saute les {segments.length - 1} passage
          {segments.length > 2 ? 's retirés' : ' retiré'} — l’à-coup est normal ici, il n’existe
          pas au rendu.
        </p>
      )}
    </div>
  )
}
