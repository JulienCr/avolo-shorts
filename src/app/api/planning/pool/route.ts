import { clipDuration } from '@/core/edl'
import type { PlanningPoolClip } from '@/lib/api'
import { deliveryToDay } from '@/server/renders'
import { getDb, getPublications, listExportedClips } from '@/server/db'
import { json, route } from '@/server/http'

/**
 * `GET /api/planning/pool` — les clips éligibles au planning (spec planning
 * §5.2).
 *
 * **Entrée, pas sortie** : un clip `exported` dont le rendu correspond au
 * montage courant, et qui n'a pas déjà une échéance `planned`. Une fois
 * programmé, il quitte ce vivier même si son rendu devient périmé ensuite —
 * c'est `GET /api/planning/schedule` qui le montre alors, avec `stale: true`.
 */
export const GET = route('GET /api/planning/pool', async () => {
  const db = getDb()
  const clips: PlanningPoolClip[] = []
  for (const clip of listExportedClips(db)) {
    if (!deliveryToDay(clip)) continue
    const alreadyPlanned = getPublications(db, clip.id).some((row) => row.status === 'planned')
    if (alreadyPlanned) continue
    clips.push({
      clipId: clip.id,
      projectId: clip.projectId,
      title: clip.title,
      duration: clipDuration(clip.segments),
    })
  }
  return json({ clips })
})
