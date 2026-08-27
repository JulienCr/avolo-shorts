'use client'

import type { VariantProps } from 'class-variance-authority'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'

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
 * L'aperçu d'un clip du vivier : rendu, description, émission, durée, et les
 * quatre plateformes une à une.
 *
 * **Un seul lecteur.** `RENDER_NATIVE = false` : un export ne porte jamais les
 * deux rendus à la fois, donc aucun choix n'est proposé entre eux.
 *
 * **Modale URL-driven** : « rien ne s'ouvre en modale sauf une confirmation »
 * vise l'URL, pas la forme visuelle — `?preview=` la rend rechargeable.
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

/**
 * Lit le rendu dès l'ouverture, sans le couper.
 *
 * **Jamais de repli muet sur un rejet.** Sans le geste du clic — l'ouverture
 * directe par `?preview=` en est une —, le navigateur refuse la lecture non
 * coupée : rester en pause, poster affiché, est honnête ; couper le son pour
 * forcer la lecture ferait croire un clip silencieux qui ne l'est pas.
 */
function Player({ clip }: { clip: PlanningPoolClip }) {
  const url = clip.outputs.variant9x16Url ?? clip.outputs.mp4Url
  const video = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    // Le clic donne le geste utilisateur qu'exige une lecture non coupée ;
    // sans lui le navigateur rejette, et le rejet se rattrape sans repli
    // muet ni bruit — `?.` : `play()` n'est pas implémenté sous jsdom.
    video.current?.play()?.catch(() => {})
  }, [url])

  if (url === null) {
    return <p className="text-sm text-muted-foreground">Aucun rendu à jour n’est disponible.</p>
  }
  return (
    <video
      ref={video}
      src={url}
      controls
      preload="metadata"
      className="mx-auto max-h-[65vh] w-auto rounded bg-zinc-950"
    />
  )
}
