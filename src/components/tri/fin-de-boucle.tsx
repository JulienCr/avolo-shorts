'use client'

import Link from 'next/link'

import type { CandidateClip } from '@/lib/api'
import { estGarde } from '@/lib/clip-status'
import { formatDuration } from '@/lib/format'
import { lienClip } from '@/lib/parcours'
import { accord } from '@/components/tri/modele'
import { Progress } from '@/components/ui/progress'

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
  clips,
  dureeGardee,
}: {
  clips: readonly CandidateClip[]
  dureeGardee: number
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
