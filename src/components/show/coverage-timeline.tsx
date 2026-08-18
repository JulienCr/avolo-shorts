'use client'

import { Film } from 'lucide-react'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { clipDuration } from '@/core/edl'
import { blockGeometry, fractionOf, placeInLanes, spanOf, timeAtClick } from '@/core/coverage'
import type { CandidateClip } from '@/lib/api'
import { LIBELLES_STATUT } from '@/lib/clip-status'
import { formatDuration, formatTimecode } from '@/lib/format'
import { lienClip } from '@/lib/parcours'
import { cn } from '@/lib/utils'

/**
 * La bande de couverture : **ce qui a été extrait de l'émission, et où**.
 *
 * Elle répond à trois questions d'un coup d'œil, dont deux qu'aucun écran ne
 * savait poser : ce qu'on a tiré de cette émission, à quel endroit, et ce qui
 * reste inexploité. Elle sert aussi de navigation — un clic sur un bloc ouvre
 * son clip — et de barre de position — un clic ailleurs y déplace la lecture.
 *
 * **En lecture seule, et c'est ce qui la distingue d'un banc de montage.** La
 * conception §13 écarte nommément « toute la famille timeline multi-pistes,
 * waveforms et playhead » : la surface d'édition est le transcript, et
 * construire un NLE reviendrait à bâtir le morceau le plus difficile du métier
 * pour un produit qui ne s'en sert pas. Rien ne se déplace ici, rien ne se
 * coupe, rien ne s'étire. La §13 porte l'arbitrage explicitement, faute de quoi
 * le lecteur suivant y verrait une contradiction.
 *
 * **Les chevauchements se voient.** Deux candidats issus de la même scène se
 * recouvrent régulièrement — le repérage propose des fenêtres qui se chevauchent
 * d'une trentaine de secondes —, et sur une seule ligne le second efface le
 * premier. `placeInLanes` (`@/core/coverage`, pur) les répartit sur le nombre
 * minimal de voies.
 */
export function CoverageTimeline({
  clips,
  durationSec,
  time,
  onSeek,
}: {
  /** Les clips **gardés**. Les propositions et les écartés n'ont rien extrait. */
  clips: readonly CandidateClip[]
  /** La durée de l'émission, en secondes. */
  durationSec: number
  /** L'instant courant du lecteur, en secondes. */
  time: number
  /** Déplacer la lecture. `null` quand il n'y a pas de proxy à déplacer. */
  onSeek: ((seconds: number) => void) | null
}) {
  const { placed, lanes } = placeInLanes(clips, (clip) => spanOf(clip.segments))

  if (durationSec <= 0) {
    return (
      <p className="text-xs text-muted-foreground">
        La durée de l’émission n’est pas encore connue : elle est sondée à
        l’ingestion.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div
        data-testid="coverage-timeline"
        role="group"
        aria-label="Couverture de l’émission par les clips gardés"
        // **Un clic hors bloc déplace la lecture.** C'est la demande explicite
        // du retour d'usage, et c'est aussi ce qui rend la bande utile quand
        // rien n'a encore été extrait : elle reste une barre de position sur
        // toute la durée. Les blocs sont des liens posés dessus, donc leur clic
        // ne descend pas jusqu'ici.
        onClick={(e) => {
          if (onSeek === null) return
          const rect = e.currentTarget.getBoundingClientRect()
          onSeek(timeAtClick(e.clientX - rect.left, rect.width, durationSec))
        }}
        className={cn(
          'relative w-full overflow-hidden rounded-md border bg-muted/50',
          onSeek !== null && 'cursor-pointer',
        )}
        style={{ height: `calc(var(--spacing) * 6 * ${Math.max(1, lanes)} + 2px)` }}
      >
        {placed.map(({ item, interval, lane }) => {
          const { left, width } = blockGeometry(interval, durationSec)
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger
                render={
                  <Link
                    href={lienClip(item.id)}
                    data-clip={item.id}
                    aria-label={`${item.title} — ${formatTimecode(interval.start)} à ${formatTimecode(interval.end)}`}
                    // `min-w` plutôt qu'une largeur élargie dans le calcul :
                    // élargir en amont ferait glisser le bord gauche de tout ce
                    // qui suit, alors qu'un bloc de trente secondes sur une
                    // heure quarante ne fait que six pixels et doit rester
                    // cliquable là où il est.
                    className={cn(
                      'absolute flex min-w-[3px] items-center overflow-hidden rounded-sm border outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      item.status === 'exported'
                        ? 'border-stage bg-stage/80'
                        : 'border-stage/70 bg-stage/40 hover:bg-stage/60',
                    )}
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      top: `calc(var(--spacing) * 6 * ${lane} + 1px)`,
                      height: 'calc(var(--spacing) * 6 - 2px)',
                    }}
                  />
                }
              />
              <TooltipContent className="max-w-72 p-0">
                <ClipSummary clip={item} start={interval.start} end={interval.end} />
              </TooltipContent>
            </Tooltip>
          )
        })}

        {/* **La tête de lecture, un filet et rien de plus.** Elle dit où l'on en
            est dans l'émission, ce qui est la seule chose qui relie le lecteur
            à la bande. `aria-hidden` : la position est déjà annoncée par les
            contrôles du lecteur, et une seconde source la dirait deux fois. */}
        <div
          aria-hidden
          data-testid="playhead"
          className="pointer-events-none absolute inset-y-0 w-px bg-foreground/70"
          style={{ left: `${fractionOf(time, durationSec) * 100}%` }}
        />
      </div>

      <p className="text-xs text-muted-foreground tabular-nums">
        {clips.length === 0
          ? 'Aucun clip gardé pour l’instant : la bande montrera ce qui aura été extrait.'
          : `${clips.length === 1 ? '1 clip gardé' : `${clips.length} clips gardés`} sur ${formatDuration(durationSec)} d’émission.`}
      </p>
    </div>
  )
}

/**
 * Ce qu'un bloc dit au survol — et au focus, parce que la primitive de bulle le
 * fait aussi : une information qui n'apparaît qu'à la souris est une information
 * que le clavier n'a pas.
 *
 * Vignette, titre, bornes, durée, état. La vignette vient du proxy
 * (`GET /api/clips/:id/thumb`) et vaut `null` tant qu'il n'est pas encodé — ce
 * qui est le cas exact où cette vue montre déjà que les images manquent.
 */
function ClipSummary({ clip, start, end }: { clip: CandidateClip; start: number; end: number }) {
  return (
    <div className="flex w-72 flex-col">
      <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-t-md bg-muted text-muted-foreground/40">
        <Film className="size-5" aria-hidden />
        {clip.thumbnailUrl !== null && (
          // Même raison que dans `candidate-card.tsx` : l'image sort d'une route
          // locale à une taille déjà fixée, `next/image` n'aurait rien à
          // optimiser et ajouterait un second décodage.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={clip.thumbnailUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 size-full object-cover"
          />
        )}
      </div>
      <div className="flex flex-col gap-1 p-2.5">
        <p className="text-sm font-medium">{clip.title || 'Sans titre'}</p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {formatTimecode(start)} → {formatTimecode(end)} · {formatDuration(clipDuration(clip.segments))}
        </p>
        <div>
          <Badge variant="secondary" className="text-xs">
            {LIBELLES_STATUT[clip.status]}
          </Badge>
        </div>
      </div>
    </div>
  )
}
