'use client'

import { ChevronDown, ChevronLeft, ChevronRight, Keyboard, RotateCw, Redo2, Undo2 } from 'lucide-react'
import { useIsMutating } from '@tanstack/react-query'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'

import { AppBar } from '@/components/navigation/app-bar'
import { HookFields } from '@/components/clip/hook-fields'
import { PreviewOutput } from '@/components/clip/output-preview'
import { FieldsTexts } from '@/components/clip/text-fields'
import { ClipPlayer, ClipTransport, togglePlayback, placePlayback } from '@/components/clip/clip-player'
import { ClipStrip } from '@/components/clip/clip-strip'
import { type ClipView, readClipView, writeClipView } from '@/components/clip/clip-view'
import { CropOverlay, RatioPicker } from '@/components/clip/crop-picker'
import { ClipPrimaryAction, deriveDeliveryState } from '@/components/clip/export-panel'
import { ExportsView } from '@/components/clip/exports-view'
import { FramingFields } from '@/components/clip/framing-fields'
import { usePlayback } from '@/components/clip/playback'
import { DialogueShortcuts, useShortcuts } from '@/components/clip/shortcuts'
import { Timeline } from '@/components/clip/timeline'
import { TranscriptDrawer } from '@/components/clip/transcript-drawer'
import { outputNames } from '@/components/clip/texts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { PublishDialog, type PublishClipTarget } from '@/components/publication/publish-dialog'
import { DEFAULT_CAPTION_STYLE } from '@/core/captions/ass'
import { splitIntoCards } from '@/core/captions/cards'
import { retimeWords } from '@/core/captions/retime'
import { clipDuration } from '@/core/edl'
import { resolveHook } from '@/core/hook'
import { isGuard } from '@/core/phase'
import { clipExportEligibility, composeDescription } from '@/core/publication'
import type { Clip, ClipDetail, ClipPatch } from '@/lib/api'
import { HOOK_DEFAULTS } from '@/lib/api'
import { LABELS_STATUS } from '@/lib/clip-status'
import { indexTranscript, lineInitial } from '@/lib/editing'
import { differences, useAutosave } from '@/lib/autosave'
import { clipNext, linkClip } from '@/lib/navigation'
import {
  useExporter,
  usePatchClip,
  useCandidates,
  usePublications,
  usePublicationAvailability,
  usePublisher,
  useSettings,
} from '@/lib/queries'
import type { Platform } from '@/core/publication'
import { cn } from '@/lib/utils'
import { useEditor, useCanCancel, useCanRestore, useSegments } from '@/store/editor'

/**
 * Ce que montre le viseur : l'aperçu vivant, ou le fichier livré, au même
 * endroit. « Export » est absent plutôt que grisé tant que rien n'est livré
 * (§3.4, 23 août) — même règle que « Publier ».
 */
export function OutputSwitch({
  delivered,
  mode,
  onMode,
}: {
  delivered: boolean
  mode: 'preview' | 'export'
  onMode: (mode: 'preview' | 'export') => void
}) {
  return (
    <ToggleGroup
      value={[mode]}
      onValueChange={(chosen: string[]) => {
        // En sélection unique, recliquer l'élément actif rend une liste vide :
        // il n'y a rien de sensé à en faire, on garde le mode précédent.
        const next = chosen[0] as 'preview' | 'export' | undefined
        if (next) onMode(next)
      }}
      variant="outline"
      size="sm"
      spacing={0}
      aria-label="Ce que montre le viseur"
    >
      <ToggleGroupItem value="preview">Aperçu</ToggleGroupItem>
      {delivered && <ToggleGroupItem value="export">Export</ToggleGroupItem>}
    </ToggleGroup>
  )
}

/**
 * L'écran de clip, **hors de la page**.
 *
 * Un fichier de `src/app/` porte une route : ce qu'il rend, il ne le compose
 * pas. La page garde donc le chargement, l'erreur et `use(params)` ; tout le
 * montage vit ici, où il se monte dans un test sans passer par la résolution
 * d'une promesse de paramètres.
 *
 * **Deux vues sous les mêmes onglets** (spec du 28 août) : Édition, où la
 * sortie 9:16 domine à côté de la source qu'on ajuste, et Exports, la
 * livraison courante. La vue vit dans l'URL (`clip-view.ts`), le geste
 * terminal unique dans la barre d'app — un seul, quelle que soit la vue,
 * puisque l'export et la publication marchent sans changer d'onglet.
 */
