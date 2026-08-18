import Link from 'next/link'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * La barre d'application : douze unités de haut, un filet, et rien d'autre.
 *
 * C'est le premier endroit où se joue le « rendu d'application de bureau plutôt
 * que de site web » de la spec §13. Un en-tête de site respire ; une barre
 * d'outil ne prend pas la place du travail.
 */
export function AppBar({
  chemin,
  children,
  className,
}: {
  /** Le fil d'Ariane, du plus général au plus précis. */
  chemin: { libelle: string; href?: string }[]
  children?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        'sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur',
        className,
      )}
    >
      <Link
        href="/"
        className="font-mono text-[0.7rem] font-semibold tracking-[0.18em] text-muted-foreground uppercase transition-colors hover:text-foreground"
      >
        avolo·shorts
      </Link>

      {chemin.map((etape, i) => (
        <span key={i} className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="text-muted-foreground/40">
            /
          </span>
          {etape.href ? (
            <Link
              href={etape.href}
              className="truncate text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {etape.libelle}
            </Link>
          ) : (
            <span className="truncate text-sm font-medium">{etape.libelle}</span>
          )}
        </span>
      ))}

      <div className="ml-auto flex items-center gap-2">{children}</div>
    </header>
  )
}
