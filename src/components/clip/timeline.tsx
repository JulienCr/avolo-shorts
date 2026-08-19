'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { useLecture } from '@/components/clip/lecture'
import type { Segment } from '@/core/edl'
import type { PublishedFraming } from '@/lib/api'
import { clipBounds } from '@/lib/editing'
import { formatTimecode } from '@/lib/format'
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

export function Timeline({
  segments,
  framing,
  proxyUrl,
  sourceDuration,
  onScrub,
  onBoundary,
}: {
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
}) {
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
   * forme fonctionnelle de `deplacerCrop` le règle ; ici la cible est absolue,
   * donc c'est une référence qui la tient à jour. (relevé par Aristarque)
   */
  const boundsRef = useRef(bounds)
  useEffect(() => {
    boundsRef.current = bounds
  }, [bounds])

  const draggingHandle = drag !== null && drag.edge !== null
  const { setVideo: setPreviewVideo, canvas: previewCanvas } = useFramePreview(drag)

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

  if (bounds === null) {
    // Tout a été retiré : il n'y a plus de bornes, donc pas de bande. Le
    // transcript reste la façon d'en sortir, et l'écran le dit dans sa zone
    // Montage — le répéter ici ferait deux phrases pour un seul état.
    return (
      <p className="text-[0.75rem] text-muted-foreground">
        Plus rien n’est monté : la bande de temps réapparaîtra dès qu’un passage sera remonté.
      </p>
    )
  }

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
   * La position part de `useLecture` plutôt que d'un état local : c'est la même
   * horloge que le lecteur, et deux sources divergeraient dès la première
   * lecture.
   */
  const stepPlayhead = (step: number) => {
    const from = useLecture.getState().position
    onScrub(clampToSource(from + step, limit))
  }

  /** Une frappe de flèche : depuis la borne courante, pas depuis celle du rendu. */
  const stepBoundary = (edge: 'start' | 'end', step: number) => {
    const current = boundsRef.current
    if (current === null) return
    const from = edge === 'start' ? current.start : current.end
    onBoundary(clampEdge(clampToSource(from + step, limit), edge), edge)
  }
  const inTime = drag !== null && drag.edge === 'start' ? drag.time : bounds.start
  const outTime = drag !== null && drag.edge === 'end' ? drag.time : bounds.end
  const ghost = drag !== null && drag.edge === null ? drag.time : null

  return (
    <div className="relative flex flex-col gap-1">
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
          // La bande nue promène la tête de lecture. Les oreilles arrêtent la
          // propagation : le même appui ne peut pas vouloir les deux.
          //
          // **Ce geste-ci n'a pas d'équivalent au clavier ici, et c'est réglé
          // ailleurs** : l'organe de navigation temporelle est le transcript, où
          // `Entrée` sur un mot place la lecture (parcours §3.3). Poser un
          // troisième `slider` sur la tête de lecture doublerait ce chemin sans
          // rien ajouter. Les deux gestes que le transcript ne sait pas
          // exprimer — les bornes — sont, eux, des `slider` atteignables.
          // (relevé par Copilot)
          e.currentTarget.setPointerCapture(e.pointerId)
          moveTo(e.clientX, null)
        }}
        onPointerMove={(e) => {
          if (drag === null || !e.currentTarget.hasPointerCapture(e.pointerId)) return
          moveTo(e.clientX, drag.edge)
        }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      >
        {/* Ce qui reste du clip, à sa place dans la source. Un bloc par segment :
            les trous entre eux **sont** les passages retirés, et c'est ce qui
            fait de cette bande autre chose qu'une barre de progression. */}
        {segments.map((s) => (
          <span
            key={`${s.start}-${s.end}`}
            aria-hidden
            className="absolute inset-y-1 rounded-sm bg-stage/45"
            style={{
              left: `${toFraction(s.start) * 100}%`,
              width: `${Math.max(0, toFraction(s.end) - toFraction(s.start)) * 100}%`,
            }}
          />
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

        {/* **Les frontières de plans, lues et non calculées.** `analysis.json`
            pèse deux à trois méga-octets ; le serveur publie déjà le cadrage plan
            par plan, et c'est tout ce qu'il faut pour savoir où le cadre saute. */}
        {framing.shots.slice(1).map((plan) => (
          <span
            key={plan.key}
            aria-hidden
            className="absolute inset-y-2 w-px bg-foreground/25"
            style={{ left: `${toFraction(plan.shot.start) * 100}%` }}
          />
        ))}

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
            // La vignette reste dans la bande : centrée sur une position au ras
            // du bord, sa moitié sortirait du cadre et se ferait rogner —
            // vérifié à l'écran, sur le geste le plus courant, qui est justement
            // de tirer une oreille jusqu'au bout.
            style={{ left: `clamp(4rem, ${toFraction(drag.time) * 100}%, calc(100% - 4rem))` }}
          >
            <canvas
              ref={previewCanvas}
              width={160}
              height={90}
              className="block w-32 rounded-sm bg-zinc-950"
            />
            <span className="mt-0.5 block text-center font-mono text-[0.7rem] tabular-nums">
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
  return Math.min(29, Math.floor((time - Math.floor(time)) / FRAME_STEP))
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
  const position = useLecture((etat) => etat.position)
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
        'absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm bg-stage outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        active && 'ring-2 ring-ring',
      )}
      style={{ left: `${left * 100}%` }}
    >
      <span
        aria-hidden
        className="absolute top-1/2 left-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-stage-foreground/70"
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
function useFramePreview(drag: Drag | null) {
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
    source.addEventListener('seeked', onSeeked)
    return () => source.removeEventListener('seeked', onSeeked)
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
   * **L'élément remplacé, lui, relâche tout.** Son `seeked` n'arrivera jamais :
   * personne ne relâcherait le verrou, et plus aucune vignette ne se peindrait.
   * C'est le seul cas où la fin d'une recherche ne peut pas s'observer.
   * (relevé par Aristarque)
   */
  useEffect(() => {
    queued.current = null
    inFlight.current = false
  }, [mounted])

  return { setVideo, canvas }
}
