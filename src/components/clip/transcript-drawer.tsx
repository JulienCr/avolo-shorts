'use client'

import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Redo2,
  Scissors,
  Undo2,
} from 'lucide-react'
import { useCallback, useRef } from 'react'

import { gestureOnWordBar } from '@/components/clip/word-gesture'
import { TranscriptSurface } from '@/components/clip/transcript-surface'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { clipBounds, selectionBounds, type ClipWord, type IndexedLine } from '@/lib/editing'
import { formatDuration, formatSpan } from '@/lib/format'
import { useEditor, useCanCancel, useCanRestore, useSegments } from '@/store/editor'

/**
 * Le transcript, **à la demande**.
 *
 * Le geste courant de cet écran est « vérifier le clip, vérifier le cadrage,
 * ajuster deux textes, exporter » ; l'édition fine du montage est ponctuelle.
 * Le transcript occupait pourtant en permanence la moitié de la surface. Il
 * passe donc dans un tiroir — **sans rien perdre** : chercher, placer la
 * lecture, retirer, poser les bornes, restaurer un mot, annuler, rétablir, et le
 * suivi de lecture.
 *
 * **Ce n'est pas une timeline qui le remplace.** Le transcript reste la surface
 * d'édition du clip (spec §13, `CLAUDE.md`) ; il cesse seulement d'être visible
 * en permanence. La distinction n'est pas cosmétique : c'est elle qui empêche la
 * refonte suivante de conclure qu'il y avait la place pour des pistes.
 *
 * Trois contraintes, chacune payée ailleurs et tenues ici :
 *
 * 1. **Un élément de défilement réel.** `TranscriptSurface` virtualise par
 *    `useVirtualizer`, qui mesure la hauteur de son conteneur de défilement. Le
 *    tiroir lui donne donc une boîte à hauteur définie (`min-h-0 flex-1`) et ne
 *    défile pas lui-même — c'est la raison qui fait refuser `scroll-area`
 *    (parcours §6.2), et elle vaut autant pour le contenant.
 * 2. **Le `tabindex` glissant survit** (§4.2) : la surface reste un seul arrêt
 *    de tabulation, et le focus initial du tiroir va sur elle plutôt que sur le
 *    premier bouton — sans quoi `Espace` activerait ce bouton au lieu de lancer
 *    la lecture, et les flèches ne déplaceraient rien.
 * 3. **Le focus revient d'où il est parti** (§4.4). C'est `SheetTrigger` qui le
 *    garantit : le bouton d'ouverture est un déclencheur de la primitive, pas un
 *    bouton qui bascule un booléen à côté.
 */
