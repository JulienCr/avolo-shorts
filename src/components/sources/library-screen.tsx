'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

import { AppBar } from '@/components/parcours/app-bar'
import { LibraryGrid } from '@/components/sources/library'
import type { Creation } from '@/components/sources/show-card'
import { messageServeur } from '@/components/sources/textes'
import { marquerSourceAnalysée, useSources } from '@/components/sources/use-sources'
import { buildLibrary } from '@/core/library'
import type { Source } from '@/lib/api'
import { lienProjet } from '@/lib/parcours'
import { useCreerProjet, useProjets } from '@/lib/queries'

/**
 * La bibliothèque : **reprendre un travail en cours, ou en commencer un**.
 *
 * **Une seule liste.** L'écran distinguait « Projets » et « Replays », alors
 * qu'un projet n'est que l'état de traitement d'un replay : une émission
 * analysée y apparaissait deux fois, et rien ne disait que c'était la même. Une
 * carte par replay, enrichie de son état — c'est le modèle mental que le retour
 * d'usage a désigné, et la jointure se fait ici, sur deux requêtes qui existaient
 * déjà.
 *
 * **L'écran ne calcule rien.** Il tient les trois requêtes, décide de ce qu'on
 * fait d'un 202, et passe le reste à `buildLibrary` (pur) puis à une grille qui
 * n'a besoin d'aucun serveur pour être montée. La redirection appartient bien
 * ici : `useCreerProjet` s'arrête à l'invalidation, parce qu'aller au projet,
 * l'annoncer ou rester sur la grille est une décision de parcours, et un hook
 * qui naviguerait empêcherait d'en changer sans le réécrire.
 *
 * **Il vit ici et non dans le fichier de route**, comme les trois autres écrans :
 * c'est ce qui le rend montable en test. La règle vient d'ailleurs — `use(params)`
 * ne se résout pas sous jsdom — mais elle vaut d'être tenue partout, sans quoi
 * elle se perd.
 */
