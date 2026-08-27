'use client'

import { Suspense } from 'react'

import { AppBar } from '@/components/navigation/app-bar'
import { SettingsScreen } from '@/components/settings/settings-screen'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * La route `/settings`, réduite à ce qu'une route doit faire.
 *
 * Tout est dans `SettingsScreen`. Elle lit désormais `?tab=` par
 * `useSearchParams` — ce qui fait sortir du rendu statique et que `next build`
 * refuse sans une limite de Suspense, comme `/projects/:id` (voir son
 * commentaire). La séparation reste aussi ce qui rend l'écran montable en
 * test : `use(params)` ne se résout pas sous jsdom.
 */
export default function SettingsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <SettingsScreen />
    </Suspense>
  )
}

function Loading() {
  return (
    <div className="flex min-h-full flex-col">
      <AppBar lieu={{ kind: 'settings' }} />
      <div className="mx-auto w-full max-w-[110rem] flex-1 px-6 py-6">
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  )
}
