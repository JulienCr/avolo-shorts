'use client'

import { Film, Play } from 'lucide-react'
import Link from 'next/link'

import type { PlanningPoolClip } from '@/lib/api'
import { formatDuration } from '@/lib/format'
import { linkClip } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { Button, buttonVariants } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { formatShowOrigin } from '@/components/planning/texts'

/**
 * Une carte du vivier : vignette, case de sélection, et deux actions.
 *
 * **Les deux boutons restent dans le DOM et focusables sans survol** — « une
 * bulle qui n'apparaît qu'au survol est invisible au clavier »
 * (`candidate-card.tsx`). Seule leur opacité suit le survol, le focus dans la
 * carte, et l'absence de survol (tactile, `hoverless:`).
 */
export function PoolCard({
  clip,
  selected,
  current,
  onToggle,
  onPreview,
  onFocus,
}: {
  clip: PlanningPoolClip
  selected: boolean
  /** La carte sur laquelle le clavier travaille : `tabIndex` glissant sur tous ses contrôles. */
  current: boolean
  onToggle: () => void
  onPreview: () => void
  onFocus: () => void
}) {
  const tabIndex = current ? 0 : -1

  return (
    <article
      data-clip={clip.clipId}
      aria-label={clip.title || clip.clipId}
      tabIndex={tabIndex}
      onFocus={onFocus}
      className={cn(
        'group/card flex flex-col overflow-hidden rounded-xl border bg-card outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'border-stage/60 ring-1 ring-stage/25',
      )}
    >
      <div className="relative aspect-video overflow-hidden bg-zinc-950">
        <Thumbnail url={clip.thumbnailUrl} title={clip.title} />

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/85 to-transparent p-2 pt-8">
          <span className="text-xs text-white/80">{formatShowOrigin(clip.projectId)}</span>
          <span className="rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-xs font-medium text-white tabular-nums">
            {formatDuration(clip.duration)}
          </span>
        </div>

        <div className="absolute top-2 left-2 z-10">
          <Checkbox
            checked={selected}
            tabIndex={tabIndex}
            onCheckedChange={() => {
              onToggle()
              onFocus()
            }}
            aria-label={`Sélectionner « ${clip.title || clip.clipId} »`}
          />
        </div>

        <div
          className={cn(
            'absolute top-2 right-2 flex items-center gap-1.5 opacity-0 transition-opacity',
            'group-hover/card:opacity-100 group-focus-within/card:opacity-100 hoverless:opacity-100',
          )}
        >
          <Button size="sm" onClick={onPreview} tabIndex={tabIndex}>
            <Play aria-hidden />
            Aperçu
          </Button>
          <Link
            href={linkClip(clip.clipId)}
            tabIndex={tabIndex}
            className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
          >
            <Film aria-hidden />
            Éditer
          </Link>
        </div>
      </div>

      <div className="p-3">
        <p className="line-clamp-2 text-sm font-medium">{clip.title || clip.clipId}</p>
      </div>
    </article>
  )
}

/**
 * La vignette, ou son absence.
 *
 * Un clip du vivier est exporté : le proxy est donc normalement présent, et
 * une vignette manquante ici est une anomalie, pas une attente à venir —
 * contrairement à `Vignette` dans `candidate-card.tsx`.
 */
function Thumbnail({ url, title }: { url: string | null; title: string }) {
  if (url !== null) {
    // Les vignettes sont extraites du proxy par une route locale, à une
    // taille déjà connue : `next/image` n'aurait rien à optimiser et
    // demanderait une configuration de domaines pour rien.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt={title} className="size-full object-cover" loading="lazy" />
    )
  }

  return (
    <div className="flex size-full flex-col items-center justify-center gap-1.5 px-3 text-center text-zinc-500">
      <Film className="size-5" aria-hidden />
      <span className="text-xs tracking-wide">vignette indisponible</span>
    </div>
  )
}
