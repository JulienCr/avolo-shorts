import { clipDuration } from '@/core/edl'
import { composeDescription } from '@/core/publication'
import type { PlanningPoolClip, PublicationDetail } from '@/lib/api'
import { clipFraming } from '@/server/clip-framing'
import { effectiveSettings, getDb, getPublications, listExportedClips } from '@/server/db'
import { json, route } from '@/server/http'
import { clipOutputs, deliveryToDay } from '@/server/renders'
import { urlVignette } from '@/server/views'

/**
 * `GET /api/planning/pool` — tous les clips exportés (spec planning §5.2).
 *
 * **Le vivier ne filtre plus, il range** : `stale` et `statuses` partent au
 * client, qui en fait ses six onglets. Les exclure ici faisait disparaître de
 * l'écran tout ce qui était déjà parti. La condition d'**entrée au planning**
 * ne bouge pas : `hasSchedulablePlatform`, et le refus du `POST`.
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
    const fresh = deliveryToDay(clip, framing, settings.hook)
    const statuses: PlanningPoolClip['statuses'] = {}
    for (const row of getPublications(db, clip.id)) {
      statuses[row.platform] = {
        status: row.status,
        error: row.error,
        updatedAt: row.updatedAt,
        remoteUrl: row.remoteUrl,
      } satisfies PublicationDetail
    }
    clips.push({
      clipId: clip.id,
      projectId: clip.projectId,
      title: clip.title,
      duration: clipDuration(clip.segments),
      // `urlVignette(clip, true)` publie l'URL sur la seule foi de la
      // livraison : sur un rendu périmé elle mène à un 404, là où le repli sur
      // le proxy donne une affiche qui existe.
      thumbnailUrl: urlVignette(clip, fresh),
      description: composeDescription(clip, { footer: settings.publication.descriptionFooter }),
      outputs: clipOutputs(clip, framing, settings.hook),
      statuses,
      stale: !fresh,
    })
  }
  return json({ clips })
})
