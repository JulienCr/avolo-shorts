'use client'

import Link from 'next/link'
import { use } from 'react'

import { AppBar } from '@/components/navigation/app-bar'
import { ClipScreen } from '@/components/clip/clip-screen'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { routeId } from '@/lib/navigation'
import { useClip } from '@/lib/queries'

/**
 * La route `/clips/:id`.
 *
 * Elle ne compose rien : elle résout son paramètre, demande le clip, et rend
 * l'un des trois états. Le montage lui-même est dans
 * `@/components/clip/clip-screen`, ce qui le rend montable en test sans passer
 * par `use(params)`.
 */
export default function ClipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = use(params)
  const id = routeId(raw)
  const detail = useClip(id)

  return (
    <div className="flex h-dvh flex-col">
      {detail.data ? (
        <ClipScreen detail={detail.data} />
      ) : (
        <>
          <AppBar lieu={{ kind: 'unknown', label: detail.isError ? 'Clip introuvable' : '…' }} />
          <main className="mx-auto w-full max-w-5xl flex-1 p-6">
            {detail.isError ? (
              // Pas d'impasse : le fil d'Ariane reste atteignable, et la
              // bibliothèque est à un cran.
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Ce clip n’existe pas, ou le projet qui le portait a été supprimé.
                </p>
                <Button render={<Link href="/" />} variant="outline">
                  Revenir à la bibliothèque
                </Button>
              </div>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                <Skeleton className="aspect-video w-full rounded-lg" />
                <div className="space-y-3">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                </div>
              </div>
            )}
          </main>
        </>
      )}
    </div>
  )
}
