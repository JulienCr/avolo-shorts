'use client'

import { Film } from 'lucide-react'
import Link from 'next/link'

import type { StepName } from '@/core/graph'
import { phaseProject } from '@/core/phase'
import { linkProject, next, type SortScope } from '@/lib/navigation'
import { useCandidates, usePatchClip, useProject } from '@/lib/queries'
import { AppBar } from '@/components/navigation/app-bar'
import { SortStage } from '@/components/sort-view/sort-stage'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The sort view's data-fetching screen: resolves a `SortScope`, fetches, and
 * gates on the proxy. `SortStage` does the rest — it takes clips and stays
 * mountable without a server, the same split as `ProjectScreen`/`ReviewFeed`.
 *
 * **Only `project` is wired.** A cross-show scope would fetch a union of
 * projects here instead of one; the switch below is where that branch lands.
 */
export function SortScreen({ scope }: { scope: SortScope }) {
  const projectId = scope.projectId
  const project = useProject(projectId)
  const candidates = useCandidates(projectId)
  const patch = usePatchClip()

  const clips = candidates.data ?? []
  const steps = project.data?.steps ?? ({} as Record<StepName, boolean>)
  // Same check as `ProjectScreen`: the proxy is one file per project, never
  // per clip, so `steps.proxy` speaks for every candidate at once.
  const proxyReady = steps.proxy === true
  const title = project.data?.project.title ?? projectId

  const phase = phaseProject(
    steps,
    project.data?.running ?? null,
    project.data?.error ?? null,
    clips,
    project.data?.everRan ?? true,
  )
  const issue = next(phase, { id: projectId })

  return (
    // `flex-1`, not just `min-h-full`: a flex item's `min-height` sets its own
    // floor but never becomes a definite height its own children can fill —
    // `main`'s `flex-1` video needs this one to actually stretch inside `body`.
    <div className="flex min-h-full flex-1 flex-col">
      <AppBar lieu={{ kind: 'project', project: { id: projectId, title } }}>
        <Link href={linkProject(projectId)} className="text-sm text-muted-foreground hover:underline">
          Retour à la grille
        </Link>
      </AppBar>
      <main className="flex flex-1 flex-col px-4 py-5">
        {!project.isSuccess && !candidates.isSuccess ? (
          <Skeleton className="aspect-video w-full max-w-3xl self-center rounded-xl" />
        ) : !proxyReady ? (
          <NoProxy projectId={projectId} />
        ) : (
          <SortStage
            projectId={projectId}
            clips={clips}
            proxyUrl={`/api/projects/${encodeURIComponent(projectId)}/proxy`}
            next={issue}
            onStatus={(clipId, status) => patch.mutate({ clipId, projectId, patch: { status } })}
          />
        )}
      </main>
    </div>
  )
}

function NoProxy({ projectId }: { projectId: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <Film className="size-6 text-muted-foreground/50" aria-hidden />
      <p className="text-sm text-muted-foreground">
        Cette vue s’ouvre avec le proxy, en cours d’encodage : elle ne peut pas jouer une vidéo qui
        n’existe pas encore.
      </p>
      <Link href={linkProject(projectId)} className="text-sm underline hover:no-underline">
        Trier sur la grille en attendant
      </Link>
    </div>
  )
}
