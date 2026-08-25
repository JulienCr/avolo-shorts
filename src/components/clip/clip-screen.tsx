'use client'

import { ChevronDown, ChevronLeft, ChevronRight, Keyboard, RotateCw, Redo2, Undo2 } from 'lucide-react'
import { useIsMutating } from '@tanstack/react-query'
import Link from 'next/link'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'

import { AppBar } from '@/components/navigation/app-bar'
import { HookFields } from '@/components/clip/hook-fields'
import { PreviewOutput } from '@/components/clip/output-preview'
import { FieldsTexts } from '@/components/clip/text-fields'
import { ClipPlayer, ClipTransport, togglePlayback, placePlayback } from '@/components/clip/clip-player'
import { ClipStrip } from '@/components/clip/clip-strip'
import { CropOverlay, RatioPicker } from '@/components/clip/crop-picker'
import { usePlayback } from '@/components/clip/playback'
import { PanelExport } from '@/components/clip/export-panel'
import { DialogueShortcuts, useShortcuts } from '@/components/clip/shortcuts'
import { Timeline } from '@/components/clip/timeline'
import { TranscriptDrawer } from '@/components/clip/transcript-drawer'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { isComputedFraming, effectiveRatio, useCurrentShot } from '@/components/clip/framing'
import { DEFAULT_CAPTION_STYLE } from '@/core/captions/ass'
import { splitIntoCards } from '@/core/captions/cards'
import { retimeWords } from '@/core/captions/retime'
import { clipDuration } from '@/core/edl'
import { resolveHook } from '@/core/hook'
import { isGuard } from '@/core/phase'
import type { Clip, ClipDetail, ClipPatch } from '@/lib/api'
import { HOOK_DEFAULTS } from '@/lib/api'
import { LABELS_STATUS } from '@/lib/clip-status'
import { clampCropX, cropWidthFraction } from '@/lib/crop-preview'
import { clipBounds, indexTranscript, lineInitial } from '@/lib/editing'
import { differences, useAutosave } from '@/lib/autosave'
import { formatDuration, formatTimecode } from '@/lib/format'
import { clipNext, linkClip } from '@/lib/navigation'
import {
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
 * La hauteur commune des deux aperçus.
 *
 * **Le nombre importe moins que l'unicité de sa source.** Les deux vues doivent
 * avoir exactement la même hauteur visuelle : la donner ici, une fois, et
 * laisser chacune en déduire sa largeur est ce qui empêche la prochaine
 * retouche de réintroduire un `max-w-40` d'un côté et une largeur libre de
 * l'autre.
 *
 * **Elle vient du volet, pas d'une constante — depuis l'établi (spec du 23
 * août, §3.3).** `h-72` reste le repli en dessous du seuil `workbench` (fenêtre
 * trop étroite ou trop basse, §7) : l'écran défile alors comme avant ce lot, et
 * une hauteur fixe y vaut ce qu'elle valait. Au-dessus du seuil, `flex-1` fait
 * des deux aperçus des **frères qui s'étirent sur la même rangée** — une
 * garantie plus forte qu'une constante partagée, parce qu'aucune retouche
 * future ne peut donner une largeur à l'un et une hauteur à l'autre sans
 * casser la rangée elle-même, visiblement. **Aucun `max-width` n'entre dans ce
 * calcul** : c'est la condition de recette du lot (mesuré : un `max-width` à
 * côté d'un `aspect-ratio` fait recalculer la hauteur depuis la largeur
 * clampée, et la boîte 16:9 retombait à 202 px là où on lui en demandait 272).
 */
const PREVIEW_FRAME = cn('h-72 w-auto', 'workbench:h-auto workbench:min-h-0 workbench:flex-1')

/**
 * L'écran de clip, **hors de la page**.
 *
 * Un fichier de `src/app/` porte une route : ce qu'il rend, il ne le compose
 * pas. La page garde donc le chargement, l'erreur et `use(params)` ; tout le
 * montage vit ici, où il se monte dans un test sans passer par la résolution
 * d'une promesse de paramètres.
 *
 * La surface d'édition est le transcript (spec §13), et **c'est aussi l'organe
 * de navigation temporelle** : cliquer un mot y place la lecture, la lecture y
 * surligne le mot en cours. Ce que cet écran ajoute autour : le lecteur qui
 * saute les passages retirés, l'aperçu de ce que le ratio produira, les deux
 * textes qui se publient, et l'export — qui vit ici, pas ailleurs, parce que
 * c'est par clip qu'on choisit le cadre.
 */
