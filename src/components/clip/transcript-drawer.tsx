'use client'

import { ArrowLeftToLine, ArrowRightToLine, Scissors } from 'lucide-react'
import { useCallback } from 'react'

import { gestureOnWordBar } from '@/components/clip/word-gesture'
import { TranscriptSurface } from '@/components/clip/transcript-surface'
import { Button } from '@/components/ui/button'
import { clipBounds, selectionBounds, type ClipWord, type IndexedLine } from '@/lib/editing'
import { formatSpan } from '@/lib/format'
import { useEditor, useSegments } from '@/store/editor'

/**
 * Le transcript, en mode Mots de la bande (spec du 28 août, §4.1) — la
 * surface d'édition du clip (spec §13, `CLAUDE.md`), qui change de viseur
 * plutôt que de visibilité.
 *
 * Rien n'est perdu de son ancien tiroir : chercher, placer la lecture,
 * retirer, poser les bornes, restaurer un mot, suivre la lecture. Annuler et
 * rétablir n'y vivent plus en double : la barre d'app les porte déjà,
 * redevenue atteignable à la souris sans tiroir modal.
 */
export function TranscriptDrawer({
  clipId,
  lines,
  words,
  firstLine,
  duration,
  search,
  onSearch,
  onPlay,
}: {
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
  const editor = useEditor()
  const segments = useSegments()

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
      if (gesture.kind === 'restore') editor.surfaceWord(words, index)
      else editor.poserBound(words, index, gesture.edge)
    },
    [words, segments, editor],
  )

  // La sélection et la recherche ne survivent pas à la sortie du mode Mots
  // (relevé par Aristarque, pour l'ancien tiroir modal) — `Timeline` s'en
  // charge désormais, sur la transition plutôt qu'au démontage. (relevé par Copilot)

  return (
    <div role="group" aria-label="Transcript du clip" className="flex h-56 flex-col rounded-md border">
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
          // sortir. L'écran le dit aussi hors du mode Mots, autrement : ici,
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
      </div>

      {/* **La boîte de défilement du virtualiseur.** `min-h-0` n'est pas un
          détail de mise en page : sans lui, l'élément flexible prend la hauteur
          de son contenu, le conteneur ne défile plus, et `scrollToIndex` — donc
          le suivi de lecture et la navigation de recherche — tombe à côté. */}
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
    </div>
  )
}
