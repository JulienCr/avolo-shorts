import type { Clip } from '@/core/edl'
import { clipDuration } from '@/core/edl'
import { composeDescription, hasSchedulablePlatform } from '@/core/publication'
import type { PlanningPendingClip, PlanningPoolClip } from '@/lib/api'
import { clipFraming } from '@/server/clip-framing'
import { effectiveSettings, getDb, getPublications, listExportedClips, listKeptClips } from '@/server/db'
import { json, route } from '@/server/http'
import { clipOutputs, deliveryToDay } from '@/server/renders'
import { urlVignette } from '@/server/views'

/**
 * `GET /api/planning/pool` — le vivier (spec §5.2), et ce qui lui manque.
 *
 * **Entrée, pas sortie** : `exported`, rendu à jour, pas d'échéance `planned`,
 * une plateforme programmable au moins — sinon `schedulePublications` rendrait
 * un succès sans échéance (§5.1). Programmé, le clip passe au calendrier.
 *
 * **`pending` porte les deux mêmes gardes** : sans elles le bouton proposerait
 * un export sans effet visible, ce qui se lit comme une panne.
 */
export const GET = route('GET /api/planning/pool', async () => {
  const db = getDb()
  const settings = effectiveSettings(db)
  const clips: PlanningPoolClip[] = []
  const pending: PlanningPendingClip[] = []

  for (const clip of listExportedClips(db)) {
    const statuses = schedulableStatuses(clip)
    if (statuses === null) continue
    // Le même `framing` va à `deliveryToDay` et `clipOutputs` : un calcul
    // divergent leur ferait chercher les fichiers sous un autre ratio, et
    // `clipOutputs` rendrait des `null` sans lever la moindre erreur.
    const framing = clipFraming(clip, settings.framing)
    if (!deliveryToDay(clip, framing, settings.hook)) {
      pending.push(waiting(clip, 'stale'))
      continue
    }
    clips.push({
      clipId: clip.id,
      projectId: clip.projectId,
      title: clip.title,
      duration: clipDuration(clip.segments),
      // `deliveryToDay` vient d'être vérifié (ligne au-dessus) : l'affiche du
      // rendu livré peut donc se servir même sans proxy.
      thumbnailUrl: urlVignette(clip, true),
      description: composeDescription(clip, { footer: settings.publication.descriptionFooter }),
      outputs: clipOutputs(clip, framing, settings.hook),
      statuses,
    })
  }

  for (const clip of listKeptClips(db)) {
    if (schedulableStatuses(clip) === null) continue
    pending.push(waiting(clip, 'unedited'))
  }

  // Les deux listes se concatènent, donc l'ordre lexicographique que chaque
  // requête tenait séparément ne survit pas au collage.
  pending.sort((a, b) => a.clipId.localeCompare(b.clipId))
  return json({ clips, pending })

  /** Les statuts du clip, ou `null` si plus rien n'est programmable pour lui. */
  function schedulableStatuses(clip: Clip): PlanningPoolClip['statuses'] | null {
    const rows = getPublications(db, clip.id)
    if (rows.some((row) => row.status === 'planned')) return null
    const statuses = Object.fromEntries(rows.map((row) => [row.platform, row.status]))
    return hasSchedulablePlatform(statuses) ? statuses : null
  }
})

function waiting(clip: Clip, reason: PlanningPendingClip['reason']): PlanningPendingClip {
  return { clipId: clip.id, projectId: clip.projectId, title: clip.title, reason }
}
