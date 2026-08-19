"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Le tiroir : une boîte de dialogue ancrée à un bord de la fenêtre.
 *
 * **Bâti sur `Dialog` et non sur le `Drawer` de Base UI**, et la raison n'est
 * pas l'habitude : `Drawer` porte une zone de balayage et un `Viewport` qui
 * gèrent son propre défilement pour le glisser-fermer. Ce tiroir-ci héberge une
 * surface virtualisée dont le conteneur de défilement doit rester un élément
 * réel, mesuré par `useVirtualizer` — c'est la même raison qui fait refuser
 * `scroll-area` (parcours §6.2), et un second conteneur interposé ferait
 * retomber `scrollToIndex` à côté. `Dialog` ne défile pas et laisse le contenu
 * s'en charger.
 *
 * Ce que la primitive apporte et qu'une boîte écrite à la main rate : le piège
 * de focus, la fermeture par `Échap`, et **le retour du focus au déclencheur**
 * (parcours §4.4).
 *
 * `SheetContent` ne défile pas lui-même (`overflow-hidden`) : c'est délibéré. Un
 * `overflow-y-auto` posé ici donnerait deux barres imbriquées, et la virtualisée
 * mesurerait la mauvaise.
 */

function Sheet({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/25 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * Les quatre ancrages.
 *
 * Le voile reste léger et sans flou, contrairement à celui de `dialog` : ce
 * tiroir-ci s'ouvre à côté d'un aperçu vidéo qu'on continue de regarder pendant
 * qu'on monte, et le brouiller reviendrait à retirer la moitié de l'écran de
 * clip pour éditer l'autre.
 */
const SIDES = {
  right:
    "inset-y-0 right-0 w-full border-l sm:max-w-2xl data-open:slide-in-from-right data-closed:slide-out-to-right",
  left: "inset-y-0 left-0 w-full border-r sm:max-w-2xl data-open:slide-in-from-left data-closed:slide-out-to-left",
  top: "inset-x-0 top-0 max-h-[85dvh] border-b data-open:slide-in-from-top data-closed:slide-out-to-top",
  bottom:
    "inset-x-0 bottom-0 max-h-[85dvh] border-t data-open:slide-in-from-bottom data-closed:slide-out-to-bottom",
} as const

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  side?: keyof typeof SIDES
  showCloseButton?: boolean
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "fixed z-50 flex flex-col overflow-hidden bg-popover text-sm text-popover-foreground shadow-lg duration-150 outline-none data-open:animate-in data-closed:animate-out",
          SIDES[side],
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" />
            }
          >
            <XIcon />
            <span className="sr-only">Fermer</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex shrink-0 flex-col gap-1 border-b p-4 pr-12", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("flex shrink-0 flex-col-reverse gap-2 border-t p-4 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-heading text-base leading-none font-medium", className)}
      {...props}
    />
  )
}

function SheetDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-[0.75rem] text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
}
