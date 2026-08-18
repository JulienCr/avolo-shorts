'use client'

import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef } from 'react'

import type { ClipWord, IndexedLine } from '@/lib/editing'
import { formatTimecode } from '@/lib/format'
import type { Selection } from '@/store/editor'
import { cn } from '@/lib/utils'

/**
 * La surface d'édition : le transcript.
 *
 * **Pas une timeline.** Spec §13, et c'est le point le plus facile à trahir :
 * ni pistes, ni forme d'onde, ni tête de lecture, ni bande des plans — qui
 * n'existe pas en itération 0, faute de détection de plans. Construire un NLE
 * reviendrait à bâtir le morceau le plus difficile du métier pour un produit qui
 * ne s'en sert pas.
 *
 * Trois gestes, et pas un de plus :
 *
 * 1. sélectionner des mots — au glissé ou au shift-clic — puis les retirer ;
 * 2. cliquer un mot barré pour le remonter ;
 * 3. poser la borne de début ou de fin sur un mot.
 *
 * Virtualisée **par phrase et non par mot** : une émission fait environ 20 000
 * mots, et laisser le navigateur composer les lignes d'une phrase coûte moins
 * que mesurer chaque mot pour les composer soi-même.
 */
export function TranscriptSurface({
  lines,
  words,
  selection,
  ligneInitiale = 0,
  onSelectionner,
  onEtendre,
  onTerminer,
  onRemonter,
}: {
  lines: IndexedLine[]
  words: ClipWord[]
  selection: Selection | null
  /** La phrase à amener sous les yeux à l'ouverture : le début du clip, pas celui du contexte. */
  ligneInitiale?: number
  onSelectionner: (index: number, etendre: boolean) => void
  onEtendre: (index: number) => void
  onTerminer: () => void
  onRemonter: (index: number) => void
}) {
  const conteneur = useRef<HTMLDivElement>(null)

  // Le compilateur React signale ici qu'il renonce à mémoïser ce composant :
  // `useVirtualizer` rend des fonctions dont le résultat change à chaque
  // défilement, et les mémoïser afficherait des lignes périmées. C'est le
  // comportement voulu, pas un défaut à corriger — l'avertissement reste visible
  // exprès, pour que personne ne le fasse taire par un `memo` mal placé.
  const virtualiseur = useVirtualizer({
    count: lines.length,
    getScrollElement: () => conteneur.current,
    // Une phrase moyenne tient sur deux lignes de texte à cette taille. La
    // mesure réelle corrige dès le premier rendu ; cette valeur ne sert qu'à
    // dimensionner la barre de défilement avant.
    estimateSize: () => 78,
    overscan: 6,
  })

  // Un glissé qui se termine hors du texte — sur la marge, hors de la fenêtre —
  // doit quand même refermer la sélection. Sans cet écouteur, le survol
  // continuerait de l'étendre au retour de la souris, bouton relâché.
  useEffect(() => {
    const relacher = () => onTerminer()
    window.addEventListener('pointerup', relacher)
    window.addEventListener('pointercancel', relacher)
    return () => {
      window.removeEventListener('pointerup', relacher)
      window.removeEventListener('pointercancel', relacher)
    }
  }, [onTerminer])

  // Le transcript montre du contexte de part et d'autre du clip : ouvert en
  // haut, on regarderait des phrases qui n'en font pas partie.
  const deplacer = virtualiseur.scrollToIndex
  useEffect(() => {
    if (ligneInitiale > 0) deplacer(ligneInitiale, { align: 'start' })
  }, [deplacer, ligneInitiale])

  const bornes = selection
    ? {
        debut: Math.min(selection.ancre, selection.tete),
        fin: Math.max(selection.ancre, selection.tete),
      }
    : null

  return (
    <div ref={conteneur} className="h-full overflow-y-auto overscroll-contain px-1 py-4">
      <div className="relative w-full" style={{ height: virtualiseur.getTotalSize() }}>
        {virtualiseur.getVirtualItems().map((item) => {
          const ligne = lines[item.index]
          return (
            <div
              key={ligne.id}
              data-index={item.index}
              ref={virtualiseur.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <div className="flex gap-3 px-3 py-1.5">
                {/* La gouttière porte la position dans la source. Ce n'est pas
                    une décoration : c'est le seul repère qui relie ce qu'on lit
                    à l'endroit du replay d'où ça vient. */}
                <span className="w-14 shrink-0 pt-[0.3rem] text-right font-mono text-[0.68rem] text-muted-foreground/60 tabular-nums select-none">
                  {formatTimecode(ligne.start)}
                </span>

                {/* `select-none` : le glissé sert à sélectionner des *mots*, et
                    la sélection de texte du navigateur se superposerait à la
                    nôtre. On perd le copier-coller du transcript, ce que rien
                    dans le produit ne demande. */}
                <p className="flex-1 text-[0.97rem] leading-[1.95] text-pretty select-none">
                  {words.slice(ligne.from, ligne.to).map((mot) => (
                    <Mot
                      key={mot.index}
                      mot={mot}
                      selectionne={
                        bornes !== null && mot.index >= bornes.debut && mot.index <= bornes.fin
                      }
                      onSelectionner={onSelectionner}
                      onEtendre={onEtendre}
                      onRemonter={onRemonter}
                    />
                  ))}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Mot({
  mot,
  selectionne,
  onSelectionner,
  onEtendre,
  onRemonter,
}: {
  mot: ClipWord
  selectionne: boolean
  onSelectionner: (index: number, etendre: boolean) => void
  onEtendre: (index: number) => void
  onRemonter: (index: number) => void
}) {
  // Un clic net sur un mot barré le remonte ; un glissé qui commence dessus le
  // sélectionne comme les autres. C'est le passage du pointeur sur un autre mot
  // entre l'appui et le relâchement qui les sépare — donc on décide au
  // relâchement, pas à l'appui.
  const glisse = useRef(false)

  return (
    <span
      role="button"
      tabIndex={0}
      aria-pressed={selectionne}
      title={mot.kept ? undefined : 'Cliquer pour remonter ce mot'}
      onPointerDown={(e) => {
        glisse.current = false
        onSelectionner(mot.index, e.shiftKey)
      }}
      onPointerEnter={() => {
        glisse.current = true
        onEtendre(mot.index)
      }}
      onPointerUp={() => {
        if (!glisse.current && !mot.kept) onRemonter(mot.index)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        if (mot.kept || e.shiftKey) onSelectionner(mot.index, e.shiftKey)
        else onRemonter(mot.index)
      }}
      className={cn(
        '-mx-0.5 cursor-default rounded-[3px] px-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        mot.kept
          ? 'hover:bg-muted'
          : 'cursor-pointer text-muted-foreground/55 line-through decoration-muted-foreground/45 decoration-[1.5px] hover:text-foreground hover:decoration-transparent',
        selectionne && 'bg-stage/35 text-foreground decoration-foreground/40',
      )}
    >
      {mot.word}{' '}
    </span>
  )
}