export function TranscriptDrawer({
  open,
  onOpenChange,
  clipId,
  lines,
  words,
  firstLine,
  duration,
  search,
  onSearch,
  onPlay,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** L'identifiant du clip : le positionnement initial n'a lieu qu'une fois par valeur. */
  clipId: string
  lines: IndexedLine[]
  words: ClipWord[]
  /** La phrase à amener sous les yeux à l'ouverture : le début du clip. */
  firstLine: number
  /** La durée montée, qui change sous les doigts à chaque coupe. */
  duration: number
  search: boolean
  onSearch: (open: boolean) => void
  /** Place la lecture sur ce mot. Le lecteur vit dans l'écran, pas ici. */
  onPlay: (index: number) => void
}) {
  const popup = useRef<HTMLDivElement>(null)
  const editor = useEditor()
  const segments = useSegments()
  const canUndo = useCanCancel()
  const canRedo = useCanRestore()

  const selection = editor.selection
  const selectionSpan = selection
    ? selectionBounds(words, selection.anchor, selection.head)
    : null

  /** Le mot barré cliqué : un trou à combler, ou une borne à déplacer (§7.1). */
  const restore = useCallback(
    (index: number) => {
      const word = words[index]
      if (!word) return
      const gesture = gestureOnWordBar(clipBounds(segments), word)
      if (gesture.kind === 'remonter') editor.surfaceWord(words, index)
      else editor.poserBound(words, index, gesture.edge)
    },
    [words, segments, editor],
  )

  return (
    <Sheet
      open={open}
      onOpenChange={(next, details) => {
        // **`Échap` se dépile, il ne referme pas tout d'un coup.** La barre de
        // recherche et la sélection sont des états *à l'intérieur* du tiroir :
        // les emporter avec lui ferait perdre le montage en cours au geste par
        // lequel on voulait seulement fermer la recherche. La primitive rend la
        // main par `cancel()`, et le gestionnaire de touches de l'écran fait le
        // reste — vider la sélection, fermer la recherche.
        if (!next && details.reason === 'escape-key' && (search || selection !== null)) {
          details.cancel()
          return
        }
        // **La sélection ne survit pas à la fermeture.** Elle vit dans le
        // transcript, qui est derrière cette porte : laissée là, elle rend
        // `Suppr` agissant sur des mots que plus personne ne voit — le tiroir
        // fermé, la touche retire un passage sans que rien ne l'ait montré. La
        // recherche part avec, pour la même raison. (relevé par Aristarque)
        if (!next) {
          editor.clearSelection()
          onSearch(false)
        }
        onOpenChange(next)
      }}
    >
      <SheetTrigger
        render={<Button size="sm" variant="outline" />}
        // Le déclencheur ne bascule pas un booléen : c'est lui que la primitive
        // refocalise à la fermeture (§4.4).
      >
        <Scissors aria-hidden />
        Modifier le montage
      </SheetTrigger>

      <SheetContent
        ref={popup}
        side="right"
        className="w-full sm:max-w-2xl"
        // **Ce modal-ci héberge les raccourcis de l'écran au lieu de les
        // suspendre**, et c'est ce que cet attribut déclare à `wouldSteal`. La
        // règle générale — un modal possède toutes les touches — vise les boîtes
        // qui interrompent le travail : la liste des raccourcis, la confirmation
        // d'écrasement. Ce tiroir est le travail. Sans cette dérogation, `Suppr`,
        // `I`, `O` et `Ctrl+Z` meurent au moment précis où on les presse.
        data-clip-shortcuts
        // **Le focus initial va sur la surface, pas sur le premier bouton.**
        // Sinon `Espace` active ce bouton au lieu de lancer la lecture — le
        // défaut que la garde des raccourcis existe pour éviter — et les flèches
        // ne déplacent aucun mot. `null` rend la main au comportement par
        // défaut, ce qui couvre le cas où la surface n'est pas encore montée.
        initialFocus={() =>
          popup.current?.querySelector<HTMLElement>('[data-surface-transcript]') ?? null
        }
      >
        <SheetHeader>
          <SheetTitle>Montage</SheetTitle>
          <SheetDescription>
            Glisser sur des mots pour les sélectionner · cliquer un mot pour y placer la lecture ·
            cliquer un mot barré pour le remonter
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
          {selection && selectionSpan ? (
            <>
              <span className="text-xs text-muted-foreground">
                <span className="font-mono tabular-nums">
                  {Math.abs(selection.head - selection.anchor) + 1}
                </span>{' '}
                mots ·{' '}
                <span className="font-mono tabular-nums">
                  {formatSpan(selectionSpan.to - selectionSpan.from)}
                </span>
              </span>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => editor.removeSelection(words)}
                title="Suppr"
              >
                <Scissors aria-hidden />
                Retirer
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => editor.poserBound(words, selection.head, 'start')}
                title="I"
              >
                <ArrowLeftToLine aria-hidden />
                Commencer ici
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => editor.poserBound(words, selection.head, 'end')}
                title="O"
              >
                <ArrowRightToLine aria-hidden />
                Terminer ici
              </Button>
            </>
          ) : duration === 0 ? (
            // Le cas prévu côté serveur, et le transcript reste la façon d'en
            // sortir. L'écran le dit aussi hors du tiroir, autrement : ici,
            // c'est le geste qui compte.
            <p className="text-[0.75rem] text-muted-foreground">
              Cliquer un mot barré fait recommencer le clip là.
            </p>
          ) : (
            <p className="text-[0.75rem] text-muted-foreground">
              Sélectionner des mots, puis <span className="font-mono">Suppr</span> ·{' '}
              <span className="font-mono">I</span> et <span className="font-mono">O</span> posent
              les bornes
            </p>
          )}

          {/* **Annuler et rétablir vivent aussi ici.** Le tiroir piège le focus :
              les boutons de la barre d'application deviennent inatteignables à la
              souris pendant qu'on monte, c'est-à-dire au moment exact où l'on
              défait. Les raccourcis, eux, traversent — la garde laisse passer
              `Ctrl+Z` sur ce modal-ci. */}
          <span className="ml-auto flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={editor.cancel}
              disabled={!canUndo}
              title="Ctrl+Z"
              aria-label="Annuler"
            >
              <Undo2 aria-hidden />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={editor.restore}
              disabled={!canRedo}
              title="Ctrl+Shift+Z"
              aria-label="Rétablir"
            >
              <Redo2 aria-hidden />
            </Button>
            <span className="ml-1 flex items-baseline gap-1.5">
              <span className="text-[0.75rem] text-muted-foreground">durée</span>
              <span className="font-mono text-sm font-medium tabular-nums">
                {formatDuration(duration)}
              </span>
            </span>
          </span>
        </div>

        {/* **La boîte de défilement du virtualiseur.** `min-h-0` n'est pas un
            détail de mise en page : sans lui, l'élément flexible prend la hauteur
            de son contenu, le conteneur ne défile plus, et `scrollToIndex` — donc
            le suivi de lecture et la navigation de recherche — tombe à côté.

            **Un avertissement connu, mesuré, et laissé tel quel** : à l'ouverture,
            React signale cinq fois « flushSync was called from inside a lifecycle
            method ». Il vient de `measureElement` de TanStack Virtual, dont les
            rappels de référence mesurent les phrases pendant le commit que la
            primitive déclenche pour ouvrir le tiroir. C'est un message de
            développement, émis par la bibliothèque, et rien n'en souffre — le
            positionnement initial tombe juste, le défilement et la recherche
            marchent. `useVirtualizer` accepte `useFlushSync: false`, qui le fait
            taire ; mesuré, il décale aussi le positionnement d'ouverture de 36 px,
            soit une demi-phrase — donc il coupe en deux la ligne où le clip
            commence, qui est précisément ce que ce positionnement existe pour
            montrer. Le silence ne vaut pas ce prix-là. */}
        <div className="min-h-0 flex-1">
          <TranscriptSurface
            key={clipId}
            lines={lines}
            words={words}
            selection={selection}
            lineInitial={firstLine}
            onSelect={editor.commencerSelection}
            onExtend={editor.extendSelection}
            onFinish={editor.finishSelection}
            onSurface={restore}
            onPlace={onPlay}
            search={search}
            onSearch={onSearch}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
