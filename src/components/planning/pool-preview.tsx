'use client'

import Link from 'next/link'
import { useEffect, useRef } from 'react'

import { PLATFORM_LABELS, PLATFORMS } from '@/core/publication'
import type { PlanningPoolClip } from '@/lib/api'
import { formatDuration } from '@/lib/format'
import { linkClip } from '@/lib/navigation'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PlatformDetailRow, StaleRenderBadge } from '@/components/planning/publication-detail'
import { formatShowOrigin } from '@/components/planning/texts'
import { usePlanningUrlParam } from '@/components/planning/url-state'
import { cn } from '@/lib/utils'

/** Le clip en aperçu, lu dans `?preview=`, et le geste qui l'y pose ou l'en retire. */
export function usePreviewUrl(): [string | null, (clipId: string | null) => void] {
  return usePlanningUrlParam('preview')
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

          {clip.stale && <StaleRenderBadge />}

          {/* Une ligne par plateforme visée, un badge pour les autres : le
              détail porte le lien vers le post, la date d'essai, le message
              d'échec et sa relance — rien de tout cela n'existe pour une
              plateforme sans ligne. */}
          <div className="flex flex-col gap-1.5">
            {PLATFORMS.map((platform) => {
              const detail = clip.statuses[platform]
              if (detail === undefined) {
                return (
                  <Badge key={platform} variant="outline" className="w-fit">
                    {PLATFORM_LABELS[platform]} · programmable
                  </Badge>
                )
              }
              return <PlatformDetailRow key={platform} clipId={clip.clipId} platform={platform} detail={detail} />
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
