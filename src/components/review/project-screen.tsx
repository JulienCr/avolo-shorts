'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'

import type { StepName } from '@/core/graph'
import { count, phaseProject, type ShowSize } from '@/core/phase'
import { RESUME_TARGETS } from '@/lib/api'
import { linkProject, next } from '@/lib/navigation'
import {
  useCandidates,
  usePatchClip,
  usePublicationAvailability,
  usePublicationRecordsByClip,
  usePublisher,
  useProject,
} from '@/lib/queries'
import type { Platform } from '@/core/publication'
import { ShowView } from '@/components/show/show-view'
import { AppBar } from '@/components/navigation/app-bar'
import { AnnouncementDStep, StripProgress, PanelProgress } from '@/components/review/progress'
import { ReviewFeed } from '@/components/review/feed'
import { layoutProgress, viewSinceUrl, type View } from '@/components/review/template'
import { ButtonRetry, ButtonResume, ButtonStart, StopButton } from '@/components/review/retry'
import { RerunCorrectionButton } from '@/components/show/transcript-panel'
import { lireSessionReview, writeSessionReview } from '@/components/review/session'
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
 * Il ne calcule rien lui-même. La phase vient de `@/core/phase`, la
 * disposition et le vocabulaire des vues de `@/components/review/template`, la boucle
 * de tri de `ReviewFeed` : il interroge, distribue et dispose. C'est la même
 * frontière que `src/core` contre `src/server`, appliquée un cran plus haut.
 *
 * **Il vit ici et non dans le fichier de route**, et c'est ce qui le rend
 * testable. La page lit ses `params` par `use()`, qui suspend ; sous `jsdom`,
 * une limite de Suspense ne se relève jamais — la promesse se tient, React ne
 * rejoue pas, et le repli reste à l'écran indéfiniment. Monter la route entière
 * dans un test ne prouvait donc rien. Séparés, l'adaptateur de route n'a plus
 * rien à prouver et l'écran se monte avec ses requêtes.
 */
