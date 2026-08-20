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
 * **`keepMounted` n'est PAS posé ici, et c'est délibéré après vérification.**
 * Une première version le forçait à `true` en croyant que `aria-controls` du
 * déclencheur en dépendait — faux : dans `useCollapsibleRoot`
 * (`@base-ui/react/collapsible`), `panelId` retombe sur le `useId()` de la
 * racine indépendamment du montage du panneau, et le déclencheur pose
 * `'aria-controls': open ? panelId : undefined` — **`open`, pas
 * `keepMounted`**. Revenir sur `keepMounted: false` et rejouer
 * `hook-fields.test.tsx` ne fait échouer aucun des tests qui vérifient
 * `aria-controls` une fois le panneau ouvert (relevé en review). L'absence
 * d'`aria-controls` quand le panneau est fermé n'est donc pas un défaut :
 * c'est le choix de Base UI, cohérent avec la pratique où le bouton n'a rien
 * à contrôler tant qu'il n'y a rien d'ouvert à désigner — `aria-expanded`
 * porte l'état à lui seul dans ce cas-là.
 */
function CollapsiblePanel({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-panel"
      className={cn('flex flex-col gap-3', className)}
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsiblePanel }
