import Link from 'next/link'
import type { ReactNode } from 'react'

import { chemin, type Lieu } from '@/lib/parcours'
import { cn } from '@/lib/utils'

/**
 * La barre d'application : douze unités de haut, un filet, et rien d'autre.
 *
 * C'est le premier endroit où se joue le « rendu d'application de bureau plutôt
 * que de site web » de la spec §13. Un en-tête de site respire ; une barre
 * d'outil ne prend pas la place du travail.
 *
 * **Elle reçoit un lieu, pas un fil d'Ariane.** Les trois écrans construisaient
 * chacun le leur à la main, sous forme d'un tableau positionnel : le modèle de
 * navigation était donc recopié trois fois, et une quatrième page l'aurait
 * recopié. `chemin` (`@/lib/parcours`) le décrit une fois pour toutes, la
 * profondeur maximale comprise.
 */
export function AppBar({
  lieu,
  children,
  className,
}: {
  /** Où l'on est. Le fil d'Ariane s'en déduit. */
  lieu: Lieu
  /**
   * L'emplacement de l'indicateur d'exécution, à droite de la barre.
   *
   * La barre laisse la place et ne dessine rien : ce qui tourne est un fait du
   * projet, et seul l'écran qui l'interroge sait quoi en dire. C'est aussi ce
   * qui évite que trois écrans écrits séparément placent chacun le leur
   * ailleurs.
   */
  children?: ReactNode
  className?: string
}) {
  const fil = chemin(lieu)

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

      {fil.map((etape, i) => (
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
            // Le dernier cran est l'écran où l'on est : un lien vers soi-même
            // n'est pas une navigation, et il volerait un arrêt de tabulation.
            <span className="truncate text-sm font-medium">{etape.libelle}</span>
          )}
        </span>
      ))}

      <div className="ml-auto flex items-center gap-2">{children}</div>
    </header>
  )
}
