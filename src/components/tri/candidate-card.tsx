'use client'

import { Check, Film, Scissors, Undo2, X } from 'lucide-react'
import Link from 'next/link'
import { useId } from 'react'

import { clipDuration } from '@/core/edl'
import type { CandidateClip } from '@/lib/api'
import { LIBELLES_STATUT, estEcarte, estGarde } from '@/lib/clip-status'
import { formatDuration, formatTimecode } from '@/lib/format'
import { lienClip } from '@/lib/parcours'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'

/**
 * Une carte de candidat.
 *
 * Spec §13 : « Trier 25 candidats occupe plus de temps que monter les trois qui
 * survivent, donc cet écran se soigne en premier. » Tout ce qui est ici sert à
 * décider en une seconde : ce que ça montre, combien de temps ça dure, ce que ça
 * raconte, et deux boutons.
 *
 * **La durée est une information, pas une contrainte.** Elle s'affiche parce
 * qu'un extrait de six minutes ne se publie pas comme un de quinze secondes, pas
 * parce qu'un seuil quelque part la refuserait. Elle est la somme des segments.
 *
 * **Elle porte son identifiant en attribut** (`data-clip`) plutôt qu'une
 * référence remontée à la grille. La boucle de tri a besoin de retrouver
 * l'élément d'une carte pour y poser le focus ; une carte de plus n'a alors rien
 * à câbler, et rien ne peut se désynchroniser entre la liste et le tableau de
 * références.
 */
export function CandidateCard({
  clip,
  onGarder,
  onEcarter,
  proxyPret,
  selectionne = false,
  onSelection,
}: {
  clip: CandidateClip
  onGarder: () => void
  onEcarter: () => void
  /**
   * Le proxy est-il sur le disque ?
   *
   * Il commande deux choses : les vignettes, qui s'en extraient, et le montage,
   * que l'écran de clip ne peut pas ouvrir sans lui. Les deux le disent, et les
   * deux disent **ce qui lèvera l'attente** — une attente dont on connaît la
   * cause est une attente supportable.
   */
  proxyPret: boolean
  /**
   * La carte est-elle celle sur laquelle le clavier travaille ?
   *
   * **Un seul arrêt de tabulation pour toute la grille** (`tabindex` glissant) :
   * trente cartes à `tabIndex={0}` demanderaient trente `Tab` pour traverser
   * l'écran, et le nombre dépendrait de la vue.
   */
  selectionne?: boolean
  onSelection?: () => void
}) {
  // Pas d'indicateur « écriture en vol » : la mise à jour est optimiste, donc la
  // carte affiche déjà la décision. Une pulsation par-dessus dirait qu'il se
  // passe quelque chose qu'on ne peut de toute façon pas attendre.
  const duree = clipDuration(clip.segments)
  const debut = clip.segments[0]?.start ?? 0
  const coupes = Math.max(0, clip.segments.length - 1)
  // La même définition que celle du gestionnaire de clic (`basculerStatut`) :
  // les deux divergeaient, et le bouton « Gardé » d'un clip exporté produisait
  // alors un changement d'état invisible.
  const garde = estGarde(clip.status)
  const ecarte = estEcarte(clip.status)

  return (
    <article
      data-clip={clip.id}
      aria-label={clip.title}
      tabIndex={selectionne ? 0 : -1}
      onFocus={onSelection}
      className={cn(
        'group/carte flex flex-col overflow-hidden rounded-xl border bg-card transition-colors outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring',
        garde && 'border-stage/60 ring-1 ring-stage/25',
        ecarte && 'opacity-55 hover:opacity-100',
        selectionne && 'ring-2 ring-ring/70',
      )}
    >
      {/* **Le lien couvre l'image, et rien d'autre.**
          Il double celui du titre : deux liens vers la même destination
          s'annoncent deux fois, donc celui-ci sort de l'arbre d'accessibilité et
          du parcours de tabulation. Mais ce qui est **information** — la
          position dans le replay, la durée, la marque de décision — doit rester
          dehors, sinon elle disparaît avec lui. D'où la superposition plutôt que
          l'imbrication, et `pointer-events-none` pour que le clic traverse. */}
      <div className="relative aspect-video overflow-hidden bg-zinc-950">
        <Link
          href={lienClip(clip.id)}
          tabIndex={-1}
          aria-hidden
          className="absolute inset-0 block outline-none"
        >
          <Vignette url={clip.thumbnailUrl} titre={clip.title} proxyPret={proxyPret} />
        </Link>

        {/* Sur l'image, en bas : la position dans le replay à gauche, la durée à
            droite. Deux nombres, jamais au même endroit qu'un texte. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/85 to-transparent p-2 pt-8">
          <span className="font-mono text-xs tracking-tight text-white/80 tabular-nums">
            {formatTimecode(debut)}
          </span>
          <span className="rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-xs font-medium text-white tabular-nums">
            {formatDuration(duree)}
          </span>
        </div>

        {garde && (
          <span className="pointer-events-none absolute top-2 left-2 flex items-center gap-1 rounded-md bg-stage px-1.5 py-0.5 text-xs font-semibold text-stage-foreground capitalize">
            <Check className="size-3" aria-hidden />
            {LIBELLES_STATUT[clip.status]}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          {/* `data-ouvrir` : c'est ce lien que la touche `Entrée` déclenche.
              Passer par lui plutôt que par le routeur garde une seule
              navigation, celle que le clic emprunte déjà. */}
          <Link
            data-ouvrir
            href={lienClip(clip.id)}
            className="line-clamp-2 text-sm leading-snug font-medium text-balance outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {clip.title}
          </Link>
          <Badge variant="outline" className="shrink-0 font-mono text-xs">
            {clip.ratio === 'auto' ? 'auto' : clip.ratio}
          </Badge>
        </div>

        <p className="line-clamp-3 text-[0.8rem] leading-relaxed text-muted-foreground">
          {clip.preview}
        </p>

        {coupes > 0 && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Scissors className="size-3" aria-hidden />
            {coupes === 1 ? 'une coupe interne' : `${coupes} coupes internes`}
          </p>
        )}

        {/* Un clic, pas de boîte de dialogue. Et le même bouton reprend sa
            décision : un tri se corrige plus souvent qu'on ne le croit. */}
        <div className="mt-auto flex gap-1.5 pt-2">
          <Button
            size="sm"
            variant={garde ? 'default' : 'outline'}
            className={cn('flex-1', garde && 'bg-stage text-stage-foreground hover:bg-stage/85')}
            onClick={onGarder}
            aria-pressed={garde}
          >
            <Check aria-hidden />
            <span className="capitalize">{garde ? LIBELLES_STATUT[clip.status] : 'Garder'}</span>
          </Button>
          {/* **Le nom du bouton porte l'état, comme celui de « Garder ».** Il
              a dit « Remettre » — l'action inverse — tout en gardant
              `aria-pressed`, ce qui s'annonce « Remettre, activé » : le nom et
              l'état se contredisent. Un bouton bascule dont le nom **est**
              l'état se lit tout seul, et le geste ne change pas — rappuyer le
              relâche, ce que l'icône de retour continue de suggérer. */}
          <Button
            size="sm"
            variant="ghost"
            className="flex-1 text-muted-foreground"
            onClick={onEcarter}
            aria-pressed={ecarte}
          >
            {ecarte ? <Undo2 aria-hidden /> : <X aria-hidden />}
            <span className="capitalize">
              {ecarte ? LIBELLES_STATUT[clip.status] : 'Écarter'}
            </span>
          </Button>
        </div>

        {garde && <Monter clipId={clip.id} proxyPret={proxyPret} />}
      </div>
    </article>
  )
}

