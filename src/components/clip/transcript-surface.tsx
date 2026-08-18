'use client'

import { useVirtualizer } from '@tanstack/react-virtual'
import { Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useLecture } from '@/components/clip/lecture'
import { chercher } from '@/components/clip/recherche'
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
  cle,
  lines,
  words,
  selection,
  ligneInitiale = 0,
  onSelectionner,
  onEtendre,
  onTerminer,
  onRemonter,
  onPlacer,
  recherche = false,
  onRecherche,
}: {
  /** Identifie le clip ouvert. Le positionnement initial n'a lieu qu'une fois par valeur. */
  cle: string
  lines: IndexedLine[]
  words: ClipWord[]
  selection: Selection | null
  /** La phrase à amener sous les yeux à l'ouverture : le début du clip, pas celui du contexte. */
  ligneInitiale?: number
  onSelectionner: (index: number, etendre: boolean) => void
  onEtendre: (index: number) => void
  onTerminer: () => void
  onRemonter: (index: number) => void
  /** Place la lecture sur ce mot. Un clic net sur un mot gardé, rien d'autre. */
  onPlacer: (index: number) => void
  recherche?: boolean
  onRecherche: (ouverte: boolean) => void
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
  const [curseur, setCurseur] = useState(0)

  /** Le défilement suit-il encore la lecture ? */
  const [suivi, setSuivi] = useState(true)

  const [requête, setRequête] = useState('')
  const [rang, setRang] = useState(0)
  const résultats = useMemo(() => chercher(words, requête), [words, requête])

  // Vrai le temps d'un défilement que **nous** avons demandé. Le navigateur
  // émet un `scroll` dans les deux cas et rien ne les distingue autrement ; le
  // drapeau retombe à l'image suivante, que la spécification place après les
  // événements de défilement.
  const auto = useRef(false)
  const deplacer = virtualiseur.scrollToIndex
  const défilerVers = useCallback(
    (ligne: number, align: 'start' | 'center' = 'center') => {
      if (ligne < 0) return
      auto.current = true
      deplacer(ligne, { align })
      requestAnimationFrame(() => {
        auto.current = false
      })
    },
    [deplacer],
  )

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
  //
  // **Sur une image, pas dans l'effet.** `scrollToIndex` déclenche un
  // `flushSync` à l'intérieur du virtualiseur ; appelé depuis un effet, React
  // avertit qu'il ne peut pas vider sa file pendant qu'il rend, et le
  // positionnement se fait alors sur des hauteurs pas encore mesurées. Une
  // image plus tard, les lignes sont mesurées et le défilement tombe juste.
  //
  // **Une fois par clip, et pas une de plus.** `ligneInitiale` se recalcule
  // quand le clip enregistré change ; repositionner à chaque fois ferait fuir
  // le texte sous les yeux pendant qu'on monte. Le repère est donc `cle`, pas
  // la valeur.
  //
  // Le repère se pose **quand le défilement a eu lieu**, pas quand il est
  // programmé. `deplacer` vient du virtualiseur et rien ne garantit sa
  // stabilité d'un rendu à l'autre : si l'effet se rejoue avant l'image, son
  // nettoyage annule la précédente, et un repère posé trop tôt court-circuiterait
  // la nouvelle. Le défilement initial n'aurait alors jamais lieu.
  const positionne = useRef<string | null>(null)
  useEffect(() => {
    if (positionne.current === cle) return
    if (ligneInitiale <= 0) {
      positionne.current = cle
      return
    }
    const image = requestAnimationFrame(() => {
      positionne.current = cle
      défilerVers(ligneInitiale, 'start')
    })
    return () => cancelAnimationFrame(image)
  }, [cle, défilerVers, ligneInitiale])

  // **Le suivi de lecture, par abonnement et non par état de rendu.** La
  // position change quatre fois par seconde : la lire dans le rendu ferait
  // reconstruire le virtualiseur à cette cadence. On ne réagit ici qu'au
  // changement de *mot*, et sans rendre quoi que ce soit.
  // Écrites depuis un effet et non pendant le rendu : une référence mise à jour
  // en plein rendu est un effet de bord que le compilateur React refuse, et pour
  // une bonne raison — un rendu abandonné laisserait la référence en avance sur
  // ce qui est affiché.
  const lignesRef = useRef(lines)
  const suiviRef = useRef(suivi)
  const défilerRef = useRef(défilerVers)
  useEffect(() => {
    lignesRef.current = lines
    suiviRef.current = suivi
    défilerRef.current = défilerVers
  }, [lines, suivi, défilerVers])
  useEffect(
    () =>
      useLecture.subscribe((etat, precedent) => {
        if (etat.motActif === null || etat.motActif === precedent.motActif) return
        if (!suiviRef.current) return
        défilerRef.current(ligneDuMot(lignesRef.current, etat.motActif))
      }),
    [],
  )

  const items = virtualiseur.getVirtualItems()
  const ligneCurseur = ligneDuMot(lines, curseur)
  const curseurRendu = items.some((item) => item.index === ligneCurseur)

  // Le focus suit le curseur, une fois le mot rendu. Quand il ne l'est pas — le
  // virtualiseur ne garde qu'une trentaine de phrases —, le conteneur le prend :
  // sans cela, un déplacement au clavier vers le bas du transcript perdrait le
  // focus sur le corps du document, et la frappe suivante ne ferait plus rien.
  const àFocaliser = useRef(false)
  useEffect(() => {
    if (!àFocaliser.current) return
    àFocaliser.current = false
    const cible = conteneur.current?.querySelector<HTMLElement>(`[data-mot="${curseur}"]`)
    if (cible) cible.focus()
    else conteneur.current?.focus()
  })

  const allerAuMot = useCallback(
    (index: number) => {
      const borné = Math.min(Math.max(index, 0), Math.max(0, words.length - 1))
      setCurseur(borné)
      àFocaliser.current = true
      // **Naviguer coupe le suivi**, que ce soit à la flèche ou par la
      // recherche : aller voir ailleurs pendant que la lecture continue ferait
      // ramener le texte sous les yeux au moment où on lit l'occurrence.
      setSuivi(false)
      // **Sans ce défilement, la flèche paraît sans effet** : le mot suivant
      // peut être hors du champ rendu, donc absent du DOM.
      défilerVers(ligneDuMot(lines, borné))
    },
    [words.length, lines, défilerVers],
  )

  function surClavier(e: React.KeyboardEvent) {
    const ligne = ligneDuMot(lines, curseur)
    if (e.key === 'ArrowRight') allerAuMot(curseur + 1)
    else if (e.key === 'ArrowLeft') allerAuMot(curseur - 1)
    else if (e.key === 'ArrowDown') allerAuMot(lines[ligne + 1]?.from ?? words.length - 1)
    else if (e.key === 'ArrowUp') allerAuMot(lines[ligne - 1]?.from ?? 0)
    else if (e.key === 'Home') allerAuMot(0)
    else if (e.key === 'End') allerAuMot(words.length - 1)
    else return
    e.preventDefault()
  }

  function allerAuRésultat(suivant: number) {
    if (résultats.length === 0) return
    const cible = (suivant + résultats.length) % résultats.length
    setRang(cible)
    allerAuMot(résultats[cible])
  }

  const bornes = selection
    ? {
        debut: Math.min(selection.ancre, selection.tete),
        fin: Math.max(selection.ancre, selection.tete),
      }
    : null

  return (
    <div className="flex h-full flex-col">
      {recherche && (
        <BarreDeRecherche
          requête={requête}
          résultats={résultats.length}
          rang={rang}
          onRequête={(valeur) => {
            setRequête(valeur)
            setRang(0)
            const trouvés = chercher(words, valeur)
            if (trouvés.length > 0) allerAuMot(trouvés[0])
          }}
          onSuivant={(pas) => allerAuRésultat(rang + pas)}
          onFermer={() => onRecherche(false)}
        />
      )}

      <div
        ref={conteneur}
        data-surface-transcript
        // Le conteneur ne prend le focus que lorsque le mot du curseur n'est pas
        // rendu : sinon la surface aurait deux arrêts de tabulation au lieu d'un.
        tabIndex={curseurRendu ? -1 : 0}
        onKeyDown={surClavier}
        onScroll={() => {
          // `auto` retombe à l'image suivante, que la spécification place après
          // les événements de défilement : ce qui arrive ici avec le drapeau
          // levé vient donc de nous, pas de l'utilisateur.
          if (auto.current) return
          if (suivi) setSuivi(false)
        }}
        className="h-full flex-1 overflow-y-auto overscroll-contain px-1 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <div className="relative w-full" style={{ height: virtualiseur.getTotalSize() }}>
          {items.map((item) => {
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
                  <span className="w-14 shrink-0 pt-[0.3rem] text-right font-mono text-[0.75rem] text-muted-foreground/70 tabular-nums select-none">
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
                        auCurseur={mot.index === curseur}
                        onSelectionner={onSelectionner}
                        onEtendre={onEtendre}
                        onRemonter={onRemonter}
                        onPlacer={(index) => {
                          // Le clic sur un mot **reprend** le suivi : c'est le
                          // geste par lequel on redit « je regarde la lecture ».
                          setSuivi(true)
                          setCurseur(index)
                          onPlacer(index)
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
export function ligneDuMot(lines: readonly IndexedLine[], mot: number): number {
  let bas = 0
  let haut = lines.length - 1
  while (bas <= haut) {
    const milieu = (bas + haut) >> 1
    if (mot < lines[milieu].from) haut = milieu - 1
    else if (mot >= lines[milieu].to) bas = milieu + 1
    else return milieu
  }
  return -1
}

function BarreDeRecherche({
  requête,
  résultats,
  rang,
  onRequête,
  onSuivant,
  onFermer,
}: {
  requête: string
  résultats: number
  rang: number
  onRequête: (valeur: string) => void
  onSuivant: (pas: number) => void
  onFermer: () => void
}) {
  const champ = useRef<HTMLInputElement>(null)
  useEffect(() => champ.current?.focus(), [])

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      <Search className="size-3.5 text-muted-foreground" aria-hidden />
      <Input
        ref={champ}
        type="search"
        aria-label="Chercher dans le transcript"
        value={requête}
        onChange={(e) => onRequête(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSuivant(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onFermer()
          }
        }}
        className="max-w-64"
      />
      <span className="text-[0.75rem] text-muted-foreground tabular-nums">
        {requête.trim() === '' ? '' : résultats === 0 ? 'Aucune occurrence' : `${rang + 1} sur ${résultats}`}
      </span>
      <Button size="icon-sm" variant="ghost" onClick={onFermer} aria-label="Fermer la recherche">
        <X aria-hidden />
      </Button>
    </div>
  )
}

function Mot({
  mot,
  selectionne,
  auCurseur,
  onSelectionner,
  onEtendre,
  onRemonter,
  onPlacer,
}: {
  mot: ClipWord
  selectionne: boolean
  auCurseur: boolean
  onSelectionner: (index: number, etendre: boolean) => void
  onEtendre: (index: number) => void
  onRemonter: (index: number) => void
  onPlacer: (index: number) => void
}) {
  // **Chaque mot s'abonne à « suis-je le mot lu », pas à la position.** Quatre
  // `timeupdate` par seconde tombent presque tous dans le même mot : deux mots
  // se rendent quand le surlignage avance, et rien d'autre ne bouge.
  const lu = useLecture((etat) => etat.motActif === mot.index)

  // Un clic net sur un mot barré le remonte ; un glissé qui commence dessus le
  // sélectionne comme les autres. C'est le passage du pointeur sur un autre mot
  // entre l'appui et le relâchement qui les sépare — donc on décide au
  // relâchement, pas à l'appui.
  const glisse = useRef(false)
  // Et un shift-clic **étend une sélection**, y compris sur un mot barré : sans
  // cette mémoire, l'appui étendait la sélection puis le relâchement remontait
  // le mot et vidait la sélection. L'intention exprimée par la touche était
  // perdue, alors que le chemin clavier, lui, la respectait déjà.
  const etendait = useRef(false)

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
      data-mot={mot.index}
      tabIndex={auCurseur ? 0 : -1}
      aria-pressed={selectionne}
      aria-current={lu ? 'location' : undefined}
      title={mot.kept ? undefined : 'Cliquer pour remonter ce mot'}
      onPointerDown={(e) => {
        glisse.current = false
        etendait.current = e.shiftKey
        onSelectionner(mot.index, e.shiftKey)
      }}
      onPointerEnter={() => {
        glisse.current = true
        onEtendre(mot.index)
      }}
      onPointerUp={() => {
        if (glisse.current || etendait.current) return
        if (mot.kept) onPlacer(mot.index)
        else onRemonter(mot.index)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        if (e.shiftKey) onSelectionner(mot.index, true)
        else if (mot.kept) {
          onSelectionner(mot.index, false)
          onPlacer(mot.index)
        } else onRemonter(mot.index)
      }}
      className={cn(
        '-mx-0.5 cursor-default rounded-[3px] px-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        mot.kept
          ? 'cursor-pointer hover:bg-muted'
          : 'cursor-pointer text-muted-foreground/55 line-through decoration-muted-foreground/45 decoration-[1.5px] hover:text-foreground hover:decoration-transparent',
        lu && 'bg-stage/20 text-foreground',
        selectionne && 'bg-stage/35 text-foreground decoration-foreground/40',
      )}
    >
      {mot.word}{' '}
    </span>
  )
}
