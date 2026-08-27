'use client'

import { Suspense } from 'react'

import { AppBar } from '@/components/navigation/app-bar'
import { PlanningScreen } from '@/components/planning/planning-screen'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * La route `/planning`, réduite à ce qu'une route doit faire.
 *
 * `PlanningScreen` lit désormais `?preview=` par `useSearchParams`, ce qui
 * fait sortir du rendu statique et que `next build` refuse sans une limite de
 * Suspense — même règle que `/settings` (voir son commentaire).
 */
export default function PlanningPage() {
  return (
    <Suspense fallback={<Loading />}>
      <PlanningScreen />
    </Suspense>
  )
}

function Loading() {
  return (
    <div className="flex min-h-full flex-col">
      <AppBar lieu={{ kind: 'planning' }} />
      <div className="mx-auto w-full max-w-[110rem] flex-1 px-6 py-6">
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  )
}
