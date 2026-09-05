'use client'

import { Keyboard, ListVideo, Send, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { useId, useRef, useState, type ReactNode } from 'react'

import {
  clipEligibilityFromStatus,
  composeDescription,
  type Platform,
  type PlatformAvailability,
  type PublicationRecord,
} from '@/core/publication'
import type { ClipStatus } from '@/core/edl'
import { count } from '@/core/phase'
import type { SelectionReport, CandidateClip } from '@/lib/api'
import { formatDuration } from '@/lib/format'
import { linkSort, type Next } from '@/lib/navigation'
import { CandidateCard } from '@/components/review/candidate-card'
import { LoopEnd } from '@/components/review/loop-end'
import { agreement, detectionWord, VIEWS, type View } from '@/components/review/template'
import { useShortcutsReview } from '@/components/review/shortcuts'
import { useSortLoop } from '@/components/review/sort-loop'
import { useReviewSession, writeSessionReview } from '@/components/review/session'
import { PublishDialog, type PublishClipTarget } from '@/components/publication/publish-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * The sort feed: twenty-five to thirty cards, two decisions per card, each
 * reversible. Keyboard shortcuts, the decided card staying put, and the
 * remaining-count carry this loop — see spec §2.5.
 *
 * It does not fetch its own data: the page hands it clips. That is what makes
 * it mountable in a test without a server or a cache, and where the
 * behaviours a regression would leave silent actually live.
 */
export function ReviewFeed({
  projectId,
  clips,
  view,
  onView,
  proxyReady,
  summary,
  next,
  onStatus,
  header,
  publicationAvailability,
  publicationAvailabilityError,
  onRetryPublicationAvailability,
  publicationRecords,
  publicationRecordsPending,
  publicationRecordsFailed,
  descriptionFooter,
  publishError,
  onPublish,
}: {
  projectId: string
  clips: readonly CandidateClip[]
  view: View
  onView: (view: View) => void
  /** Le proxy est-il là ? Il commande les vignettes et l'ouverture du montage. */
  proxyReady: boolean
  /** Ce que le repérage n'a pas jugé, ou `null`. Voir `detectionWord`. */
  summary: SelectionReport | null
  /** Injectée par la page, comme `PublishDialog` — voir son propre commentaire. */
  publicationAvailability?: Readonly<Record<Platform, PlatformAvailability>>
  /** `usePublicationAvailability` a échoué — voir `PublishDialog.availabilityError`. */
  publicationAvailabilityError?: boolean
  /** Réessaie la disponibilité — voir `PublishDialog.onRetryAvailability`. */
  onRetryPublicationAvailability?: () => void
  /**
   * Ce qu'une publication précédente a laissé, par clip et par plateforme —
   * la page l'interroge par `usePublicationRecordsByClip`. Sans lui, la boîte
   * ne voit jamais qu'une plateforme est déjà `published` : elle la propose
   * par défaut, et le serveur refuse toute la publication groupée faute de
   * `force`. (relevé par Copilot, Codex et Aristarque)
   */
  publicationRecords?: Readonly<Record<string, Partial<Record<Platform, PublicationRecord>>>>
  /** Les clips dont l'enregistrement n'a pas encore répondu — voir `PublishDialog.recordsLoading`. */
  publicationRecordsPending?: ReadonlySet<string>
  /** Les clips dont l'enregistrement a échoué — voir `PublishDialog.recordsError`. */
  publicationRecordsFailed?: ReadonlySet<string>
  /**
   * `publication.descriptionFooter` — même source que `clip-screen.tsx`,
   * `undefined` tant que non chargé (relevé par Copilot).
   */
  descriptionFooter?: string
  /** Ce qu'un envoi groupé a laissé en échec — la page l'attend avec `mutateAsync`. */
  publishError?: string | null
  /** Lance la publication en masse — la page en fait un `POST` par clip. */
  onPublish?: (targets: readonly { clipId: string; platform: Platform }[], force: boolean) => void
  /**
   * L'issue de la phase, calculée par la page.
   *
   * Elle arrive en propriété plutôt que d'être calculée ici : `next` a besoin
   * de la phase, donc du relevé d'artefacts et de l'exécution en cours, que ce
   * composant n'a aucune raison de connaître. C'est la fin de boucle qui la
   * consomme — c'est le seul endroit où l'on sait enfin de quoi la liste est
   * faite.
   */
  next: Next
  onStatus: (clipId: string, status: Exclude<ClipStatus, 'exported'>) => void
  /** Ce que la page pose en bout de ligne d'en-tête — la relance, notamment. */
  header?: ReactNode
}) {
  const counts = count(clips)
  const word = detectionWord(summary)

  const grid = useRef<HTMLDivElement>(null)

  const [help, setHelp] = useState(false)

  /**
   * La sélection pour la publication en masse (retour d'usage §2.4).
   *
   * **Un `Set` d'identifiants, distinct de `selection`.** Cette dernière est
   * la carte sur laquelle le clavier travaille — une seule à la fois, jamais
   * persistée au-delà d'un changement de vue. Celle-ci est un choix explicite
   * de l'utilisateur, indépendant du clavier, et qui survit au déplacement du
   * curseur : cocher trois cartes puis naviguer aux flèches ne doit rien
   * décocher.
   */
  const [selectedForPublish, setSelectedForPublish] = useState<ReadonlySet<string>>(new Set())
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)

  function togglePublishSelection(clipId: string) {
    setSelectedForPublish((current) => {
      const next = new Set(current)
      if (next.has(clipId)) next.delete(clipId)
      else next.add(clipId)
      return next
    })
  }

  // **La même logique que la publication d'un clip seul** (retour d'usage
  // §11) : `PublishClipTarget` et `clipEligibilityFromStatus` viennent tous
  // deux de `@/core/publication`, sans rien de propre à la vue Émission.
  // L'éligibilité diffère dans sa source — le statut du clip ici, `outputs`
  // sur l'écran de clip, parce que cette liste n'a jamais chargé les sorties
  // de chaque clip — et donc dans sa précision : `outputs.mp4Url` peut
  // devenir `null` (rendu périmé par une édition, fichier disparu) alors que
  // `status` reste `exported`, ce que cette vue ne peut pas voir. La sélection
  // en masse peut donc, dans ce cas rare, juger publiable un clip que l'écran
  // de clip refuserait — signalé par Aristarque, non corrigé ici : le
  // corriger demanderait de charger `outputs` pour chaque candidat, un appel
  // réseau que cette PR ne fait pas (hors périmètre, voir issue de suivi).
  //
  // **Réconciliée avec `clips`, jamais lue sur `selectedForPublish` seul.**
  // `selectedForPublish` peut porter un identifiant qu'un repérage forcé a fait
  // disparaître de `clips` ; filtrer ici est ce qui évite d'annoncer « 1 clip
  // sélectionné » puis d'ouvrir une modale « Publier 0 clip ». (relevé par
  // Copilot)
  const clipsToPublish: PublishClipTarget[] = clips
    .filter((c) => selectedForPublish.has(c.id))
    .map((c) => ({
      clipId: c.id,
      title: c.title,
      eligibility: clipEligibilityFromStatus(c.status),
      records: publicationRecords?.[c.id],
      // Même garde que `PanelExport` : absent tant que le réglage n'est pas
      // connu, plutôt que de composer avec un pied de page supposé vide
      // (relevé par Copilot).
      composedDescription:
        descriptionFooter === undefined ? undefined : composeDescription(c, { footer: descriptionFooter }),
    }))
  const selectedForPublishCount = clipsToPublish.length
  const publicationRecordsLoading = clipsToPublish.some((c) => publicationRecordsPending?.has(c.clipId))
  const publicationRecordsError = clipsToPublish.some((c) => publicationRecordsFailed?.has(c.clipId))

  // **Aucun `useCallback` ici, et c'est délibéré.** Ces gestes ferment sur la
  // liste, la vue et la sélection : leurs tableaux de dépendances seraient longs,
  // faux un jour, et sans bénéfice — `useShortcutsReview` garde les derniers
  // derrière une référence, donc rien ne se réabonne au changement d'identité, et
  // le compilateur de React mémorise ce qui vaut de l'être.
  function element(clipId: string | null): HTMLElement | null {
    if (clipId === null) return null
    const cards = grid.current?.querySelectorAll<HTMLElement>('[data-clip]') ?? []
    // Une comparaison d'attribut plutôt qu'un sélecteur : les identifiants de
    // clip héritent du nom de fichier d'origine, accents et espaces compris, et
    // il n'y a pas trente cartes à parcourir.
    for (const card of cards) if (card.getAttribute('data-clip') === clipId) return card
    return null
  }

  // Reports whether it found the card: restoring focus on return needs to
  // know whether to retry after the next view change.
  function attemptFocus(clipId: string | null): boolean {
    const card = element(clipId)
    if (card === null) return false
    card.focus()
    // `scrollIntoView` doesn't exist under jsdom; focus alone suffices in a
    // real browser for cards already on screen.
    if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' })
    return true
  }

  const { visible, current, select, focusCard: focus, move, decide, decideOn, undo, done } =
    useSortLoop(clips, view, onStatus, attemptFocus)

  function open() {
    // Le lien de la carte, pas le routeur : une seule navigation, celle que le
    // clic emprunte déjà.
    element(current)?.querySelector<HTMLAnchorElement>('a[data-open]')?.click()
  }

  useShortcutsReview({
    previous: () => move(-1),
    next: () => move(1),
    keep: () => decide('kept'),
    discard: () => decide('discarded'),
    open,
    undo,
    help: () => setHelp(true),
  })

  useReviewSession(projectId, current, view, focus)

  return (
    <div
      className="flex flex-col gap-4"
      onClickCapture={(event) => {
        const target = event.target
        if (!(target instanceof HTMLElement)) return
        const link = target.closest<HTMLAnchorElement>('a[href^="/clips/"]')
        if (link === null) return
        // **La carte se note ici, et pas en continu au fil de la sélection.**
        // Une écriture à chaque déplacement écrasait la carte mémorisée pendant
        // la restauration elle-même : au retour, `focus` posait la sélection
        // sur une carte que la vue n'affichait pas encore, la sélection
        // retombait sur la première visible, et cette retombée était réécrite
        // par-dessus la carte qu'on cherchait à retrouver.
        //
        // Et elle se lit sur la carte cliquée plutôt que sur la sélection : la
        // capture précède le focus, donc `current` désigne encore la carte
        // d'avant. À défaut de carte — la liste de fin de boucle n'en est pas
        // une —, l'identifiant se relit dans l'URL du lien.
        const card =
          link.closest('[data-clip]')?.getAttribute('data-clip') ??
          decodeURIComponent(link.getAttribute('href')?.slice('/clips/'.length) ?? '')
        writeSessionReview(projectId, { returning: true, card: card === '' ? null : card })
      }}
    >
      {/* **Le départ vers un clip pose la marque de retour.** Un écouteur
          délégué en capture plutôt qu'un gestionnaire par lien : le clip
          s'ouvre depuis le titre d'une carte, depuis son bouton « Monter » et
          depuis la liste de fin de boucle, et un raccord posé sur deux d'entre
          eux manquerait au troisième sans que rien ne le signale. */}
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
        <h1 className="text-lg font-semibold tracking-tight">Propositions</h1>

        <p data-testid="counts" className="text-sm text-muted-foreground">
          <span className="font-mono tabular-nums">{counts.aSort}</span> à trier ·{' '}
          <span className="text-stage-foreground">
            {agreement(counts.guards, 'clip gardé', 'clips gardés')}
          </span>{' '}
          · <span className="font-mono tabular-nums">{formatDuration(counts.durationKept)}</span> au
          total
        </p>

        <div className="ml-auto flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setHelp(true)}
                  aria-label="Les raccourcis du tri"
                />
              }
            >
              <Keyboard aria-hidden />
            </TooltipTrigger>
            <TooltipContent>Les raccourcis · ?</TooltipContent>
          </Tooltip>
          {header}
        </div>
      </div>

      {/* **La barre d'outils, dès qu'au moins un clip est coché** (retour
          d'usage §2.4). Elle ouvre la même modale que le bouton « Publier »
          de l'écran de clip — `PublishDialog`, `@/components/publication` —
          sans rien réécrire de sa logique. */}
      {selectedForPublishCount > 0 && (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2">
          <p className="text-sm">
            {selectedForPublishCount === 1 ? '1 clip sélectionné' : `${selectedForPublishCount} clips sélectionnés`}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelectedForPublish(new Set())}>
              Annuler la sélection
            </Button>
            <Button size="sm" onClick={() => setPublishDialogOpen(true)}>
              <Send aria-hidden />
              Publier {selectedForPublishCount === 1 ? '1 clip' : `${selectedForPublishCount} clips`}
            </Button>
          </div>
        </div>
      )}

      {/* **Une ligne persistante, jamais un `toast`** (spec publication §6.2) :
          l'échec d'un envoi groupé ne doit pas disparaître avant d'avoir été
          lu. (relevé par Copilot, Codex et Aristarque) */}
      {publishError !== null && publishError !== undefined && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden />
          <AlertTitle>La publication groupée a rencontré une erreur.</AlertTitle>
          <AlertDescription>{publishError}</AlertDescription>
        </Alert>
      )}

      {/* **Ça reste à l'écran.** Ni notification, ni bandeau qu'on referme : ce
          que le repérage n'a pas jugé est une propriété permanente de cette
          liste, au même titre que son nombre d'éléments, et ça vit à côté du
          compte. Une information qui change la confiance qu'on accorde à un
          écran ne peut pas s'afficher trois secondes. */}
      {word !== null && (
        <p
          data-testid="detection"
          className={
            word.loss
              ? 'rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm'
              : 'text-sm text-muted-foreground'
          }
        >
          <span className="font-medium">{word.phrase}</span>
          {word.detail !== null && <span className="block text-muted-foreground">{word.detail}</span>}
          {word.provisional && (
            <span className="block text-muted-foreground">
              Décompte provisoire : la passe de repérage ne s’est pas terminée.
            </span>
          )}
        </p>
      )}

      {/* **Le contenu est dans un panneau, pas à côté des onglets.** Un
          `tablist` sans `tabpanel` s'annonce « onglet 1 sur 3 » sans qu'aucun
          panneau ne soit désigné : on entend une structure qui ne mène nulle
          part. Un seul panneau suffit — celui de la vue active, dont le contenu
          change avec elle. */}
      <Tabs value={view} onValueChange={(value) => onView(value as View)}>
        <div className="flex items-center justify-between gap-3">
          <TabsList>
            {VIEWS.map(({ value, label }) => (
              <TabsTrigger key={value} value={value}>
                {label}
                <Badge variant="outline" className="ml-1 font-mono text-xs tabular-nums">
                  {value === 'atrier'
                    ? counts.aSort
                    : value === 'gardes'
                      ? counts.guards
                      : counts.discarded}
                </Badge>
              </TabsTrigger>
            ))}
          </TabsList>

          <ButtonSort projectId={projectId} proxyReady={proxyReady} />
        </div>

        <TabsContent value={view} className="flex flex-col gap-4">
          {clips.length === 0 && (
            <Empty
              title="Aucune proposition pour le moment."
              detail="Le repérage n’a rien rendu, ou il n’a pas encore tourné."
            />
          )}

          {/* **La fin s'ajoute, elle ne remplace pas.** La dernière décision fait
              tomber le compteur à zéro : annoncer la fin *à la place* de la grille
              escamoterait vingt-cinq cartes sous la main au moment précis où l'on
              vient de décider — et `U`, qui ramène sur la carte de la décision
              défaite, n'aurait plus de carte où revenir. Les cartes restent donc en
              place, marquées, jusqu'au changement de vue qui les compacte. */}
          {done && (
            <LoopEnd
              projectId={projectId}
              clips={clips}
              durationKept={counts.durationKept}
              next={next}
            />
          )}

          {clips.length > 0 && visible.length === 0 && !done && (
            <Empty title={LABELS_EMPTY[view].title} detail={LABELS_EMPTY[view].detail} />
          )}

          {visible.length > 0 && (
            <div
              ref={grid}
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
            >
              {visible.map((clip) => (
                // **La case vit hors de `CandidateCard`, en superposition** —
                // comme le lien qui couvre déjà la vignette (voir le
                // commentaire de `candidate-card.tsx`). `CandidateCard` reste
                // celui de l'écran de tri seul ; lui ajouter une seconde
                // notion de sélection y aurait mélangé la carte sur laquelle
                // le clavier travaille (`selectionne`) et le choix,
                // indépendant, de ce qui part à la publication.
                <div key={clip.id} className="relative">
                  {/* Le clic sur la case ne doit pas ouvrir le clip : elle
                      n'est pas dans le lien qui couvre la vignette, et la
                      capture au niveau du fil (plus bas) ne cible que
                      `a[href^="/clips/"]`, donc rien à arrêter ici. */}
                  <div className="absolute top-2 right-2 z-10 flex items-center rounded-md bg-black/55 p-1 backdrop-blur-sm">
                    <Checkbox
                      checked={selectedForPublish.has(clip.id)}
                      // **Le même parcours Tab glissant que `CandidateCard`**
                      // (`candidate-card.tsx`, `tabulable`/`selectionne`) :
                      // sans ça, chaque carte visible ajoute un arrêt Tab
                      // supplémentaire, y compris les cartes qui ne sont pas
                      // sous le curseur — des dizaines d'arrêts sur une
                      // grille chargée. (relevé par Copilot)
                      tabIndex={clip.id === current ? 0 : -1}
                      // **Le focus revient à la carte, comme après « Garder »
                      // ou « Écarter ».** La case, un `[role="checkbox"]`,
                      // est désormais dans la garde des raccourcis
                      // (`raccourcis.ts`) : y rester après le clic rendrait
                      // le clavier muet sans que rien à l'écran ne le
                      // signale, la carte gardant son anneau de sélection.
                      onCheckedChange={() => {
                        togglePublishSelection(clip.id)
                        focus(clip.id)
                      }}
                      aria-label={`Sélectionner « ${clip.title || clip.id} » pour publication`}
                    />
                  </div>
                  <CandidateCard
                    clip={clip}
                    proxyReady={proxyReady}
                    selected={clip.id === current}
                    onSelection={() => select(clip.id)}
                    // **Le focus revient à la carte après un clic.** Il resterait
                    // sinon sur le bouton, que la garde des raccourcis écarte comme
                    // tout `button` : plus une seule touche ne répondrait, sans
                    // message et sans retour visible — la carte garderait son anneau
                    // de sélection, donc l'écran affirmerait le contraire. Or la
                    // souris pour décider puis le clavier pour enchaîner est le mode
                    // d'usage attendu, pas un cas tordu. Un focus posé par programme
                    // ne déclenche pas `:focus-visible` : rien ne bouge à l'œil.
                    onKeep={() => {
                      decideOn(clip.id, 'kept')
                      focus(clip.id)
                    }}
                    onDiscard={() => {
                      decideOn(clip.id, 'discarded')
                      focus(clip.id)
                    }}
                  />
                </div>
              ))}
            </div>
          )}

        </TabsContent>
      </Tabs>

      <HelpKeyboard open={help} onOpen={setHelp} />

      <PublishDialog
        open={publishDialogOpen}
        onOpenChange={setPublishDialogOpen}
        clips={clipsToPublish}
        availability={publicationAvailability}
        availabilityError={publicationAvailabilityError}
        onRetryAvailability={onRetryPublicationAvailability}
        recordsLoading={publicationRecordsLoading}
        recordsError={publicationRecordsError}
        onLaunch={onPublish}
      />
    </div>
  )
}