export function ClipScreen({ detail }: { detail: ClipDetail }) {
  const { clip, project, lines, proxyUrl, outputs, framing } = detail
  const editor = useEditor()
  const segments = useSegments()
  const canCancel = useCanCancel()
  const canRestore = useCanRestore()
  const patch = usePatchClip()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const view: ClipView = readClipView(searchParams.toString())
  const [mode, setMode] = useState<'preview' | 'export'>('preview')

  // **La liste des candidats, interrogée ici et pas supposée en cache.** Arriver
  // par une URL partagée, un signet ou un rechargement est un parcours que la
  // conception promet de rendre repreneur, et le cache est alors vide. Venant du
  // tri, c'est un succès de cache et cela ne coûte rien.
  const candidates = useCandidates(clip.projectId)

  const publicationAvailability = usePublicationAvailability()
  const publications = usePublications(clip.id)
  const publisher = usePublisher()
  const publicationRecords = Object.fromEntries(
    (publications.data ?? []).map((row) => [
      row.platform,
      {
        status: row.status,
        remoteUrl: row.remoteUrl,
        publishedFingerprint: row.publishedFingerprint,
        error: row.error,
        stale: row.stale,
      },
    ]),
  )
  function launchPublish(targets: readonly { clipId: string; platform: Platform }[], force: boolean) {
    publisher.mutate({ clipId: clip.id, platforms: targets.map((t) => t.platform), force })
  }
  // **La boîte se ferme dès la confirmation** (`confirmLaunch`, `publish-dialog.tsx`),
  // avant que le `POST` ne réponde : un refus de prévalidation — rendu
  // périmé, titre YouTube vide, conflit 409 — disparaissait donc sans aucun
  // retour. `publisher.error` porte ce refus, affiché ici plutôt que dans la
  // boîte qui n'existe déjà plus. (relevé par Codex)
  const publishError = publisher.isError
    ? publisher.error instanceof Error
      ? publisher.error.message
      : 'La publication a échoué.'
    : null

  // Les globaux du hook, en cache et sans coût : `useSettings` sert déjà
  // l'écran des réglages. `resolveHook` les croise avec la surcharge du clip
  // pour l'aperçu (`PreviewOutput`) et pour `HookFields`, qui en a besoin
  // pour distinguer un champ hérité d'un champ surchargé.
  const settings = useSettings()
  const hookGlobals = settings.data?.hook
  const framingGlobals = settings.data?.framing
  const resolvedHook = resolveHook(hookGlobals ?? HOOK_DEFAULTS, clip)
  // `undefined` tant que les réglages n'ont pas répondu : distinct d'un pied
  // de page réellement vide, mais `ExportsView` demande une chaîne définie —
  // le pire cas est une composition sans pied de page pendant le court
  // chargement des réglages, jamais un texte incomplet publié.
  const descriptionFooter = settings.data?.publication?.descriptionFooter ?? ''

  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const [search, setSearch] = useState(false)
  /**
   * Les champs de texte dont l'écriture est restée en échec.
   *
   * Ils ne se déduisent pas de `patch.isError`, qui ne décrit que le dernier
   * appel de l'observateur partagé : une écriture qui aboutit derrière une qui
   * a échoué le remet à faux, et l'export repartirait contre un texte que le
   * serveur n'a pas. (relevé par Codex et par Copilot)
   */
  const [textsInFailure, setTextsInFailure] = useState<string[]>([])
  const flagFailureText = useCallback((field: string, inFailure: boolean) => {
    setTextsInFailure((list) =>
      inFailure
        ? list.includes(field)
          ? list
          : [...list, field]
        : list.filter((other) => other !== field),
    )
  }, [])
  const [help, setHelp] = useState(false)
  /** Le tiroir de montage. Le transcript n'occupe plus la moitié de l'écran. */
  const [drawerOpen, setDrawerOpen] = useState(false)
  // La phrase qui dit pourquoi le rectangle de cadrage ne bouge pas : rendue par
  // le sélecteur de ratio, désignée par le rectangle. Un seul identifiant pour
  // les deux, sans quoi l'un décrirait un paragraphe que l'autre ne rend pas.
  const cropReasonId = useId()

  // Le store se charge du clip une fois, et pas à chaque passage de la requête :
  // la garde est dans `charger`.
  const charger = editor.charger
  useEffect(() => {
    charger(clip)
  }, [charger, clip])

  const { words, lines: linesIndexed } = useMemo(
    () => indexTranscript(lines, segments),
    [lines, segments],
  )

  // Mémoïsé : seule la recherche du carton actif varie au timeupdate (voir `CaptionOverlay`).
  const captionCards = useMemo(() => splitIntoCards(retimeWords(words, segments)), [words, segments])

  // **La remise à zéro d'abord, la publication des mots ensuite — l'ordre de
  // déclaration est l'ordre d'exécution.** Le clip suivant repart d'une position
  // nulle, faute de quoi celle du précédent surlignerait un mot avant même
  // d'avoir lu quoi que ce soit ; mais déclarée après, cette remise à zéro
  // efface les mots qu'on vient de publier, et plus rien ne se surligne jusqu'à
  // la première coupe.
  useEffect(() => {
    usePlayback.getState().reset()
    return () => usePlayback.getState().reset()
  }, [clip.id])

  // Le surlignage se calcule dans `usePlayback`, à partir de ces mots-ci : ils
  // sont réindexés à chaque coupe, et un index gardé tel quel surlignerait un
  // mot au hasard.
  useEffect(() => {
    usePlayback.getState().defineWords(words)
  }, [words])

  const duration = clipDuration(segments)
  const selection = editor.selection

  // Calculée sur le clip **enregistré**, et la règle est dans `@/lib/editing`.
  // La surface, elle, ne s'en sert qu'une fois par clip (voir `key`).
  const firstLine = useMemo(() => lineInitial(lines, clip.segments), [lines, clip.segments])

  const autosave = useAutosave({
    // **Tant que le store n'a pas chargé ce clip, on n'enregistre rien.** Au
    // premier rendu, `segments` vaut `[]` et le cadrage ses valeurs par défaut :
    // comparés au clip du serveur, ils forment une modification — celle qui
    // viderait le clip. `charger` ne s'exécute qu'après ce rendu, donc sans
    // cette garde l'écriture différée part d'un état qui n'est pas le montage,
    // et le Strict Mode de développement la déclenche immédiatement.
    ready: editor.clipId === clip.id,
    reference: clip,
    segments,
    ratio: editor.ratio,
    cropX: editor.cropX,
    // **`mutateAsync` ici aussi**, et pour la raison écrite sur `write` plus
    // bas : cet observateur-ci est celui que les champs de texte et les marques
    // se partagent avec le montage, donc `mutate` aurait laissé la première
    // frappe de titre emporter le sort de l'enregistrement en vol. (issue #55)
    write: patch.mutateAsync,
    reconcile: editor.reconcile,
  })

  // **L'échec d'une écriture directe ne remonte pas par `useAutosave`.**
  // Celui-ci ne compare que les segments, le ratio et le cadrage ; le titre, la
  // description et les marques partent par la même mutation sans y figurer. Sans
  // ce raccord, la barre affiche « enregistré » sur une écriture que le serveur
  // vient de refuser, et son rollback a déjà remis la valeur d'avant à l'écran.
  // (relevé par Copilot)
  const writeInFailure = patch.isError || textsInFailure.length > 0
  const inFailure = autosave === 'failed' || writeInFailure
  const lastRejection = patch.isError ? patch.variables : undefined

  // **Toutes les écritures en vol sur ce clip, et pas seulement la dernière.**
  // `isPending` décrit le dernier appel de l'observateur, que les champs de
  // texte, les marques et l'enregistrement du montage partagent : une écriture
  // récente qui aboutit le remet à faux alors qu'une plus ancienne est encore
  // en vol, et l'export part contre un état que le serveur n'a pas encore.
  // (relevé par Copilot)
  // Ce que la barre sait renvoyer : l'écart de montage que l'écriture différée
  // refuse de rejouer telle quelle, ou la dernière écriture directe refusée.
  const canReturn =
    differences(clip, segments, editor.ratio, editor.cropX) !== null ||
    (lastRejection !== undefined && lastRejection.clipId === clip.id)

  const writesInFlight = useIsMutating({
    predicate: (mutation) =>
      (mutation.state.variables as { clipId?: string } | undefined)?.clipId === clip.id,
  })

  /**
   * Une écriture directe — titre, description, marques.
   *
   * **`mutateAsync`, et pas `mutate`.** Les rappels de `mutate` sont attachés à
   * la dernière mutation de l'observateur, que `usePatchClip` partage entre
   * tous les champs et l'enregistrement du montage : une écriture partie
   * entre-temps efface ceux de la précédente, dont l'appelant n'apprend jamais
   * le sort. La promesse de `mutateAsync`, elle, appartient à la mutation.
   * (relevé par Copilot)
   */
  const write = useCallback(
    (fields: ClipPatch) =>
      patch.mutateAsync({ clipId: clip.id, projectId: clip.projectId, patch: fields }),
    [patch, clip.id, clip.projectId],
  )

  useShortcuts({
    playbackOrPause: () => togglePlayback(video, segments),
    cancel: editor.cancel,
    restore: editor.restore,
    remove: () => editor.removeSelection(words),
    escape: () => (search ? setSearch(false) : editor.clearSelection()),
    // **« Le mot sous le curseur » est le mot sélectionné.** Cliquer un mot le
    // sélectionne, `Entrée` aussi : les deux chemins font coïncider le curseur
    // du clavier et la sélection, et `I`/`O` n'ont donc pas besoin d'un troisième
    // repère.
    poserBound: (edge) => {
      if (selection) editor.poserBound(words, selection.head, edge)
    },
    // **`Ctrl+F` ouvre le tiroir en même temps que la recherche.** Le transcript
    // n'est plus visible en permanence : ouvrir une barre de recherche sur une
    // surface fermée ne chercherait nulle part, et le raccourci passerait pour
    // mort sur l'écran qui l'a inventé.
    find: () => {
      setSearch(true)
      setDrawerOpen(true)
    },
    help: () => setHelp(true),
    aSelection: selection !== null,
  })

  const guards = (candidates.data ?? []).filter((c) => isGuard(c.status))
  const rank = guards.findIndex((c) => c.id === clip.id)
  const previous = rank > 0 ? guards[rank - 1] : null
  const next = clipNext(candidates.data ?? [], clip.id)

  // ---------------------------------------------------------------------
  // Le geste terminal unique : export et publication, quelle que soit la
  // vue active. Monté ici plutôt que dans `ExportsView` — sinon le bouton de
  // la barre d'app ne ferait rien tant que l'onglet Exports n'est pas ouvert.
  // ---------------------------------------------------------------------
  const exporter = useExporter()
  const [confirmation, setConfirmation] = useState(false)
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const state = deriveDeliveryState(clip.status, outputs)
  const native = framing.ratio
  const names = outputNames(clip.id, native)
  // **Trois empêchements, et chacun a sa raison.** Rendre un état non
  // enregistré produirait un fichier qui ne correspond à rien de persistant ;
  // rendre un clip vide ne produirait rien du tout.
  const prevention =
    duration <= 0
      ? 'Tous les mots ont été retirés : il n’y a rien à rendre.'
      : autosave === 'pending'
        ? 'Un enregistrement est en attente. Rendre maintenant produirait un fichier qui ne correspond à rien de persistant.'
        : autosave === 'failed' || writeInFailure
          ? 'Le dernier enregistrement a échoué. Le rendu attend qu’il passe.'
          : writesInFlight > 0
            ? 'Une modification est en cours d’écriture. Le rendu lirait la version d’avant.'
            : null
  const exportDisabled = prevention !== null || exporter.isPending
  const publicationEligibility = clipExportEligibility(state === 'delivered')

  function launch(force: boolean) {
    if (exportDisabled) return
    exporter.mutate({ clipId: clip.id, force })
  }

  function onExport() {
    if (exportDisabled) return
    // « jamais livré » lance directement ; « périmé » confirme toujours
    // l'écrasement — un geste confirmé n'est jamais le primaire (spec du 23
    // août, §3.4).
    if (state === 'stale') setConfirmation(true)
    else launch(false)
  }

  function onPublish() {
    if (exportDisabled || !publicationEligibility.eligible) return
    setPublishDialogOpen(true)
  }

  const publishTarget: PublishClipTarget = {
    clipId: clip.id,
    title: clip.title,
    eligibility: publicationEligibility,
    records: publicationRecords,
    composedDescription: settings.data === undefined
      ? undefined
      : composeDescription(clip, { footer: descriptionFooter }),
  }

  return (
    <>
      <AppBar
        lieu={{
          kind: 'clip',
          project: { id: clip.projectId, title: project.title },
          clip: { title: clip.title },
        }}
      >
        {/* Trois états, dont l'échec : un montage qui n'est pas parti doit se
            voir, sinon on ferme l'onglet en croyant l'avoir enregistré. Et
            « enregistré » n'apparaît qu'une fois le dernier état local
            réellement écrit — pas pendant les 600 ms de temporisation. */}
        <span
          className={cn(
            'text-[0.75rem]',
            inFailure ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {inFailure
            ? 'échec de l’enregistrement'
            : autosave === 'pending' || patch.isPending
              ? 'enregistrement…'
              : 'enregistré'}
        </span>

        {/* **Réessayer, plutôt qu'attendre un nouveau geste.** L'écriture
            différée retient la signature de la tentative ratée et ne la rejoue
            pas telle quelle — sans quoi elle boucle. Ce bouton refait la même
            comparaison et l'envoie, ce qui débloque sans rien inventer. */}
        {/* **Le bouton ne paraît que s'il a quelque chose à renvoyer.** Un
            échec qui ne porte que sur un champ de texte se rattrape à côté du
            champ, où le geste est déjà : un second bouton, inerte, y ferait
            croire à une reprise qui n'a pas lieu. */}
        {inFailure && canReturn && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              // Le montage d'abord — c'est l'écart que l'écriture différée
              // refuse de rejouer telle quelle, sans quoi elle bouclerait. À
              // défaut, la dernière écriture directe : elle n'a pas d'écart à
              // recalculer, seulement une requête à refaire.
              const change = differences(clip, segments, editor.ratio, editor.cropX)
              if (change) {
                void write(change).catch(() => {})
                return
              }
              const rejected = patch.variables
              if (rejected && rejected.clipId === clip.id) void write(rejected.patch).catch(() => {})
            }}
          >
            <RotateCw aria-hidden />
            Réessayer
          </Button>
        )}

        <Button
          size="sm"
          variant="ghost"
          onClick={editor.cancel}
          disabled={!canCancel}
          title="Ctrl+Z"
        >
          <Undo2 aria-hidden />
          Annuler
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={editor.restore}
          disabled={!canRestore}
          title="Ctrl+Shift+Z"
        >
          <Redo2 aria-hidden />
          Rétablir
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => setHelp(true)}
          aria-label="Raccourcis clavier"
        >
          <Keyboard aria-hidden />
        </Button>

        {/* **Les onglets et le geste terminal, dans la barre — spec du 28
            août.** La vue devient un endroit plutôt qu'un pli, et son bouton
            se pose là où sa vue se choisit. Le primaire est le dernier
            élément interactif de la ligne. */}
        <Tabs
          value={view}
          onValueChange={(v) => {
            const query = writeClipView(searchParams.toString(), v as ClipView)
            router.replace(`${pathname}${query}`, { scroll: false })
          }}
        >
          <TabsList variant="line">
            <TabsTrigger value="edition">Édition</TabsTrigger>
            <TabsTrigger value="exports">Exports</TabsTrigger>
          </TabsList>
        </Tabs>

        {exporter.isError && (
          <span className="text-[0.75rem] text-destructive" aria-live="assertive">
            échec de l’export
          </span>
        )}

        <ClipPrimaryAction state={state} onExport={onExport} onPublish={onPublish} disabled={exportDisabled} />
      </AppBar>

      {/* **La boucle, en haut et d'un seul tenant** : la fresque des clips gardés
          à gauche, et à droite ce qu'elle n'exprime pas — l'état de celui qu'on
          monte, son rang, et les deux sauts qui sautent les écartés. */}
      <div className="flex shrink-0 items-center gap-3 border-b pr-4">
        <ClipStrip clips={guards} currentId={clip.id} />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Badge variant="outline" className="shrink-0 text-[0.75rem]">
            {LABELS_STATUS[clip.status]}
          </Badge>
          {rank >= 0 && (
            // Le rang dit qu'on est dans une boucle, pas au bout du monde.
            <span className="text-[0.75rem] text-muted-foreground">
              clip {rank + 1} sur {guards.length} gardés
            </span>
          )}
          {previous ? (
            <Button size="sm" variant="ghost" render={<Link href={linkClip(previous.id)} />}>
              <ChevronLeft aria-hidden />
              Clip précédent
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled>
              <ChevronLeft aria-hidden />
              Clip précédent
            </Button>
          )}
          {next ? (
            <Button size="sm" variant="outline" render={<Link href={linkClip(next.id)} />}>
              Clip suivant
              <ChevronRight aria-hidden />
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled>
              Clip suivant
              <ChevronRight aria-hidden />
            </Button>
          )}
        </div>
      </div>

      {view === 'edition' ? (
        /* **Deux volets, la sortie 9:16 dominante** (spec du 28 août, §1) : à
            gauche l'instrument — la source qu'on ajuste, la fiche qui
            l'accompagne, la bande de temps —, à droite le produit — la
            sortie verticale, dimensionnée sur la hauteur du volet plutôt que
            sur une constante partagée avec la source. Au-dessus du seuil
            `workbench` (largeur **et** hauteur, voir `globals.css`), l'écran
            ne défile plus — `main` devient la rangée fixe des deux volets. En
            dessous, il redevient la colonne qui défile d'avant ce lot. */
        <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 workbench:flex-row workbench:overflow-hidden">
          <section
            aria-labelledby="zone-image"
            // **`container-type: inline-size` ici, pas sur la rangée qu'il
            // borne** — même piège que documenté plus loin dans ce fichier
            // avant ce lot : posé sur la rangée, `cqw` remonte à l'ancêtre
            // suivant plutôt qu'à la section.
            className="flex min-w-0 min-h-0 shrink-0 flex-col gap-3 workbench:min-h-0 workbench:min-w-0 workbench:flex-1 workbench:overflow-y-auto workbench:[container-type:inline-size]"
          >
            <h2 id="zone-image" className="shrink-0 text-sm font-medium">
              Image
            </h2>

            {/* **La source et la fiche éditoriale, côte à côte.** Le hook
                brûle dans l'image : son champ doit rester visible en même
                temps qu'elle. La fiche vise 30 % du volet, bornée entre
                360 et 620 px — au-delà, elle voudrait dire une ligne plus
                large que ce qu'un téléphone affiche jamais. */}
            <div className="flex min-h-0 flex-wrap items-start gap-4 workbench:flex-nowrap workbench:max-h-[58vh]">
              <figure className="flex min-w-0 flex-1 flex-col gap-1.5">
                <figcaption className="shrink-0 truncate text-[0.75rem] text-muted-foreground">
                  la source — le rectangle est le cadre pris pour ce plan
                </figcaption>
                <ClipPlayer
                  proxyUrl={proxyUrl}
                  segments={segments}
                  onVideo={setVideo}
                  frame="h-72 w-auto workbench:h-auto workbench:min-h-0 workbench:w-full workbench:[aspect-ratio:16/9]"
                  overlay={
                    <CropOverlay
                      framing={framing}
                      ratio={editor.ratio}
                      cropX={editor.cropX}
                      onCropX={editor.moveCrop}
                      describedBy={cropReasonId}
                    />
                  }
                />
              </figure>

              <div className="flex min-w-0 shrink-0 flex-col gap-3 workbench:w-[clamp(360px,30cqw,620px)]">
                <FieldsTexts clip={clip} onWrite={write} onFailure={flagFailureText} />
                <HookFields
                  clip={clip}
                  globals={hookGlobals}
                  onWrite={write}
                  onFailure={flagFailureText}
                />
              </div>
            </div>

            <div className="shrink-0">
              <ClipTransport video={video} proxyUrl={proxyUrl} segments={segments} />
            </div>

            <div className="shrink-0">
              <Timeline
                segments={segments}
                framing={framing}
                proxyUrl={proxyUrl}
                sourceDuration={project.durationSec}
                onScrub={(time) => {
                  // **La bande est en temps source, la lecture ne l'est pas.** Une
                  // position tombée dans un passage retiré est légitime à regarder —
                  // c'est tout l'intérêt d'une bande à coupes visibles — mais la
                  // lecture, elle, saute les retraits (`playbackAction`). On confie
                  // donc la position à `placePlayback`, qui la ramène dans le
                  // montage : l'image montrait ce qu'il y a là, la lecture reprend
                  // au segment suivant.
                  placePlayback(video, segments, time)
                }}
                onBoundary={editor.setBoundaryAt}
              />
            </div>

            <div className="shrink-0">
              <RatioPicker
                framing={framing}
                ratio={editor.ratio}
                onRatio={editor.chooseRatio}
                cropReasonId={cropReasonId}
              />
            </div>

            <div className="shrink-0">
              <FramingFields clip={clip} globals={framingGlobals} framing={framing} onWrite={write} />
            </div>

            {duration === 0 && (
              // Le cas prévu côté serveur et qui n'avait pas de rendu propre :
              // tout a été retiré. **Il se dit hors du tiroir**, sinon il faudrait
              // ouvrir le montage pour apprendre qu'il n'y a plus de montage.
              <p className="shrink-0 text-[0.75rem] text-muted-foreground">
                Il ne reste rien du clip. Ouvrir le montage pour le reconstruire : cliquer un mot
                barré le fait recommencer là.
              </p>
            )}

            {/* **Le transcript reste la surface d'édition, il cesse d'être
                toujours visible.** Il occupait la moitié de l'écran pour un geste
                ponctuel, pendant que le geste courant — vérifier, ajuster deux
                textes, exporter — se faisait sur l'autre moitié. Ce n'est pas une
                timeline qui le remplace : la bande plus haut ajoute le geste que
                le texte ne sait pas exprimer, elle ne monte pas les mots. */}
            <div className="shrink-0">
              <TranscriptDrawer
                open={drawerOpen}
                onOpenChange={setDrawerOpen}
                clipId={clip.id}
                lines={linesIndexed}
                words={words}
                firstLine={firstLine}
                duration={duration}
                search={search}
                onSearch={setSearch}
                onPlay={(index) => placePlayback(video, segments, words[index].start)}
              />
            </div>

            <div className="shrink-0">
              <RenderSettings
                clip={clip}
                onBranding={(branding) => void write({ branding }).catch(() => {})}
                onCaptions={(captions) => void write({ captions }).catch(() => {})}
              />
            </div>
          </section>

          <div
            aria-labelledby="zone-sortie"
            // **Le volet qui domine.** Sa largeur se déduit de sa hauteur —
            // `aspect-ratio: 9/16` posé sur la figure elle-même, pas sur cette
            // enveloppe — plutôt que de la partager avec la source (spec §1,
            // qui annule la règle « même hauteur » de `PREVIEW_FRAME`).
            // `items-start` est ce qui laisse la figure se mesurer à sa propre
            // largeur au lieu d'être étirée à celle de l'enveloppe, qu'aucune
            // largeur ne fixe plus ici.
            className="flex shrink-0 flex-col items-start gap-2 workbench:min-h-0"
          >
            <h2 id="zone-sortie" className="sr-only">
              Sortie
            </h2>
            {mode === 'preview' ? (
              <PreviewOutput
                hook={hookGlobals !== undefined ? resolvedHook : undefined}
                video={video}
                framing={framing}
                ratio={editor.ratio}
                cropX={editor.cropX}
                frame="h-72 w-auto workbench:h-auto workbench:min-h-0 workbench:flex-1"
                figureClassName="workbench:min-h-0 workbench:flex-1"
                captionCards={clip.captions ? captionCards : undefined}
                captionStyle={DEFAULT_CAPTION_STYLE}
                segments={segments}
              />
            ) : (
              <figure className="flex min-h-0 flex-col gap-1.5 workbench:flex-1">
                <figcaption className="shrink-0 truncate text-[0.75rem] text-muted-foreground">
                  fichier livré
                </figcaption>
                <video
                  src={outputs.variant9x16Url ?? outputs.mp4Url ?? undefined}
                  controls
                  preload="metadata"
                  className="h-72 w-auto rounded-lg bg-zinc-950 workbench:h-auto workbench:min-h-0 workbench:flex-1"
                />
              </figure>
            )}
            <OutputSwitch delivered={state === 'delivered'} mode={mode} onMode={setMode} />
          </div>
        </main>
      ) : (
        <ExportsView
          clip={clip}
          outputs={outputs}
          framing={framing}
          descriptionFooter={descriptionFooter}
          onReexport={() => setConfirmation(true)}
          reexportDisabled={exportDisabled}
        />
      )}

      <Dialog open={confirmation} onOpenChange={setConfirmation}>
        <DialogContent role="alertdialog">
          <DialogHeader>
            <DialogTitle>Refaire les rendus ?</DialogTitle>
            <DialogDescription>Ces fichiers sont livrés et seront écrasés :</DialogDescription>
          </DialogHeader>
          <ul className="font-mono text-[0.75rem]">
            {[names.mp4, names.variant9x16, names.texts]
              .filter((name): name is string => name !== null)
              .map((name) => (
                <li key={name}>{name}</li>
              ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(false)}>
              Annuler
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmation(false)
                launch(true)
              }}
            >
              Écraser et refaire
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PublishDialog
        open={publishDialogOpen}
        onOpenChange={setPublishDialogOpen}
        clips={[publishTarget]}
        availability={publicationAvailability.data}
        availabilityError={publicationAvailability.isError}
        onRetryAvailability={() => publicationAvailability.refetch()}
        recordsLoading={publications.isPending}
        recordsError={publications.isError}
        onLaunch={launchPublish}
      />

      {/* **Une ligne persistante, jamais un `toast`** (spec publication §6.2) :
          la boîte se ferme dès la confirmation, avant que le `POST` ne
          réponde. */}
      {publishError !== null && (
        <p className="shrink-0 p-2 text-center text-[0.75rem] text-destructive" role="alert">
          La publication a échoué : {publishError}
        </p>
      )}

      <DialogueShortcuts open={help} onOpen={setHelp} />
    </>
  )
}

