import type { Clip } from '@/core/edl'
import { clipDuration } from '@/core/edl'
import { composeDescription, hasSchedulablePlatform } from '@/core/publication'
import type { PlanningPendingClip, PlanningPoolClip, PublicationDetail } from '@/lib/api'
import { clipFraming } from '@/server/clip-framing'
import { effectiveSettings, getDb, getPublications, listExportedClips, listKeptClips } from '@/server/db'
import { json, route } from '@/server/http'
import { clipOutputs, deliveryToDay } from '@/server/renders'
import { urlVignette } from '@/server/views'

/**
 * `GET /api/planning/pool` — tous les clips exportés, et ce qui manque au
 * vivier (spec planning §5.2).
 *
 * **Le vivier ne filtre plus, il range** : `stale` et `statuses` partent aux
 * six onglets du client ; l'entrée au planning ne bouge pas
 * (`hasSchedulablePlatform`, et le refus du `POST`). **`pending` garde ses
 * deux gardes** (#263), et un rendu périmé y est en plus de `clips` — le
 * voir n'est pas le réparer.
 */
export const GET = route('GET /api/planning/pool', async () => {
  const db = getDb()
  const settings = effectiveSettings(db)
  const clips: PlanningPoolClip[] = []
  const pending: PlanningPendingClip[] = []

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
    if (!fresh && schedulable(clip)) pushWaiting(clip, 'stale')
  }

  for (const clip of listKeptClips(db)) {
    if (schedulable(clip)) pushWaiting(clip, 'missing')
  }

  // Les deux listes se concatènent, donc l'ordre lexicographique que chaque
  // requête tenait séparément ne survit pas au collage.
  pending.sort((a, b) => a.clipId.localeCompare(b.clipId))
  return json({ clips, pending })

  /** Empile l'entrée d'attente, sauf pour un clip qu'aucun export ne peut rendre. */
  function pushWaiting(clip: Clip, reason: PlanningPendingClip['reason']): void {
    const entry = waiting(clip, reason)
    if (entry !== null) pending.push(entry)
  }

  /** Reste-t-il quelque chose à programmer pour ce clip ? */
  function schedulable(clip: Clip): boolean {
    const rows = getPublications(db, clip.id)
    if (rows.some((row) => row.status === 'planned')) return false
    return hasSchedulablePlatform(Object.fromEntries(rows.map((row) => [row.platform, row.status])))
  }
})

/**
 * L'entrée de `pending`, ou `null` pour un clip qu'aucun export ne peut rendre.
 *
 * **Un clip sans segment est écarté** : l'édition autorise de vider un clip
 * (`tests/core/phase.test.ts`), et `renderClip` refuse une durée nulle — le
 * proposer offrirait une cible qui échoue à chaque tentative. (relevé par
 * Copilot)
 */
function waiting(clip: Clip, reason: PlanningPendingClip['reason']): PlanningPendingClip | null {
  if (clipDuration(clip.segments) <= 0) return null
  return { clipId: clip.id, projectId: clip.projectId, title: clip.title, reason }
}
