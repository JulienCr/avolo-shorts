'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

/**
 * TanStack Query, posé dès l'itération 0.
 *
 * Il a d'abord servi des fixtures, où il n'y avait rien à rafraîchir — et
 * c'était précisément la raison de le poser si tôt. L'analyse dure 30 à
 * 45 minutes (spec §13) : le suivi d'avancement, l'invalidation et la reprise
 * d'étape devaient tous passer par ici. Les deux premiers y passent depuis que la
 * tâche 10 a branché `@/lib/api` sur les vraies routes, sans que `@/lib/queries`
 * ait eu à changer. La reprise d'étape attend son bouton :
 * `POST /api/projects/:id/run` n'a pas d'appelant côté navigateur. Les brancher
 * plus tard aurait voulu dire reprendre chaque composant.
 */
export function Providers({ children }: { children: ReactNode }) {
  // Dans un `useState`, pas au niveau du module : un client partagé entre deux
  // rendus serveur mélangerait les caches de deux visiteurs. Il n'y en a qu'un
  // ici, mais la forme correcte ne coûte rien de plus.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Ces données changent quand quelqu'un les change, pas toutes seules.
            // Un refetch au retour sur l'onglet ne ferait que faire clignoter
            // l'écran de tri au milieu d'un tri.
            refetchOnWindowFocus: false,
            staleTime: 30_000,
          },
        },
      }),
  )

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
