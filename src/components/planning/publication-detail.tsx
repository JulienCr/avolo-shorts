'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'

import { formatErrorDetail } from '@/core/publication-errors'
import { PLATFORM_LABELS, PLATFORMS, PUBLICATION_STATUS_LABELS } from '@/core/publication'
import type { PlanningAggregateStatus } from '@/core/planning'
import { keys } from '@/lib/queries'
import { publishClip, type PublicationDetail } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

/**
 * Ce que le bandeau et le vivier partagent d'une publication : les tons des
 * badges, et la ligne de détail par plateforme.
 *
 * Elle vivait dans `five-week-band.tsx` ; le vivier en a besoin mot pour mot
 * — lien vers le post, message d'échec, relance —, et deux copies auraient
 * divergé au premier correctif.
 */

/** Le ton du badge d'état agrégé — `failed` reste seul à porter le rouge plein. */
export const AGGREGATE_BADGE_VARIANT: Record<PlanningAggregateStatus, 'outline' | 'secondary' | 'destructive'> = {
  planned: 'outline',
  failed: 'destructive',
  partial_failure: 'outline',
  published: 'secondary',
  submitted: 'secondary',
  in_progress: 'outline',
  partial: 'outline',
}

export const STATUS_BADGE_VARIANT = {
  planned: 'secondary',
  in_progress: 'outline',
  submitted: 'secondary',
  published: 'secondary',
  failed: 'destructive',
} as const

const FORMAT_ATTEMPT = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Europe/Paris',
})

/**
 * **Signale, ne bloque rien** (spec §5.3) : l'ambre du produit, pas le rouge
 * d'échec — un rendu périmé n'est pas une publication ratée, et partagerait
 * sinon sa couleur avec ce qui, lui, bloque.
 */
export function StaleRenderBadge() {
  return (
    <Badge variant="outline" className="w-fit border-stage/60 bg-stage/15 text-stage-foreground">
      rendu périmé
    </Badge>
  )
}

export function PlatformDetailRow({
  clipId,
  platform,
  detail,
}: {
  clipId: string
  platform: (typeof PLATFORMS)[number]
  detail: PublicationDetail
}) {
  const client = useQueryClient()
  const retry = useMutation({
    mutationFn: () => publishClip(clipId, [platform]),
    onSuccess() {
      void client.invalidateQueries({ queryKey: ['planning-schedule'] })
      // Le vivier lit les mêmes lignes depuis qu'il montre ce qui est parti :
      // sans cette clé, sa carte garde son badge « échec » après la relance.
      void client.invalidateQueries({ queryKey: keys.planningPool })
      // Même clé que `usePublisher` (`src/lib/queries.ts:942`) : sans elle,
      // `usePublications` sert le `failed` périmé pendant son `staleTime`.
      void client.invalidateQueries({ queryKey: keys.publications(clipId) })
    },
  })

  return (
    <div className="flex flex-col gap-0.5 rounded border px-1.5 py-1">
      <div className="flex items-center gap-1.5">
        <Badge variant={STATUS_BADGE_VARIANT[detail.status]} className="shrink-0">
          {PUBLICATION_STATUS_LABELS[detail.status]}
        </Badge>
        <span className="font-medium">{PLATFORM_LABELS[platform]}</span>
        {/* **`http`/`https` seulement**, même garde que `PlatformRecords`
            (`src/components/publication/publish-dialog.tsx`) : `remoteUrl`
            ne doit jamais devenir un `href` non vérifié. */}
        {detail.remoteUrl !== null && /^https?:\/\//.test(detail.remoteUrl) && (
          <a
            href={detail.remoteUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline"
          >
            <ExternalLink className="size-3" aria-hidden />
            <span className="sr-only">voir en ligne sur {PLATFORM_LABELS[platform]}</span>
          </a>
        )}
        <span className="ml-auto font-mono tabular-nums text-muted-foreground">
          {FORMAT_ATTEMPT.format(new Date(detail.updatedAt))}
        </span>
      </div>

      {/* **Le message brut, lisible sans survol** (`ui/tooltip.tsx`) : la
          raison d'un échec ne doit dépendre ni d'un `hover`, ni du clavier
          pour être découverte une fois le détail déplié. */}
      {detail.status === 'failed' && detail.error !== null && (
        <pre className="whitespace-pre-wrap break-words font-mono text-[0.7rem] text-destructive">
          {formatErrorDetail(detail.error)}
        </pre>
      )}

      {detail.status === 'failed' && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="w-fit"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
          aria-label={`Relancer ${PLATFORM_LABELS[platform]}`}
        >
          Relancer
        </Button>
      )}

      {/* Sans ça, un rendu périmé ou un connecteur indisponible réactive le
          bouton sans un mot : la relance semble n'avoir rien fait. */}
      {retry.isError && (
        <p role="alert" className="text-[0.7rem] text-destructive">
          {retry.error instanceof Error ? retry.error.message : 'La relance a échoué.'}
        </p>
      )}
    </div>
  )
}
