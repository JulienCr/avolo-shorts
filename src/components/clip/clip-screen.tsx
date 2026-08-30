'use client'

import { ChevronLeft, ChevronRight, Keyboard, RotateCw, Redo2, TriangleAlert, Undo2 } from 'lucide-react'
import { useIsMutating } from '@tanstack/react-query'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { AppBar } from '@/components/navigation/app-bar'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { outputNames } from '@/components/clip/texts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { ApiError, HOOK_DEFAULTS } from '@/lib/api'
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
 * L'écran de clip, **hors de la page** — `src/app/` garde le chargement et
 * `use(params)`, tout le montage vit ici, testable sans promesse à résoudre.
 *
 * **Deux vues sous les mêmes onglets** (spec du 28 août) : Édition, où la
 * sortie 9:16 domine à côté de la source, et Exports, la livraison
 * courante. La vue vit dans l'URL (`clip-view.ts`) ; le geste terminal
 * unique vit dans la barre, un seul quelle que soit la vue.
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

  // La liste des candidats est interrogée ici, pas supposée en cache : une
  // URL partagée ou un rechargement arrivent sur un cache vide, et le tri
  // n'y perd rien puisque c'est déjà un succès de cache pour lui.
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
  // `undefined` tant que les réglages n'ont pas répondu, jamais `''` : sinon
  // `ExportsView` copierait un texte de publication sans son pied de page
  // configuré. (relevé par Codex et par Copilot)
  const descriptionFooter =
    settings.data === undefined ? undefined : (settings.data.publication?.descriptionFooter ?? '')

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

  /**
   * Les écritures directes (marques, sous-titres) restées en échec, avec le
   * patch exact à rejouer. Même raison que `textsInFailure` : `patch.isError`
   * ne décrit que le dernier appel de l'observateur partagé, qu'une écriture
   * suivante réussie efface — la modale se refermait alors sur un échec dont
   * plus rien n'annonçait le sort. (issue #283)
   */
  const [directWritesInFailure, setDirectWritesInFailure] = useState<
    Partial<Record<'branding' | 'captions', ClipPatch>>
  >({})
  const [help, setHelp] = useState(false)
  // La phrase qui dit pourquoi le rectangle de cadrage ne bouge pas : rendue par
  // le sélecteur de ratio, désignée par le rectangle. Un seul identifiant pour
  // les deux, sans quoi l'un décrirait un paragraphe que l'autre ne rend pas.
  const cropReasonId = useId()
  // Même principe pour le transport : ses trois boutons se désactivent quand
  // le montage est vide, et pointent vers le paragraphe qui le dit déjà plus
  // bas — pas un second texte à tenir synchrone avec le premier.
  const emptyClipReasonId = useId()

  // Le store se charge du clip une fois, et pas à chaque passage de la requête :
  // la garde est dans `charger`.
  const charger = editor.charger
  useEffect(() => {
    charger(clip)
  }, [charger, clip])

  // `charger` ne vide pas la sélection à `clipId` égal (`store/editor.ts:113-126`) :
  // revenir sur ce même clip par un lien la laisserait active, atteignable
  // par `Suppr`. (relevé par Copilot)
  const clearSelection = editor.clearSelection
  useEffect(() => {
    clearSelection()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- une fois par montage
  }, [])

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

  // Ce que décrivait le clip au moment du dernier export lancé : compare à
  // `signatureRendered` pour savoir si « rendu terminé » décrit encore ce
  // clip-ci, ou un montage qu'un `PATCH` a déjà écarté depuis.
  const renderFingerprint = JSON.stringify([
    clip.id,
    segments,
    editor.ratio,
    editor.cropX,
    framing,
    clip.branding,
    clip.captions,
    clip.title,
    clip.description,
  ])

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
    // `mutateAsync`, pour la même raison que `write` plus bas : partagé avec
    // les champs de texte, `mutate` laisserait la première frappe de titre
    // emporter le sort de l'enregistrement en vol. (issue #55)
    write: patch.mutateAsync,
    reconcile: editor.reconcile,
  })

  // `useAutosave` ne compare que les segments, le ratio et le cadrage : le
  // titre, la description et les marques partent par la même mutation sans y
  // figurer, d'où les deux raccords ci-dessous. (relevé par Copilot)
  const directFailureCount = Object.keys(directWritesInFailure).length
  const writeInFailure = patch.isError || textsInFailure.length > 0 || directFailureCount > 0
  const inFailure = autosave === 'failed' || writeInFailure
  const lastRejection = patch.isError ? patch.variables : undefined

  // Toutes les écritures en vol, pas la seule dernière : une récente qui
  // aboutit remettrait `isPending` à faux pendant qu'une plus ancienne
  // court encore, et l'export partirait contre un état pas encore reçu.
  const canReturn =
    differences(clip, segments, editor.ratio, editor.cropX) !== null ||
    (lastRejection !== undefined && lastRejection.clipId === clip.id) ||
    directFailureCount > 0

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

  /**
   * Une écriture directe suivie par sa propre marque d'échec — marques et
   * sous-titres. Un jeton par champ, sur le modèle de `usePatchClip` : une
   * réponse tardive d'une écriture dépassée ne doit ni effacer la marque
   * qu'une écriture plus récente vient de poser, ni réparer un échec qu'elle
   * n'a pas causé, **ni se propager à l'appelant** — `RenderSettings` ferme
   * sa modale sur tout rejet, et un rejet périmé la fermerait sur un échec
   * déjà éclipsé. (issue #283, relevé par Aristarque)
   */
  const directWriteSeq = useRef<Partial<Record<'branding' | 'captions', number>>>({})
  const writeDirect = useCallback(
    (field: 'branding' | 'captions', fields: ClipPatch) => {
      const seq = (directWriteSeq.current[field] ?? 0) + 1
      directWriteSeq.current[field] = seq
      return write(fields).then(
        (result) => {
          if (directWriteSeq.current[field] !== seq) return result
          setDirectWritesInFailure((prev) => {
            if (!(field in prev)) return prev
            const rest = { ...prev }
            delete rest[field]
            return rest
          })
          return result
        },
        (error: unknown) => {
          if (directWriteSeq.current[field] !== seq) return undefined
          setDirectWritesInFailure((prev) => ({ ...prev, [field]: fields }))
          throw error
        },
      )
    },
    [write],
  )

  useShortcuts({
    playbackOrPause: () => togglePlayback(video, segments),
    cancel: editor.cancel,
    restore: editor.restore,
    remove: () => editor.removeSelection(words),
    escape: () => (search ? setSearch(false) : editor.clearSelection()),
    // **« Le mot sous le curseur » est le mot sélectionné.** Cliquer ou `Entrée`
    // font coïncider le curseur et la sélection ; `I`/`O` n'ont donc pas besoin
    // d'un troisième repère.
    poserBound: (edge) => {
      if (selection) editor.poserBound(words, selection.head, edge)
    },
    // `Ctrl+F` demande la recherche : le transcript est toujours monté,
    // la barre trouve donc toujours une surface où chercher.
    find: () => setSearch(true),
    help: () => setHelp(true),
    aSelection: selection !== null,
  })

  const guards = (candidates.data ?? []).filter((c) => isGuard(c.status))
  const rank = guards.findIndex((c) => c.id === clip.id)
  const previous = rank > 0 ? guards[rank - 1] : null
  const next = clipNext(candidates.data ?? [], clip.id)

  // Le geste terminal unique vit ici, pas dans `ExportsView` : sinon le
  // bouton de la barre ne ferait rien tant que l'onglet Exports n'est pas
  // ouvert, et le geste doit marcher depuis les deux vues.
  const exporter = useExporter()
  const [confirmation, setConfirmation] = useState(false)
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [signatureRendered, setSignatureRendered] = useState<string | null>(null)
  const state = deriveDeliveryState(clip.status, outputs)
  // Une édition après « Export » peut périmer la livraison sans que `mode`
  // ne bouge, sinon le viseur tente un `<video>` sans `src`. (relevé par
  // Codex et par Copilot)
  const effectiveMode = mode === 'export' && state !== 'delivered' ? 'preview' : mode
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
  const exportSignature = `${clip.id}|${renderFingerprint}`
  // La raison se lit, elle ne se devine pas : ce que le geste terminal fait
  // savoir, un seul état à la fois — bloqué, occupé, ou ce qu'il vient de
  // faire.
  const exportStatus = exporter.isPending
    ? 'Rendu en cours — de dix secondes à une minute.'
    : prevention !== null
      ? prevention
      : exporter.isSuccess && signatureRendered === exportSignature
        ? exporter.data.skipped
          ? 'Rien n’a été refait : les fichiers étaient déjà à jour.'
          : 'Rendu terminé.'
        : null
  const exportStatusId = useId()

  function launch(force: boolean) {
    if (exportDisabled) return
    setSignatureRendered(exportSignature)
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
    composedDescription:
      descriptionFooter === undefined ? undefined : composeDescription(clip, { footer: descriptionFooter }),
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

        {exportStatus !== null && (
          <span id={exportStatusId} className="text-[0.75rem] text-muted-foreground" aria-live="polite">
            {exportStatus}
          </span>
        )}

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
              // Le montage d'abord — l'écriture différée refuse de rejouer
              // son écart tel quel, sans quoi elle bouclerait. Les écritures
              // directes ensuite, qui n'ont pas cet écart à recalculer.
              const change = differences(clip, segments, editor.ratio, editor.cropX)
              if (change) {
                void write(change).catch(() => {})
                return
              }
              // Les écritures directes en échec ensuite : chacune garde son
              // propre patch, contrairement à `patch.variables` qui ne porte
              // que la dernière tentative de l'observateur partagé.
              const directEntries = Object.entries(directWritesInFailure) as [
                'branding' | 'captions',
                ClipPatch,
              ][]
              if (directEntries.length > 0) {
                directEntries.forEach(([field, fields]) => void writeDirect(field, fields).catch(() => {}))
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
            // Quitter Édition démonte `Timeline` directement : une
            // sélection y resterait sinon, atteignable par `Suppr`.
            // (relevé par Copilot)
            if (view === 'edition' && v !== 'edition') {
              editor.clearSelection()
              setSearch(false)
            }
            const query = writeClipView(searchParams.toString(), v as ClipView)
            router.replace(`${pathname}${query}`, { scroll: false })
          }}
        >
          <TabsList variant="line">
            {/* Un seul panneau est monté à la fois (relevé par le
                coordinateur) : `aria-controls` ne pointe que vers celui qui
                l'est vraiment, sinon l'autre référence un id qui n'existe pas
                dans le DOM. */}
            <TabsTrigger
              id="tab-edition"
              value="edition"
              aria-controls={view === 'edition' ? 'panel-edition' : undefined}
            >
              Édition
            </TabsTrigger>
            <TabsTrigger
              id="tab-exports"
              value="exports"
              aria-controls={view === 'exports' ? 'panel-exports' : undefined}
            >
              Exports
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <ClipPrimaryAction
          state={state}
          onExport={onExport}
          onPublish={onPublish}
          disabled={exportDisabled}
          busy={exporter.isPending}
          describedBy={exportStatus !== null ? exportStatusId : undefined}
        />
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
        <main
          id="panel-edition"
          aria-labelledby="tab-edition"
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 workbench:flex-row workbench:overflow-hidden"
        >
          <section
            aria-labelledby="zone-image"
            // **`container-type: inline-size` ici, pas sur la rangée** :
            // posé sur la rangée, `cqw` remonte à l'ancêtre suivant plutôt
            // qu'à la section (mesuré, voir la fiche plus bas).
            className="flex min-w-0 min-h-0 shrink-0 flex-col gap-3 workbench:min-h-0 workbench:min-w-0 workbench:flex-1 workbench:overflow-y-auto workbench:[container-type:inline-size]"
          >
            <h2 id="zone-image" className="shrink-0 text-sm font-medium">
              Image
            </h2>

            {/* `min-h-0` forçait la rangée sous la hauteur de sa figure — débordement
                mesuré sur le transport et la bande (spec §4.2). Retiré, avec
                `max-h-[58vh]` : la section défile au besoin si le total dépasse. */}
            <div role="group" aria-label="Source" className="rounded-lg border p-4">
              <div
                data-slot="source-row"
                className="flex flex-wrap items-start gap-4 workbench:flex-nowrap"
              >
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

              <div className="mt-4 shrink-0">
                <ClipTransport
                  video={video}
                  proxyUrl={proxyUrl}
                  segments={segments}
                  emptyReasonId={emptyClipReasonId}
                />
              </div>
            </div>

            {duration === 0 && (
              // Le cas prévu côté serveur et qui n'avait pas de rendu propre :
              // tout a été retiré. Le transcript, toujours visible, est déjà
              // là pour le dire (spec du 30 août, §2.5).
              <p id={emptyClipReasonId} className="shrink-0 text-[0.75rem] text-muted-foreground">
                Il ne reste rien du clip. Cliquer un mot barré dans le transcript le fait
                recommencer là.
              </p>
            )}

            {/* La bande et le transcript coexistent (spec du 30 août, §2.5) :
                la surface d'édition du clip (spec §13, `CLAUDE.md`) est
                toujours montée, plus derrière un mode ni un tiroir. */}
            <div role="group" aria-label="Montage" className="rounded-lg border p-4">
              <Timeline
                clipId={clip.id}
                segments={segments}
                framing={framing}
                ratio={editor.ratio}
                cropX={editor.cropX}
                proxyUrl={proxyUrl}
                sourceDuration={project.durationSec}
                onScrub={(time) => {
                  // La bande est en temps source, la lecture saute les
                  // retraits : `placePlayback` ramène la position dans le
                  // montage plutôt que de lire un passage retiré.
                  placePlayback(video, segments, time)
                }}
                onBoundary={editor.setBoundaryAt}
                lines={linesIndexed}
                words={words}
                firstLine={firstLine}
                duration={duration}
                search={search}
                onSearch={setSearch}
                onPlay={(index) => placePlayback(video, segments, words[index].start)}
              />
            </div>

            {/* Ratio, montage doublage et rendu : trois déclencheurs de modale
                (`FramingFields`/`RenderSettings` depuis la #281) qui n'ont plus
                besoin de trois blocs empilés (spec §2.3) — une seule rangée. */}
            <div role="region" aria-label="Outils de cadrage" className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <RatioPicker
                framing={framing}
                ratio={editor.ratio}
                onRatio={editor.chooseRatio}
                cropReasonId={cropReasonId}
              />
              <FramingFields clip={clip} globals={framingGlobals} framing={framing} onWrite={write} />
              <RenderSettings
                clip={clip}
                onBranding={(branding) => writeDirect('branding', { branding })}
                onCaptions={(captions) => writeDirect('captions', { captions })}
              />
            </div>
          </section>

          <div
            role="region"
            aria-labelledby="zone-sortie"
            // La dérivation vit ici, sur l'enfant flexible de `<main>` —
            // pas sur une figure nichée : posée trop bas, le volet se
            // mesurait sur son plus large enfant en ligne (214 px, mesuré).
            className="flex shrink-0 flex-col gap-2 workbench:h-full workbench:min-h-0 workbench:[aspect-ratio:9/16]"
          >
            <h2 id="zone-sortie" className="sr-only">
              Sortie
            </h2>
            {effectiveMode === 'preview' ? (
              <PreviewOutput
                hook={hookGlobals !== undefined ? resolvedHook : undefined}
                video={video}
                framing={framing}
                ratio={editor.ratio}
                cropX={editor.cropX}
                // Largeur **et** hauteur explicites, jamais l'une déduite de
                // l'autre ici : le volet est déjà 9:16, le canevas n'a plus
                // qu'à le remplir plutôt que se mesurer lui-même.
                frame="h-72 w-auto workbench:h-full workbench:min-h-0 workbench:w-full"
                figureClassName="workbench:w-full workbench:min-h-0 workbench:flex-1"
                captionCards={clip.captions ? captionCards : undefined}
                captionStyle={DEFAULT_CAPTION_STYLE}
                segments={segments}
              />
            ) : (
              <figure className="flex min-h-0 flex-col gap-1.5 workbench:w-full workbench:flex-1">
                <figcaption className="shrink-0 truncate text-[0.75rem] text-muted-foreground">
                  fichier livré
                </figcaption>
                <video
                  // Même intitulé que les lecteurs d'`ExportsView` (relevé
                  // par Aristarque).
                  aria-label={
                    outputs.variant9x16Url !== null
                      ? 'Variante 9:16'
                      : `Le rendu ${native} de ${clip.title || 'ce clip'}`
                  }
                  src={outputs.variant9x16Url ?? outputs.mp4Url ?? undefined}
                  controls
                  preload="metadata"
                  className="h-72 w-auto rounded-lg bg-zinc-950 workbench:h-full workbench:min-h-0 workbench:w-full"
                />
              </figure>
            )}
            <OutputSwitch delivered={state === 'delivered'} mode={effectiveMode} onMode={setMode} />
          </div>
        </main>
      ) : (
        <ExportsView
          id="panel-exports"
          aria-labelledby="tab-exports"
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

      {/* **Le détail, pas un résumé** : le code et le message du serveur —
          une raison qu'on ne peut pas diagnostiquer ne vaut guère mieux
          qu'un échec silencieux. Hors de la barre, qui n'a pas la place
          d'une alerte ; le geste qui l'a causée y reste visible. */}
      {exporter.isError && (
        <Alert variant="destructive" className="shrink-0 rounded-none border-x-0">
          <TriangleAlert aria-hidden />
          <AlertTitle>
            L’export a échoué
            {exporter.error instanceof ApiError ? ` (${exporter.error.status})` : ''}
          </AlertTitle>
          <AlertDescription>{exporter.error.message}</AlertDescription>
        </Alert>
      )}

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
 * « Réglages du rendu » : les marques et les sous-titres, derrière une
 * modale (spec §6) — le badge compte les cases décochées, seul écart qui
 * vaille d'être su sans l'ouvrir.
 *
 * La phrase sous la case des marques n'est pas décorative : un clip qui
 * incruste refuse de se rendre quand aucune marque n'est exploitable, et
 * cette case est la seule échappatoire.
 */
function RenderSettings({
  clip,
  onBranding,
  onCaptions,
}: {
  clip: Clip
  onBranding: (branding: boolean) => Promise<unknown>
  onCaptions: (captions: boolean) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const overrideCount = (clip.branding ? 0 : 1) + (clip.captions ? 0 : 1)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" size="sm" variant="ghost" className="w-fit gap-1.5 px-2">
            Réglages du rendu
            {overrideCount > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums">
                {overrideCount}
              </span>
            )}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Réglages du rendu</DialogTitle>
        </DialogHeader>
        <label className="flex items-start gap-2 text-[0.75rem]">
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 accent-stage"
            checked={clip.branding}
            // Ferme la modale sur un refus : le bandeau d'échec et
            // « Réessayer » vivent dans l'AppBar, inerte tant qu'elle reste
            // ouverte. (relevé par Copilot)
            onChange={(e) => void onBranding(e.target.checked).catch(() => setOpen(false))}
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
            onChange={(e) => void onCaptions(e.target.checked).catch(() => setOpen(false))}
          />
          <span>
            Incruster les sous-titres
            <span className="block text-muted-foreground">
              Décochée, la case laisse un clip sans sous-titres brûlés dans l’image — le texte
              reste dans le `.txt` de publication.
            </span>
          </span>
        </label>
      </DialogContent>
    </Dialog>
  )
}

