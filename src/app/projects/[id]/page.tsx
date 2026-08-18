'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, use } from 'react'

import type { StepName } from '@/core/graph'
import { compter, phaseProjet } from '@/core/parcours'
import { lienProjet } from '@/lib/parcours'
import { useCandidats, usePatchClip, useProjet } from '@/lib/queries'
import { AppBar } from '@/components/parcours/app-bar'
import { AnnonceDÉtape, BandeAvancement, PanneauAvancement } from '@/components/tri/avancement'
import { FilDeTri } from '@/components/tri/fil'
import { dispositionAvancement, vueDepuisUrl, type Vue } from '@/components/tri/modele'
import { BoutonRelance, BoutonReprise } from '@/components/tri/relance'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * L'écran de projet.
 *
 * **Un seul objectif : décider quelles propositions valent d'être montées.**
 * L'avancement de l'analyse est sur le même écran non pas comme second objectif,
 * mais parce que c'est le même objet à un autre moment de sa vie (spec §2.4).
 *
 * Ce fichier ne calcule rien. La phase vient de `@/core/parcours`, la
 * disposition de `@/components/tri/modele`, la boucle de tri de `FilDeTri` : il
 * ne fait qu'interroger, distribuer et disposer. C'est la même frontière que
 * `src/core` contre `src/server`, appliquée un cran plus haut, et elle se
 * vérifie à la lecture.
 */