export function ProjectScreen({ id }: { id: string }) {
  const project = useProject(id)
  const candidates = useCandidates(id)
  const patch = usePatchClip()
  const publicationAvailability = usePublicationAvailability()
  const publisher = usePublisher()
  const [view, goToView] = useViewInUrl(id)

  const clips = candidates.data ?? []
  // **Seuls les clips exportés peuvent porter une publication** (`clipExportEligibility`) :
  // borner la requête à eux évite un `GET /publications` par clip du projet,
  // dont la grande majorité n'a jamais été rendue.
  const exportedClipIds = clips.filter((c) => c.status === 'exported').map((c) => c.id)
  const { byClip: publicationRecords, pendingClipIds: publicationRecordsPending } =
    usePublicationRecordsByClip(exportedClipIds)

  const [publishError, setPublishError] = useState<string | null>(null)

  /**
   * Un `POST /publish` par clip, jamais un seul lot : la route ne prend qu'un
   * identifiant de clip (spec §6.4). `ReviewFeed` ne fait qu'appeler ceci ;
   * il ne connaît ni la mutation ni le regroupement.
   *
   * **`mutateAsync` et non `mutate`, en boucle `await`.** `publisher` est une
   * seule mutation partagée par tous les clips sélectionnés : l'appeler en
   * boucle sans attendre ne laisse `isError`/`error` refléter que le dernier
   * appel, et un 409 sur un clip déjà publié disparaissait sans qu'aucun
   * message ne le dise — la boîte se ferme dans tous les cas. (relevé par
   * Copilot, Codex et Aristarque)
   */
  async function publishSelection(targets: readonly { clipId: string; platform: Platform }[], force: boolean) {
    setPublishError(null)
    const byClip = new Map<string, Platform[]>()
    for (const target of targets) {
      const platforms = byClip.get(target.clipId) ?? []
      platforms.push(target.platform)
      byClip.set(target.clipId, platforms)
    }
    const outcomes = await Promise.allSettled(
      Array.from(byClip, ([clipId, platforms]) => publisher.mutateAsync({ clipId, platforms, force })),
    )
    const failures = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected')
    if (failures.length > 0) {
      setPublishError(
        failures
          .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
          .join(' · '),
      )
    }
  }
  const steps = project.data?.steps ?? ({} as Record<StepName, boolean>)
  const running = project.data?.running ?? null
  // **Au repos seulement.** Pendant qu'une exécution tourne, l'échec affiché
  // serait celui d'avant — et c'est le serveur qui le garantit déjà en rendant
  // `error: null` tant que `running` n'est pas nul.
  const error = project.data?.error ?? null
  // Distinct d'`error` depuis les issues #137/#140 : voir le commentaire du
  // bandeau plus bas.
  const warning = project.data?.warning ?? null
  // Défaut prudent tant que l'état n'a pas répondu : `true` plutôt que `false`.
  const everRan = project.data?.everRan ?? true

  const phase = phaseProject(steps, running, error, clips, everRan)

  // **Attendre n'est pas la même chose que ne pas savoir.**
  //
  // `ready` dit que les deux requêtes ont rendu la main, en succès comme en
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
  const toResume = project.isSuccess && running === null && RESUME_TARGETS.some((c) => steps[c] !== true)

  // **Une liste qui n'a pas pu se charger n'est pas une liste vide.** Sans
  // cette distinction, un `GET /candidates` en échec montait le fil de tri sur
  // un tableau vide : l'écran affichait « aucune proposition » juste sous le
  // bandeau qui dit ne pas avoir pu les charger, et se contredisait. Des données
  // périmées, elles, restent affichées — la phase ne retire jamais ce qui
  // existe. (relevé par Copilot)
  const listUnknown = candidates.isError && candidates.data === undefined

  // **Ce qui dimensionne les durées annoncées.** Les trois champs viennent de
  // trois moments : la taille du fichier est connue avant même que la copie
  // commence, la durée arrive avec l'ingestion, le compte de fenêtres avec le
  // bilan de repérage. C'est `sizeBytes` qui compte le plus ici, et c'est le
  // dernier arrivé : sans lui, le panneau se taisait pendant toute la copie —
  // l'étape la plus longue sur un fichier de 12 Go, et la seule qu'on regarde
  // vraiment. Ce qui manque encore rend `null`, et une absence se lit toujours
  // mieux qu'un chiffre inventé.
  const size: ShowSize = {
    durationSec: project.data?.project.durationSec ?? null,
    sizeBytes: project.data?.sizeBytes ?? null,
    windows: project.data?.selectionReport?.windows ?? null,
  }

  const ready = !project.isPending && !candidates.isPending
  const layout =
    project.isSuccess && !candidates.isPending
      ? layoutProgress(phase, running, clips.length === 0)
      : 'rien'

  return (
    <div className="flex min-h-full flex-col">
      <AppBar lieu={{ kind: 'projet', project: { id, title: project.data?.project.title ?? id } }}>
        {/* **L'arrêt suit l'avancement quand il se replie.** Le panneau cède la
            place à la grille dès qu'il y a quelque chose à trier, et il reste
            alors six minutes d'encodage : sans ce bouton, arrêter demanderait
            d'attendre que l'analyse redevienne la seule chose à l'écran, ce qui
            n'arrive jamais. */}
        {layout === 'bande' && running !== null && (
          <>
            <StripProgress running={running} />
            <StopButton projectId={id} compact />
          </>
        )}
      </AppBar>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5">
        {/* Au-dessus de la disposition, pour survivre au panneau : c'est
            précisément quand il cède la place à la grille qu'il y a quelque
            chose à annoncer. */}
        <AnnouncementDStep
          running={running}
          steps={steps}
          connu={project.isSuccess}
          everRan={everRan}
        />

        <div className="flex flex-col gap-4">
          {/* **Deux origines d'erreur, et la seconde n'efface pas la première.**
              L'analyse a échoué : c'est un fait du serveur, il vit en bandeau et
              son message vient de `ProjectStatus.error`. La liste ne se charge
              pas : c'est un incident local, il a son message et son
              « réessayer ». Les deux peuvent tenir en même temps.

              Le bandeau ne double pas le panneau, qui porte déjà le message du
              serveur et le bouton de reprise.

              **Plus de garde sur `steps.candidates` depuis les issues
              #137/#140.** Elle visait à taire ce bandeau quand seule la
              correction avait échoué — `candidates.json` existe alors quand
              même —, mais `candidates` tourne **avant** `proxy` et `analysis`
              sur `TARGETS_INITIAL` (`src/server/run.ts`) : une vraie panne de
              l'un des deux, après un repérage réussi, restait masquée par la
              même garde. `error` et l'avertissement de correction vivent
              maintenant dans deux champs séparés du statut ; ce bandeau ne lit
              plus que le premier, et n'a donc plus besoin de deviner. (relevé
              par Aristarque) */}
          {error !== null && running === null && layout !== 'panneau' && (
            <Alert variant="destructive">
              <AlertTitle>La dernière analyse a échoué.</AlertTitle>
              <AlertDescription>
                <p>{error}</p>
                {/* `running !== null` est toujours faux sous la garde ci-dessus,
                    et c'est délibéré : la garde tient à un contrat de serveur —
                    `error` n'est servi qu'au repos — et le jour où elle bouge,
                    le bouton doit se désactiver tout seul plutôt que de rester
                    figé sur un `false` écrit à la main. */}
                <ButtonResume projectId={id} inCurrent={running !== null} />
              </AlertDescription>
            </Alert>
          )}

          {/* **La panne tolérée de la correction, distincte de `error` depuis
              les issues #137/#140.** Ni un échec d'analyse ni un incident
              local : le repérage a tourné sur un texte non corrigé, et le
              rattrapage est le même bouton que dans le panneau transcript —
              réutilisé tel quel, pour ne garder qu'un seul endroit qui sache
              lancer `force: ['correction']`. */}
          {warning !== null && running === null && layout !== 'panneau' && (
            <Alert>
              <AlertTitle>La correction automatique du transcript a échoué.</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                <p>{warning}</p>
                <RerunCorrectionButton projectId={id} inCurrent={running !== null} />
              </AlertDescription>
            </Alert>
          )}

          {/* **Une troisième origine, et elle n'est ni l'une ni l'autre.** Ce
              n'est pas l'analyse qui a échoué — on ne sait pas ce qu'elle a
              fait —, c'est l'état du projet qui ne se lit pas : un projet
              inconnu, un serveur qui ne répond plus. Sans ce mot, l'écran
              restait sur un squelette que rien ne venait jamais remplacer. */}
          {project.isError && (
            <Alert variant="destructive">
              <AlertTitle>L’état de ce projet ne se charge pas.</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                <p>{message(project.error)}</p>
                <Button size="sm" variant="outline" onClick={() => void project.refetch()}>
                  Réessayer
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {candidates.isError && (
            <Alert variant="destructive">
              <AlertTitle>Les propositions ne se chargent pas.</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                <p>{message(candidates.error)}</p>
                <Button size="sm" variant="outline" onClick={() => void candidates.refetch()}>
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
          {layout === 'panneau' ? (
            <PanelProgress
              steps={steps}
              running={running}
              error={error}
              everRan={everRan}
              size={size}
              resume={
                phase.analysis === 'new' ? (
                  <ButtonStart projectId={id} inCurrent={running !== null} />
                ) : (
                  <ButtonResume projectId={id} inCurrent={running !== null} />
                )
              }
              shutdown={running !== null ? <StopButton projectId={id} /> : null}
            />
          ) : !ready ? (
            <PendingGrid />
          ) : (
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
                  n'apprendrait rien.

                  **Elle ne dépend pas non plus de la liste des candidats.** Elle
                  vivait derrière la même garde que le fil de tri, si bien qu'un
                  `GET /candidates` en échec emportait le lecteur alors que le
                  proxy et l'état du projet étaient parfaitement disponibles. La
                  liste ne commande que la bande, qui le dit quand elle ne sait
                  pas. (relevé par Copilot) */}
              <ShowView
                projectId={id}
                durationSec={project.data?.project.durationSec ?? 0}
                proxyReady={steps.proxy === true}
                clips={clips}
                clipsKnown={!listUnknown}
                // **Le départ vers un clip pose la marque de retour**, comme
                // celui qui part d'une carte : sans elle, revenir d'un clip
                // ouvert depuis la bande retombait sur la vue par défaut, alors
                // que le même clip ouvert d'une carte rendait la vue d'où l'on
                // venait. La bande, elle, ne connaît pas le stockage de session.
                onOpenClip={(clipId) =>
                  writeSessionReview(id, { returning: true, card: clipId })
                }
              />

              {/* **La liste, elle, ne se rend pas sans elle-même.** Une liste
                  qui n'a pas pu se charger n'est pas une liste vide : le fil de
                  tri afficherait « aucune proposition » juste sous le bandeau
                  qui dit ne pas avoir pu les charger. */}
              {!listUnknown && (
              <ReviewFeed
                projectId={id}
                clips={clips}
                view={view}
                onView={goToView}
                proxyReady={steps.proxy === true}
                summary={project.data?.selectionReport ?? null}
                next={next(phase, { id })}
                onStatus={(clipId, status) =>
                  patch.mutate({ clipId, projectId: id, patch: { status } })
                }
                publicationAvailability={publicationAvailability.data}
                publicationRecords={publicationRecords}
                publicationRecordsPending={publicationRecordsPending}
                publishError={publishError}
                onPublish={publishSelection}
                header={
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
                    {toResume && <ButtonResume projectId={id} inCurrent={false} />}
                    <ButtonRetry
                      projectId={id}
                      count={count(clips)}
                      inCurrent={running !== null}
                    />
                  </>
                }
              />
              )}
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
function useViewInUrl(projectId: string): [View, (view: View) => void] {
  const router = useRouter()
  const parameters = useSearchParams()
  const named = parameters.get('vue')
  const view = viewSinceUrl(named)

  function goTo(chosen: View) {
    const next = new URLSearchParams(parameters.toString())
    // **La vue s'écrit toujours, « à trier » comprise.** L'omettre rendait une
    // URL nue indiscernable de celle du fil d'Ariane, donc impossible à
    // distinguer d'un retour de clip : le repli ci-dessous aurait ramené sur
    // « gardés » quelqu'un qui venait de choisir « à trier ».
    next.set('vue', chosen)
    router.replace(`${linkProject(projectId)}?${next.toString()}`, { scroll: false })
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
    if (named !== null) return
    // **Seulement sur un retour marqué.** Venir de la bibliothèque emprunte la
    // même URL nue que le fil d'Ariane d'un clip : sans cette marque, la vue
    // mémorisée s'imposait à toute visite du projet, alors qu'elle décrit un
    // aller-retour en cours et non une préférence. (relevé par Codex)
    const { view: memoized, returning } = lireSessionReview(projectId)
    if (returning && memoized !== null && memoized !== 'atrier') goTo(memoized)
    // Une seule fois, à l'arrivée : c'est un retour, pas une préférence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Et le pendant : la vue courante est recopiée en session à chaque fois
  // qu'elle change, sans quoi le repli ci-dessus n'aurait jamais rien à lire.
  useEffect(() => {
    writeSessionReview(projectId, { view })
  }, [projectId, view])

  return [view, goTo]
}

/** Le message d'un échec, quelle que soit sa nature. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Cause inconnue.'
}

/**
 * Le squelette de la grille.
 *
 * **À ne pas confondre avec l'attente d'analyse** : celui-ci dure deux cents
 * millisecondes, l'autre neuf minutes. C'est pourquoi le panneau d'avancement
 * n'est pas une grille grise — les deux rendaient la même page.
 */
function PendingGrid() {
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