/**
 * « Réglages du rendu » : les marques et les sous-titres, repliés.
 *
 * **Les deux vivent dans la zone Image**, avec le ratio et le cadrage : ce
 * qu'ils décident est ce que l'image porte. Les marques ont vécu dans le
 * panneau d'export, à portée du bouton qui les consomme — mais la table des
 * zones les range ici, et les garder là-bas laissait l'écran contredire sa
 * propre description. (relevé par Copilot)
 *
 * **Repliés, parce que la valeur par défaut convient à chaque clip** (spec du
 * 23 août, §3.3, point 3) : les deux sont activés à la création, et ne se
 * règlent qu'en exception. Le badge sur le déclencheur compte les cases
 * décochées — le seul écart qui vaille la peine d'être su sans ouvrir le pli
 * — même vocabulaire que « Personnaliser » sur le hook (`hook-fields.tsx`).
 *
 * La phrase sous la case des marques n'est pas décorative : un clip qui
 * incruste refuse de se rendre quand aucune marque n'est exploitable, et
 * cette case est la seule échappatoire — elle n'était atteignable qu'en
 * `curl` avant d'exister.
 */
function RenderSettings({
  clip,
  onBranding,
  onCaptions,
}: {
  clip: Clip
  onBranding: (branding: boolean) => void
  onCaptions: (captions: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const overrideCount = (clip.branding ? 0 : 1) + (clip.captions ? 0 : 1)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={
          <Button type="button" size="sm" variant="ghost" className="w-fit gap-1.5 px-2">
            <ChevronDown
              aria-hidden
              className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
            />
            Réglages du rendu
            {overrideCount > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums">
                {overrideCount}
              </span>
            )}
          </Button>
        }
      />
      <CollapsiblePanel className="flex flex-col gap-2 pt-2">
        <label className="flex items-start gap-2 text-[0.75rem]">
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 accent-stage"
            checked={clip.branding}
            onChange={(e) => onBranding(e.target.checked)}
          />
          <span>
            Incruster les marques
            <span className="block text-muted-foreground">
              Un clip qui les incruste refuse de se rendre quand aucune marque n’est exploitable.
              Décocher est l’échappatoire.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-[0.75rem]">
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 accent-stage"
            checked={clip.captions}
            onChange={(e) => onCaptions(e.target.checked)}
          />
          <span>
            Incruster les sous-titres
            <span className="block text-muted-foreground">
              Décochée, la case laisse un clip sans sous-titres brûlés dans l’image — le texte
              reste dans le `.txt` de publication.
            </span>
          </span>
        </label>
      </CollapsiblePanel>
    </Collapsible>
  )
}
