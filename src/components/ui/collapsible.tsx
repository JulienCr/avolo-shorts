'use client'

import * as React from 'react'
import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible'

import { cn } from '@/lib/utils'

/**
 * Le repli générique, sur `@base-ui/react/collapsible` — même famille que
 * `select.tsx`, `dialog.tsx` et `sheet.tsx`, qui enveloppent déjà Base UI
 * plutôt que Radix. `Root`/`Trigger`/`Panel` posent `aria-expanded` et
 * `aria-controls` tout seuls : rien à câbler à la main ici pour le critère
 * d'accessibilité du repli des surcharges du hook (`hook-fields.tsx`).
 *
 * Premier appelant : le panneau des dix surcharges de `HookFields`, fermé
 * par défaut. Aucun composant `ui/` ne portait encore ce besoin.
 */
const Collapsible = CollapsiblePrimitive.Root

function CollapsibleTrigger({
  className,
  ...props
}: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn('outline-none', className)}
      {...props}
    />
  )
}

/**
 * **`keepMounted` par défaut.** Sans lui, Base UI retire le panneau du DOM
 * quand il est fermé — et avec lui, `aria-controls` du déclencheur, qui ne
 * peut pas référencer un `id` que rien ne porte plus. Mesuré : sans
 * `keepMounted`, le bouton « Personnaliser » de `HookFields` gardait
 * `aria-expanded="false"` mais perdait `aria-controls` entièrement, exactement
 * le critère d'accessibilité que ce repli doit tenir. Fermé, Base UI pose
 * `hidden` sur le panneau à la place — invisible et hors du parcours du
 * clavier, mais toujours référençable.
 */
function CollapsiblePanel({
  className,
  keepMounted = true,
  ...props
}: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-panel"
      keepMounted={keepMounted}
      className={cn('flex flex-col gap-3', className)}
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsiblePanel }
