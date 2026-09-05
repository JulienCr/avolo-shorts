'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

import { AppBar } from '@/components/navigation/app-bar'
import { scopeFromSearchParams } from '@/lib/navigation'
import { SortScreen } from '@/components/sort-view/sort-screen'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The `/sort` route, reduced to what a route has to do.
 *
 * **Scope is a search parameter, not a path segment.** The later cross-show
 * queue is the same URL with a different scope, never a sibling route — see
 * `SortScope` in `@/lib/navigation`. `useSearchParams` forces server-rendered
 * on demand, same reason as `/settings` and `/projects/:id`: a Suspense
 * boundary is what `next build` requires around it.
 */
export default function SortPage() {
  return (
    <Suspense fallback={<Loading />}>
      <SortRoute />
    </Suspense>
  )
}

function SortRoute() {
  const scope = scopeFromSearchParams(useSearchParams())
  if (scope === null) {
    return (
      <div className="flex min-h-full flex-col">
        <AppBar lieu={{ kind: 'unknown', label: 'Tri' }} />
        <main className="mx-auto flex w-full max-w-[900px] flex-1 items-center justify-center px-4 py-5 text-sm text-muted-foreground">
          Aucune émission désignée.
        </main>
      </div>
    )
  }
  return <SortScreen scope={scope} />
}

function Loading() {
  return (
    <div className="flex min-h-full flex-col">
      <AppBar lieu={{ kind: 'unknown', label: 'Tri' }} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-5">
        <Skeleton className="aspect-video w-full rounded-xl" />
      </main>
    </div>
  )
}
