'use client'

import { useRef, useState } from 'react'

import type { PlanningPoolClip } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { PoolCard } from '@/components/planning/pool-card'
import { filterPool, POOL_FILTER_NONE, showsInPool, type PoolFilter } from '@/components/planning/pool-filter'
import { formatShowOrigin } from '@/components/planning/texts'

const ALL_SHOWS = 'all'
const SKELETONS = 8

/**
 * Le vivier en grille : filtre par émission, recherche, et navigation
 * clavier bidimensionnelle.
 *
 * **Le filtre reste dans le composant, pas dans l'URL** — même règle que
 * `LibraryGrid` (`sources/library.tsx`) : une recherche à demi tapée dans une
 * URL est une URL qu'on ne peut plus partager.
 */
export function PoolGrid({
  clips,
  loading,
  selected,
  onToggle,
  onPreview,
}: {
  clips: readonly PlanningPoolClip[]
  loading: boolean
  selected: ReadonlySet<string>
  onToggle: (clipId: string) => void
  onPreview: (clipId: string) => void
}) {
  const [filter, setFilter] = useState<PoolFilter>(POOL_FILTER_NONE)
  const [current, setCurrent] = useState<string | null>(null)
  const grid = useRef<HTMLDivElement>(null)

  const visible = filterPool(clips, filter)
  const active = visible.some((c) => c.clipId === current) ? current : (visible[0]?.clipId ?? null)
  const hiddenSelectedCount = [...selected].filter(
    (id) => !visible.some((c) => c.clipId === id),
  ).length

  function focus(clipId: string | null) {
    if (clipId === null) return
    grid.current?.querySelector<HTMLElement>(`[data-clip="${cssEscape(clipId)}"]`)?.focus()
  }

  function move(deltaColumns: number, deltaRows: number) {
    if (visible.length === 0) return
    const columns = columnCount(grid.current)
    const index = visible.findIndex((c) => c.clipId === active)
    const delta = deltaColumns + deltaRows * columns
    const target = visible[Math.min(visible.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta))]
    if (target === undefined) return
    setCurrent(target.clipId)
    focus(target.clipId)
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {Array.from({ length: SKELETONS }, (_, i) => (
          <Skeleton key={i} className="aspect-[9/16] w-full" />
        ))}
      </div>
    )
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
    <div className="flex flex-col gap-3">
      <FilterBar clips={clips} filter={filter} onFilter={setFilter} restricted={visible.length !== clips.length} />

      {hiddenSelectedCount > 0 && (
        <p className="text-sm text-muted-foreground">
          {hiddenSelectedCount === 1
            ? '1 clip sélectionné est masqué par le filtre.'
            : `${hiddenSelectedCount} clips sélectionnés sont masqués par le filtre.`}
        </p>
      )}

      {visible.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <p className="text-sm font-medium">Aucun clip ne correspond au filtre.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setFilter(POOL_FILTER_NONE)}>
            Tout afficher
          </Button>
        </div>
      ) : (
        <div
          ref={grid}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') {
              e.preventDefault()
              move(1, 0)
            } else if (e.key === 'ArrowLeft') {
              e.preventDefault()
              move(-1, 0)
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              move(0, 1)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              move(0, -1)
            }
          }}
        >
          {visible.map((clip) => (
            <PoolCard
              key={clip.clipId}
              clip={clip}
              selected={selected.has(clip.clipId)}
              current={clip.clipId === active}
              onToggle={() => onToggle(clip.clipId)}
              onPreview={() => onPreview(clip.clipId)}
              onFocus={() => setCurrent(clip.clipId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FilterBar({
  clips,
  filter,
  onFilter,
  restricted,
}: {
  clips: readonly PlanningPoolClip[]
  filter: PoolFilter
  onFilter: (filter: PoolFilter) => void
  restricted: boolean
}) {
  const shows = showsInPool(clips)
  const visibleCount = filterPool(clips, filter).length

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <Label className="text-sm font-normal">Émission</Label>
        <Select
          value={filter.projectId ?? ALL_SHOWS}
          onValueChange={(value) =>
            onFilter({ ...filter, projectId: value === ALL_SHOWS ? null : value })
          }
        >
          <SelectTrigger className="w-56">
            <SelectValue>
              {filter.projectId === null ? 'Toutes les émissions' : formatShowOrigin(filter.projectId)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SHOWS}>Toutes les émissions</SelectItem>
            {shows.map((projectId) => (
              <SelectItem key={projectId} value={projectId}>
                {formatShowOrigin(projectId)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pool-search" className="sr-only">
          Rechercher un clip
        </Label>
        <Input
          id="pool-search"
          type="search"
          placeholder="Rechercher un clip…"
          value={filter.search}
          onChange={(e) => onFilter({ ...filter, search: e.target.value })}
          className="w-56"
        />
      </div>

      {restricted && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {visibleCount} clips sur {clips.length}
        </p>
      )}
    </div>
  )
}

/** Le nombre de colonnes que le CSS rend réellement — 1 quand rien ne le dit. */
function columnCount(grid: HTMLElement | null): number {
  if (grid === null) return 1
  const tracks = getComputedStyle(grid).gridTemplateColumns
  if (tracks === '' || tracks === 'none') return 1
  return tracks.split(/\s+/).filter((track) => track !== '').length
}

/** `CSS.escape` n'existe pas toujours sous jsdom ; un repli minimal suffit ici. */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
}
