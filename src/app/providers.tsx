'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

/**
 * TanStack Query, posé dès l'itération 0.
 *
 * Il n'y a pourtant rien à rafraîchir tant que les données viennent de
 * fixtures — et c'est précisément la raison de le poser maintenant. L'analyse
 * dure 30 à 45 minutes (spec §13) : le suivi d'avancement, l'invalidation et la
 * reprise d'étape passeront tous par ici. Les brancher plus tard voudrait dire
 * reprendre chaque composant ; les brancher maintenant ne coûte que ce fichier.
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
