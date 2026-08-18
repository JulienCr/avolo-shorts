'use client'

import Link from 'next/link'

import type { CandidateClip } from '@/lib/api'
import { estGarde } from '@/lib/clip-status'
import { formatDuration } from '@/lib/format'
import { lienClip, lienProjet, type Suite } from '@/lib/parcours'
import { accord } from '@/components/tri/modele'
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
 * **Elle tranche ce que `suite` ne distingue pas.** « Tout a été écarté » et
 * « des clips gardés restent à monter » tombent tous deux sur `travail: 'trie'`
 * : la liste est non vide, donc pas `rien`, et sans clip gardé, donc pas
 * `livre`. Les séparer demanderait une cinquième valeur de `Travail` ou la liste
 * des clips en argument. C'est donc l'écran qui le dit, puisque c'est lui qui
 * tient la liste.
 */
export function FinDeBoucle({
  projectId,
  clips,
  dureeGardee,
  suite,
}: {
  projectId: string
  clips: readonly CandidateClip[]
  dureeGardee: number
  /** L'issue de la phase. Voir `Issue` pour ce que l'écran en fait. */
  suite: Suite
}) {
  const gardes = clips.filter((c) => estGarde(c.status))

  if (gardes.length === 0) {
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
  const montes = gardes.filter((c) => c.status === 'exported').length

  return (
    <section className="rounded-xl border px-6 py-8">
      <h2 className="text-sm font-medium">Tout est trié.</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {accord(gardes.length, 'clip gardé', 'clips gardés')}, {formatDuration(dureeGardee)} au
        total. {accord(montes, 'est monté', 'sont montés')}.
      </p>

      <Progress
        value={Math.round((montes / gardes.length) * 100)}
        aria-label="Clips gardés déjà montés"
        className="mt-4 max-w-md"
      />

      <Issue suite={suite} projectId={projectId} />

      <ul className="mt-5 flex flex-col gap-1.5">
        {gardes.map((clip) => (
          <li key={clip.id} className="flex items-baseline justify-between gap-4 text-sm">
            <Link
              href={lienClip(clip.id)}
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
function Issue({ suite, projectId }: { suite: Suite; projectId: string }) {
  if (suite.kind === 'attente') {
    return (
      <p data-testid="issue" className="mt-4 max-w-prose text-sm text-muted-foreground">
        {suite.raison}
      </p>
    )
  }

  if (suite.cible === lienProjet(projectId)) return null

  return (
    <Link
      data-testid="issue"
      href={suite.cible}
      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-4')}
    >
      {suite.libelle}
    </Link>
  )
}
