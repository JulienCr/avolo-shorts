'use client'

import Link from 'next/link'

import type { CandidateClip } from '@/lib/api'
import { isGuard } from '@/lib/clip-status'
import { formatDuration } from '@/lib/format'
import { linkClip, linkProject, type Next } from '@/lib/navigation'
import { agreement } from '@/components/review/template'
import { buttonVariants } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

/**
 * La fin de la boucle de tri.
 *
 * **Une boucle a besoin d'une fin.** Quand le compteur tombe à zéro, l'écran le
 * dit et propose la suite : la liste des clips gardés avec leur état de montage.
 * C'est aussi le seul endroit du parcours où une progression linéaire est
 * honnête, puisqu'on connaît enfin le dénominateur — le nombre de clips gardés
 * ne se sait qu'à la fin du tri, et c'est pourquoi le reste de l'écran compte
 * ce qui reste à faire plutôt qu'un pourcentage.
 *
 * **Elle tranche ce que `next` ne distingue pas.** « Tout a été écarté » et
 * « des clips gardés restent à monter » tombent tous deux sur `travail: 'sorted'`
 * : la liste est non vide, donc pas `none`, et sans clip gardé, donc pas
 * `delivered`. Les séparer demanderait une cinquième valeur de `Work` ou la liste
 * des clips en argument. C'est donc l'écran qui le dit, puisque c'est lui qui
 * tient la liste.
 */
export function LoopEnd({
  projectId,
  clips,
  durationKept,
  next,
}: {
  projectId: string
  clips: readonly CandidateClip[]
  durationKept: number
  /** L'issue de la phase. Voir `Issue` pour ce que l'écran en fait. */
  next: Next
}) {
  const guards = clips.filter((c) => isGuard(c.status))

  if (guards.length === 0) {
    return (
      <section className="rounded-xl border border-dashed px-6 py-12 text-center">
        <h2 className="text-sm font-medium">Tout a été écarté.</h2>
        <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">
          Rien ne part au montage. Un nouveau repérage rendra d’autres
          propositions ; les décisions déjà prises, elles, y survivent.
        </p>
      </section>
    )
  }

  // Le dénominateur enfin connu : combien des clips gardés sont déjà rendus.
  const mounts = guards.filter((c) => c.status === 'exported').length

  return (
    <section className="rounded-xl border px-6 py-8">
      <h2 className="text-sm font-medium">Tout est trié.</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {agreement(guards.length, 'clip gardé', 'clips gardés')}, {formatDuration(durationKept)} au
        total. {editingProgress(mounts, guards.length)}
      </p>

      <Progress
        value={Math.round((mounts / guards.length) * 100)}
        aria-label="Clips gardés déjà montés"
        className="mt-4 max-w-md"
      />

      <Issue next={next} projectId={projectId} />

      <ul className="mt-5 flex flex-col gap-1.5">
        {guards.map((clip) => (
          <li key={clip.id} className="flex items-baseline justify-between gap-4 text-sm">
            <Link
              href={linkClip(clip.id)}
              className="truncate font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {clip.title}
            </Link>
            <span className="shrink-0 text-xs text-muted-foreground">
              {clip.status === 'exported' ? 'monté et exporté' : 'à monter'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Où en est le montage des clips gardés.
 *
 * Trois formes plutôt qu'un `agreement` unique : « 0 est monté » se lit mal, et
 * c'est la phrase la plus regardée du parcours — celle qui dit ce qu'il reste à
 * faire une fois le tri fini.
 */
function editingProgress(mounts: number, guards: number): string {
  if (mounts === 0) return 'Aucun n’est encore monté.'
  if (mounts >= guards) return 'Tous sont montés.'
  return `${mounts} sur ${guards} ${mounts === 1 ? 'est monté' : 'sont montés'}.`
}

/**
 * L'issue de la phase, telle que cet écran la rend.
 *
 * **`suite` rend une cible qui est une URL, jamais un ordre**, et ce qu'on en
 * fait appartient à l'écran. Trois cas, et le troisième est celui qui compte :
 *
 * - une **attente** est un résultat de plein droit — sa raison et ce qui la
 *   lèvera —, pas un état dégradé. `{ triable, trie }` est réel : Julien a fini
 *   de trier avant la fin de l'encodage, il n'a aucune action qui fasse avancer
 *   le montage, et forcer une action ici reviendrait à en inventer une ;
 * - une **action qui mène ailleurs** est un lien. C'est le succès du parcours —
 *   « choisir une autre émission » —, jusqu'ici inexprimable ;
 * - une **action qui vise cet écran-ci** ne se rend pas. « Trier les
 *   propositions » et « passer au montage » désignent la grille qui est déjà
 *   sous les yeux : un lien vers soi-même n'est pas une navigation, et il
 *   volerait un arrêt de tabulation.
 */
function Issue({ next, projectId }: { next: Next; projectId: string }) {
  if (next.kind === 'waiting') {
    return (
      <p data-testid="outcome" className="mt-4 max-w-prose text-sm text-muted-foreground">
        {next.reason}
      </p>
    )
  }

  if (next.target === linkProject(projectId)) return null

  return (
    <Link
      data-testid="outcome"
      href={next.target}
      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-4')}
    >
      {next.label}
    </Link>
  )
}