/**
 * Le geste qui ouvre le montage, et son absence de geste quand le proxy manque.
 *
 * **`aria-disabled` et non `disabled`.** Un contrôle `disabled` sort du parcours
 * de tabulation : au clavier, on ne découvre ni le bouton, ni la raison pour
 * laquelle il ne répond pas. Et la raison est écrite **à côté**, jamais dans une
 * bulle d'aide — une bulle qui n'apparaît qu'au survol est invisible au clavier,
 * alors que la raison d'un blocage doit se lire avant d'essayer.
 */
function Monter({ clipId, proxyPret }: { clipId: string; proxyPret: boolean }) {
  // **La raison est liée au contrôle, pas seulement posée à côté.** À l'œil,
  // l'adjacence suffit ; à la voix, sans `aria-describedby` on entend « Monter »
  // et rien d'autre — c'est-à-dire un bouton qui ne répond pas sans qu'on
  // sache pourquoi.
  const raison = useId()

  if (!proxyPret) {
    return (
      <div className="pt-1">
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          aria-disabled="true"
          aria-describedby={raison}
          // Inerte, pas absent : le bouton reste atteignable et annonçable.
          onClick={(événement) => événement.preventDefault()}
        >
          <Film aria-hidden />
          Monter
        </Button>
        <p
          id={raison}
          data-testid="raison-monter"
          className="mt-1 text-xs text-muted-foreground"
        >
          Le montage s’ouvrira avec le proxy, en cours d’encodage.
        </p>
      </div>
    )
  }

  // **Un lien, pas un bouton stylé en lien.** `Button render={<Link/>}` de Base
  // UI pose `role="button"` sur l'ancre dès que l'élément rendu n'est pas un
  // `<button>` natif : le lecteur d'écran annoncerait « bouton » là où le clic
  // du milieu, le glisser-déposer et « ouvrir dans un nouvel onglet » marchent.
  return (
    <Link
      href={lienClip(clipId)}
      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-1 w-full')}
    >
      <Film aria-hidden />
      Monter
    </Link>
  )
}

/**
 * La vignette, ou son absence.
 *
 * Les images se tirent du proxy, qui arrive **après** les candidats : pendant
 * les six minutes de son encodage, la grille est déjà triable et les
 * emplacements sont vides. Le repli tient donc la place au bon rapport d'aspect,
 * et il dit **ce qui lèvera l'attente** — sans quoi une absence permanente et
 * une absence temporaire se ressemblent trait pour trait.
 */
function Vignette({
  url,
  titre,
  proxyPret,
}: {
  url: string | null
  titre: string
  proxyPret: boolean
}) {
  if (url) {
    // Les vignettes sont extraites du proxy par une route locale, à une taille
    // déjà connue : `next/image` n'aurait rien à optimiser et demanderait une
    // configuration de domaines pour rien.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt={titre} className="size-full object-cover" loading="lazy" />
    )
  }

  return (
    <div className="flex size-full flex-col items-center justify-center gap-1.5 px-3 text-center text-zinc-500">
      <Film className="size-5" aria-hidden />
      <span className="text-xs tracking-wide">
        {proxyPret ? 'vignette indisponible' : 'les images arrivent avec le proxy'}
      </span>
    </div>
  )
}
