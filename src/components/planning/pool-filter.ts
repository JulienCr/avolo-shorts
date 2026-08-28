/**
 * Le filtre du vivier : par onglet, par émission, par recherche.
 *
 * Pur, sans DOM — la grille en garde l'état et en fait le rendu.
 */

import { hasSchedulablePlatform, PLATFORMS, type Platform, type PublicationStatus } from '@/core/publication'
import { statusesOnly } from '@/core/planning'
import type { PlanningPoolClip } from '@/lib/api'

/**
 * Les six onglets.
 *
 * **Ils se recoupent** : ce sont des filtres, pas un classement. Deux
 * plateformes publiées, une en échec et une vierge donnent un clip qui est à
 * la fois `partial`, `errors` et `toPublish` — le masquer sous un seul
 * onglet cacherait ce qui reste à faire derrière ce qui a raté.
 */
export type PoolView = 'toPublish' | 'scheduled' | 'published' | 'partial' | 'errors' | 'all'

export const POOL_VIEWS: readonly { value: PoolView; label: string }[] = [
  { value: 'toPublish', label: 'À publier' },
  { value: 'scheduled', label: 'Programmés' },
  { value: 'published', label: 'Publié' },
  { value: 'partial', label: 'Partiels' },
  { value: 'errors', label: 'Erreurs' },
  { value: 'all', label: 'Tout' },
]

/** L'onglet nommé par l'URL, ou celui par défaut — le vivier tel qu'il était. */
export function poolViewSinceUrl(value: string | null): PoolView {
  return POOL_VIEWS.some((v) => v.value === value) ? (value as PoolView) : 'toPublish'
}

/** Parti et arrivé au bout : un brouillon TikTok attend une main, mais il est sorti d'ici. */
function isSettled(status: PublicationStatus | undefined): boolean {
  return status === 'published' || status === 'submitted'
}

/**
 * Le clip appartient-il à cet onglet ?
 *
 * Sur les quatre `PLATFORMS`, pas sur les seules lignes présentes : une
 * plateforme sans ligne est une plateforme qui n'est pas partie.
 * **`in_progress` se range avec « Programmés »** — sans lui, un clip dont les
 * quatre envois tournent n'appartiendrait à aucun onglet nommé et
 * disparaîtrait le temps de son envoi.
 */
export function matchesPoolView(
  statuses: Partial<Record<Platform, PublicationStatus>>,
  view: PoolView,
): boolean {
  const values = PLATFORMS.map((platform) => statuses[platform])
  switch (view) {
    case 'toPublish':
      return (
        hasSchedulablePlatform(statuses) &&
        !values.some((s) => s === 'planned' || s === 'in_progress')
      )
    case 'scheduled':
      return values.some((s) => s === 'planned' || s === 'in_progress')
    case 'published':
      return values.every(isSettled)
    case 'partial':
      return values.some(isSettled) && !values.every(isSettled)
    case 'errors':
      return values.some((s) => s === 'failed')
    case 'all':
      return true
  }
}

/**
 * Ce qui restreint le vivier **à l'intérieur** d'un onglet.
 *
 * Séparé de l'onglet parce que les deux ne vivent pas au même endroit :
 * l'onglet est dans l'URL, l'émission et la recherche restent locales à la
 * grille (`pool-grid.tsx`).
 */
export type PoolRestriction = { projectId: string | null; search: string }

export const POOL_RESTRICTION_NONE: PoolRestriction = { projectId: null, search: '' }

export type PoolFilter = PoolRestriction & { view: PoolView }

export const POOL_FILTER_NONE: PoolFilter = { view: 'toPublish', ...POOL_RESTRICTION_NONE }

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

/** Les deux axes qui ne sont pas l'onglet — ceux sur lesquels les compteurs se comptent. */
function matchesBesideView(clip: PlanningPoolClip, filter: PoolFilter): boolean {
  if (filter.projectId !== null && clip.projectId !== filter.projectId) return false
  const search = normalize(filter.search.trim())
  return search === '' || normalize(clip.title).includes(search)
}

/** Le vivier restreint : `projectId: null` ne restreint rien, une recherche vide non plus. */
export function filterPool(
  clips: readonly PlanningPoolClip[],
  filter: PoolFilter,
): PlanningPoolClip[] {
  return clips.filter(
    (clip) => matchesBesideView(clip, filter) && matchesPoolView(statusesOnly(clip.statuses), filter.view),
  )
}

/**
 * Ce que chaque onglet afficherait, **émission et recherche déjà appliquées**.
 *
 * À la différence de `countsByFilter` (`@/core/library`), qui compte sur tout :
 * un onglet qui annonce 3 et s'ouvre vide parce que la recherche les exclut
 * est l'écart qu'on ne remarque pas.
 */
export function countsByPoolView(
  clips: readonly PlanningPoolClip[],
  filter: PoolFilter,
): Record<PoolView, number> {
  const counts = { toPublish: 0, scheduled: 0, published: 0, partial: 0, errors: 0, all: 0 }
  for (const clip of clips) {
    if (!matchesBesideView(clip, filter)) continue
    const statuses = statusesOnly(clip.statuses)
    for (const { value } of POOL_VIEWS) {
      if (matchesPoolView(statuses, value)) counts[value] += 1
    }
  }
  return counts
}
