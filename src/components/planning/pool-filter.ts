/**
 * Le filtre du vivier : par émission, par recherche.
 *
 * Pur, sans DOM — la grille en garde l'état et en fait le rendu.
 */

import type { PlanningPoolClip } from '@/lib/api'

export type PoolFilter = { projectId: string | null; search: string }

export const POOL_FILTER_NONE: PoolFilter = { projectId: null, search: '' }

/** Les émissions présentes dans le vivier, dans l'ordre où elles y apparaissent. */
export function showsInPool(clips: readonly PlanningPoolClip[]): string[] {
  const seen = new Set<string>()
  const shows: string[] = []
  for (const clip of clips) {
    if (!seen.has(clip.projectId)) {
      seen.add(clip.projectId)
      shows.push(clip.projectId)
    }
  }
  return shows
}

/** Insensible à la casse et aux accents : un `é` précomposé et un `e` combinant s'affichent pareil. */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/** Le vivier restreint : `projectId: null` ne restreint rien, une recherche vide non plus. */
export function filterPool(
  clips: readonly PlanningPoolClip[],
  filter: PoolFilter,
): PlanningPoolClip[] {
  const search = normalize(filter.search.trim())
  return clips.filter((clip) => {
    if (filter.projectId !== null && clip.projectId !== filter.projectId) return false
    if (search !== '' && !normalize(clip.title).includes(search)) return false
    return true
  })
}
