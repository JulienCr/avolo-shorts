'use client'

import { useVirtualizer } from '@tanstack/react-virtual'
import { Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { usePlayback } from '@/components/clip/playback'
import { find } from '@/components/clip/search'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
 * **Et c'est aussi l'organe de navigation temporelle**, ce qui ne contredit pas
 * la phrase précédente mais la renforce : cliquer un mot place la lecture, la
 * lecture surligne le mot en cours, et plus rien ne réclame de tête de lecture
 * puisque la position se lit dans le texte.
 *
 * Cinq gestes :
 *
 * 1. sélectionner des mots — au glissé ou au shift-clic — puis les retirer ;
 * 2. cliquer un mot barré pour le remonter, ou déplacer une borne s'il est
 *    dehors (§7.1, la décision est dans `geste-mot.ts`) ;
 * 3. poser la borne de début ou de fin sur un mot ;
 * 4. cliquer un mot gardé pour y placer la lecture ;
 * 5. chercher, parce que le `Ctrl+F` du navigateur ne voit que ce qui est rendu.
 *
 * Virtualisée **par phrase et non par mot** : une émission fait environ 20 000
 * mots, et laisser le navigateur composer les lignes d'une phrase coûte moins
 * que mesurer chaque mot pour les composer soi-même.
 *
 * **Son conteneur de défilement reste un élément réel, et la primitive
 * `scroll-area` est refusée pour ça.** Le virtualiseur mesure la hauteur de cet
 * élément et y pose ses positions ; une zone de défilement stylée interposerait
 * son propre conteneur, et le `scrollToIndex` du positionnement initial
 * retomberait à côté — sur la seule ligne qui compte, celle où le clip commence.
 */
export function TranscriptSurface({
  key,
  lines,
  words,
  selection,
  lineInitial = 0,
  onSelect,
  onExtend,
  onFinish,
  onSurface,
  onPlace,
  search = false,
  onSearch,
}: {
  /** Identifie le clip ouvert. Le positionnement initial n'a lieu qu'une fois par valeur. */
  key: string
  lines: IndexedLine[]
  words: ClipWord[]
  selection: Selection | null
  /** La phrase à amener sous les yeux à l'ouverture : le début du clip, pas celui du contexte. */
  lineInitial?: number
  onSelect: (index: number, extend: boolean) => void
  onExtend: (index: number) => void
  onFinish: () => void
  onSurface: (index: number) => void
  /** Place la lecture sur ce mot. Un clic net sur un mot gardé, rien d'autre. */
  onPlace: (index: number) => void
  search?: boolean
  onSearch: (open: boolean) => void
}) {
  const container = useRef<HTMLDivElement>(null)

  // Le compilateur React signale ici qu'il renonce à mémoïser ce composant :
  // `useVirtualizer` rend des fonctions dont le résultat change à chaque
  // défilement, et les mémoïser afficherait des lignes périmées. C'est le
  // comportement voulu, pas un défaut à corriger — mais un `eslint` bruyant sur
  // un avertissement volontaire noie le prochain, lui accidentel : rendu muet
  // ci-dessous, la raison reste ici plutôt que dupliquée en ligne (issue #56).
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => container.current,
    // Une phrase moyenne tient sur deux lignes de texte à cette taille. La
    // mesure réelle corrige dès le premier rendu ; cette valeur ne sert qu'à
    // dimensionner la barre de défilement avant.
    estimateSize: () => 78,
    overscan: 6,
  })

  /**
   * **Le mot du clavier, et il n'est pas celui de la lecture.** Un seul arrêt de
   * tabulation pour toute la surface ; à l'intérieur, les flèches déplacent ce
   * curseur et `Tab` sort. Chaque mot était un arrêt, ce qui demandait une
   * centaine de `Tab` pour traverser le transcript — et le nombre dépendait de
   * ce que le virtualiseur avait rendu, donc de la position de défilement.
   *
   * **Son index vit ici, pas dans le DOM** : le mot actif peut sortir du champ
   * rendu, et un `document.activeElement` ne survit pas à son démontage.
   */
  const [cursor, setCursor] = useState(0)

  /** Le défilement suit-il encore la lecture ? */
  const [tracked, setTracked] = useState(true)

  const [request, setRequest] = useState('')
  const [rank, setRank] = useState(0)
  const results = useMemo(() => find(words, request), [words, request])

  // Vrai le temps d'un défilement que **nous** avons demandé. Le navigateur
  // émet un `scroll` dans les deux cas et rien ne les distingue autrement ; le
  // drapeau retombe à l'image suivante, que la spécification place après les
  // événements de défilement.
  const auto = useRef(false)
  const move = virtualizer.scrollToIndex
  const scrollToward = useCallback(
    (line: number, align: 'start' | 'center' = 'center') => {
      if (line < 0) return
      auto.current = true
      move(line, { align })
      requestAnimationFrame(() => {
        auto.current = false
      })
    },
    [move],
  )

  // Un glissé qui se termine hors du texte — sur la marge, hors de la fenêtre —
  // doit quand même refermer la sélection. Sans cet écouteur, le survol
  // continuerait de l'étendre au retour de la souris, bouton relâché.
  useEffect(() => {
    const release = () => onFinish()
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [onFinish])

  // Le transcript montre du contexte de part et d'autre du clip : ouvert en
  // haut, on regarderait des phrases qui n'en font pas partie.
  //
  // **Sur une image, pas dans l'effet.** `scrollToIndex` déclenche un
  // `flushSync` à l'intérieur du virtualiseur ; appelé depuis un effet, React
  // avertit qu'il ne peut pas vider sa file pendant qu'il rend, et le
  // positionnement se fait alors sur des hauteurs pas encore mesurées. Une
  // image plus tard, les lignes sont mesurées et le défilement tombe juste.
  //
  // **Une fois par clip, et pas une de plus.** `lineInitial` se recalcule
  // quand le clip enregistré change ; repositionner à chaque fois ferait fuir
  // le texte sous les yeux pendant qu'on monte. Le repère est donc `key`, pas
  // la valeur.
  //
  // Le repère se pose **quand le défilement a eu lieu**, pas quand il est
  // programmé. `move` vient du virtualiseur et rien ne garantit sa
  // stabilité d'un rendu à l'autre : si l'effet se rejoue avant l'image, son
  // nettoyage annule la précédente, et un repère posé trop tôt court-circuiterait
  // la nouvelle. Le défilement initial n'aurait alors jamais lieu.
  const positioned = useRef<string | null>(null)
  useEffect(() => {
    if (positioned.current === key) return
    if (lineInitial <= 0) {
      positioned.current = key
      return
    }
    const image = requestAnimationFrame(() => {
      positioned.current = key
      scrollToward(lineInitial, 'start')
    })
    return () => cancelAnimationFrame(image)
  }, [key, scrollToward, lineInitial])

  // **Le suivi de lecture, par abonnement et non par état de rendu.** La
  // position change quatre fois par seconde : la lire dans le rendu ferait
  // reconstruire le virtualiseur à cette cadence. On ne réagit ici qu'au
  // changement de *mot*, et sans rendre quoi que ce soit.
  // Écrites depuis un effet et non pendant le rendu : une référence mise à jour
  // en plein rendu est un effet de bord que le compilateur React refuse, et pour
  // une bonne raison — un rendu abandonné laisserait la référence en avance sur
  // ce qui est affiché.
  const linesRef = useRef(lines)
  const trackedRef = useRef(tracked)
  const scrollRef = useRef(scrollToward)
  useEffect(() => {
    linesRef.current = lines
    trackedRef.current = tracked
    scrollRef.current = scrollToward
  }, [lines, tracked, scrollToward])
  useEffect(
    () =>
      usePlayback.subscribe((state, previous) => {
        if (state.wordActive === null || state.wordActive === previous.wordActive) return
        if (!trackedRef.current) return
        scrollRef.current(wordLine(linesRef.current, state.wordActive))
      }),
    [],
  )

  const items = virtualizer.getVirtualItems()
  const lineCursor = wordLine(lines, cursor)
  const cursorRender = items.some((item) => item.index === lineCursor)

  // Le focus suit le curseur, une fois le mot rendu. Quand il ne l'est pas — le
  // virtualiseur ne garde qu'une trentaine de phrases —, le conteneur le prend :
  // sans cela, un déplacement au clavier vers le bas du transcript perdrait le
  // focus sur le corps du document, et la frappe suivante ne ferait plus rien.
  const toFocus = useRef(false)
  useEffect(() => {
    if (!toFocus.current) return
    toFocus.current = false
    const target = container.current?.querySelector<HTMLElement>(`[data-mot="${cursor}"]`)
    if (target) target.focus()
    else container.current?.focus()
  })

  const goWord = useCallback(
    (index: number) => {
      const bound = Math.min(Math.max(index, 0), Math.max(0, words.length - 1))
      setCursor(bound)
      // **Le curseur du clavier *est* la sélection.** Sans cela, `I` et `O`
      // posent la borne sur le mot cliqué il y a trois gestes, puisque l'écran
      // lit `selection.tete` — et rien ne le dit. `onFinish` referme le
      // glissé que `commencerSelection` ouvre : un survol à la souris étendrait
      // sinon la sélection sans qu'on ait rien pressé. (relevé par Copilot)
      onSelect(bound, false)
      onFinish()
      toFocus.current = true
      // **Naviguer coupe le suivi**, que ce soit à la flèche ou par la
      // recherche : aller voir ailleurs pendant que la lecture continue ferait
      // ramener le texte sous les yeux au moment où on lit l'occurrence.
      setTracked(false)
      // **Sans ce défilement, la flèche paraît sans effet** : le mot suivant
      // peut être hors du champ rendu, donc absent du DOM.
      scrollToward(wordLine(lines, bound))
    },
    [words.length, lines, scrollToward, onSelect, onFinish],
  )

  function onKeyboard(e: React.KeyboardEvent) {
    const line = wordLine(lines, cursor)
    if (e.key === 'ArrowRight') goWord(cursor + 1)
    else if (e.key === 'ArrowLeft') goWord(cursor - 1)
    else if (e.key === 'ArrowDown') goWord(lines[line + 1]?.from ?? words.length - 1)
    else if (e.key === 'ArrowUp') goWord(lines[line - 1]?.from ?? 0)
    else if (e.key === 'Home') goWord(0)
    else if (e.key === 'End') goWord(words.length - 1)
    else return
    e.preventDefault()
  }

  function goResult(next: number) {
    if (results.length === 0) return
    const target = (next + results.length) % results.length
    setRank(target)
    goWord(results[target])
  }

  const bounds = selection
    ? {
        debut: Math.min(selection.anchor, selection.head),
        fin: Math.max(selection.anchor, selection.head),
      }
    : null

  return (
    <div className="flex h-full flex-col">
      {search && (
        <SearchBar
          request={request}
          results={results.length}
          rank={rank}
          onRequest={(value) => {
            setRequest(value)
            setRank(0)
            const found = find(words, value)
            if (found.length > 0) goWord(found[0])
          }}
          onNext={(not) => goResult(rank + not)}
          onClose={() => onSearch(false)}
        />
      )}

      <div
        ref={container}
        data-surface-transcript
        // Le conteneur ne prend le focus que lorsque le mot du curseur n'est pas
        // rendu : sinon la surface aurait deux arrêts de tabulation au lieu d'un.
        tabIndex={cursorRender ? -1 : 0}
        onKeyDown={onKeyboard}
        // **La molette, en plus du défilement.** `scroll` ne part que si
        // `scrollTop` bouge : une molette en butée haute ou basse n'émet rien,
        // et le suivi restait actif alors que l'utilisateur venait de dire le
        // contraire. (relevé par Copilot)
        onWheel={() => {
          if (tracked) setTracked(false)
        }}
        onScroll={() => {
          // `auto` retombe à l'image suivante, que la spécification place après
          // les événements de défilement : ce qui arrive ici avec le drapeau
          // levé vient donc de nous, pas de l'utilisateur.
          if (auto.current) return
          if (tracked) setTracked(false)
        }}
        className="h-full flex-1 overflow-y-auto overscroll-contain px-1 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const line = lines[item.index]
            return (
              <div
                key={line.id}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <div className="flex gap-3 px-3 py-1.5">
                  {/* La gouttière porte la position dans la source. Ce n'est pas
                      une décoration : c'est le seul repère qui relie ce qu'on lit
                      à l'endroit du replay d'où ça vient. */}
                  <span className="w-14 shrink-0 pt-[0.3rem] text-right font-mono text-[0.75rem] text-muted-foreground/70 tabular-nums select-none">
                    {formatTimecode(line.start)}
                  </span>

                  {/* `select-none` : le glissé sert à sélectionner des *mots*, et
                      la sélection de texte du navigateur se superposerait à la
                      nôtre. On perd le copier-coller du transcript, ce que rien
                      dans le produit ne demande. */}
                  <p className="flex-1 text-[0.97rem] leading-[1.95] text-pretty select-none">
                    {words.slice(line.from, line.to).map((word) => (
                      <Word
                        key={word.index}
                        word={word}
                        selected={
                          bounds !== null && word.index >= bounds.debut && word.index <= bounds.fin
                        }
                        cursor={word.index === cursor}
                        onSelect={onSelect}
                        onExtend={onExtend}
                        onFinish={onFinish}
                        onSurface={onSurface}
                        onPlace={(index) => {
                          // Le clic sur un mot **reprend** le suivi : c'est le
                          // geste par lequel on redit « je regarde la lecture ».
                          setTracked(true)
                          setCursor(index)
                          onPlace(index)
                        }}
                      />
                    ))}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * La phrase qui porte ce mot, ou `-1`.
 *
 * Dichotomique : elle s'appelle à chaque changement de mot actif, donc plusieurs
 * fois par seconde, sur les quelques centaines de phrases d'une émission.
 */
export function wordLine(lines: readonly IndexedLine[], word: number): number {
  let bottom = 0
  let top = lines.length - 1
  while (bottom <= top) {
    const middle = (bottom + top) >> 1
    if (word < lines[middle].from) top = middle - 1
    else if (word >= lines[middle].to) bottom = middle + 1
    else return middle
  }
  return -1
}

function SearchBar({
  request,
  results,
  rank,
  onRequest,
  onNext,
  onClose,
}: {
  request: string
  results: number
  rank: number
  onRequest: (value: string) => void
  onNext: (not: number) => void
  onClose: () => void
}) {
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => field.current?.focus(), [])

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      <Search className="size-3.5 text-muted-foreground" aria-hidden />
      <Input
        ref={field}
        type="search"
        aria-label="Chercher dans le transcript"
        value={request}
        onChange={(e) => onRequest(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onNext(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
        className="max-w-64"
      />
      <span className="text-[0.75rem] text-muted-foreground tabular-nums">
        {request.trim() === '' ? '' : results === 0 ? 'Aucune occurrence' : `${rank + 1} sur ${results}`}
      </span>
      <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Fermer la recherche">
        <X aria-hidden />
      </Button>
    </div>
  )
}

function Word({
  word,
  selected,
  cursor,
  onSelect,
  onExtend,
  onFinish,
  onSurface,
  onPlace,
}: {
  word: ClipWord
  selected: boolean
  cursor: boolean
  onSelect: (index: number, extend: boolean) => void
  onExtend: (index: number) => void
  onFinish: () => void
  onSurface: (index: number) => void
  onPlace: (index: number) => void
}) {
  // **Chaque mot s'abonne à « suis-je le mot lu », pas à la position.** Quatre
  // `timeupdate` par seconde tombent presque tous dans le même mot : deux mots
  // se rendent quand le surlignage avance, et rien d'autre ne bouge.
  const lu = usePlayback((state) => state.wordActive === word.index)

  // Un clic net sur un mot barré le remonte ; un glissé qui commence dessus le
  // sélectionne comme les autres. C'est le passage du pointeur sur un autre mot
  // entre l'appui et le relâchement qui les sépare — donc on décide au
  // relâchement, pas à l'appui.
  const dragged = useRef(false)
  // Et un shift-clic **étend une sélection**, y compris sur un mot barré : sans
  // cette mémoire, l'appui étendait la sélection puis le relâchement remontait
  // le mot et vidait la sélection. L'intention exprimée par la touche était
  // perdue, alors que le chemin clavier, lui, la respectait déjà.
  const extended = useRef(false)

  return (
    // `role="button"` et non un `<button>` : un bouton est un bloc en ligne, et
    // un mot doit pouvoir se **couper en fin de ligne** comme le texte qui
    // l'entoure. Un `<span>` coule, un `<button>` saute à la ligne entière.
    //
    // Un seul mot est atteignable au clavier à la fois — le curseur —, et les
    // flèches le déplacent. Un mot *est* la commande ici : le rendre
    // inatteignable retirerait les gestes du produit à qui n'a pas de souris,
    // mais en faire cent arrêts de tabulation rendait la surface infranchissable.
    <span
      role="button"
      data-mot={word.index}
      tabIndex={cursor ? 0 : -1}
      aria-pressed={selected}
      aria-current={lu ? 'location' : undefined}
      title={word.kept ? undefined : 'Cliquer pour remonter ce mot'}
      onPointerDown={(e) => {
        dragged.current = false
        extended.current = e.shiftKey
        onSelect(word.index, e.shiftKey)
      }}
      onPointerEnter={() => {
        dragged.current = true
        onExtend(word.index)
      }}
      onPointerUp={() => {
        if (dragged.current || extended.current) return
        if (word.kept) onPlace(word.index)
        else onSurface(word.index)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        if (e.shiftKey) onSelect(word.index, true)
        else if (word.kept) {
          onSelect(word.index, false)
          // **Le glissé se referme.** `commencerSelection` l'ouvre, et le
          // clavier n'a pas de relâchement de bouton pour le clore : sans cette
          // ligne, passer la souris sur un mot voisin étend la sélection alors
          // qu'aucun bouton n'est enfoncé. (relevé par Codex)
          onFinish()
          onPlace(word.index)
        } else onSurface(word.index)
      }}
      className={cn(
        '-mx-0.5 cursor-default rounded-[3px] px-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        word.kept
          ? 'cursor-pointer hover:bg-muted'
          : 'cursor-pointer text-muted-foreground/55 line-through decoration-muted-foreground/45 decoration-[1.5px] hover:text-foreground hover:decoration-transparent',
        lu && 'bg-stage/20 text-foreground',
        selected && 'bg-stage/35 text-foreground decoration-foreground/40',
      )}
    >
      {word.word}{' '}
    </span>
  )
}
