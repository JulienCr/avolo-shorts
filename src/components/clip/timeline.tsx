'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { usePlayback } from '@/components/clip/playback'
import { TranscriptDrawer } from '@/components/clip/transcript-drawer'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { normalizeSegments, type Segment } from '@/core/edl'
import type { PublishedFraming } from '@/lib/api'
import { clipBounds, type ClipWord, type IndexedLine } from '@/lib/editing'
import { formatDuration, formatSpan, formatTimecode } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * La bande de temps, sous l'aperçu source.
 *
 * **Elle ne remplace pas le transcript**, et ce n'est pas la timeline
 * multi-pistes que la spec §13 écarte. Elle ajoute un geste que le texte ne sait
 * pas exprimer : gagner la demi-seconde de silence avant une réplique, se caler
 * sur une réaction muette, rattraper une borne posée sur un mot alors que le
 * souffle d'avant en faisait partie. Les mots continuent de se monter dans le
 * transcript ; ici on monte du temps.
 *
 * Trois choses au même endroit, et c'est ce qui la justifie là plutôt qu'ailleurs.
 *
 * **1. Le temps est celui de la source, coupes visibles.** La bande couvre de
 * l'entrée à la sortie *dans l'émission*, et les passages retirés y creusent des
 * trous à leur vraie place. C'est la première décision du projet — le clip est
 * une liste de segments — et c'est aussi ce qui permet aux frontières de plan de
 * se lire là où elles tombent. Une bande en temps *monté* les afficherait
 * ailleurs.
 *
 * **2. Deux oreilles, libres à l'image près.** Pas d'aimantation aux mots, pas
 * d'aimantation aux plans : le contrôle est celui d'un banc de montage, et la
 * contrepartie est assumée — une borne peut tomber au milieu d'un mot. Le
 * transcript, lui, garde son aimantation ; les deux chemins coexistent parce
 * qu'ils répondent à deux intentions différentes.
 *
 * **3. Trois secondes de contexte de chaque côté**, pour qu'on puisse élargir
 * autant que resserrer. La fenêtre se recalcule après chaque geste : tirer une
 * oreille jusqu'au bord n'enferme pas dans ces trois secondes-là, puisque la
 * borne obtenue en rouvre trois autres.
 *
 * **Ce qu'elle n'écrit pas.** Rien ne part sur le réseau d'ici. Les bornes
 * changent le montage du store, et c'est l'écriture différée existante qui les
 * envoie — un second chemin d'écriture casserait la réconciliation par jeton,
 * payée par deux issues.
 */

/** Le contexte montré de part et d'autre des bornes, en secondes. */
const CONTEXT_SECONDS = 3

/** Le pas du clavier : une image à 30 fps, et un pas large sous `Shift`. */
const FRAME_STEP = 1 / 30
const COARSE_STEP = 0.5

/** La plus petite durée qu'un geste puisse laisser : une borne ne traverse pas l'autre. */
const MIN_DURATION = FRAME_STEP

type Drag = {
  /** L'oreille tirée, ou `null` quand c'est la tête de lecture qu'on promène. */
  edge: 'start' | 'end' | null
  /** La position demandée, en temps source. Non contrainte par la fenêtre. */
  time: number
}

/**
 * Les deux viseurs d'un même montage (spec du 28 août, §4.1) : `time` pose la
 * piste et ses repères, `words` lui substitue le transcript. `setBoundaryAt` et
 * `poserBound` écrivent la même liste de segments — le commutateur ne fait donc
 * que changer d'instrument, jamais de fonction.
 */
export type BandMode = 'time' | 'words'

