'use client'

import { Check, Film, Scissors, Undo2, X } from 'lucide-react'
import Link from 'next/link'

import { clipDuration } from '@/core/edl'
import type { CandidateClip } from '@/lib/api'
import { LIBELLES_STATUT, estEcarte, estGarde } from '@/lib/clip-status'
import { formatDuration, formatTimecode } from '@/lib/format'
import { lienClip } from '@/lib/parcours'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

/**
 * Une carte de candidat.
 *
 * Spec §13 : « Trier 25 candidats occupe plus de temps que monter les trois qui
 * survivent, donc cet écran se soigne en premier. » Tout ce qui est ici sert à
 * décider en une seconde : ce que ça montre, combien de temps ça dure, ce que ça
 * raconte, et deux boutons.
 *
 * **La durée est une information, pas une contrainte.** Elle s'affiche parce
 * qu'un extrait de six minutes ne se publie pas comme un de quinze secondes, pas
 * parce qu'un seuil quelque part la refuserait. Elle est la somme des segments.
 */
export function CandidateCard({
  clip,
  onGarder,
  onEcarter,
}: {
  clip: CandidateClip
  onGarder: () => void
  onEcarter: () => void
}) {
  // Pas d'indicateur « écriture en vol » : la mise à jour est optimiste, donc la
  // carte affiche déjà la décision. Une pulsation par-dessus dirait qu'il se
  // passe quelque chose qu'on ne peut de toute façon pas attendre.
  const duree = clipDuration(clip.segments)
  const debut = clip.segments[0]?.start ?? 0
  const coupes = Math.max(0, clip.segments.length - 1)
  // La même définition que celle du gestionnaire de clic (`basculerStatut`) :
  // les deux divergeaient, et le bouton « Gardé » d'un clip exporté produisait
  // alors un changement d'état invisible.
  const garde = estGarde(clip.status)
  const ecarte = estEcarte(clip.status)

  return (
    <article
      className={cn(
        'group/carte flex flex-col overflow-hidden rounded-xl border bg-card transition-colors',
        garde && 'border-stage/60 ring-1 ring-stage/25',
        ecarte && 'opacity-55 hover:opacity-100',
      )}
    >
      <Link
        href={lienClip(clip.id)}
        className="relative block aspect-video overflow-hidden bg-zinc-950 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Vignette url={clip.thumbnailUrl} titre={clip.title} />

        {/* Sur l'image, en bas : la position dans le replay à gauche, la durée à
            droite. Deux nombres, jamais au même endroit qu'un texte. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/85 to-transparent p-2 pt-8">
          <span className="font-mono text-[0.68rem] tracking-tight text-white/70 tabular-nums">
            {formatTimecode(debut)}
          </span>
          <span className="rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-xs font-medium text-white tabular-nums">
            {formatDuration(duree)}
          </span>
        </div>

        {garde && (
          <span className="absolute top-2 left-2 flex items-center gap-1 rounded-md bg-stage px-1.5 py-0.5 text-[0.68rem] font-semibold text-stage-foreground capitalize">
            <Check className="size-3" aria-hidden />
            {LIBELLES_STATUT[clip.status]}
          </span>
        )}
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <Link
            href={lienClip(clip.id)}
            className="line-clamp-2 text-sm leading-snug font-medium text-balance outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {clip.title}
          </Link>
          <Badge variant="outline" className="shrink-0 font-mono text-[0.68rem]">
            {clip.ratio === 'auto' ? 'auto' : clip.ratio}
          </Badge>
        </div>

        <p className="line-clamp-3 text-[0.8rem] leading-relaxed text-muted-foreground">
          {clip.preview}
        </p>

        {coupes > 0 && (
          <p className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
            <Scissors className="size-3" aria-hidden />
            {coupes === 1 ? 'une coupe interne' : `${coupes} coupes internes`}
          </p>
        )}

        {/* Un clic, pas de boîte de dialogue. Et le même bouton reprend sa
            décision : un tri se corrige plus souvent qu'on ne le croit. */}
        <div className="mt-auto flex gap-1.5 pt-2">
          <Button
            size="sm"
            variant={garde ? 'default' : 'outline'}
            className={cn(
              'flex-1',
              garde && 'bg-stage text-stage-foreground hover:bg-stage/85',
            )}
            onClick={onGarder}
            aria-pressed={garde}
          >
            <Check aria-hidden />
            <span className="capitalize">{garde ? LIBELLES_STATUT[clip.status] : 'Garder'}</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="flex-1 text-muted-foreground"
            onClick={onEcarter}
            aria-pressed={ecarte}
          >
            {ecarte ? <Undo2 aria-hidden /> : <X aria-hidden />}
            {ecarte ? 'Remettre' : 'Écarter'}
          </Button>
        </div>
      </div>
    </article>
  )
}

/**
 * La vignette, ou son absence.
 *
 * Les fichiers n'existent pas encore : ils viendront de la tâche 12, étape 1,
 * extraits **du proxy** au premier segment. En attendant, l'emplacement est
 * tenu — au bon rapport d'aspect, pour que la grille ne bouge pas d'un pixel le
 * jour où les images arrivent — et le repli dit pourquoi il est là.
 */
function Vignette({ url, titre }: { url: string | null; titre: string }) {
  if (url) {
    // Les vignettes sont extraites du proxy par une route locale, à une taille
    // déjà connue : `next/image` n'aurait rien à optimiser et demanderait une
    // configuration de domaines pour rien.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt={titre} className="size-full object-cover" loading="lazy" />
    )
  }

  return (
    <div className="flex size-full flex-col items-center justify-center gap-1.5 text-zinc-600">
      <Film className="size-5" aria-hidden />
      <span className="text-[0.68rem] tracking-wide">vignette en attente du proxy</span>
    </div>
  )
}
