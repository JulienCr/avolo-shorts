'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect } from 'react'

import type { StepName } from '@/core/graph'
import { compter, phaseProjet, type TailleÉmission } from '@/core/parcours'
import { CIBLES_DE_REPRISE } from '@/lib/api'
import { lienProjet, suite } from '@/lib/parcours'
import { useCandidats, usePatchClip, useProjet } from '@/lib/queries'
import { VueÉmission } from '@/components/emission/vue-emission'
import { AppBar } from '@/components/parcours/app-bar'
import { AnnonceDÉtape, BandeAvancement, PanneauAvancement } from '@/components/tri/avancement'
import { FilDeTri } from '@/components/tri/fil'
import { dispositionAvancement, vueDepuisUrl, type Vue } from '@/components/tri/modele'
import { BoutonArrêt, BoutonRelance, BoutonReprise } from '@/components/tri/relance'
import { lireSessionTri, écrireSessionTri } from '@/components/tri/session'
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
 * Il ne calcule rien lui-même. La phase vient de `@/core/parcours`, la
 * disposition et le vocabulaire des vues de `@/components/tri/modele`, la boucle
 * de tri de `FilDeTri` : il interroge, distribue et dispose. C'est la même
 * frontière que `src/core` contre `src/server`, appliquée un cran plus haut.
 *
 * **Il vit ici et non dans le fichier de route**, et c'est ce qui le rend
 * testable. La page lit ses `params` par `use()`, qui suspend ; sous `jsdom`,
 * une limite de Suspense ne se relève jamais — la promesse se tient, React ne
 * rejoue pas, et le repli reste à l'écran indéfiniment. Monter la route entière
 * dans un test ne prouvait donc rien. Séparés, l'adaptateur de route n'a plus
 * rien à prouver et l'écran se monte avec ses requêtes.
 */
