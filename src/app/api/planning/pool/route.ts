import { clipDuration } from '@/core/edl'
import { hasSchedulablePlatform } from '@/core/publication'
import type { PlanningPoolClip } from '@/lib/api'
import { clipFraming } from '@/server/clip-framing'
import { effectiveSettings, getDb, getPublications, listExportedClips } from '@/server/db'
import { json, route } from '@/server/http'
import { clipOutputs, deliveryToDay } from '@/server/renders'
import { urlVignette } from '@/server/views'

/**
 * `GET /api/planning/pool` — les clips éligibles au planning (spec planning
 * §5.2).
 *
 * **Entrée, pas sortie** : un clip `exported` dont le rendu correspond au
 * montage courant, qui n'a pas déjà une échéance `planned`, et dont au moins
 * une plateforme reste programmable. `schedulePublications` ne réécrit
 * jamais une ligne au résultat déjà arrêté (§5.1) : un clip dont les quatre
 * lignes portent un résultat produirait sinon un succès sans aucune échéance
 * réellement posée. Une fois programmé, il quitte ce vivier même si son
 * rendu devient périmé ensuite — c'est `GET /api/planning/schedule` qui le
 * montre alors, avec `stale: true`.
 */
export const GET = route('GET /api/planning/pool', async () => {
  const db = getDb()
  const settings = effectiveSettings(db)
  const clips: PlanningPoolClip[] = []
  for (const clip of listExportedClips(db)) {
    // Le même `framing` va à `deliveryToDay` et `clipOutputs` : un calcul
    // divergent leur ferait chercher les fichiers sous un autre ratio, et
    // `clipOutputs` rendrait des `null` sans lever la moindre erreur.
    const framing = clipFraming(clip, settings.framing)
    if (!deliveryToDay(clip, framing, settings.hook)) continue
    const rows = getPublications(db, clip.id)
    if (rows.some((row) => row.status === 'planned')) continue
    const statuses = Object.fromEntries(rows.map((row) => [row.platform, row.status]))
    if (!hasSchedulablePlatform(statuses)) continue
    clips.push({
      clipId: clip.id,
      projectId: clip.projectId,
      title: clip.title,
      duration: clipDuration(clip.segments),
      // `deliveryToDay` vient d'être vérifié (ligne au-dessus) : l'affiche du
      // rendu livré peut donc se servir même sans proxy.
      thumbnailUrl: urlVignette(clip, true),
      description: clip.description,
      outputs: clipOutputs(clip, framing, settings.hook),
      statuses,
    })
  }
  return json({ clips })
})
