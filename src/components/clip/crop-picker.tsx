'use client'

import { useRef } from 'react'

import type { Ratio } from '@/core/edl'
import { resolveRatio } from '@/core/framing'
import {
  ORDRE_RATIOS,
  clampCropX,
  cropLeftFraction,
  cropWidthFraction,
} from '@/lib/crop-preview'
import { cn } from '@/lib/utils'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

/** Le pas du clavier, en fraction de la largeur de l'image. */
const PAS = 0.01
const PAS_RAPIDE = 0.05

/**
 * Le rectangle de cadrage, posé sur l'image.
 *
 * **Pleine hauteur, déplaçable horizontalement seulement** (spec §2). Il n'y a
 * rien à régler verticalement : le crop prend toute la hauteur de la source,
 * donc un seul nombre — `cropX`, le centre entre 0 et 1 — décrit entièrement le
 * cadre. Un rectangle à quatre poignées offrirait trois degrés de liberté qui
 * n'existent pas, et inviterait à recadrer verticalement, ce qui rognerait les
 * comédiens.
 *
 * **Ce n'est pas un `slider`, et la primitive générique est refusée pour trois
 * raisons cumulées** : sa plage dépend du ratio — le centre d'un 9:16 ne va que
 * de 15,8 à 84,2 % —, la prise garde l'écart entre le point saisi et le centre
 * pour ne pas sauter au premier appui, et il se fige en 16:9. Une primitive
 * générique perdrait les trois.
 *
 * Le réglage à la main n'est pas un pis-aller jetable : quand le cadrage
 * automatique arrivera (itération 1), il ne fera que préremplir cette valeur, et
 * ce rectangle restera le recours de dernier ressort.
 */
