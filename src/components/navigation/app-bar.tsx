import { CalendarClock, Settings } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { path, planningLink, settingsLink, type Lieu } from '@/lib/navigation'
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
 * recopié. `chemin` (`@/lib/navigation`) le décrit une fois pour toutes, la
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
  const feed = path(lieu)

  return (
    <header
      className={cn(
        'sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-brand-blue px-4 text-brand-blue-foreground backdrop-blur',
        className,
      )}
    >
      <Link href="/" className="flex items-center opacity-90 transition-opacity hover:opacity-100">
        <Image src="/avolo-logo.png" alt="avolo·shorts" width={32} height={32} priority />
      </Link>

      {feed.map((step, i) => (
        <span key={i} className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="text-brand-blue-foreground/40">
            /
          </span>
          {step.href ? (
            <Link
              href={step.href}
              className="truncate text-sm text-brand-blue-foreground/70 transition-colors hover:text-brand-blue-foreground"
            >
              {step.label}
            </Link>
          ) : (
            // Le dernier cran est l'écran où l'on est : un lien vers soi-même
            // n'est pas une navigation, et il volerait un arrêt de tabulation.
            <span className="truncate text-sm font-medium">{step.label}</span>
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
            dépasse toujours pas trois : `/settings` est un frère de la racine.

            Il disparaît sur l'écran des paramètres lui-même : un lien vers soi
            n'est pas une navigation, et il volerait un arrêt de tabulation. */}
        {lieu.kind !== 'planning' && (
          <Link
            href={planningLink()}
            aria-label="Planning"
            className="flex size-8 items-center justify-center rounded-md text-brand-blue-foreground/70 transition-colors outline-none hover:bg-brand-blue-foreground/10 hover:text-brand-blue-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CalendarClock className="size-4" aria-hidden />
          </Link>
        )}
        {lieu.kind !== 'settings' && (
          <Link
            href={settingsLink()}
            aria-label="Paramètres"
            className="flex size-8 items-center justify-center rounded-md text-brand-blue-foreground/70 transition-colors outline-none hover:bg-brand-blue-foreground/10 hover:text-brand-blue-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Settings className="size-4" aria-hidden />
          </Link>
        )}
      </div>
    </header>
  )
}
