'use client'

import { useRef } from 'react'

import {
  isComputedFraming,
  originMessage,
  effectiveRatio,
  shotRatios,
  useCurrentShot,
} from '@/components/clip/framing'
import type { Ratio } from '@/core/edl'
import type { PublishedFraming } from '@/lib/api'
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
 * **Le rectangle saute aux frontières de plans pendant la lecture** dès que le
 * cadrage est calculé : c'est là que le cadre change, c'est là qu'une coupe
 * existe déjà, et c'est ce qui fait passer la décision en revue sans qu'on la
 * demande (§3.5). Il est alors **inerte** — la position vient du calcul, et un
 * curseur qui bougerait sans rien changer au fichier produit serait pire qu'un
 * curseur figé. La dérogation par plan, qui le rendra réglable à nouveau, demande
 * une table persistée que le clip ne porte pas encore (§9.4).
 *
 * **C'est le cadre de la variante 9:16 qu'il montre**, celui qui varie : le natif
 * garde un seul ratio pour tout le clip, que le panneau d'export énonce. Montrer
 * le cadre fixe ici reviendrait à ne rien montrer du travail de l'automatique.
 *
 * Quand l'analyse manque, le réglage à la main reprend la main entièrement :
 * c'est le cadrage de l'itération 0, et il n'a jamais été jetable.
 */
export function CropOverlay({
  framing,
  ratio,
  cropX,
  onCropX,
}: {
  /** Le cadrage que le serveur publie : ratio résolu, crop par plan, origine. */
  framing: PublishedFraming
  /** Le ratio **en cours d'édition**, qui n'est pas encore celui du clip enregistré. */
  ratio: Ratio | 'auto'
  /** Le cadrage manuel en cours d'édition. Ignoré quand le cadrage est calculé. */
  cropX: number
  /** Une valeur, ou une fonction de la précédente — indispensable pour les flèches répétées. */
  onCropX: (cropX: number | ((precedent: number) => number)) => void
}) {
  const cadre = useRef<HTMLDivElement>(null)
  // L'écart entre le point saisi et le centre du rectangle, en fraction. Sans
  // lui, le rectangle sauterait pour se centrer sous le pointeur au premier
  // appui — un déplacement que personne n'a demandé.
  const prise = useRef(0)

  // Le plan sous la lecture. Le `hook` s'appelle sans condition, et son résultat
  // n'est consulté que si le cadrage est calculé.
  const plan = useCurrentShot(framing)
  const automatique = isComputedFraming(framing)

  const effectif = effectiveRatio(plan, ratio)
  const position = automatique ? (plan?.cropX ?? 0.5) : cropX
  const largeur = cropWidthFraction(effectif)
  const gauche = cropLeftFraction(position, largeur)
  const centre = clampCropX(position, largeur)
  // Figé quand le cadre couvre toute la source — il n'y a rien à déplacer — ou
  // quand c'est le calcul qui décide de sa position.
  const fige = largeur >= 1 || automatique

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
        aria-label={
          automatique ? 'Position horizontale du cadre, calculée' : 'Position horizontale du cadre'
        }
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
        <span className="absolute top-1 left-1 rounded bg-stage px-1 font-mono text-[0.75rem] font-semibold text-stage-foreground">
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
 * Le choix du ratio.
 *
 * **Une contrainte sur le cadre, pas un format de sortie unique.** Ce que ce
 * sélecteur décide est le **cadre pris dans la source** : `auto` laisse chaque
 * plan prendre le plus serré qui tienne chez lui, une pastille concrète le force
 * partout. Le fichier natif sort alors à ce ratio-là — épingler 4:5 donne un
 * natif 4:5 —, et seule la variante, quand elle est due, a un canevas 1080x1920
 * constant. C'est l'échappatoire quand l'automatique choisit mal, et c'est pour
 * ça qu'il est ici plutôt que dans une page de réglages. (relevé par Copilot)
 */
export function RatioPicker({
  framing,
  ratio,
  onRatio,
}: {
  /** Le cadrage que le serveur publie : c'est lui qui dit ce que vaut « auto ». */
  framing: PublishedFraming
  ratio: Ratio | 'auto'
  onRatio: (ratio: Ratio | 'auto') => void
}) {
  const valeurs: (Ratio | 'auto')[] = ['auto', ...ORDRE_RATIOS]
  const plan = useCurrentShot(framing)
  const effectif = effectiveRatio(plan, ratio)
  const origin = originMessage(framing)
  const varied = ratio === 'auto' ? shotRatios(framing) : []

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

      {/* **Un mot, au même endroit, dans les deux cas** (§3.5). Ce que le
          sélecteur ne peut pas dire seul : ce que « auto » a choisi *pour le
          plan qu'on regarde*, et qu'un ratio épinglé vaut pour tous. */}
      <p className="font-mono text-[0.75rem] text-muted-foreground">
        {ratio === 'auto' ? `auto → ${effectif}` : `${effectif} · épinglé partout`}
        {' · natif '}
        {framing.ratio}
      </p>

      {/* **Le ratio se choisit par plan, et ce n'est pas devinable.** Sans cette
          ligne, un cadre qui change de taille en cours de lecture passe pour un
          défaut de rendu — alors que c'est le bénéfice qu'on cherche : un ratio
          unique écraserait chaque plan serré sous le plus large. */}
      {varied.length > 1 && (
        <p className="basis-full text-[0.75rem] text-muted-foreground">
          Le cadre change avec les plans — <span className="font-mono">{varied.join(', ')}</span> —
          dans la variante 9:16, où chacun est posé sur fond flouté. Le rendu natif, celui du
          feed, garde <span className="font-mono">{framing.ratio}</span> d’un bout à l’autre.
        </p>
      )}

      {/* **Le repli se dit, il ne se subit pas.** `renders` ne dépend pas
          d'`analysis` dans le graphe : rien ne garantit qu'un clip en « auto »
          ait des plans sous la main, et un 9:16 centré posé sans un mot ne se
          verrait qu'à l'image, trois minutes d'export plus tard. */}
      {origin !== null && (
        <p className="basis-full text-[0.75rem] text-amber-500 dark:text-amber-400">{origin}</p>
      )}

      {/* **La raison d'un contrôle inerte s'écrit à côté de lui.** Le curseur de
          framing se fige en 16:9 puisque le cadre couvre alors toute la source ;
          sans cette phrase, il passe pour cassé — et une bulle d'aide ne
          conviendrait pas, elle serait invisible au clavier. */}
      {effectif === '16:9' && (
        <p className="basis-full text-[0.75rem] text-muted-foreground">
          En 16:9 le cadre occupe toute la largeur de la source : il n’y a rien à déplacer.
        </p>
      )}

      {/* **Une seule ligne à la fois, et c'est délibéré.** Quand les cadres
          varient, la ligne au-dessus dit déjà que le calcul décide par plan ; la
          répéter en dessous ferait trois paragraphes empilés sous un sélecteur
          de six pastilles, et personne ne lit le troisième. */}
      {origin === null && varied.length <= 1 && (
        <p className="basis-full text-[0.75rem] text-muted-foreground">
          Le cadre est calculé pour chaque plan et saute à leurs frontières. Le régler à la main
          demande la dérogation par plan, qui n’est pas encore enregistrable.
        </p>
      )}
    </div>
  )
}
