'use client'

import { Film, Play } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'

import { aggregatePublicationStatus, PLANNING_AGGREGATE_LABELS, statusesOnly } from '@/core/planning'
import { hasSchedulablePlatform, PLATFORMS } from '@/core/publication'
import type { PlanningPoolClip } from '@/lib/api'
import { formatDuration } from '@/lib/format'
import { linkClip } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { AGGREGATE_BADGE_VARIANT, StaleRenderBadge } from '@/components/planning/publication-detail'
import { formatShowOrigin } from '@/components/planning/texts'

/**
 * Une carte du vivier : vignette, état de publication, et deux actions.
 *
 * **Les deux boutons restent dans le DOM et focusables sans survol** — « une
 * bulle qui n'apparaît qu'au survol est invisible au clavier »
 * (`candidate-card.tsx`). Seule leur opacité suit le survol et le focus.
 *
 * **La case ne s'affiche que sur un clip programmable** : sans plateforme
 * libre, `POST /api/planning/schedule` rend 400.
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
  const statuses = statusesOnly(clip.statuses)
  const schedulable = hasSchedulablePlatform(statuses)
  // `aggregatePublicationStatus` n'agrège que les lignes reçues : sur un objet
  // vide il rend `'planned'`, et sur un clip parti vers une seule plateforme
  // il rend `'published'`. Une plateforme sans ligne n'est pas partie.
  const rows = Object.keys(clip.statuses).length
  const reduced = rows > 0 ? aggregatePublicationStatus(statuses) : null
  const claimsDone = reduced === 'published' || reduced === 'submitted'
  const aggregate = claimsDone && rows < PLATFORMS.length ? 'partial' : reduced

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
      <div className="relative aspect-[9/16] overflow-hidden bg-zinc-950">
        <Thumbnail url={clip.thumbnailUrl} title={clip.title} />

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/85 to-transparent p-2 pt-8">
          <span className="text-xs text-white/80">{formatShowOrigin(clip.projectId)}</span>
          <span className="rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-xs font-medium text-white tabular-nums">
            {formatDuration(clip.duration)}
          </span>
        </div>

        {schedulable && (
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
        )}

        {/* Centré, pas ancré à un coin : à sept colonnes le bandeau ancré à
            droite chevauchait la case (mesuré : −54 px). `pointer-events-none`
            ici évite que son emprise vide n'intercepte les clics vers elle. */}
        <div
          className={cn(
            'pointer-events-none absolute inset-0 flex items-center justify-center p-2 opacity-0 transition-opacity',
            'group-hover/card:opacity-100 group-focus-within/card:opacity-100 hoverless:opacity-100',
          )}
        >
          {/* `flex-wrap` sans largeur fixée : le bandeau (164 px) déborde
              encore d'une carte de 119 px même centré, donc les boutons
              s'empilent dès que la place manque. Le fond ne mord que sur eux. */}
          <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1.5 rounded-lg bg-black/55 p-1.5 backdrop-blur-sm">
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
      </div>

      <div className="flex flex-col gap-1.5 p-3">
        <p className="line-clamp-2 text-sm font-medium">{clip.title || clip.clipId}</p>
        {(aggregate !== null || clip.stale) && (
          <div className="flex flex-wrap gap-1.5">
            {aggregate !== null && (
              <Badge variant={AGGREGATE_BADGE_VARIANT[aggregate]} className="w-fit">
                {PLANNING_AGGREGATE_LABELS[aggregate]}
              </Badge>
            )}
            {clip.stale && <StaleRenderBadge />}
          </div>
        )}
      </div>
    </article>
  )
}

/**
 * La vignette, ou son absence.
 *
 * **`urlVignette(clip, true)` publie l'URL sur la seule foi de la livraison**,
 * sans sonder le disque (`src/server/views.ts`) : une affiche jamais rendue,
 * ou un rendu supprimé entre la liste et le chargement, y donne un 404. Le
 * repli suit donc `clip-strip.tsx` — l'URL en échec est retenue en état
 * plutôt qu'un booléen, pour ne pas la confondre avec celle du clip suivant.
 */
function Thumbnail({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  const hasImage = url !== null && failed !== url

  if (hasImage) {
    // Les vignettes sont extraites du proxy par une route locale, à une
    // taille déjà connue : `next/image` n'aurait rien à optimiser et
    // demanderait une configuration de domaines pour rien.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={title}
        className="size-full object-cover"
        loading="lazy"
        onError={() => setFailed(url)}
      />
    )
  }

  return (
    <div className="flex size-full flex-col items-center justify-center gap-1.5 px-3 text-center text-zinc-500">
      <Film className="size-5" aria-hidden />
      <span className="text-xs tracking-wide">vignette indisponible</span>
    </div>
  )
}
