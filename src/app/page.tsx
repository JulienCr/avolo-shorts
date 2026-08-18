'use client'

import { useRouter } from 'next/navigation'

import { AppBar } from '@/components/parcours/app-bar'
import { GrilleSources } from '@/components/sources/grille-sources'
import { ListeProjets } from '@/components/sources/liste-projets'
import type { Creation } from '@/components/sources/source-card'
import { messageServeur } from '@/components/sources/textes'
import { useSources } from '@/components/sources/use-sources'
import type { Source } from '@/lib/api'
import { lienProjet } from '@/lib/parcours'
import { useCreerProjet, useProjets } from '@/lib/queries'

/**
 * La bibliothèque : **reprendre un travail en cours, ou en commencer un**.
 *
 * **Un écran, deux sections, les projets d'abord.** La grille des replays est
 * l'entrée du tunnel — jusqu'ici, créer un projet se faisait en `curl` —, mais ce
 * n'est pas le geste quotidien : une émission par semaine arrive, et chacune se
 * travaille en plusieurs séances. Ce qu'on ouvre le plus souvent est un projet
 * déjà lancé. Les deux sections sur le même écran évitent par ailleurs de choisir
 * arbitrairement un écran d'atterrissage.
 *
 * **La page ne calcule rien.** Elle tient les trois requêtes, décide de ce qu'on
 * fait d'un 202, et passe le reste à deux composants qui n'ont pas besoin d'un
 * serveur pour être montés. La redirection appartient bien ici : `useCreerProjet`
 * s'arrête à l'invalidation, parce qu'aller au projet, l'annoncer ou rester sur
 * la grille est une décision de parcours, et un hook qui naviguerait empêcherait
 * d'en changer sans le réécrire.
 *
 * **La racine n'a pas de fil d'Ariane**, et son titre n'est donc porté que par la
 * marque de la barre d'application. Le `h1` reste, pour le plan du document : les
 * deux sections sont des `h2`, et une hiérarchie qui commence au deuxième niveau
 * n'a pas de racine à laquelle revenir.
 */
export default function Bibliotheque() {
  const router = useRouter()
  const projets = useProjets()
  const sources = useSources()
  const creer = useCreerProjet()

  const creation: Creation = {
    // Le **nom** de la source en cours de création, pas un booléen : c'est ce
    // qui permet à la carte cliquée d'afficher l'attente et aux autres de se
    // contenter de se taire.
    enCours: creer.isPending ? (creer.variables ?? null) : null,
    erreur: creer.isError ? messageServeur(creer.error) : null,
    lancer: (source: Source) => {
      creer.mutate(source.name, {
        // **La redirection est la confirmation.** La réponse est un 202 — l'analyse
        // est acceptée et lancée, pas faite —, et l'écran de projet est
        // exactement celui qui sait montrer une analyse qui commence. Une
        // notification en plus dirait deux fois la même chose.
        onSuccess: ({ projectId }) => router.push(lienProjet(projectId)),
      })
    },
  }

  return (
    <div className="flex min-h-full flex-col">
      <AppBar lieu={{ kind: 'bibliotheque' }} />

      {/* Pas de colonne de texte : c'est un plan de travail, et la spec §13
          demande un rendu d'application de bureau plutôt que de site web. La
          largeur maximale n'existe que pour qu'un écran très large ne rende pas
          des cartes de sept cents pixels. */}
      <main className="mx-auto flex w-full max-w-[110rem] flex-1 flex-col gap-8 px-6 py-6">
        <h1 className="sr-only">Bibliothèque</h1>

        <ListeProjets
          projets={projets.data}
          chargement={projets.isPending}
          // Le message du serveur, jamais une phrase composée depuis
          // l'exception : `projets.isError` n'était lu nulle part, et une API en
          // panne rendait exactement la même page qu'une bibliothèque vide.
          erreur={projets.isError ? messageServeur(projets.error) : null}
          onReessayer={() => void projets.refetch()}
        />

        <GrilleSources
          listing={sources.data}
          chargement={sources.isPending}
          erreur={sources.isError ? messageServeur(sources.error) : null}
          onReessayer={() => {
            // **L'échec de création s'oublie avec le rafraîchissement**, parce
            // que c'est lui qui le rend caduc : sur une source disparue entre
            // l'affichage et le clic, la carte s'en va et le message continuerait
            // sinon de nommer un fichier qui n'est plus là.
            creer.reset()
            void sources.refetch()
          }}
          creation={creation}
        />
      </main>
    </div>
  )
}
