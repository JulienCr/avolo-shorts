'use client'

import { useId, useRef, useState } from 'react'

import type { PlanningPoolClip } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PoolCard } from '@/components/planning/pool-card'
import {
  countsByPoolView,
  filterPool,
  POOL_RESTRICTION_NONE,
  POOL_VIEWS,
  showsInPool,
  type PoolFilter,
  type PoolRestriction,
  type PoolView,
} from '@/components/planning/pool-filter'
import { formatShowOrigin } from '@/components/planning/texts'

const ALL_SHOWS = 'all'
const SKELETONS = 8

/**
 * Le vivier en grille : six onglets, filtre par émission, recherche, et
 * navigation clavier bidimensionnelle.
 *
 * **L'émission et la recherche restent dans le composant, pas dans l'URL** —
 * même règle que `LibraryGrid` (`sources/library.tsx`) : une recherche à demi
 * tapée dans une URL est une URL qu'on ne peut plus partager. L'onglet, lui,
 * vit dans l'URL (`review/template.ts`) : un rechargement doit rendre le même
 * écran, et on revient ici après un aller-retour par « Éditer ».
 */
export function PoolGrid({
  clips,
  loading,
  view,
  onView,
  selected,
  onToggle,
  onPreview,
}: {
  clips: readonly PlanningPoolClip[]
  loading: boolean
  view: PoolView
  onView: (view: PoolView) => void
  selected: ReadonlySet<string>
  onToggle: (clipId: string) => void
  onPreview: (clipId: string) => void
}) {
  const [restriction, setRestriction] = useState<PoolRestriction>(POOL_RESTRICTION_NONE)
  const [current, setCurrent] = useState<string | null>(null)
  const grid = useRef<HTMLDivElement>(null)

  const filter: PoolFilter = { ...restriction, view }
  const counts = countsByPoolView(clips, filter)
  const visible = filterPool(clips, filter)
  const restricting = restriction.projectId !== null || restriction.search.trim() !== ''
  const active = visible.some((c) => c.clipId === current) ? current : (visible[0]?.clipId ?? null)
  // Un id sélectionné qui a quitté `clips` (clip réédité, redevenu `kept`)
  // n'est pas « masqué par le filtre » : ne compter que ceux encore présents
  // dans le vivier (relevé par Copilot).
  const hiddenSelectedCount = [...selected].filter(
    (id) => clips.some((c) => c.clipId === id) && !visible.some((c) => c.clipId === id),
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
        {Array.from({ length: SKELETONS }, (_, i) => (
          <Skeleton key={i} className="aspect-[9/16] w-full" />
        ))}
      </div>
    )
  }

  if (clips.length === 0) {
    return (
      <div className="rounded-xl border border-dashed px-6 py-14 text-center">
        <p className="text-sm font-medium">Aucun clip exporté.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Exportez un clip depuis son émission pour qu’il rejoigne le vivier.
        </p>
      </div>
    )
  }

  return (
    /* **Le contenu est dans un panneau, pas à côté des onglets** — un
       `tablist` sans `tabpanel` s'annonce « onglet 1 sur 6 » sans qu'aucun
       panneau ne soit désigné (`review/feed.tsx`). Un seul suffit, celui de
       l'onglet actif. */
    <Tabs value={view} onValueChange={(value) => onView(value as PoolView)} className="gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <TabsList>
          {POOL_VIEWS.map(({ value, label }) => (
            <TabsTrigger key={value} value={value}>
              {label}
              <Badge variant="outline" className="ml-1 font-mono text-xs tabular-nums">
                {counts[value]}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>

        <FilterBar
          clips={clips}
          filter={filter}
          onRestrict={setRestriction}
          restricted={restricting}
          visibleCount={visible.length}
        />
      </div>

      {hiddenSelectedCount > 0 && (
        <p className="text-sm text-muted-foreground">
          {hiddenSelectedCount === 1
            ? '1 clip sélectionné est masqué par le filtre.'
            : `${hiddenSelectedCount} clips sélectionnés sont masqués par le filtre.`}
        </p>
      )}

      <TabsContent value={view}>
      {visible.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          {/* Deux vides à ne pas confondre : l'onglet n'a rien, ou le filtre
              cache ce qu'il a. Le second se répare d'un clic, le premier non. */}
          <p className="text-sm font-medium">
            {restricting ? 'Aucun clip ne correspond au filtre.' : EMPTY_LABELS[view]}
          </p>
          {restricting && (
            <Button variant="outline" size="sm" className="mt-3" onClick={() => setRestriction(POOL_RESTRICTION_NONE)}>
              Tout afficher
            </Button>
          )}
        </div>
      ) : (
        <div
          ref={grid}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7"
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
      </TabsContent>
    </Tabs>
  )
}

/** Ce que dit un onglet vide — la raison change avec lui. */
const EMPTY_LABELS: Record<PoolView, string> = {
  toPublish: 'Aucun clip à programmer.',
  scheduled: 'Aucune échéance en attente.',
  published: 'Aucun clip publié.',
  partial: 'Aucun clip partiellement publié.',
  errors: 'Aucun clip en échec.',
  all: 'Aucun clip ne correspond au filtre.',
}

function FilterBar({
  clips,
  filter,
  onRestrict,
  restricted,
  visibleCount,
}: {
  clips: readonly PlanningPoolClip[]
  filter: PoolFilter
  onRestrict: (restriction: PoolRestriction) => void
  restricted: boolean
  visibleCount: number
}) {
  const shows = showsInPool(clips)
  const showId = useId()

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={showId} className="text-sm font-normal">
          Émission
        </Label>
        <Select
          value={filter.projectId ?? ALL_SHOWS}
          onValueChange={(value) =>
            onRestrict({ search: filter.search, projectId: value === ALL_SHOWS ? null : value })
          }
        >
          <SelectTrigger id={showId} className="w-56">
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
          onChange={(e) => onRestrict({ projectId: filter.projectId, search: e.target.value })}
          className="w-56"
        />
      </div>

      {/* Sur l'onglet, pas de compte : sa pastille le porte déjà, et « 13 sur
          15 » se lirait comme un filtre posé alors qu'il n'y en a aucun. */}
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