export function ClipScreen({ detail }: { detail: ClipDetail }) {
  const { clip, project, lines, proxyUrl, outputs, framing } = detail
  const editor = useEditor()
  const segments = useSegments()
  const canCancel = useCanCancel()
  const canRestore = useCanRestore()
  const patch = usePatchClip()

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
  const resolvedHook = resolveHook(hookGlobals ?? HOOK_DEFAULTS, clip)

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

  const bounds = clipBounds(segments)
  const duration = clipDuration(segments)

  // Tout ce qui décide du rendu. Le panneau d'export s'en sert pour dater son
  // annonce de résultat : une coupe de même durée, un cadrage déplacé ou les
  // marques basculées périment les fichiers sans changer la durée.
  // **Le cadrage résolu y entre, et pas seulement le ratio demandé.** Le cadre
  // se recalcule sur les segments : une coupe peut le changer sans que
  // `editeur.ratio` ni `editeur.cropX` ne bougent, et « rendu terminé »
  // continuerait de décrire des fichiers que le `PATCH` vient d'écarter.
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
  const inFailure = autosave === 'failed' || patch.isError || textsInFailure.length > 0
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

      {/* **L'établi, deux volets sous la fresque** (spec du 23 août, §3.3) : à
          gauche la scène — choisir l'extrait —, à droite la fiche — dire ce
          qu'il dira. C'est la diagonale du regard : l'œil entre en haut à
          gauche, en sort en bas à droite, et le rail qui suit `<main>` pose le
          geste terminal à cette sortie-là. Au-dessus du seuil `workbench`
          (largeur **et** hauteur, voir `globals.css`), l'écran ne défile plus
          — `main` devient la rangée fixe des deux volets. En dessous, il
          redevient la colonne qui défile d'avant ce lot : la largeur seule ne
          suffit pas à garantir que les aperçus restent lisibles. */}
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto workbench:flex-row workbench:overflow-hidden">
        <section
          aria-labelledby="zone-image"
          // **`container-type: inline-size` ici, pas sur la rangée qu'il
          // borne.** Un conteneur de requête ne se mesure pas lui-même — posé
          // sur la rangée, `cqw` remontait à l'ancêtre suivant (donc à la
          // largeur de la fenêtre, pas du volet) et le plafond calculé
          // valait le double de ce qu'il fallait. Mesuré : 430,7 px au lieu
          // des 211,5 attendus à 1024 px de large.
          //
          // **`shrink-0` en dehors de l'établi, `min-h-0` seulement dedans.**
          // Sous le seuil, `main` redevient une colonne qui défile
          // (`overflow-y-auto`) plutôt qu'une rangée fixe : sans `shrink-0`,
          // le volet pouvait se faire comprimer par l'algorithme flex avant
          // même que le défilement n'entre en jeu, et son propre contenu
          // débordait alors *par-dessus* le volet suivant plutôt que de
          // pousser la page vers le bas. Mesuré, à 1416×800 : le titre du
          // volet Contenu se peignait au milieu du transport du volet Image.
          className="flex min-w-0 shrink-0 flex-col gap-3 border-b p-4 workbench:min-h-0 workbench:flex-1 workbench:overflow-hidden workbench:border-r workbench:border-b-0 workbench:[container-type:inline-size]"
        >
          <h2 id="zone-image" className="shrink-0 text-sm font-medium">
            Image
          </h2>

          {/* **Deux images, deux outils, et la même hauteur.** À gauche la source
              avec le rectangle : on cadre en regardant ce qu'on laisse dehors. À
              droite le canevas de sortie, à l'échelle du téléphone : c'est là
              qu'un 16:9 se voit occuper le tiers de la hauteur et un 4:5 les sept
              dixièmes. `PREVIEW_FRAME` est l'unique source des deux — voir sa
              note en tête de fichier.

              **`max-h` en `cqw`, mesuré, pas deviné.** À 1024 px de large —
              le plancher `workbench` — une fenêtre haute et étroite (par
              exemple 1024×1318) donne au volet gauche plus de hauteur que sa
              largeur ne peut en accueillir côte à côte sans repli à la ligne
              (`workbench:flex-nowrap`) : les deux boîtes, dérivant leur
              largeur de la hauteur disponible, débordaient alors du volet —
              mesuré, `document.documentElement.scrollWidth` dépassait
              `innerWidth` de 212 px. Le plafond ici n'est **pas** un
              `max-width` posé à côté d'un `aspect-ratio` sur les boîtes
              elles-mêmes — c'est la faute que le lot ne doit pas réintroduire
              — mais un plafond sur la **rangée**, en unités de conteneur
              (`container-type: inline-size` sur elle, comme `PreviewOutput`
              le fait déjà pour son propre calque). `2,3403` est la somme des
              deux rapports fixes que les boîtes portent toujours, 16:9 et
              9:16 (`RATIOS`), jamais celui du plan en cours. */}
          <div className="flex flex-1 flex-wrap items-stretch gap-4 workbench:min-h-0 workbench:flex-nowrap workbench:max-h-[calc((100cqw-1rem)/2.3403)]">
            {/* **La largeur de chaque figure se pose, elle ne se déduit plus —
                mais seulement dans l'établi.** Mesuré : laissée à
                `flex-basis: auto` (le défaut), la largeur d'une figure
                dépendait de la longueur de sa légende — 420 px de figure pour
                une boîte 16:9 qui n'en demandait que 333 — et le calcul
                intrinsèque d'une boîte à `aspect-ratio` imbriquée dans un
                enfant `flex-1` (la hauteur du cadre) se résout à une valeur
                indéterminée pendant cette même passe : la boîte de sortie
                débordait alors de sa figure de 30,7 px, rognée par
                `overflow-hidden` du volet. Les deux rapports sont **fixes**
                (16:9 pour la source, 9:16 pour le cadre du téléphone — jamais
                celui du plan en cours, qui ne change que le canevas *dans* ce
                cadre) : leur donner ces poids en `flex-grow`/`flex-shrink`
                répartit la rangée d'après eux plutôt que d'après le texte de
                la légende, qui tronque désormais au lieu de peser sur la
                mise en page. **`workbench:` seulement** : sous le seuil, les
                deux boîtes reviennent à leur `h-72` fixe et `flex-wrap`
                reprend la main — un poids `flex` sans base sur les deux les
                aurait fait chevaucher et déborder plutôt que passer à la
                ligne. (relevé par Codex, les deux fois) */}
            <figure className="flex min-w-0 flex-col gap-1.5 workbench:basis-0 workbench:grow-[calc(16/9)] workbench:shrink-[calc(16/9)]">
              <figcaption className="shrink-0 truncate text-[0.75rem] text-muted-foreground">
                la source — le rectangle est le cadre pris pour ce plan
              </figcaption>
              <ClipPlayer
                proxyUrl={proxyUrl}
                segments={segments}
                onVideo={setVideo}
                frame={PREVIEW_FRAME}
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
            <PreviewOutput
              hook={hookGlobals !== undefined ? resolvedHook : undefined}
              video={video}
              framing={framing}
              ratio={editor.ratio}
              cropX={editor.cropX}
              frame={PREVIEW_FRAME}
              figureClassName="workbench:basis-0 workbench:grow-[calc(9/16)] workbench:shrink-[calc(9/16)]"
              captionCards={clip.captions ? captionCards : undefined}
              captionStyle={DEFAULT_CAPTION_STYLE}
              segments={segments}
            />
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

          {/* **Les faits de montage rejoignent la scène** (spec du 23 août,
              §3.3) : « Montage » cessait d'être une zone, ses trois faits et
              son déclencheur montent ici, à côté du cadre qu'ils décrivent
              tous les quatre. Une `h2` de moins sur l'écran entier. */}
          <dl className="shrink-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.75rem]">
            <dt className="text-muted-foreground">Durée</dt>
            <dd className="font-mono tabular-nums">{formatDuration(duration)}</dd>

            <dt className="text-muted-foreground">Bornes</dt>
            {/* Relues dans la liste rendue, jamais la valeur demandée :
                `moveBoundary` pose la borne sur le segment voisin quand la
                demande tombe dans un trou. */}
            <dd className="font-mono tabular-nums">
              {bounds ? `${formatTimecode(bounds.start)} → ${formatTimecode(bounds.end)}` : '—'}
            </dd>

            <dt className="text-muted-foreground">Segments</dt>
            <dd className="font-mono tabular-nums">{segments.length}</dd>

            {/* **« (variante) », et non « Cadre » seul.** Cette ligne lit
                `shot.cropX`, jamais `cropXNative` : elle décrit la variante
                9:16, pas le natif, qui garde son propre crop plus haut dans
                l'écran. Sans le mot, rien ne distingue les deux (addendum #178). */}
            <dt className="text-muted-foreground">Cadre (variante)</dt>
            {/* Ce que le rendu découpera sur le plan qu'on regarde : le cadre
                saute aux frontières, donc une seule valeur pour tout le clip ne
                voudrait rien dire. La valeur est ramenée dans l'image, comme le
                rectangle la dessine — pas la valeur brute du store, qui garde
                l'intention quand on passe par un ratio où elle ne tient pas. */}
            <ShotFrameLine framing={framing} ratio={editor.ratio} cropX={editor.cropX} />
          </dl>

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

        <section
          aria-labelledby="zone-contenu"
          // Même raccord que la zone Image : `shrink-0` hors de l'établi,
          // `min-h-0` seulement dedans (où c'est `workbench:overflow-y-auto`
          // qui reprend le défilement, local au volet plutôt qu'à la page).
          className="flex min-w-0 shrink-0 flex-col gap-3 p-4 workbench:min-h-0 workbench:w-[30rem] workbench:overflow-y-auto"
        >
          <h2 id="zone-contenu" className="shrink-0 text-sm font-medium">
            Contenu
          </h2>
          {/* Le titre, la description et le hook : des livrables du produit,
              pas des étiquettes de la page. */}
          <FieldsTexts clip={clip} onWrite={write} onFailure={flagFailureText} />
          <HookFields
            clip={clip}
            globals={hookGlobals}
            onWrite={write}
            onFailure={flagFailureText}
          />
        </section>
      </main>

      {/* **Le rail : quatrième frère flexible, jamais `sticky` ni `fixed`**
          (spec du 23 août, §3.3). La barre d'application est le seul
          `sticky` du dépôt (`app-bar.tsx`) et ce lot n'en ajoute pas un
          second. `PanelExport` porte à la fois le pli « Détail » et le rail
          lui-même — un seul `shrink-0`, le pli au-dessus, le rail en
          dessous. */}
      <PanelExport
        clip={clip}
        outputs={outputs}
        framing={framing}
        duration={duration}
        autosave={autosave}
        fingerprint={renderFingerprint}
        // `enregistrement` ne suit que le montage : le titre, la description
        // et les marques passent par la même mutation sans y figurer.
        writeInCurrent={writesInFlight > 0}
        writeInFailure={patch.isError || textsInFailure.length > 0}
        publicationAvailability={publicationAvailability.data}
        publicationRecords={publicationRecords}
        recordsLoading={publications.isPending}
        publishError={publishError}
        onPublish={launchPublish}
      />

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

/**
 * Le cadre du plan sous la lecture, en toutes lettres.
 *
 * **Un composant à part, et c'est la raison qui compte** : il s'abonne à la
 * position de lecture, qui change quatre fois par seconde. Lu dans `ClipScreen`,
 * il ferait rendre le transcript virtualisé et le lecteur à cette cadence. Ici,
 * le sélecteur ne rend qu'un index de plan, donc rien ne bouge entre deux
 * frontières.
 */
function ShotFrameLine({
  framing,
  ratio,
  cropX,
}: {
  framing: ClipDetail['framing']
  ratio: Clip['ratio']
  cropX: number
}) {
  const shot = useCurrentShot(framing)
  const effective = effectiveRatio(shot, ratio)
  const position = isComputedFraming(framing) ? (shot?.cropX ?? 0.5) : cropX
  const percent = Math.round(clampCropX(position, cropWidthFraction(effective)) * 100)
  // Un plan splitté n'a pas de position de crop unique : le pourcentage ne
  // décrirait rien (spec du 25 août, addendum #178).
  const split = shot?.split !== undefined
  return (
    <dd className="font-mono tabular-nums">
      {split ? 'split' : `${effective} · ${percent} %`}
      {shot?.source === 'default' && (
        <span className="ml-1 font-sans text-amber-500 dark:text-amber-400">
          rien mesuré sur ce plan
        </span>
      )}
    </dd>
  )
}
