'use client'

import { useRef } from 'react'

import {
  isComputedFraming,
  originMessage,
  effectiveRatio,
  shotRatios,
  anyShotSplit,
  activeSplit,
  useCurrentShot,
} from '@/components/clip/framing'
import type { Ratio } from '@/core/edl'
import type { PublishedFraming } from '@/lib/api'
import {
  ORDER_RATIOS,
  clampCropX,
  cropLeftFraction,
  cropWidthFraction,
} from '@/lib/crop-preview'
import { cn } from '@/lib/utils'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

/** Le pas du clavier, en fraction de la largeur de l'image. */
const NOT = 0.01
const NOT_FAST = 0.05

/**
 * Pourquoi le curseur de cadrage ne déplace rien, ou `null` quand il déplace.
 *
 * Trois causes cumulables, dans l'ordre où elles priment : le plan est
 * splitté (deux cellules, pas de crop unique) ; le cadrage est calculé (la
 * dérogation par plan qui rendrait le curseur utile n'existe pas encore,
 * §9.4) ; ou le cadre couvre toute la source (16:9, rien à déplacer).
 * `CropOverlay` et `RatioPicker` l'appellent tous deux, pour ne jamais rendre
 * deux textes différents pour la même cause.
 */
export function frozenCropReason(
  framing: PublishedFraming,
  effective: Ratio,
  split = false,
): string | null {
  if (split) {
    return 'Ce plan pose deux personnes en deux cellules empilées (split-screen) : il n’y a pas un seul crop à déplacer.'
  }
  const computed = isComputedFraming(framing)
  const fullWidth = cropWidthFraction(effective) >= 1
  if (fullWidth) {
    return computed
      ? 'En 16:9 le cadre occupe toute la largeur de la source : il n’y a rien à déplacer. Sur un plan plus serré, la position est calculée et le curseur ne la déplace pas — la régler à la main demande la dérogation par plan, qui n’est pas encore enregistrable.'
      : 'En 16:9 le cadre occupe toute la largeur de la source : il n’y a rien à déplacer.'
  }
  return computed
    ? 'Le cadre est calculé pour chaque plan et saute à leurs frontières : le curseur ne le déplace pas. Le régler à la main demande la dérogation par plan, qui n’est pas encore enregistrable.'
    : null
}

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
  describedBy,
}: {
  /** Le cadrage que le serveur publie : ratio résolu, crop par plan, origine. */
  framing: PublishedFraming
  /** Le ratio **en cours d'édition**, qui n'est pas encore celui du clip enregistré. */
  ratio: Ratio | 'auto'
  /** Le cadrage manuel en cours d'édition. Ignoré quand le cadrage est calculé. */
  cropX: number
  /** Une valeur, ou une fonction de la précédente — indispensable pour les flèches répétées. */
  onCropX: (cropX: number | ((previous: number) => number)) => void
  /**
   * L'élément qui porte la raison de l'inertie, rendu par `RatioPicker`.
   *
   * **L'adjacence ne suffit pas.** À l'œil, une phrase posée sous le sélecteur
   * se lit ; à la voix, sans `aria-describedby` on entend « position
   * horizontale du cadre, calculée » et rien d'autre — c'est-à-dire un contrôle
   * qui ne répond pas sans qu'on sache pourquoi. Même raccord que le bouton
   * « Monter » d'une carte de candidat.
   */
  describedBy?: string
}) {
  const frame = useRef<HTMLDivElement>(null)
  // L'écart entre le point saisi et le centre du rectangle, en fraction. Sans
  // lui, le rectangle sauterait pour se centrer sous le pointeur au premier
  // appui — un déplacement que personne n'a demandé.
  const prise = useRef(0)

  // Le plan sous la lecture. Le `hook` s'appelle sans condition, et son résultat
  // n'est consulté que si le cadrage est calculé.
  const shot = useCurrentShot(framing)
  const automatic = isComputedFraming(framing)

  const effective = effectiveRatio(shot, ratio)
  const split = activeSplit(shot, framing, ratio)
  const position = automatic ? (shot?.cropX ?? 0.5) : cropX
  const width = cropWidthFraction(effective)
  const left = cropLeftFraction(position, width)
  const center = clampCropX(position, width)
  // Figé quand le cadre couvre toute la source, ou quand c'est le calcul qui
  // décide de sa position. `split` n'a pas sa place ici : il n'est jamais posé
  // hors du cadrage calculé, donc `automatic` couvre déjà ce cas.
  const frozen = width >= 1 || automatic
  // La même énumération que celle qu'affiche `RatioPicker`, appelée plutôt que
  // recopiée : deux conditions parallèles finissent par diverger, et le jour où
  // elles divergent le rectangle décrit un texte qui n'est plus rendu.
  const reason = frozenCropReason(framing, effective, split)

  function pointerFraction(clientX: number): number | null {
    const rect = frame.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return null
    return (clientX - rect.left) / rect.width
  }

  function onKeyboard(e: React.KeyboardEvent) {
    const not = e.shiftKey ? NOT_FAST : NOT
    // Depuis la valeur précédente et non depuis `center` : une flèche maintenue
    // envoie plusieurs frappes avant le prochain rendu, et toutes liraient sinon
    // la même valeur — le cadre n'avancerait que d'un cran.
    if (e.key === 'ArrowLeft') onCropX((p) => clampCropX(p - not, width))
    else if (e.key === 'ArrowRight') onCropX((p) => clampCropX(p + not, width))
    else if (e.key === 'Home') onCropX(clampCropX(0, width))
    else if (e.key === 'End') onCropX(clampCropX(1, width))
    else return
    e.preventDefault()
  }

  if (split && shot?.split) {
    // Pas de crop unique à situer : deux rectangles, un par cellule, dans les
    // coordonnées de la source (mêmes fractions que `splitCellRect`). Un
    // `slider` mentirait sur les deux (`aria-valuenow` d'une position qui
    // n'existe pas) ; `group` porte la même raison sans en simuler une.
    // (relevé par Codex, Copilot)
    return (
      <div
        ref={frame}
        role="group"
        tabIndex={reason !== null ? 0 : -1}
        aria-label="Cadre de ce plan, en deux cellules empilées"
        aria-describedby={reason !== null ? describedBy : undefined}
        className="pointer-events-none absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-stage focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
      >
        {shot.split.map((cell, i) => (
          <div
            key={i}
            aria-hidden
            className="absolute border-2 border-stage/90 shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
            style={{
              left: `${cell.x0 * 100}%`,
              top: `${cell.y0 * 100}%`,
              width: `${(cell.x1 - cell.x0) * 100}%`,
              height: `${(cell.y1 - cell.y0) * 100}%`,
            }}
          />
        ))}
      </div>
    )
  }

  return (
    <div ref={frame} className="pointer-events-none absolute inset-0">
      {/* Ce qui tombe hors du cadre est assombri, pas masqué : on cadre en
          regardant ce qu'on laisse dehors. */}
      <div
        className="absolute inset-y-0 left-0 bg-black/55"
        style={{ width: `${left * 100}%` }}
        aria-hidden
      />
      <div
        className="absolute inset-y-0 right-0 bg-black/55"
        style={{ width: `${(1 - left - width) * 100}%` }}
        aria-hidden
      />

      <div
        role="slider"
        // **Inerte, mais pas absent.** `disabled` — ou un `tabIndex` à -1 — sort
        // du parcours de tabulation : au clavier on ne découvre ni le contrôle
        // ni la raison pour laquelle il ne répond pas (§4.4). Le rectangle reste
        // donc atteignable tant qu'il a quelque chose à dire, et ne se retire
        // que s'il n'a plus rien à expliquer.
        tabIndex={frozen && reason === null ? -1 : 0}
        aria-label={
          automatic ? 'Position horizontale du cadre, calculée' : 'Position horizontale du cadre'
        }
        aria-describedby={frozen && reason !== null ? describedBy : undefined}
        // La plage réelle, pas 0-100 : le centre d'un 9:16 ne peut aller que de
        // 15,8 à 84,2 % puisque le rectangle ne sort jamais du cadre. Annoncer
        // « 16 sur 100 » à la butée gauche laisserait croire qu'il reste de la
        // marge.
        aria-valuemin={Math.round((width / 2) * 100)}
        aria-valuemax={Math.round((1 - width / 2) * 100)}
        aria-valuenow={Math.round(center * 100)}
        aria-valuetext={`${Math.round(center * 100)} % de la largeur`}
        aria-disabled={frozen || undefined}
        onKeyDown={frozen ? undefined : onKeyboard}
        onPointerDown={(e) => {
          if (frozen) return
          const f = pointerFraction(e.clientX)
          if (f === null) return
          prise.current = f - center
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (frozen || !e.currentTarget.hasPointerCapture(e.pointerId)) return
          const f = pointerFraction(e.clientX)
          if (f === null) return
          onCropX(clampCropX(f - prise.current, width))
        }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
        className={cn(
          'pointer-events-auto absolute inset-y-0 outline-none',
          'border-2 border-stage/90 shadow-[0_0_0_1px_rgba(0,0,0,0.45)]',
          'focus-visible:ring-2 focus-visible:ring-stage focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950',
          frozen ? 'cursor-default' : 'cursor-ew-resize',
        )}
        style={{ left: `${left * 100}%`, width: `${width * 100}%` }}
      >
        {/* `split` a déjà rendu son propre retour ci-dessus : ici, toujours `effective`. */}
        <span className="absolute top-1 left-1 rounded bg-stage px-1 font-mono text-[0.75rem] font-semibold text-stage-foreground">
          {effective}
        </span>

        {!frozen && (
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
 *
 * **Le piège que le libellé ferme, et qui n'est écrit dans aucune spec.** Depuis
 * que la spec §11 a tranché les deux fichiers, ce sélecteur porte deux
 * conséquences qui ne se ressemblent pas : il fixe le ratio du **fichier natif**,
 * un seul pour tout le clip, pendant que la **variante 9:16** pose *chaque plan*
 * au cadre le plus serré qui tienne, sans que personne ne le règle. Quelqu'un qui
 * croirait piloter sa sortie TikTok plan par plan avec ces six pastilles se
 * tromperait, et rien dans la géométrie de l'écran ne l'en empêche — les deux
 * aperçus montrent le cadre de la *variante*, qui est celui qui bouge.
 *
 * D'où deux lignes sous le sélecteur, et non une : la première dit ce qu'il vaut
 * ici et maintenant, la seconde **nomme les deux fichiers**. Elle est longue
 * parce qu'elle a deux choses à dire ; la raccourcir en supprimant l'un des deux
 * noms rouvre exactement le piège, et c'est la refonte suivante qui le paierait.
 */
export function RatioPicker({
  framing,
  ratio,
  onRatio,
  cropReasonId,
}: {
  /** Le cadrage que le serveur publie : c'est lui qui dit ce que vaut « auto ». */
  framing: PublishedFraming
  ratio: Ratio | 'auto'
  onRatio: (ratio: Ratio | 'auto') => void
  /**
   * L'identifiant de la phrase qui dit pourquoi le rectangle de cadrage ne
   * bouge pas. Le rectangle la désigne par `aria-describedby` ; elle est rendue
   * ici, sous le sélecteur, parce qu'une superposition sur l'image n'a pas de
   * place pour du texte.
   */
  cropReasonId?: string
}) {
  const values: (Ratio | 'auto')[] = ['auto', ...ORDER_RATIOS]
  const shot = useCurrentShot(framing)
  const effective = effectiveRatio(shot, ratio)
  const split = activeSplit(shot, framing, ratio)
  const anySplit = anyShotSplit(framing)
  const origin = originMessage(framing)
  const varied = ratio === 'auto' ? shotRatios(framing) : []
  const varies = varied.length > 1
  /**
   * Le ratio du fichier natif **tel que le prochain rendu le prendra**.
   *
   * `framing.ratio` est celui que le serveur a résolu au dernier `PATCH`, donc
   * celui d'avant tant que l'écriture différée n'est pas partie : épingler 4:5
   * sur un clip résolu en 9:16 faisait annoncer « le natif est déjà vertical »
   * pendant une seconde, c'est-à-dire une sortie qui n'aura pas lieu. Un ratio
   * épinglé, lui, se connaît tout de suite — `computeFraming` le prend verbatim.
   * (relevé par Aristarque)
   */
  const nativeRatio = ratio === 'auto' ? framing.ratio : ratio
  // La variante n'existe que si le natif n'est pas déjà vertical (spec §11).
  const variantDue = nativeRatio !== '9:16'
  const cropReason = frozenCropReason(framing, effective, split)

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <ToggleGroup
        value={[ratio]}
        onValueChange={(chosen: string[]) => {
          // En sélection unique, recliquer l'élément actif rend une liste vide.
          // Un clip a toujours un ratio : on garde alors le précédent.
          const next = chosen[0] as Ratio | 'auto' | undefined
          if (next) onRatio(next)
        }}
        variant="outline"
        size="sm"
        spacing={0}
        // **« de sortie » était le mot faux.** Il y a deux sorties, et ce
        // sélecteur n'en règle qu'une directement.
        aria-label="Ratio du cadre pris dans la source"
      >
        {values.map((v) => (
          <ToggleGroupItem key={v} value={v} className="font-mono text-xs">
            {v}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {/* **Un mot, au même endroit, dans les deux cas** (§3.5). Ce que le
          sélecteur ne peut pas dire seul : ce que « auto » a choisi *pour le
          plan qu'on regarde*, et qu'un ratio épinglé vaut pour tous. */}
      <p className="font-mono text-[0.75rem] text-muted-foreground">
        {ratio === 'auto'
          ? `auto → ${split ? 'split' : effective}`
          : split
            ? 'split · sur ce plan'
            : `${effective} · épinglé partout`}
        {' · natif '}
        {nativeRatio}
      </p>

      {/* **La ligne qui nomme les deux fichiers reste visible, toujours.**
          `2026-08-18-parcours-utilisateur-design.md` §3.3 : c'est elle seule qui
          empêche de croire que les six pastilles de ratio règlent la sortie
          verticale plan par plan. Ce qui folde en dessous, ce sont les phrases
          qui expliquent *comment* chacune se comporte (§4.1 du 23 août) — la
          distinction est le point du geste : le nom ne se cache jamais, la
          notice s'ouvre à la demande. (relevé par Aristarque) */}
      <p className="basis-full text-[0.75rem] text-muted-foreground">
        <strong className="font-medium">Fichier natif</strong>{' '}
        <span className="font-mono">{nativeRatio}</span>
        {' · '}
        <strong className="font-medium">Variante 9:16</strong>{' '}
        {variantDue ? (anySplit ? 'sur fond flouté, en split sur certains plans' : 'sur fond flouté') : 'aucune'}
      </p>

      <details className="group/comportement basis-full">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-[0.75rem] text-muted-foreground marker:content-none hover:text-foreground">
          <span className="inline-block transition-transform group-open/comportement:rotate-90">
            ›
          </span>
          Comment chaque sortie se comporte
        </summary>
        <p className="mt-1 text-[0.75rem] text-muted-foreground">
          {variantDue ? (
            <>
              Le <strong className="font-medium">fichier natif</strong> sort en{' '}
              <span className="font-mono">{nativeRatio}</span>, le même d’un bout à l’autre, pour le
              feed. La <strong className="font-medium">variante 9:16</strong> pose chaque plan sur
              un canevas vertical, sur fond flouté
              {varies && (
                <>
                  {' '}
                  — le cadre y change avec les plans (
                  <span className="font-mono">{varied.join(', ')}</span>)
                </>
              )}
              {anySplit && (
                <>
                  {' '}
                  — un plan à deux personnes se pose en deux cellules empilées, sans fond
                </>
              )}{' '}
              : elle suit le calcul et ne se règle pas ici.
            </>
          ) : (
            <>
              Le <strong className="font-medium">fichier natif</strong> est déjà vertical : c’est la
              seule sortie, il n’y a pas de variante à produire.
            </>
          )}
        </p>
      </details>

      {/* **Le repli se dit, il ne se subit pas** — mais il se lit à la demande.
          `renders` ne dépend pas d'`analysis` dans le graphe : rien ne garantit
          qu'un clip en « auto » ait des plans sous la main, et un 9:16 centré
          posé sans un mot ne se verrait qu'à l'image, trois minutes d'export
          plus tard. C'était la troisième prose permanente de l'écran de clip
          (retour d'usage §4.1) ; elle passe derrière un dépliant plutôt que de
          disparaître, parce que c'est un avertissement, pas une explication
          qu'on apprend une fois. Le losange ambre sur le déclencheur porte le
          même mot que le texte qu'il replie, pour qu'on n'ait pas à l'ouvrir
          pour savoir qu'il y a quelque chose à lire. */}
      {origin !== null && (
        <details className="group/aide basis-full">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[0.75rem] text-amber-500 marker:content-none hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300">
            <span className="inline-block transition-transform group-open/aide:rotate-90">›</span>
            Repli du cadrage automatique
          </summary>
          <p className="mt-1 text-[0.75rem] text-amber-500 dark:text-amber-400">{origin}</p>
        </details>
      )}

      {/* **La raison d'un contrôle inerte s'écrit à côté de lui**, et le
          rectangle la désigne par `aria-describedby` : l'adjacence se lit à
          l'œil, pas à la voix. Le texte vient de `frozenCropReason`, appelée par
          les deux, pour qu'aucune divergence ne fasse pointer vers un
          paragraphe qui n'est plus rendu. */}
      {cropReason !== null && (
        <p id={cropReasonId} className="basis-full text-[0.75rem] text-muted-foreground">
          {cropReason}
        </p>
      )}
    </div>
  )
}
