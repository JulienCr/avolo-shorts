'use client'

import { Pause, Play, VideoOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { Segment } from '@/core/edl'
import { playbackAction } from '@/lib/editing'
import { formatTimecode } from '@/lib/format'
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

  const coupes = Math.max(0, segments.length - 1)
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

  // Une coupe doit se voir tout de suite — **même en pause**. Sans cette
  // seconde condition, la tête de lecture restait affichée au milieu d'un
  // passage qu'on venait de retirer jusqu'à la reprise : le lecteur se recalait
  // bien, mais le nombre affiché mentait entre-temps.
  useEffect(() => {
    surTemps()
  }, [surTemps])

  function basculer() {
    const v = video.current
    if (!v) return
    if (v.paused) {
      // Une coupe faite pendant la pause peut avoir retiré le passage sous la
      // tête de lecture. On reprend alors au segment suivant, pas au début du
      // clip : revenir au début à chaque reprise obligerait à réécouter tout ce
      // qu'on vient de valider.
      const action = playbackAction(segments, v.currentTime)
      if (action.kind === 'seek') v.currentTime = action.to
      else if (action.kind === 'end') v.currentTime = debut
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
          <div className="flex size-full items-center justify-center text-zinc-700">
            <VideoOff className="size-6" aria-hidden />
          </div>
        )}

        {overlay}
      </div>

      {/* Sans proxy, pas de transport : un bouton désactivé et une position à
          `0:00:00` prétendraient qu'il y a quelque chose à lire. */}
      {proxyUrl ? (
        <>
          <div className="flex items-center gap-2">
            <Button
              size="icon-sm"
              variant="outline"
              onClick={basculer}
              disabled={segments.length === 0}
              aria-label={enLecture ? 'Mettre en pause' : 'Lire'}
            >
              {enLecture ? <Pause aria-hidden /> : <Play aria-hidden />}
            </Button>

            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {formatTimecode(position)}
            </span>
          </div>

          {/* La durée n'est pas répétée ici : elle vit au-dessus du transcript,
              là où les coupes se font. Deux fois le même nombre, c'est un de
              trop. */}
          {coupes > 0 && (
            <p className="text-[0.7rem] text-muted-foreground">
              {coupes === 1
                ? 'La lecture saute le passage retiré'
                : `La lecture saute les ${coupes} passages retirés`}{' '}
              — l’à-coup est normal ici, il n’existe pas au rendu.
            </p>
          )}
        </>
      ) : (
        <p className="text-[0.7rem] text-muted-foreground">
          Le proxy n’a pas encore été construit. Le cadrage se règle quand même : le rectangle
          suit le ratio choisi.
        </p>
      )}
    </div>
  )
}
