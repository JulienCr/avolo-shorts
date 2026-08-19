'use client'

import { Suspense, use } from 'react'

import { AppBar } from '@/components/navigation/app-bar'
import { ProjectScreen } from '@/components/review/project-screen'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * La route `/projects/:id`, réduite à ce qu'une route doit faire.
 *
 * Elle résout ses `params` et pose la limite de Suspense ; tout le reste est
 * dans `ProjectScreen`. **La limite n'est pas décorative** : `useSearchParams`
 * fait sortir du rendu statique, et `next build` refuse un composant qui
 * l'appelle sans elle — vérifié, la route sort bien en « server-rendered on
 * demand ».
 */
export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return (
    <Suspense fallback={<Loading id={id} />}>
      <ProjectScreen id={id} />
    </Suspense>
  )
}

function Loading({ id }: { id: string }) {
  return (
    <div className="flex min-h-full flex-col">
      <AppBar lieu={{ kind: 'projet', project: { id, title: id } }} />
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-4/3 rounded-xl" />
          ))}
        </div>
      </main>
    </div>
  )
}