export function EcranDeProjet({ id }: { id: string }) {
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

  // **Attendre n'est pas la même chose que ne pas savoir.**
  //
  // `prêt` dit que les deux requêtes ont rendu la main, en succès comme en
  // échec : c'est lui qui décide entre le squelette et le contenu, et le tenir
  // sur le seul succès laissait un projet introuvable sur un squelette éternel,
  // sans message et sans recours.
  //
  // La disposition, elle, exige le succès de l'état : `steps` vide et `running`
  // nul donnent `interrompu`, et l'écran proposerait de reprendre une analyse
  // dont il ne sait rien. Une requête d'état en échec laisse donc la grille
  // passer devant — l'invariant vaut aussi contre nos propres pannes : la phase
  // ne retire jamais ce qui existe, et une liste chargée reste triable.
  // **Il manque une étape et rien ne tourne.** Le prédicat porte sur les cibles
  // de la reprise, pas sur la phase : `triable` ne dit rien du proxy, et c'est
  // pourtant lui qui manque le plus souvent ici. Rien à reprendre quand tout est
  // là — un bouton dont le plan reviendrait vide promet un travail qui n'aura
  // pas lieu.
  const àReprendre = projet.isSuccess && running === null && CIBLES_DE_REPRISE.some((c) => steps[c] !== true)

  // **Une liste qui n'a pas pu se charger n'est pas une liste vide.** Sans
  // cette distinction, un `GET /candidates` en échec montait le fil de tri sur
  // un tableau vide : l'écran affichait « aucune proposition » juste sous le
  // bandeau qui dit ne pas avoir pu les charger, et se contredisait. Des données
  // périmées, elles, restent affichées — la phase ne retire jamais ce qui
  // existe. (relevé par Copilot)
  const listeInconnue = candidats.isError && candidats.data === undefined

  // **Ce qui dimensionne les durées annoncées, et ce qui manque.** La durée
  // vient de l'ingestion et le compte de fenêtres du bilan de repérage ; la
  // taille du fichier, elle, n'est pas publiée par `GET /api/projects/:id` —
  // elle vit sur `Source`, que seule la bibliothèque interroge. Le panneau
  // n'annonce donc rien pendant les quelques dizaines de secondes qui précèdent
  // la fin de l'ingestion, ce qui est la règle qu'il tient déjà : une absence se
  // lit mieux qu'un chiffre inventé.
  const taille: TailleÉmission = {
    durationSec: projet.data?.project.durationSec ?? null,
    sizeBytes: null,
    fenêtres: projet.data?.repérage?.fenêtres ?? null,
  }

  const prêt = !projet.isPending && !candidats.isPending
  const disposition =
    projet.isSuccess && !candidats.isPending
      ? dispositionAvancement(phase, running, clips.length === 0)
      : 'rien'

  return (
    <div className="flex min-h-full flex-col">
      <AppBar lieu={{ kind: 'projet', projet: { id, titre: projet.data?.project.title ?? id } }}>
        {/* **L'arrêt suit l'avancement quand il se replie.** Le panneau cède la
            place à la grille dès qu'il y a quelque chose à trier, et il reste
            alors six minutes d'encodage : sans ce bouton, arrêter demanderait
            d'attendre que l'analyse redevienne la seule chose à l'écran, ce qui
            n'arrive jamais. */}
        {disposition === 'bande' && running !== null && (
          <>
            <BandeAvancement running={running} />
            <BoutonArrêt projectId={id} compact />
          </>
        )}
      </AppBar>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5">
        {/* Au-dessus de la disposition, pour survivre au panneau : c'est
            précisément quand il cède la place à la grille qu'il y a quelque
            chose à annoncer. */}
        <AnnonceDÉtape running={running} steps={steps} connu={projet.isSuccess} />

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
                {/* `running !== null` est toujours faux sous la garde ci-dessus,
                    et c'est délibéré : la garde tient à un contrat de serveur —
                    `error` n'est servi qu'au repos — et le jour où elle bouge,
                    le bouton doit se désactiver tout seul plutôt que de rester
                    figé sur un `false` écrit à la main. */}
                <BoutonReprise projectId={id} enCours={running !== null} />
              </AlertDescription>
            </Alert>
          )}

          {/* **Une troisième origine, et elle n'est ni l'une ni l'autre.** Ce
              n'est pas l'analyse qui a échoué — on ne sait pas ce qu'elle a
              fait —, c'est l'état du projet qui ne se lit pas : un projet
              inconnu, un serveur qui ne répond plus. Sans ce mot, l'écran
              restait sur un squelette que rien ne venait jamais remplacer. */}
          {projet.isError && (
            <Alert variant="destructive">
              <AlertTitle>L’état de ce projet ne se charge pas.</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                <p>{messageDe(projet.error)}</p>
                <Button size="sm" variant="outline" onClick={() => void projet.refetch()}>
                  Réessayer
                </Button>
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
              taille={taille}
              reprise={<BoutonReprise projectId={id} enCours={running !== null} />}
              arret={running !== null ? <BoutonArrêt projectId={id} /> : null}
            />
          ) : !prêt ? (
            <GrilleEnAttente />
          ) : listeInconnue ? null : (
            <>
              {/* **La vue de l'émission, au-dessus du tri.** L'écran n'est plus
                  seulement un écran de tri : une fois l'analyse passée, c'est
                  aussi l'endroit depuis lequel on comprend ce qui a été produit
                  à partir de l'émission. Le lecteur montre le replay entier —
                  trous compris, contrairement à celui d'un clip — et la bande
                  dit où sont les clips gardés.

                  Elle ne s'affiche pas sous le panneau d'avancement : celui-ci
                  ne prend la page que lorsqu'il n'y a rien d'autre à montrer, et
                  poser un lecteur sans proxy sous une analyse qui commence
                  n'apprendrait rien. */}
              <VueÉmission
                projectId={id}
                duréeSec={projet.data?.project.durationSec ?? 0}
                proxyPret={steps.proxy === true}
                clips={clips}
              />

              <FilDeTri
                projectId={id}
                clips={clips}
                vue={vue}
                onVue={allerÀLaVue}
                proxyPret={steps.proxy === true}
                bilan={projet.data?.repérage ?? null}
                suite={suite(phase, { id })}
                onStatut={(clipId, status) =>
                  patch.mutate({ clipId, projectId: id, patch: { status } })
                }
                entete={
                  <>
                    {/* **La reprise vit aussi devant la grille.** Un redémarrage
                        du serveur après le repérage et avant le proxy laisse
                        `running` à nul et la liste pleine : la grille passe
                        devant — c'est l'invariant —, mais « relancer le repérage »
                        ne vise que `candidates` et ne reconstruit jamais le
                        proxy. Le montage restait alors désactivé sans aucun
                        moyen d'avancer, c'est-à-dire la même impasse que le
                        panneau ferme, avec une grille par-dessus.
                        (relevé par Codex) */}
                    {àReprendre && <BoutonReprise projectId={id} enCours={false} />}
                    <BoutonRelance
                      projectId={id}
                      compte={compter(clips)}
                      enCours={running !== null}
                    />
                  </>
                }
              />
            </>
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
  const nommée = paramètres.get('vue')
  const vue = vueDepuisUrl(nommée)

  function allerÀ(choisie: Vue) {
    const suivants = new URLSearchParams(paramètres.toString())
    // **La vue s'écrit toujours, « à trier » comprise.** L'omettre rendait une
    // URL nue indiscernable de celle du fil d'Ariane, donc impossible à
    // distinguer d'un retour de clip : le repli ci-dessous aurait ramené sur
    // « gardés » quelqu'un qui venait de choisir « à trier ».
    suivants.set('vue', choisie)
    router.replace(`${lienProjet(projectId)}?${suivants.toString()}`, { scroll: false })
  }

  // **Le retour d'un clip repasse par une URL nue.** `chemin` construit le fil
  // d'Ariane sur `lienProjet`, sans paramètre — c'est un contrat gelé, et il n'a
  // pas à connaître la vue. L'écran rattrape donc depuis la session, et
  // seulement quand l'URL ne nomme rien : une URL qui nomme sa vue reste
  // souveraine, y compris celle qu'on partage. (relevé par Codex)
  //
  // Dans un effet, jamais pendant le rendu : lire `sessionStorage` au rendu
  // donnerait une sortie différente sur le serveur et dans le navigateur, donc
  // une hydratation en désaccord.
  useEffect(() => {
    if (nommée !== null) return
    // **Seulement sur un retour marqué.** Venir de la bibliothèque emprunte la
    // même URL nue que le fil d'Ariane d'un clip : sans cette marque, la vue
    // mémorisée s'imposait à toute visite du projet, alors qu'elle décrit un
    // aller-retour en cours et non une préférence. (relevé par Codex)
    const { vue: mémorisée, retour } = lireSessionTri(projectId)
    if (retour && mémorisée !== null && mémorisée !== 'atrier') allerÀ(mémorisée)
    // Une seule fois, à l'arrivée : c'est un retour, pas une préférence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Et le pendant : la vue courante est recopiée en session à chaque fois
  // qu'elle change, sans quoi le repli ci-dessus n'aurait jamais rien à lire.
  useEffect(() => {
    écrireSessionTri(projectId, { vue })
  }, [projectId, vue])

  return [vue, allerÀ]
}

/** Le message d'un échec, quelle que soit sa nature. */
function messageDe(erreur: unknown): string {
  return erreur instanceof Error ? erreur.message : 'Cause inconnue.'
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