export function CropOverlay({
  ratio,
  cropX,
  onCropX,
}: {
  ratio: Ratio | 'auto'
  cropX: number
  /** Une valeur, ou une fonction de la précédente — indispensable pour les flèches répétées. */
  onCropX: (cropX: number | ((precedent: number) => number)) => void
}) {
  const cadre = useRef<HTMLDivElement>(null)
  // L'écart entre le point saisi et le centre du rectangle, en fraction. Sans
  // lui, le rectangle sauterait pour se centrer sous le pointeur au premier
  // appui — un déplacement que personne n'a demandé.
  const prise = useRef(0)

  // `resolveRatio` vient de `@/core/framing` : c'est le rendu qui décide de ce
  // que vaut `'auto'`, l'aperçu ne fait que le lui demander.
  const effectif = resolveRatio(ratio)
  const largeur = cropWidthFraction(effectif)
  const gauche = cropLeftFraction(cropX, largeur)
  const centre = clampCropX(cropX, largeur)
  const fige = largeur >= 1

  function fractionDuPointeur(clientX: number): number | null {
    const rect = cadre.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return null
    return (clientX - rect.left) / rect.width
  }

  function surClavier(e: React.KeyboardEvent) {
    const pas = e.shiftKey ? PAS_RAPIDE : PAS
    // Depuis la valeur précédente et non depuis `centre` : une flèche maintenue
    // envoie plusieurs frappes avant le prochain rendu, et toutes liraient sinon
    // la même valeur — le cadre n'avancerait que d'un cran.
    if (e.key === 'ArrowLeft') onCropX((p) => clampCropX(p - pas, largeur))
    else if (e.key === 'ArrowRight') onCropX((p) => clampCropX(p + pas, largeur))
    else if (e.key === 'Home') onCropX(clampCropX(0, largeur))
    else if (e.key === 'End') onCropX(clampCropX(1, largeur))
    else return
    e.preventDefault()
  }

  return (
    <div ref={cadre} className="pointer-events-none absolute inset-0">
      {/* Ce qui tombe hors du cadre est assombri, pas masqué : on cadre en
          regardant ce qu'on laisse dehors. */}
      <div
        className="absolute inset-y-0 left-0 bg-black/55"
        style={{ width: `${gauche * 100}%` }}
        aria-hidden
      />
      <div
        className="absolute inset-y-0 right-0 bg-black/55"
        style={{ width: `${(1 - gauche - largeur) * 100}%` }}
        aria-hidden
      />

      <div
        role="slider"
        tabIndex={fige ? -1 : 0}
        aria-label="Position horizontale du cadre"
        // La plage réelle, pas 0-100 : le centre d'un 9:16 ne peut aller que de
        // 15,8 à 84,2 % puisque le rectangle ne sort jamais du cadre. Annoncer
        // « 16 sur 100 » à la butée gauche laisserait croire qu'il reste de la
        // marge.
        aria-valuemin={Math.round((largeur / 2) * 100)}
        aria-valuemax={Math.round((1 - largeur / 2) * 100)}
        aria-valuenow={Math.round(centre * 100)}
        aria-valuetext={`${Math.round(centre * 100)} % de la largeur`}
        aria-disabled={fige || undefined}
        onKeyDown={fige ? undefined : surClavier}
        onPointerDown={(e) => {
          if (fige) return
          const f = fractionDuPointeur(e.clientX)
          if (f === null) return
          prise.current = f - centre
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (fige || !e.currentTarget.hasPointerCapture(e.pointerId)) return
          const f = fractionDuPointeur(e.clientX)
          if (f === null) return
          onCropX(clampCropX(f - prise.current, largeur))
        }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
        className={cn(
          'pointer-events-auto absolute inset-y-0 outline-none',
          'border-2 border-stage/90 shadow-[0_0_0_1px_rgba(0,0,0,0.45)]',
          'focus-visible:ring-2 focus-visible:ring-stage focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950',
          fige ? 'cursor-default' : 'cursor-ew-resize',
        )}
        style={{ left: `${gauche * 100}%`, width: `${largeur * 100}%` }}
      >
        <span className="absolute top-1 left-1 rounded bg-stage px-1 font-mono text-[0.65rem] font-semibold text-stage-foreground">
          {effectif}
        </span>

        {!fige && (
          <>
            <span
              aria-hidden
              className="absolute top-1/2 left-0 h-9 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-stage"
            />
            <span
              aria-hidden
              className="absolute top-1/2 right-0 h-9 w-1 translate-x-1/2 -translate-y-1/2 rounded-full bg-stage"
            />
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Le choix du ratio, **par clip**.
 *
 * Sur trois émissions, seuls 24 à 33 % du temps tiennent dans un 9:16, contre
 * 48 % jusqu'au 1:1 (spec §2). Tout sortir en 9:16 jette donc la moitié du
 * matériel : c'est pour ça que ce sélecteur existe, et pour ça qu'il est ici
 * plutôt que dans une page de réglages.
 */
export function RatioPicker({
  ratio,
  onRatio,
}: {
  ratio: Ratio | 'auto'
  onRatio: (ratio: Ratio | 'auto') => void
}) {
  const valeurs: (Ratio | 'auto')[] = ['auto', ...ORDRE_RATIOS]

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <ToggleGroup
        value={[ratio]}
        onValueChange={(choisi: string[]) => {
          // En sélection unique, recliquer l'élément actif rend une liste vide.
          // Un clip a toujours un ratio : on garde alors le précédent.
          const suivant = choisi[0] as Ratio | 'auto' | undefined
          if (suivant) onRatio(suivant)
        }}
        variant="outline"
        size="sm"
        spacing={0}
        aria-label="Ratio de sortie"
      >
        {valeurs.map((v) => (
          <ToggleGroupItem key={v} value={v} className="font-mono text-xs">
            {v}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {ratio === 'auto' && (
        <p className="text-[0.7rem] text-muted-foreground">
          « auto » vaut 9:16 en itération 0 — le cadrage automatique n’existe pas encore.
        </p>
      )}
    </div>
  )
}