export function LibraryScreen() {
  const router = useRouter()
  const client = useQueryClient()
  const projects = useProjets()
  const sources = useSources()
  const create = useCreerProjet()

  const creation: Creation = {
    // Le **nom** de la source en cours de création, pas un booléen : c'est ce
    // qui permet à la carte cliquée d'afficher l'attente et aux autres de se
    // contenter de se taire.
    pending: create.isPending ? (create.variables ?? null) : null,
    error: create.isError ? messageServeur(create.error) : null,
    start: (source: Source) => {
      // **`mutateAsync` et non `mutate`, et le rappel n'est pas passé à
      // TanStack.** Les liens vers une émission déjà analysée restent ouverts
      // pendant une création — c'est le seul geste encore utile pendant
      // l'attente —, donc on peut quitter la bibliothèque avant que le `lstat`
      // 9p ne réponde. TanStack n'appelle alors plus les rappels donnés à
      // `mutate` : son observateur est démonté. La marque manquerait pendant les
      // trente secondes du `staleTime`, c'est-à-dire exactement la fenêtre du
      // retour. Une chaîne de promesse, elle, ne dépend d'aucun observateur, et
      // le client de requêtes vit au-dessus de cet écran. (relevé par Codex)
      void create
        .mutateAsync(source.name)
        .then(({ projectId }) => marquerSourceAnalysée(client, source.name, projectId))
        .catch(() => {
          // L'échec est déjà porté par `creer.isError`, qui alimente l'alerte de
          // la grille. Rattrapé ici seulement pour ne pas laisser un rejet nu.
        })
    },
  }

  // **La redirection, elle, reste liée à l'écran**, et c'est tout l'intérêt de
  // la séparer de la correction du cache : ramener de force sur la bibliothèque
  // quelqu'un qui vient d'aller trier une autre émission serait pire que de ne
  // rien faire. Un effet ne s'exécute pas sur un composant démonté, ce qui
  // exprime la règle sans qu'on ait à tenir un drapeau « suis-je encore là ».
  //
  // **La redirection est la confirmation.** La réponse est un 202 — l'analyse
  // est acceptée et lancée, pas faite —, et la vue Émission est celle qui sait
  // montrer une analyse qui commence. Une notification en plus dirait deux fois
  // la même chose.
  const createdProjectId = create.data?.projectId
  useEffect(() => {
    if (createdProjectId !== undefined) router.push(lienProjet(createdProjectId))
  }, [createdProjectId, router])

  // **Une liste de projets qui n'a pas pu se charger n'est pas une liste vide.**
  // Le repli sur `[]` faisait passer chaque source portant un `projectId` par
  // `showState(null, true)` : les quatre émissions déjà analysées s'affichaient
  // « Analyse en cours », un état concret déduit d'une absence d'information.
  // On ne fabrique donc aucune entrée tant que cette requête a échoué sans rien
  // laisser en cache — un cache périmé, lui, reste affiché, c'est la règle que
  // l'écran de projet tient déjà pour ses candidats. (relevé par Copilot)
  const projectsUnknown = projects.isError && projects.data === undefined
  // **Une panne des replays ne doit pas emporter les émissions.** L'ancien écran
  // gardait sa section « Projets » quand `GET /api/sources` échouait ; la liste
  // unifiée la perdait, et avec elle l'accès aux clips et aux rendus de tout ce
  // qui était déjà analysé — sur une panne qui ne les concerne pas. Les projets
  // restent donc des entrées, marquées `replay: 'unknown'` plutôt qu'orphelines :
  // on ne sait pas si leur fichier est là, on n'a pas pu regarder.
  // (relevé par Copilot)
  const sourcesKnown = !(sources.isError && sources.data === undefined)
  const entries = projectsUnknown
    ? []
    : buildLibrary(sources.data?.sources ?? [], projects.data ?? [], sourcesKnown)

  return (
    <div className="flex min-h-full flex-col">
      <AppBar lieu={{ kind: 'bibliotheque' }} />

      {/* Pas de colonne de texte : c'est un plan de travail, et la spec §13
          demande un rendu d'application de bureau plutôt que de site web. La
          largeur maximale n'existe que pour qu'un écran très large ne rende pas
          des cartes de sept cents pixels. */}
      <main className="mx-auto flex w-full max-w-[110rem] flex-1 flex-col gap-6 px-6 py-6">
        <h1 className="sr-only">Bibliothèque</h1>

        <LibraryGrid
          entries={entries}
          // Sans ce mot, la grille vide qui suit un échec de `GET /api/projects`
          // faisait rendre le diagnostic de montage : « aucune vidéo dans ce
          // dossier », sous un bandeau qui dit tout autre chose, alors que les
          // replays s'étaient chargés. Deux vides qui ne se ressemblent que par
          // leur longueur. (relevé par Copilot)
          entriesKnown={!projectsUnknown}
          projects={projects.data}
          mount={sources.data?.montage}
          // **Les deux requêtes, pas une.** Monter la grille dès que les sources
          // répondent afficherait dix-huit cartes « À analyser » le temps que la
          // liste des projets arrive, puis les basculerait sous les yeux —
          // exactement le saut que les squelettes existent pour éviter.
          loading={sources.isPending || projects.isPending}
          // Le message du serveur, jamais une phrase composée depuis
          // l'exception.
          error={sources.isError ? messageServeur(sources.error) : null}
          projectsError={projects.isError ? messageServeur(projects.error) : null}
          onRetry={() => {
            // **L'échec de création s'oublie avec le rafraîchissement**, parce
            // que c'est lui qui le rend caduc : sur une source disparue entre
            // l'affichage et le clic, la carte s'en va et le message continuerait
            // sinon de nommer un fichier qui n'est plus là.
            create.reset()
            void sources.refetch()
            void projects.refetch()
          }}
          creation={creation}
        />
      </main>
    </div>
  )
}
