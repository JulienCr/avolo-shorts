/**
 * Le statut d'un clip, vu par l'écran de tri.
 *
 * Ce module existe parce que deux endroits avaient chacun leur idée de ce que
 * « gardé » veut dire : la carte comptait `exported` comme gardé, le
 * gestionnaire de clic ne reconnaissait que `kept`. Cliquer le bouton affiché
 * « Gardé » sur un clip exporté l'envoyait donc vers `kept` — un changement
 * d'état invisible à l'écran, qui perdait au passage la trace de l'export.
 *
 * Une seule définition, lue par les deux.
 *
 * **Elle a déménagé dans `@/core/phase` et ce module la ré-exporte.**
 * `phaseProject` en a besoin pour l'axe du travail humain, et la frontière de
 * pureté interdit à `src/core` d'importer `src/lib` : la recopier là-bas aurait
 * rendu deux endroits à un module qui existe précisément parce qu'ils
 * divergeaient. Les appelants, eux, n'ont pas bougé.
 */

import type { ClipStatus } from '@/core/edl'
import { isDiscarded, isGuard } from '@/core/phase'

export { isDiscarded, isGuard }

export const LABELS_STATUS: Record<ClipStatus, string> = {
  candidate: 'proposition',
  kept: 'gardé',
  discarded: 'écarté',
  exported: 'exporté',
}

/** Les deux seules décisions que l'écran de tri sait prendre. */
export type Decision = 'kept' | 'discarded'

/**
 * Le statut après un clic sur « garder » ou « écarter ».
 *
 * **Le même bouton reprend sa décision** : rappuyer dessus ramène le clip au
 * rang de proposition. Un tri se corrige plus souvent qu'on ne le croit, et
 * exiger un troisième bouton pour défaire coûterait une colonne de plus sur
 * vingt-cinq cartes.
 */
export function toggleStatus(
  current: ClipStatus,
  decision: Decision,
): Exclude<ClipStatus, 'exported'> {
  const active = decision === 'kept' ? isGuard(current) : isDiscarded(current)
  return active ? 'candidate' : decision
}

/**
 * The status each clip's decide gesture last dispatched, kept next to
 * `toggleStatus` (issue #330) — not a component ref, which can't cross the
 * clip screen and the sort screen closing over the same server truth.
 */
const decided = new Map<string, ClipStatus>()

/**
 * Toggles from the remembered decision, falling back to `fallback` when
 * nothing is remembered yet, stores the result, and returns it.
 *
 * @param fallback The caller's own snapshot of the server status.
 * Call synchronously, one line before `mutate`/`onStatus`, never after an
 * `await`: it is the only value guaranteed current for the very next
 * dispatch, ahead of the query cache that `cancelQueries` has not settled yet.
 */
export function decideStatus(
  clipId: string,
  fallback: ClipStatus,
  decision: Decision,
): Exclude<ClipStatus, 'exported'> {
  const next = toggleStatus(decided.get(clipId) ?? fallback, decision)
  decided.set(clipId, next)
  return next
}

/** Resynchronises the remembered status from a confirmed server value. */
export function resyncStatus(clipId: string, status: ClipStatus): void {
  decided.set(clipId, status)
}

/** Forgets a clip's remembered status, e.g. when no server value survives to resync from. */
export function forgetStatus(clipId: string): void {
  decided.delete(clipId)
}

/**
 * Test-only: wipes every remembered status.
 *
 * `decided` is module state, so it survives across `it()` blocks in the same
 * file (issue #330) — a harness that decides through `useSortLoop` without a
 * real `usePatchClip` never resynchronises, and a reused clip id then reads
 * a previous test's decision. Call in `afterEach`.
 */
export function resetDecideStatusForTests(): void {
  decided.clear()
}
