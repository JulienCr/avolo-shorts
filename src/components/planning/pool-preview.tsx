'use client'

import type { VariantProps } from 'class-variance-authority'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'

import { PLATFORM_LABELS, PLATFORMS, PUBLICATION_STATUS_LABELS, type PublicationStatus } from '@/core/publication'
import type { PlanningPoolClip } from '@/lib/api'
import { formatDuration } from '@/lib/format'
import { linkClip } from '@/lib/navigation'
import { buttonVariants } from '@/components/ui/button'
import { Badge, badgeVariants } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatShowOrigin } from '@/components/planning/texts'
import { cn } from '@/lib/utils'

/**
 * Le clip en aperçu, lu dans `?preview=`, et le geste qui l'y pose ou l'en
 * retire.
 *
 * **Les autres paramètres survivent** — même règle que
 * `useTranscriptPanelUrl` (`show/transcript-panel.tsx`) : un `URLSearchParams`
 * reconstruit depuis `useSearchParams().toString()` avant d'ajouter ou de
 * retirer la clé.
 */
export function usePreviewUrl(): [string | null, (clipId: string | null) => void] {
  const router = useRouter()
  const searchParams = useSearchParams()
  const preview = searchParams.get('preview')

  function setPreview(clipId: string | null) {
    const params = new URLSearchParams(searchParams.toString())
    if (clipId !== null) params.set('preview', clipId)
    else params.delete('preview')
    const query = params.toString()
    router.replace(`/planning${query === '' ? '' : `?${query}`}`, { scroll: false })
  }

  return [preview, setPreview]
}

/** Le ton du badge par plateforme — `failed` est seul à porter le rouge. */
const STATUS_BADGE_VARIANT: Record<PublicationStatus, VariantProps<typeof badgeVariants>['variant']> = {
  planned: 'outline',
  in_progress: 'outline',
  submitted: 'secondary',
  published: 'secondary',
  failed: 'destructive',
}

/**
 * L'aperçu d'un clip du vivier : le rendu, la description, l'émission, la
 * durée, et les quatre plateformes une à une.
 *
 * **Un seul lecteur vidéo.** `RENDER_NATIVE = false` : un clip exporté porte
 * `-9x16.mp4`, ou `.mp4` quand son ratio natif est déjà 9:16 — jamais les
 * deux. Un bouton pour choisir entre deux rendus dont un seul peut exister
 * mentirait, donc aucun choix n'est proposé.
 *
 * **Une modale URL-driven, et non une exception à « rien ne s'ouvre en
 * modale sauf une confirmation »** : cette règle vise l'URL, pas la forme
 * visuelle. `?preview=` rend l'aperçu rechargeable et partageable, ce qui est
 * précisément ce que la règle exige.
 */
export function PoolPreview({
  clip,
  onClose,
}: {
  clip: PlanningPoolClip | null
  onClose: () => void
}) {
  return (
    <Dialog open={clip !== null} onOpenChange={(open) => !open && onClose()}>
      {clip !== null && (
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{clip.title || clip.clipId}</DialogTitle>
            <DialogDescription>{clip.description.trim() || '(sans description)'}</DialogDescription>
          </DialogHeader>

          <Player clip={clip} />

          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>{formatShowOrigin(clip.projectId)}</span>
            <span className="font-mono tabular-nums">{formatDuration(clip.duration)}</span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {PLATFORMS.map((platform) => {
              const status = clip.statuses[platform]
              return (
                <Badge key={platform} variant={status === undefined ? 'outline' : STATUS_BADGE_VARIANT[status]}>
                  {PLATFORM_LABELS[platform]} · {status === undefined ? 'programmable' : PUBLICATION_STATUS_LABELS[status]}
                </Badge>
              )
            })}
          </div>

          <DialogFooter>
            <Link href={linkClip(clip.clipId)} className={cn(buttonVariants({ variant: 'outline' }))}>
              Éditer
            </Link>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}

function Player({ clip }: { clip: PlanningPoolClip }) {
  const url = clip.outputs.variant9x16Url ?? clip.outputs.mp4Url
  if (url === null) {
    return <p className="text-sm text-muted-foreground">Aucun rendu à jour n’est disponible.</p>
  }
  return (
    <video
      src={url}
      controls
      preload="metadata"
      className="mx-auto max-h-[65vh] w-auto rounded bg-zinc-950"
    />
  )
}