export default function PageDeProjet({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  // **La limite de Suspense n'est pas décorative** : `useSearchParams` fait
  // sortir du rendu statique, et `next build` refuse un composant qui l'appelle
  // sans elle. Le repli est le même squelette que celui du chargement des
  // données — il ne dure de toute façon que le temps de l'hydratation.
  return (
    <Suspense fallback={<Chargement id={id} />}>
      <EcranDeProjet id={id} />
    </Suspense>
  )
}

function EcranDeProjet({ id }: { id: string }) {
  const projet = useProjet(id)
  const candidats = useCandidats(id)
  const patch = usePatchClip()
  const [vue, allerÀLaVue] = useVueDansUrl(id)

  const clips = candidats.data ?? []
  const steps = projet.data?.steps ?? ({} as Record<StepName, boolean>)
  const running = projet.data?.running ?? null
  // **Au repos seulement.** Pendant qu'une exécution tourne, l'échec affiché
  // serait celui d'avant — et c'est le serveur qui le garantit déjà en rendant
  // `error: null` tant que `running` n'est pas nul.
  const erreur = projet.data?.error ?? null

  const phase = phaseProjet(steps, running, erreur, clips)
  // Tant que l'état du projet n'a pas répondu, `steps` est vide et `running`
  // nul : la phase dirait `interrompu`, et l'écran proposerait de reprendre une
  // analyse dont il ne sait rien. On attend la première réponse.
  const disposition = projet.isSuccess
    ? dispositionAvancement(phase, running, clips.length === 0)
    : 'rien'

  return (
    <div className="flex min-h-full flex-col">
      <AppBar lieu={{ kind: 'projet', projet: { id, titre: projet.data?.project.title ?? id } }}>
        {disposition === 'bande' && running !== null && <BandeAvancement running={running} />}
      </AppBar>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5">
        {/* Au-dessus de la disposition, pour survivre au panneau : c'est
            précisément quand il cède la place à la grille qu'il y a quelque
            chose à annoncer. */}
        <AnnonceDÉtape running={running} steps={steps} />

        <div className="flex flex-col gap-4">
          {/* **Deux origines d'erreur, et la seconde n'efface pas la première.**
              L'analyse a échoué : c'est un fait du serveur, il vit en bandeau et
              son message vient de `ProjectStatus.error`. La liste ne se charge
              pas : c'est un incident local, il a son message et son
              « réessayer ». Les deux peuvent tenir en même temps.

              Le bandeau ne double pas le panneau, qui porte déjà le message du
              serveur et le bouton de reprise. */}
          {erreur !== null && running === null && disposition !== 'panneau' && (
            <Alert variant="destructive">
              <AlertTitle>La dernière analyse a échoué.</AlertTitle>
              <AlertDescription>
                <p>{erreur}</p>
                <BoutonReprise projectId={id} enCours={false} />
              </AlertDescription>
            </Alert>
          )}

          {candidats.isError && (
            <Alert variant="destructive">
              <AlertTitle>Les propositions ne se chargent pas.</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                <p>{messageDe(candidats.error)}</p>
                <Button size="sm" variant="outline" onClick={() => void candidats.refetch()}>
                  Réessayer
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {/* **Le panneau et le squelette ne coexistent pas.** Le premier décrit
              une attente de neuf minutes, le second une requête de deux cents
              millisecondes : les afficher ensemble ferait passer l'un pour
              l'autre, ce qui est exactement ce que la conception reproche à
              l'écran d'aujourd'hui. */}
          {disposition === 'panneau' ? (
            <PanneauAvancement
              steps={steps}
              running={running}
              erreur={erreur}
              reprise={<BoutonReprise projectId={id} enCours={running !== null} />}
            />
          ) : projet.isPending || candidats.isPending ? (
            <GrilleEnAttente />
          ) : (
            <FilDeTri
              projectId={id}
              clips={clips}
              vue={vue}
              onVue={allerÀLaVue}
              proxyPret={steps.proxy === true}
              bilan={projet.data?.repérage ?? null}
              onStatut={(clipId, status) =>
                patch.mutate({ clipId, projectId: id, patch: { status } })
              }
              entete={
                <BoutonRelance projectId={id} compte={compter(clips)} enCours={running !== null} />
              }
            />
          )}

          {/* Une écriture optimiste qui échoue remet la carte comme elle était.
              Sans ce mot, le clic aurait simplement l'air de ne pas avoir été
              pris — et on recommencerait. */}
          {patch.isError && (
            <Alert variant="destructive">
              <AlertDescription>
                L’enregistrement a échoué. La carte est revenue à son état précédent.
              </AlertDescription>
            </Alert>
          )}
        </div>
      </main>
    </div>
  )
}

/**
 * La vue active, **dans l'URL**.
 *
 * Un rechargement doit rendre le même écran : c'est ce que l'URL garantit et
 * qu'un état de composant ne garantit pas. La position de défilement et le
 * focus, eux, restent en session — une position de défilement dans une URL est
 * une URL qu'on ne peut plus partager.
 *
 * `replace` et non `push` : basculer d'onglet n'est pas une navigation dont on
 * veut revenir par le bouton « précédent », qui doit ramener à la bibliothèque.
 * Et `scroll: false`, sans quoi chaque changement de vue remonterait la page.
 */
function useVueDansUrl(projectId: string): [Vue, (vue: Vue) => void] {
  const router = useRouter()
  const paramètres = useSearchParams()
  const vue = vueDepuisUrl(paramètres.get('vue'))

  return [
    vue,
    (choisie: Vue) => {
      const suivants = new URLSearchParams(paramètres.toString())
      // La vue par défaut ne s'écrit pas : une URL nue est celle qu'on partage.
      if (choisie === 'atrier') suivants.delete('vue')
      else suivants.set('vue', choisie)
      const requête = suivants.toString()
      router.replace(`${lienProjet(projectId)}${requête === '' ? '' : `?${requête}`}`, {
        scroll: false,
      })
    },
  ]
}

/** Le message d'un échec, quelle que soit sa nature. */
function messageDe(erreur: unknown): string {
  return erreur instanceof Error ? erreur.message : 'Cause inconnue.'
}

function Chargement({ id }: { id: string }) {
  return (
    <div className="flex min-h-full flex-col">
      <AppBar lieu={{ kind: 'projet', projet: { id, titre: id } }} />
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5">
        <GrilleEnAttente />
      </main>
    </div>
  )
}

/**
 * Le squelette de la grille.
 *
 * **À ne pas confondre avec l'attente d'analyse** : celui-ci dure deux cents
 * millisecondes, l'autre neuf minutes. C'est pourquoi le panneau d'avancement
 * n'est pas une grille grise — les deux rendaient la même page.
 */
function GrilleEnAttente() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border">
          <Skeleton className="aspect-video rounded-none" />
          <div className="space-y-2 p-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        </div>
      ))}
    </div>
  )
}