export function Timeline({
  clipId,
  segments,
  framing,
  proxyUrl,
  sourceDuration,
  onScrub,
  onBoundary,
  lines,
  words,
  firstLine,
  duration,
  search,
  onSearch,
  onPlay,
}: {
  /** L'identifiant du clip : construit l'URL de la planche, sépare le transcript d'un clip à l'autre. */
  clipId: string
  segments: Segment[]
  /** Les plans traversés, publiés par le serveur. On les lit, on ne les calcule pas. */
  framing: PublishedFraming
  proxyUrl: string | null
  /** La durée de l'émission. Elle borne ce qu'un glissé peut demander. */
  sourceDuration: number
  /** Une position demandée à la fin d'un geste de lecture. */
  onScrub: (time: number) => void
  /** Une borne posée à la fin d'un geste. **Une seule par geste** : voir `commit`. */
  onBoundary: (time: number, edge: 'start' | 'end') => void
  /** Le transcript, pour le mode Mots — la même donnée que la surface d'édition. */
  lines: IndexedLine[]
  words: ClipWord[]
  /** La phrase à amener sous les yeux à l'ouverture du mode Mots. */
  firstLine: number
  /** La durée montée, dans le pied de la bande et le mode Mots. */
  duration: number
  search: boolean
  onSearch: (open: boolean) => void
  /** Place la lecture sur ce mot, depuis le mode Mots. */
  onPlay: (index: number) => void
}) {
  // `search` peut déjà valoir `true` au montage — retour depuis les Exports,
  // Ctrl+F laissé ouvert. Le mode initial le reflète, sinon la bande s'ouvre
  // en Temps sans champ de recherche alors que la recherche est demandée.
  const [mode, setMode] = useState<BandMode>(search ? 'words' : 'time')
  // Ajustée pendant le rendu, pas dans un effet : `search` (`Ctrl+F`) porte
  // une demande externe, le mode la suit — jamais l'inverse.
  const [searchSeen, setSearchSeen] = useState(search)
  if (search !== searchSeen) {
    setSearchSeen(search)
    if (search) setMode('words')
  }
  const track = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const bounds = clipBounds(segments)
  // Une durée nulle voudrait dire « aucune position n'est atteignable » et
  // écraserait tout le glissé sur zéro. Le cas ne devrait pas se produire — le
  // projet porte sa durée — mais un `0` mal servi ne doit pas figer la bande.
  const limit = sourceDuration > 0 ? sourceDuration : Infinity

  // **La fenêtre ne bouge pas pendant un geste, et c'est délibéré.** Elle se
  // déduit des bornes *du store*, qui ne changent qu'au relâchement : une fenêtre
  // qui suivrait la position demandée changerait l'échelle sous le pointeur, donc
  // la position que ce même pointeur désigne — le curseur s'emballerait sans que
  // la main bouge. Le glissé, lui, extrapole au-delà des bords (`timeAtPointer`),
  // et la fenêtre se recale au relâchement autour de la borne obtenue. On n'est
  // donc jamais coincé à trois secondes : chaque geste en rouvre trois autres.
  const view = viewport(bounds, limit)

  /**
   * Les bornes **du dernier rendu**, lues par les flèches du clavier.
   *
   * Une touche maintenue se répète plus vite que React ne rend : trois frappes
   * lues dans la même fermeture partent toutes de la même borne et calculent
   * trois fois le même résultat — l'oreille n'avance que d'un cran et paraît
   * collée. C'est le défaut exact que le curseur de cadrage a déjà payé, où la
   * forme fonctionnelle de `moveCrop` le règle ; ici la cible est absolue,
   * donc c'est une référence qui la tient à jour. (relevé par Aristarque)
   */
  const boundsRef = useRef(bounds)
  useEffect(() => {
    boundsRef.current = bounds
  }, [bounds])

  const draggingHandle = drag !== null && drag.edge !== null
  const { setVideo: setPreviewVideo, canvas: previewCanvas } = useFramePreview(drag, proxyUrl)

  const timeAtPointer = useCallback(
    (clientX: number): number | null => {
      const rect = track.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return null
      // Non bornée par la fenêtre : sortir par la gauche continue de reculer,
      // ce qui est la façon la plus simple de ne pas buter sur le contexte.
      const raw = view.start + ((clientX - rect.left) / rect.width) * (view.end - view.start)
      // **Une position non finie ne part pas plus loin.** Elle ferait lever
      // `currentTime` sur la vignette — donc au milieu d'un geste — et poserait
      // une borne `NaN` dans le montage, que `normalizeSegments` jetterait sans
      // rien dire. Un pointeur sans coordonnée n'arrive pas dans un navigateur ;
      // il arrive quand la couche d'événements en fabrique un.
      if (!Number.isFinite(raw)) return null
      return Math.min(Math.max(raw, 0), limit)
    },
    [view.start, view.end, limit],
  )

  /** Une borne ne traverse pas l'autre : le clip garderait une durée négative. */
  const clampEdge = useCallback(
    (time: number, edge: 'start' | 'end' | null): number => {
      if (bounds === null || edge === null) return time
      return edge === 'start'
        ? Math.min(time, bounds.end - MIN_DURATION)
        : Math.max(time, bounds.start + MIN_DURATION)
    },
    [bounds],
  )

  const moveTo = useCallback(
    (clientX: number, edge: 'start' | 'end' | null) => {
      const time = timeAtPointer(clientX)
      if (time === null) return
      setDrag({ edge, time: clampEdge(time, edge) })
    },
    [timeAtPointer, clampEdge],
  )

  /**
   * **Un seul effet par geste, et c'est la raison de tout ce qui précède.**
   *
   * Poser la borne à chaque `pointermove` empilerait soixante instantanés dans
   * la pile d'annulation pour un seul glissé : `Ctrl+Z` défairait alors un
   * soixantième de geste, ce que personne n'appelle « annuler ». La position vit
   * donc en état local le temps du geste, et une seule écriture part au
   * relâchement.
   */
  const commit = useCallback(() => {
    // **L'effet est ici, pas dans la fonction de mise à jour.** Un `setDrag`
    // dont l'argument pose une borne au passage est un effet de bord dans un
    // calcul d'état : le mode strict rejoue les mises à jour, donc le geste
    // partirait deux fois et empilerait deux instantanés d'annulation pour un
    // seul glissé. `drag` est déjà une dépendance de l'écouteur qui appelle
    // ceci, donc la valeur lue est celle du geste en cours.
    if (drag === null) return
    if (drag.edge === null) onScrub(drag.time)
    else onBoundary(drag.time, drag.edge)
    setDrag(null)
  }, [drag, onScrub, onBoundary])

  // Un glissé qui se termine hors de la bande — sur la marge, hors de la
  // fenêtre — doit quand même se conclure. Même raison que dans le transcript :
  // sans cet écouteur, le survol continuerait de déplacer au retour de la
  // souris, bouton relâché.
  useEffect(() => {
    if (drag === null) return
    const release = () => commit()
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [drag, commit])

  const span = view.end - view.start
  const toFraction = (t: number) => Math.min(Math.max((t - view.start) / span, 0), 1)

  /**
   * Une frappe de flèche sur la tête de lecture.
   *
   * **Le geste que la bande apporte n'a pas d'équivalent dans le transcript.**
   * Celui-ci place la lecture *sur un mot* ; se poser dans un silence, ou dans
   * un passage retiré pour aller voir ce qu'il contient, ne s'y exprime pas. Un
   * contrôle qui ne répondrait qu'au pointeur retirerait donc au clavier une
   * capacité neuve, et pas un doublon. (relevé par Copilot)
   *
   * La position part de `usePlayback` plutôt que d'un état local : c'est la même
   * horloge que le lecteur, et deux sources divergeraient dès la première
   * lecture.
   */
  const stepPlayhead = (step: number) => {
    const from = usePlayback.getState().position
    onScrub(clampToSource(from + step, limit))
  }

  /** Une frappe de flèche : depuis la borne courante, pas depuis celle du rendu. */
  const stepBoundary = (edge: 'start' | 'end', step: number) => {
    const current = boundsRef.current
    if (current === null) return
    const from = edge === 'start' ? current.start : current.end
    onBoundary(clampEdge(clampToSource(from + step, limit), edge), edge)
  }
  // Lues seulement dans la branche `bounds !== null` du rendu ci-dessous ;
  // le repli à 0 ne s'observe jamais, faute de bande à afficher sans bornes.
  const inTime = drag !== null && drag.edge === 'start' ? drag.time : (bounds?.start ?? 0)
  const outTime = drag !== null && drag.edge === 'end' ? drag.time : (bounds?.end ?? 0)
  const ghost = drag !== null && drag.edge === null ? drag.time : null

  // **Une coupe par trou entre segments consécutifs.** `normalizeSegments`
  // trie et fusionne ce qui se touche : deux entrées voisines dans son résultat
  // encadrent donc toujours un trou réel, jamais un artefact d'ordre.
  const kept = normalizeSegments(segments)
  const cuts = kept.slice(1).map((s, i) => ({ from: kept[i].end, to: s.start }))

  /** Une borne tapée au clavier : même chemin d'écriture qu'un glissé ou une flèche. */
  const commitBound = (time: number, edge: 'start' | 'end') => {
    onBoundary(clampEdge(clampToSource(time, limit), edge), edge)
  }

  return (
    <div className="relative flex flex-col gap-1">
      <Tabs value={mode} onValueChange={(next) => setMode(next as BandMode)}>
        <TabsList variant="line" aria-label="Ce que montre la bande">
          <TabsTrigger value="time">
            <span aria-hidden>◷</span> Temps
          </TabsTrigger>
          <TabsTrigger value="words">
            <span aria-hidden>❞</span> Mots
          </TabsTrigger>
        </TabsList>

        {/* **Un seul panneau, associé aux onglets ci-dessus.** Un `tablist`
            sans `tabpanel` s'annonce sans rien désigner — même contrat que
            `src/components/review/feed.tsx:419-440`. (relevé par Copilot) */}
        <TabsContent value={mode}>
          {mode === 'words' ? (
            <TranscriptDrawer
              clipId={clipId}
              lines={lines}
              words={words}
              firstLine={firstLine}
              duration={duration}
              search={search}
              onSearch={onSearch}
              onPlay={onPlay}
            />
          ) : bounds === null ? (
            // Tout a été retiré : il n'y a plus de bornes, donc pas de bande.
            // L'onglet Mots reste accessible ci-dessus — c'est par lui qu'on
            // remonte un mot retiré. (relevé par Codex, Copilot)
            <p className="text-[0.75rem] text-muted-foreground">
              Plus rien n’est monté : la bande de temps réapparaîtra dès qu’un passage sera remonté.
            </p>
          ) : (
            <>
              <div className="flex items-baseline justify-between text-[0.75rem] text-muted-foreground">
                <span className="font-mono tabular-nums">{formatTimecode(view.start)}</span>
                {/* Ce que la bande montre, dit une fois. Sans cette ligne, les creux
                    passent pour des blancs de rendu plutôt que pour les coupes. */}
                <span>temps de l’émission — les creux sont les passages retirés</span>
                <span className="font-mono tabular-nums">{formatTimecode(view.end)}</span>
              </div>

              <div
                ref={track}
                data-timeline
                role="group"
                aria-label="Bande de temps du clip"
                className="relative h-12 w-full touch-none rounded-md bg-muted/60 select-none"
                onPointerDown={(e) => {
                  // La bande nue promène la tête de lecture ; les oreilles arrêtent la
                  // propagation, le même appui ne pouvant vouloir les deux. Pas de
                  // troisième `slider` ici : le transcript place déjà la lecture au clavier.
                  e.currentTarget.setPointerCapture(e.pointerId)
                  moveTo(e.clientX, null)
                }}
                onPointerMove={(e) => {
                  if (drag === null || !e.currentTarget.hasPointerCapture(e.pointerId)) return
                  moveTo(e.clientX, drag.edge)
                }}
                onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
              >
                {/* **Le calque clipé, séparé de l'oreille et de l'aperçu.**
                    L'aperçu de scrub sort du cadre par le haut (`-top-2
                    -translate-y-full`, plus bas) ; le clip qui arrondit les
                    coins de la planche ne peut donc pas porter sur le conteneur
                    qui l'accueille. (relevé par Codex) */}
                <div className="absolute inset-0 overflow-hidden rounded-md">
                  {/* **La planche du proxy, en fond de piste** (route de la tâche 5) :
                      la bande cesse de dire seulement où on est pour dire quoi. Bornée
                      sur `bounds`, pas sur la fenêtre : c'est exactement ce que la
                      route tuile. */}
                  {proxyUrl !== null && (
                    <div
                      data-testid="filmstrip"
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0"
                      style={{
                        left: `${toFraction(bounds.start) * 100}%`,
                        width: `${Math.max(0, toFraction(bounds.end) - toFraction(bounds.start)) * 100}%`,
                        // Bornée dans l'URL : sinon le navigateur garde une
                        // planche déjà chargée, étirée, après que A ou B a
                        // bougé. (relevé par Codex)
                        backgroundImage: `url("/api/clips/${encodeURIComponent(clipId)}/filmstrip?bounds=${bounds.start.toFixed(2)}-${bounds.end.toFixed(2)}")`,
                        backgroundSize: '100% 100%',
                      }}
                    />
                  )}

                  {/* Ce qui reste du clip, à sa place dans la source — un voile
                      teinté, pas un aplat, sinon la planche ci-dessus disparaît
                      dessous. Les trous entre segments **sont** les passages
                      retirés, et c'est ce qui fait de cette bande autre chose qu'une
                      barre de progression. */}
                  {segments.map((s) => (
                    <span
                      key={`${s.start}-${s.end}`}
                      aria-hidden
                      className="absolute inset-y-0 border-y-[3px] border-stage bg-stage/25"
                      style={{
                        left: `${toFraction(s.start) * 100}%`,
                        width: `${Math.max(0, toFraction(s.end) - toFraction(s.start)) * 100}%`,
                      }}
                    />
                  ))}

                  {/* **La coupe : une encoche hachurée qui porte sa durée.** Un
                      passage que quelqu'un a retiré, et ça se défait — à l'inverse
                      de la frontière de plan ci-dessous, qui ne se défait pas. Rare
                      dans ce dépôt (aucun clip n'a plus d'un segment), donc quand il
                      y en a une, elle doit se voir. */}
                  {cuts.map((cut) => (
                    <div
                      key={`${cut.from}-${cut.to}`}
                      data-testid="cut"
                      aria-label={`Passage retiré, ${formatSpan(cut.to - cut.from)}`}
                      className="absolute inset-y-0 z-[6] grid place-items-center bg-[repeating-linear-gradient(135deg,currentColor_0,currentColor_2px,transparent_2px,transparent_6px)] text-foreground/30"
                      style={{
                        left: `${toFraction(cut.from) * 100}%`,
                        width: `${Math.max(0, toFraction(cut.to) - toFraction(cut.from)) * 100}%`,
                      }}
                    >
                      <b
                        aria-hidden
                        className="rounded bg-background/90 px-1 font-mono text-[0.75rem] whitespace-nowrap text-foreground"
                      >
                        ✂ {formatSpan(cut.to - cut.from)}
                      </b>
                    </div>
                  ))}

                  {/* Ce que le geste en cours ferait, avant qu'il ne soit fait. */}
                  {draggingHandle && (
                    <span
                      aria-hidden
                      className="absolute inset-y-0 border-x border-dashed border-foreground/40 bg-foreground/5"
                      style={{
                        left: `${toFraction(Math.min(inTime, outTime)) * 100}%`,
                        width: `${Math.max(0, toFraction(Math.max(inTime, outTime)) - toFraction(Math.min(inTime, outTime))) * 100}%`,
                      }}
                    />
                  )}

                  {/* **Les frontières de plans, lues et non calculées, jamais
                      nommées.** `analysis.json` pèse deux à trois méga-octets ; le
                      serveur publie déjà le cadrage plan par plan. Un cadrage que
                      l'analyse a trouvé ne se défait pas — le repère n'a donc pas
                      besoin d'un nom (`cadrage`, le cadre est fixe à l'intérieur
                      d'un plan). */}
                  {framing.shots.slice(1).map((shot) => (
                    <span
                      key={shot.key}
                      data-testid="shot-mark"
                      aria-hidden
                      className="absolute inset-y-2 w-px bg-foreground/25"
                      style={{ left: `${toFraction(shot.shot.start) * 100}%` }}
                    />
                  ))}
                </div>

                <Playhead
                  view={view}
                  ghost={ghost}
                  onStep={(step) => stepPlayhead(step)}
                />

                <Handle
                  edge="start"
                  time={inTime}
                  left={toFraction(inTime)}
                  active={drag?.edge === 'start'}
                  onGrab={(clientX) => moveTo(clientX, 'start')}
                  onStep={(step) => stepBoundary('start', step)}
                  min={view.start}
                  max={view.end}
                />
                <Handle
                  edge="end"
                  time={outTime}
                  left={toFraction(outTime)}
                  active={drag?.edge === 'end'}
                  onGrab={(clientX) => moveTo(clientX, 'end')}
                  onStep={(step) => stepBoundary('end', step)}
                  min={view.start}
                  max={view.end}
                />

                {/* L'image de la position demandée, pendant le geste. Le lecteur
                    principal n'y touche pas : le faire chercher soixante fois par seconde
                    tuerait la lecture et ferait sauter l'aperçu de sortie, qui s'accroche
                    à ses trames. */}
                {drag !== null && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute -top-2 z-20 -translate-x-1/2 -translate-y-full rounded border bg-popover p-1 shadow-lg"
                    // La vignette reste dans la bande : centrée sur une position au
                    // ras du bord, sa moitié se ferait rogner — vérifié à l'écran,
                    // sur le geste le plus courant, qui tire une oreille jusqu'au bout.
                    style={{ left: `clamp(4rem, ${toFraction(drag.time) * 100}%, calc(100% - 4rem))` }}
                  >
                    <canvas
                      ref={previewCanvas}
                      width={160}
                      height={90}
                      className="block w-32 rounded-sm bg-zinc-950"
                    />
                    <span className="mt-0.5 block text-center font-mono text-xs tabular-nums">
                      {formatTimecode(drag.time)}
                    </span>
                  </span>
                )}
              </div>

              {/* Le second `<video>`, **caché et sans son**. C'est la source des vignettes
                  de scrub : un élément à part plutôt que le lecteur, pour la raison écrite
                  juste au-dessus. Il ne charge que ses métadonnées tant que personne ne
                  tire. */}
              {proxyUrl !== null && (
                <video
                  ref={setPreviewVideo}
                  src={proxyUrl}
                  muted
                  preload="metadata"
                  aria-hidden
                  tabIndex={-1}
                  className="pointer-events-none absolute bottom-0 left-0 size-px opacity-0"
                />
              )}
            </>
          )}

          {/* **Le pied de la bande, dans les deux modes.** La poignée pour
              approcher, le champ pour poser à l'image près (spec du 28 août,
              §4.3) : les deux visent la même écriture, donc les deux valent
              quel que soit le viseur choisi au-dessus. */}
          {bounds !== null && (
            <div className="flex items-center gap-3">
              <BoundField label="A" seconds={bounds.start} edge="start" onCommit={commitBound} />
              <BoundField label="B" seconds={bounds.end} edge="end" onCommit={commitBound} />
              <span className="flex items-baseline gap-1 text-[0.75rem] text-muted-foreground">
                durée
                <span className="font-mono tabular-nums text-foreground">{formatDuration(duration)}</span>
              </span>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

/**
 * Le rang de l'image dans sa seconde, à 30 images par seconde.
 *
 * C'est l'unité dans laquelle la flèche déplace, donc la seule qui rende
 * l'ajustement audible : « 0:35:10, image 12 » avance à chaque frappe là où le
 * timecode seul reste identique vingt-neuf fois de suite.
 */
function frameWithinSecond(time: number): number {
  // **La tolérance n'est pas de la prudence.** `(100 + 1/30 - 100) / (1/30)`
  // vaut un cheveu de moins que 1 en binaire : sans elle, la première flèche
  // depuis une seconde entière annonce encore « image 0 », c'est-à-dire
  // exactement le silence que cette annonce existe pour rompre.
  // (relevé par Copilot)
  return Math.min(29, Math.floor((time - Math.floor(time)) / FRAME_STEP + 1e-6))
}

/** Ramène un temps dans la source. */
function clampToSource(time: number, limit: number): number {
  return Math.min(Math.max(time, 0), limit)
}

/**
 * La fenêtre visible : les bornes, plus trois secondes de contexte de part et
 * d'autre.
 *
 * Le contexte n'est pas décoratif — sans lui on ne peut que resserrer, jamais
 * élargir, et la moitié de l'intérêt des oreilles disparaît.
 */
function viewport(
  bounds: { start: number; end: number } | null,
  limit: number,
): { start: number; end: number } {
  if (bounds === null) return { start: 0, end: Number.isFinite(limit) ? limit : 1 }
  const start = Math.max(0, bounds.start - CONTEXT_SECONDS)
  // La borne haute ne dépasse pas la source, mais la fenêtre garde une largeur :
  // une largeur nulle rendrait toutes les positions égales à `NaN`.
  const end = Math.max(start + 1, Math.min(limit, bounds.end + CONTEXT_SECONDS))
  return { start, end }
}

/**
 * La tête de lecture, **seule abonnée à la position**.
 *
 * Un composant à part pour la même raison que l'horloge du lecteur : la position
 * change quatre fois par seconde, et la lire dans la bande ferait rendre les
 * segments, les frontières de plans et les deux oreilles à cette cadence.
 */
function Playhead({
  view,
  ghost,
  onStep,
}: {
  view: { start: number; end: number }
  /** La position promenée par un glissé, tant qu'elle n'est pas confiée au lecteur. */
  ghost: number | null
  /** Une flèche : un déplacement relatif, en secondes. */
  onStep: (step: number) => void
}) {
  const position = usePlayback((state) => state.position)
  const time = ghost ?? position
  const left = Math.min(Math.max((time - view.start) / (view.end - view.start), 0), 1)
  return (
    // **Un `slider`, et pas un trait décoratif.** Promener la lecture est le
    // geste que la bande apporte, et le transcript ne sait le faire que de mot en
    // mot : un contrôle réservé au pointeur retirerait au clavier une capacité
    // neuve. `role="slider"` a aussi la bonne conséquence sur la garde des
    // raccourcis, qui laisse déjà les flèches à un curseur focalisé.
    <span
      role="slider"
      tabIndex={0}
      aria-label="Tête de lecture"
      aria-valuemin={Math.round(view.start)}
      aria-valuemax={Math.round(view.end)}
      aria-valuenow={Math.round(time * 1000) / 1000}
      aria-valuetext={`${formatTimecode(time)}, image ${frameWithinSecond(time)}`}
      data-playhead
      onKeyDown={(e) => {
        const step = e.shiftKey ? COARSE_STEP : FRAME_STEP
        if (e.key === 'ArrowLeft') onStep(-step)
        else if (e.key === 'ArrowRight') onStep(step)
        else return
        e.preventDefault()
      }}
      className={cn(
        'absolute inset-y-0 z-10 w-1 -translate-x-1/2 rounded-full outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        ghost === null ? 'bg-foreground/70' : 'bg-foreground',
      )}
      style={{ left: `${left * 100}%` }}
    />
  )
}

/**
 * Une oreille : la borne d'entrée ou de sortie, tirée à la main.
 *
 * `role="slider"` comme le rectangle de cadrage, et pour la même conséquence
 * utile : la garde des raccourcis écarte déjà les flèches d'un `[role="slider"]`,
 * donc une oreille focalisée les reçoit sans que l'écran les lui vole.
 *
 * **`aria-valuetext` porte le timecode**, pas un nombre de secondes : « 1247 »
 * ne dit rien, « 0:20:47 » se compare à ce qu'on lit ailleurs à l'écran.
 */
function Handle({
  edge,
  time,
  left,
  active,
  onGrab,
  onStep,
  min,
  max,
}: {
  edge: 'start' | 'end'
  time: number
  left: number
  active: boolean
  onGrab: (clientX: number) => void
  onStep: (step: number) => void
  min: number
  max: number
}) {
  return (
    <span
      role="slider"
      tabIndex={0}
      aria-label={edge === 'start' ? 'Borne d’entrée' : 'Borne de sortie'}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      // **La valeur garde ses décimales, et le texte compte les images.** Le
      // clavier déplace la borne d'un trentième de seconde : arrondie à la
      // seconde, la valeur annoncée ne bougeait pas avant vingt-neuf frappes, et
      // l'ajustement image par image — la raison d'être de ces flèches — ne se
      // disait nulle part. (relevé par Copilot)
      aria-valuenow={Math.round(time * 1000) / 1000}
      aria-valuetext={`${formatTimecode(time)}, image ${frameWithinSecond(time)}`}
      data-edge={edge}
      onPointerDown={(e) => {
        // La bande, dessous, promène la tête de lecture : le même appui ne peut
        // pas vouloir les deux.
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        onGrab(e.clientX)
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        onGrab(e.clientX)
      }}
      onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      onKeyDown={(e) => {
        // **Une image, ou un pas large sous `Shift`.** Chaque frappe pose une
        // borne, donc empile un instantané : c'est le bon grain pour un
        // ajustement fin, où l'on veut pouvoir revenir d'un cran.
        const step = e.shiftKey ? COARSE_STEP : FRAME_STEP
        if (e.key === 'ArrowLeft') onStep(-step)
        else if (e.key === 'ArrowRight') onStep(step)
        else return
        e.preventDefault()
      }}
      className={cn(
        // **Franches, pas discrètes** (spec du 28 août, §4.3) : 16 px plutôt
        // que 12, pour rester saisissables au pouce sur la planche derrière.
        'absolute inset-y-0 z-10 w-4 -translate-x-1/2 cursor-ew-resize rounded bg-stage outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        active && 'ring-2 ring-ring',
      )}
      style={{ left: `${left * 100}%` }}
    >
      <span
        aria-hidden
        className="absolute top-1/2 left-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-stage-foreground/70"
      />
    </span>
  )
}

/**
 * L'image de la position demandée, pendant qu'on tire.
 *
 * **Au plus une recherche en vol.** Un `pointermove` part soixante fois par
 * seconde ; en faire soixante recherches sur un proxy servi en requêtes
 * partielles produit une tempête d'abandons — et ce chemin est déjà fragile côté
 * serveur : une requête `Range` abandonnée y lève une `uncaughtException`
 * (issue #75, corrigée ailleurs). On garde donc la dernière position demandée et
 * on ne relance qu'au `seeked` précédent : le rythme s'aligne sur ce que le
 * décodeur sait tenir au lieu de le noyer. Ce n'est pas une optimisation, c'est
 * ce qui rend le geste tenable.
 */
function useFramePreview(drag: Drag | null, proxyUrl: string | null) {
  const video = useRef<HTMLVideoElement | null>(null)
  /**
   * **Le montage du `<video>` réveille les effets — une référence ne le fait
   * pas, et c'est un défaut mesuré.**
   *
   * Ce `<video>`-ci n'existe pas au premier rendu : le store n'a pas encore
   * chargé le clip, `clipBounds` rend `null`, la bande sort par son retour
   * anticipé et l'élément n'est pas monté. L'effet qui branche `seeked`
   * s'exécutait alors sur une référence vide, ne branchait rien, et ne se
   * rejouait jamais — ses dépendances n'avaient pas bougé. Vérifié au
   * navigateur : la vignette de scrub restait **noire**, sur le seul composant
   * dont c'est la raison d'être, sans une erreur nulle part.
   *
   * Un drapeau d'état à côté de la référence règle les deux moitiés : la
   * référence porte l'élément qu'on pilote — `currentTime` est une écriture, et
   * un élément gardé en état serait une valeur d'état qu'on mute —, le drapeau
   * porte le fait qu'il existe, donc la dépendance.
   */
  const [mounted, setMounted] = useState(false)
  const setVideo = useCallback((element: HTMLVideoElement | null) => {
    video.current = element
    setMounted(element !== null)
  }, [])

  const canvas = useRef<HTMLCanvasElement>(null)
  /** La position demandée pendant qu'une recherche est en vol, ou `null`. */
  const queued = useRef<number | null>(null)
  const inFlight = useRef(false)

  const paint = useCallback(() => {
    const source = video.current
    const target = canvas.current
    if (source === null || target === null) return
    // Le proxy se charge en requêtes partielles : une source de 0x0 fait lever
    // `drawImage`. Même garde que dans l'aperçu de sortie.
    if (source.videoWidth <= 0 || source.videoHeight <= 0) return
    const ctx = target.getContext('2d')
    if (ctx === null) return
    ctx.drawImage(source, 0, 0, target.width, target.height)
  }, [])

  // Le rendu du `seeked` : peindre, puis repartir vers la dernière position
  // demandée entre-temps. C'est ici que la coalescence se referme.
  useEffect(() => {
    const source = video.current
    if (!mounted || source === null) return
    const onSeeked = () => {
      paint()
      const next = queued.current
      queued.current = null
      if (next === null) {
        inFlight.current = false
        return
      }
      source.currentTime = next
    }
    // **`error` compte comme une fin de recherche.** Un décodage refusé n'émet
    // pas `seeked` : sans cette seconde porte, le verrou resterait pris jusqu'au
    // prochain changement de source, et la vignette ne repartirait plus.
    const onError = () => {
      queued.current = null
      inFlight.current = false
    }
    source.addEventListener('seeked', onSeeked)
    source.addEventListener('error', onError)
    return () => {
      source.removeEventListener('seeked', onSeeked)
      source.removeEventListener('error', onError)
    }
  }, [mounted, paint])

  const time = drag?.time ?? null
  useEffect(() => {
    const source = video.current
    if (!mounted || source === null || time === null || !Number.isFinite(time)) return
    // **On peint avant de chercher.** La vignette apparaît avec le geste, et une
    // recherche sur un proxy servi en requêtes partielles prend le temps qu'elle
    // prend : sans ce premier trait, le début de chaque glissé montre un
    // rectangle noir. L'image affichée est celle d'avant, ce que le timecode
    // sous la vignette dit déjà.
    paint()
    if (inFlight.current) {
      queued.current = time
      return
    }
    inFlight.current = true
    source.currentTime = time
  }, [mounted, time, paint])

  /**
   * Le geste fini, **la file se vide mais le verrou reste** : une recherche
   * restée en attente ferait repartir le décodeur pour une image que plus
   * personne ne regarde, alors que celle qui est *réellement en vol*, elle,
   * n'est pas terminée pour autant.
   *
   * **Relâcher le verrou ici casserait la garantie d'une seule recherche à la
   * fois.** Un second glissé qui commence avant le `seeked` du premier
   * réécrirait `currentTime` sur-le-champ et abandonnerait la requête `Range` en
   * cours — c'est-à-dire le chemin que l'issue #75 a rendu sûr, mais qu'on n'a
   * aucune raison d'emprunter deux fois par geste. Seul `onSeeked` relâche.
   * (relevé par Copilot)
   */
  useEffect(() => {
    if (drag === null) queued.current = null
  }, [drag])

  /**
   * **La source qui change relâche tout.** Son `seeked` n'arrivera jamais,
   * donc personne ne relâcherait le verrou.
   *
   * **« La source » n'est pas « le nœud ».** Naviguer vers un autre clip
   * réutilise le même `<video>` — React ne change que son `src` — donc un
   * montage/démontage ne repère pas le cas : une recherche en vol restait
   * comptée pour toujours, et la file s'empilait sans jamais partir.
   * (relevé par Aristarque, précisé par Copilot)
   */
  useEffect(() => {
    queued.current = null
    inFlight.current = false
  }, [mounted, proxyUrl])

  return { setVideo, canvas }
}

/**
 * Un temps tapé au clavier — `h:mm:ss`, `m:ss` ou `ss`. `null` devant une
 * saisie qui ne s'y prête pas : une ambiguïté se rejette, elle ne se devine
 * pas au hasard.
 */
function parseTimecode(text: string): number | null {
  const parts = text.trim().split(':')
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null
  // Les parties `mm`/`ss` sont strictement inférieures à 60 : `1:90` ne
  // vaut rien, il ne se relit pas comme `2:30`. (relevé par Aristarque)
  if (parts.slice(1).some((p) => Number(p) >= 60)) return null
  const result = parts.reduce((total, part) => total * 60 + Number(part), 0)
  // Une chaîne de centaines de chiffres passe le regex et déborde en
  // `Infinity`, qu'`onCommit` écrirait comme borne — rejeté ici plutôt
  // que laissé à l'autosave, qui le tournerait en `null`. (relevé par Aristarque)
  return Number.isFinite(result) ? result : null
}

/**
 * Un champ de borne, en bas de la bande.
 *
 * **Il affiche `clipBounds`, jamais la valeur tapée** (spec du 28 août, §4.3) :
 * `seconds` vient toujours du montage relu, jamais d'un état local qui
 * refléterait la demande. La frappe vit dans `draft` le temps de la saisie, et
 * s'efface au commit — la valeur qui reste à l'écran est alors celle que
 * `onCommit` a réellement obtenue.
 */
function BoundField({
  label,
  seconds,
  edge,
  onCommit,
}: {
  label: string
  seconds: number
  edge: 'start' | 'end'
  onCommit: (seconds: number, edge: 'start' | 'end') => void
}) {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = () => {
    if (draft === null) return
    const parsed = parseTimecode(draft)
    if (parsed !== null) onCommit(parsed, edge)
    setDraft(null)
  }

  return (
    <label className="flex items-center gap-1 text-[0.75rem] text-muted-foreground">
      {label}
      <input
        // Le libellé visible reste `A`/`B` ; le nom accessible reprend celui
        // des oreilles (`Handle`, plus bas), lisible hors contexte.
        // (relevé par Copilot)
        aria-label={edge === 'start' ? 'Borne d’entrée' : 'Borne de sortie'}
        className="w-20 rounded border bg-background px-1.5 py-0.5 font-mono text-[0.75rem] text-foreground tabular-nums"
        value={draft ?? formatDuration(seconds)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        // **`Entrée` valide, sans forcer le flou.** Un `blur()` immédiat
        // relirait `commit` sur la fermeture d'avant — `draft` n'est effacé
        // qu'au prochain rendu — et écrirait la borne une seconde fois.
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          commit()
        }}
      />
    </label>
  )
}