const LABELS_EMPTY: Record<View, { title: string; detail: string }> = {
  atrier: {
    title: 'Tout est trié.',
    detail: 'Les propositions décidées se retrouvent dans les deux autres vues.',
  },
  gardes: {
    title: 'Aucun clip gardé.',
    detail: 'Les clips gardés se montent depuis leur carte.',
  },
  ecartes: { title: 'Aucun clip écarté.', detail: 'Rien n’a encore été mis de côté.' },
}

/** The entry point to the full-screen sort view, on the tab row. */
function ButtonSort({ projectId, proxyReady }: { projectId: string; proxyReady: boolean }) {
  const reason = useId()

  if (!proxyReady) {
    return (
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          aria-disabled="true"
          aria-describedby={reason}
          onClick={(event) => event.preventDefault()}
        >
          <ListVideo aria-hidden />
          Trier
        </Button>
        <p id={reason} data-testid="reason-sort" className="text-xs text-muted-foreground">
          Le tri plein écran s’ouvrira avec le proxy, en cours d’encodage.
        </p>
      </div>
    )
  }

  // A link, not a button styled as one — `Button render={<Link/>}` from Base
  // UI puts `role="button"` on the anchor, breaking it as a link (same as
  // `Mount` in `candidate-card.tsx`).
  return (
    <Link href={linkSort({ kind: 'project', projectId })} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      <ListVideo aria-hidden />
      Trier
    </Link>
  )
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-xl border border-dashed px-6 py-14 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </div>
  )
}

/**
 * La liste des raccourcis.
 *
 * **Elle existe parce que le reste existe** : sept raccourcis qui ne se
 * découvrent que dans un attribut `title` sont sept raccourcis que personne
 * n'utilise.
 */
function HelpKeyboard({
  open,
  onOpen,
}: {
  open: boolean
  onOpen: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Les raccourcis du tri</DialogTitle>
          <DialogDescription>
            Toutes ces touches sont directes en AZERTY : un raccourci à deux mains
            n’économise rien sur un geste répété trente fois.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map(([key, effect]) => (
            <div key={key} className="contents">
              <dt className="font-mono text-xs text-muted-foreground">{key}</dt>
              <dd>{effect}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}

const SHORTCUTS: readonly [string, string][] = [
  ['J / K', 'carte suivante, précédente'],
  ['Flèches', 'idem'],
  ['P', 'garder, et avancer d’une carte'],
  ['X', 'écarter, et avancer d’une carte'],
  ['Entrée', 'ouvrir le clip'],
  ['U', 'défaire la dernière décision, et revenir sur sa carte'],
  ['?', 'cette liste'],
]
