import { Settings } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { chemin, lienParametres, type Lieu } from '@/lib/parcours'
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
   * Ce que l'écran pose à droite de la barre, **l'indicateur d'exécution
   * compris**.
   *
   * La barre laisse la place et ne dessine rien : ce qui tourne est un fait du
   * projet, et seul l'écran qui l'interroge sait quoi en dire. Un emplacement
   * unique et convenu évite surtout que trois écrans écrits séparément placent
   * chacun le leur ailleurs — l'écran de projet y met son avancement, celui de
   * clip son état d'enregistrement.
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
        // `text-xs` et non `text-[0.7rem]` : la conception §4.5 pose un plancher
        // de `0.75rem` pour tout ce qui porte une information, et ce lien est le
        // seul chemin de retour à la racine depuis les trois autres écrans.
        // C'était le dernier reste sous le plancher dans tout `src/` (issue #56,
        // point 6).
        className="font-mono text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase transition-colors hover:text-foreground"
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

      <div className="ml-auto flex items-center gap-2">
        {children}
        {/* **Les paramètres se rejoignent depuis partout, et depuis un seul
            endroit.** Ils ne décrivent aucune émission — changer un réglage ne
            recalcule rien, un recalcul reste une action explicite —, donc ils
            n'ont pas de place dans la hiérarchie des trois écrans. La barre est
            le seul élément que ces trois écrans partagent, et la profondeur ne
            dépasse toujours pas trois : `/parametres` est un frère de la racine.

            Il disparaît sur l'écran des paramètres lui-même : un lien vers soi
            n'est pas une navigation, et il volerait un arrêt de tabulation. */}
        {lieu.kind !== 'parametres' && (
          <Link
            href={lienParametres()}
            aria-label="Paramètres"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Settings className="size-4" aria-hidden />
          </Link>
        )}
      </div>
    </header>
  )
}
