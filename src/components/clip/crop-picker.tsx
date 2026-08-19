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
 * Pourquoi le curseur de cadrage ne déplace rien, ou `null` quand il déplace.
 *
 * **Un contrôle inerte sans raison écrite fait douter de l'outil**, et c'est la
 * forme que le dépôt a déjà retenue ailleurs : le bouton « Monter » d'une carte
 * de candidat reste atteignable, porte `aria-disabled` et pointe vers sa raison,
 * écrite à côté (`src/components/tri/candidate-card.tsx`). Une bulle d'aide ne
 * conviendrait pas — elle serait invisible au clavier, et la raison d'un blocage
 * se lit avant d'essayer.
 *
 * Deux causes, et elles se cumulent :
 *
 * - **rien à déplacer** — en 16:9 le cadre couvre toute la source ;
 * - **rien à écrire** — le cadrage est calculé, et la dérogation par plan qui
 *   rendrait le curseur utile demande une table persistée que le clip ne porte
 *   pas encore (§9.4). C'est délibéré : un curseur qui bougerait sans rien
 *   changer au fichier produit serait pire qu'un curseur figé.
 *
 * **La seconde moitié de cette fonction est datée et doit partir avec le lot qui
 * rebranche le curseur.** Elle tient en une branche, exprès : le jour où la
 * dérogation s'enregistre, c'est la condition `automatique` qui disparaît, pas
 * une phrase à retrouver dans trois paragraphes.
 *
 * Exportée parce que **deux composants en ont besoin et doivent s'accorder** :
 * le sélecteur l'affiche, le rectangle la désigne par `aria-describedby`. Deux
 * conditions recopiées finiraient par diverger, et le jour où elles divergent le
 * rectangle pointe vers un texte qui n'est plus rendu.
 */
export function frozenCropReason(framing: PublishedFraming, effective: Ratio): string | null {
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
  onCropX: (cropX: number | ((precedent: number) => number)) => void
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
  // La même énumération que celle qu'affiche `RatioPicker`, appelée plutôt que
  // recopiée : deux conditions parallèles finissent par diverger, et le jour où
  // elles divergent le rectangle décrit un texte qui n'est plus rendu.
  const reason = frozenCropReason(framing, effectif)

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
        // **Inerte, mais pas absent.** `disabled` — ou un `tabIndex` à -1 — sort
        // du parcours de tabulation : au clavier on ne découvre ni le contrôle
        // ni la raison pour laquelle il ne répond pas (§4.4). Le rectangle reste
        // donc atteignable tant qu'il a quelque chose à dire, et ne se retire
        // que s'il n'a plus rien à expliquer.
        tabIndex={fige && reason === null ? -1 : 0}
        aria-label={
          automatique ? 'Position horizontale du cadre, calculée' : 'Position horizontale du cadre'
        }
        aria-describedby={fige && reason !== null ? describedBy : undefined}
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
  const valeurs: (Ratio | 'auto')[] = ['auto', ...ORDRE_RATIOS]
  const plan = useCurrentShot(framing)
  const effectif = effectiveRatio(plan, ratio)
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
  const cropReason = frozenCropReason(framing, effectif)

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
        // **« de sortie » était le mot faux.** Il y a deux sorties, et ce
        // sélecteur n'en règle qu'une directement.
        aria-label="Ratio du cadre pris dans la source"
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
        {nativeRatio}
      </p>

      {/* **Les deux fichiers, nommés.** Voir le bloc de tête : c'est la ligne qui
          empêche de croire qu'on règle ici la sortie verticale plan par plan. */}
      <p className="basis-full text-[0.75rem] text-muted-foreground">
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

      {/* **Le repli se dit, il ne se subit pas.** `renders` ne dépend pas
          d'`analysis` dans le graphe : rien ne garantit qu'un clip en « auto »
          ait des plans sous la main, et un 9:16 centré posé sans un mot ne se
          verrait qu'à l'image, trois minutes d'export plus tard. */}
      {origin !== null && (
        <p className="basis-full text-[0.75rem] text-amber-500 dark:text-amber-400">{origin}</p>
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
