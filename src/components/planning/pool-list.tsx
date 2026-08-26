'use client'

import { useRef, useState } from 'react'

import type { PlanningPoolClip } from '@/lib/api'
import { formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Checkbox } from '@/components/ui/checkbox'
import { formatShowOrigin } from '@/components/planning/texts'

/**
 * Le vivier : la liste des clips exportés, transversale aux émissions, à
 * cocher avant de dater (spec §5.3).
 *
 * **Sélection copiée de `ReviewFeed`** (`src/components/review/feed.tsx`), pas
 * réinventée : un `Set` local, la case en superposition, un `tabIndex` glissant
 * pour ne pas ajouter un arrêt Tab par ligne visible.
 */
export function PoolList({
  clips,
  selected,
  onToggle,
}: {
  clips: readonly PlanningPoolClip[]
  selected: ReadonlySet<string>
  onToggle: (clipId: string) => void
}) {
  const [current, setCurrent] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const active = clips.some((c) => c.clipId === current) ? current : (clips[0]?.clipId ?? null)

  function focus(clipId: string | null) {
    if (clipId === null) return
    list.current?.querySelector<HTMLElement>(`[data-clip="${cssEscape(clipId)}"]`)?.focus()
  }

  function move(delta: number) {
    if (clips.length === 0) return
    const index = clips.findIndex((c) => c.clipId === active)
    const target = clips[Math.min(clips.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta))]
    if (target === undefined) return
    setCurrent(target.clipId)
    focus(target.clipId)
  }

  if (clips.length === 0) {
    return (
      <div className="rounded-xl border border-dashed px-6 py-14 text-center">
        <p className="text-sm font-medium">Aucun clip à programmer.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Exportez un clip depuis son émission pour qu’il rejoigne le vivier.
        </p>
      </div>
    )
  }

  return (
    <div ref={list} className="flex flex-col gap-2">
      {clips.map((clip) => {
        const isCurrent = clip.clipId === active
        const isSelected = selected.has(clip.clipId)
        return (
          <div key={clip.clipId} className="relative">
            <div className="absolute top-1/2 left-3 z-10 -translate-y-1/2">
              <Checkbox
                checked={isSelected}
                tabIndex={isCurrent ? 0 : -1}
                onCheckedChange={() => {
                  onToggle(clip.clipId)
                  setCurrent(clip.clipId)
                  focus(clip.clipId)
                }}
                aria-label={`Sélectionner « ${clip.title || clip.clipId} »`}
              />
            </div>
            <div
              data-clip={clip.clipId}
              tabIndex={isCurrent ? 0 : -1}
              onFocus={() => setCurrent(clip.clipId)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  move(1)
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  move(-1)
                }
              }}
              className={cn(
                'flex items-center gap-4 rounded-lg border bg-card py-3 pr-4 pl-12 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isSelected && 'border-stage/60 ring-1 ring-stage/25',
              )}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {clip.title || clip.clipId}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatShowOrigin(clip.projectId)}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {formatDuration(clip.duration)}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** `CSS.escape` n'existe pas toujours sous jsdom ; un repli minimal suffit ici. */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
}
