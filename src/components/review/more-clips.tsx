'use client'

import { ApiError } from '@/lib/api'
import { useProject, useRequestMoreClips } from '@/lib/queries'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

const REASON_IN_CURRENT = 'Une exécution est déjà en cours ; les nouvelles propositions arriveront à sa fin.'

/**
 * Le pont vers la seconde passe de repérage — le seul chemin pour l'atteindre.
 *
 * **Trois états, lus sur `ProjectStatus` seul** : `moreClips.exhausted` dit que
 * le replay est épuisé, `running` dit qu'une exécution tourne déjà (la sienne
 * ou celle d'un autre onglet), et l'absence des deux rend les boutons. Aucun
 * état n'est déduit d'ailleurs — pas de la liste des clips, pas de la boucle.
 */
export function MoreClips({ projectId }: { projectId: string }) {
  const project = useProject(projectId)
  const moreClips = useRequestMoreClips()

  const status = project.data
  if (status === undefined) return null

  if (status.moreClips?.exhausted === true) {
    return (
      <p className="mt-4 max-w-prose text-sm text-muted-foreground">
        Tout le replay a été exploré ; un nouveau repérage n’ajoutera rien de plus.
      </p>
    )
  }

  const inCurrent = status.running !== null
  const blocked = inCurrent || moreClips.isPending

  const ask = (count: 5 | 10) => {
    if (blocked) return
    moreClips.mutate({ projectId, count })
  }

  return (
    <div className="mt-4 flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Button variant="outline" size="sm" aria-disabled={blocked} onClick={() => ask(5)}>
          +5
        </Button>
        <Button variant="outline" size="sm" aria-disabled={blocked} onClick={() => ask(10)}>
          +10
        </Button>
      </div>
      {inCurrent && (
        <p data-testid="reason-more-clips" className="max-w-xs text-xs text-muted-foreground">
          {REASON_IN_CURRENT}
        </p>
      )}
      <MoreClipsFailure error={moreClips.error} />
    </div>
  )
}

/**
 * L'échec d'une demande de +N. Un 409 est une course perdue, pas une panne
 * (même raisonnement que `RetryFailure` dans `retry.tsx`) ; les deux 400 et le
 * 404 rendent tels quels le message du serveur — c'est déjà la bonne phrase.
 */
function MoreClipsFailure({ error }: { error: Error | null }) {
  if (error === null) return null
  const conflict = error instanceof ApiError && error.status === 409
  return (
    <Alert variant="destructive" className="max-w-sm">
      <AlertDescription>
        {conflict
          ? 'Une exécution tourne déjà sur ce projet ; l’écran la suivra dès qu’elle se signalera.'
          : error.message}
      </AlertDescription>
    </Alert>
  )
}
