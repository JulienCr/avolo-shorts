'use client'

import { ChevronRight } from 'lucide-react'
import Link from 'next/link'

import { AppBar } from '@/components/parcours/app-bar'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDuration } from '@/lib/format'
import { lienProjet } from '@/lib/parcours'
import { useProjets } from '@/lib/queries'

/**
 * La liste des émissions analysées.
 *
 * L'ingestion (tâche 7) et le lanceur (tâche 10) existent depuis les PR #18 et
 * #20, mais rien ici ne les appelle : `POST /api/projects` et
 * `POST /api/projects/:id/run` n'ont pas d'appelant côté navigateur. Le
 * sélecteur de source et la création d'un projet sont la tâche 15. D'ici là,
 * cette page n'ouvre rien de nouveau, elle mène au tri de ce qui est déjà là.
 */
export default function Accueil() {
  const projets = useProjets()

  return (
    <div className="flex min-h-full flex-col">
      <AppBar lieu={{ kind: 'bibliotheque' }} />

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
        <h1 className="text-xl font-semibold tracking-tight">Émissions</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Un clip est une liste de segments : on raccourcit une vanne trop longue en retirant son
          milieu, jamais en tronquant sa chute.
        </p>

        {projets.isPending && (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        )}

        <ul className="space-y-2">
          {projets.data?.map((projet) => (
            <li key={projet.id}>
              <Link
                href={lienProjet(projet.id)}
                className="flex items-center gap-4 rounded-xl border bg-card px-4 py-3 transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{projet.title}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{projet.id}</p>
                </div>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {formatDuration(projet.durationSec)}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}
