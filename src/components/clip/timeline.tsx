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

  const draggingHandle = drag !== null && drag.edge !== null
  const { video: previewVideo, canvas: previewCanvas } = useFramePreview(proxyUrl, drag)

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
    setDrag((current) => {
      if (current === null) return null
      if (current.edge === null) onScrub(current.time)
      else onBoundary(current.time, current.edge)
      return null
    })
  }, [onScrub, onBoundary])

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
        className="relative h-12 w-full touch-none rounded-md bg-muted/60 select-none"
        onPointerDown={(e) => {
          // La bande nue promène la tête de lecture. Les oreilles arrêtent la
          // propagation : le même appui ne peut pas vouloir les deux.
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

        <Playhead view={view} ghost={ghost} />

        <Handle
          edge="start"
          time={inTime}
          left={toFraction(inTime)}
          active={drag?.edge === 'start'}
          onGrab={(clientX) => moveTo(clientX, 'start')}
          onStep={(step) =>
            onBoundary(clampEdge(clampToSource(bounds.start + step, limit), 'start'), 'start')
          }
          min={view.start}
          max={view.end}
        />
        <Handle
          edge="end"
          time={outTime}
          left={toFraction(outTime)}
          active={drag?.edge === 'end'}
          onGrab={(clientX) => moveTo(clientX, 'end')}
          onStep={(step) =>
            onBoundary(clampEdge(clampToSource(bounds.end + step, limit), 'end'), 'end')
          }
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
            style={{ left: `${toFraction(drag.time) * 100}%` }}
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
          ref={previewVideo}
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
}: {
  view: { start: number; end: number }
  /** La position promenée par un glissé, tant qu'elle n'est pas confiée au lecteur. */
  ghost: number | null
}) {
  const position = useLecture((etat) => etat.position)
  const time = ghost ?? position
  const left = Math.min(Math.max((time - view.start) / (view.end - view.start), 0), 1)
  return (
    <span
      aria-hidden
      className={cn(
        'absolute inset-y-0 w-0.5 rounded-full',
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
      aria-valuenow={Math.round(time)}
      aria-valuetext={formatTimecode(time)}
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
function useFramePreview(proxyUrl: string | null, drag: Drag | null) {
  const video = useRef<HTMLVideoElement>(null)
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
    if (source === null) return
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
  }, [paint, proxyUrl])

  const time = drag?.time ?? null
  useEffect(() => {
    const source = video.current
    if (source === null || time === null || !Number.isFinite(time)) return
    if (inFlight.current) {
      queued.current = time
      return
    }
    inFlight.current = true
    source.currentTime = time
  }, [time])

  // Le geste fini, la file se vide : une recherche restée en attente ferait
  // repartir le décodeur pour une image que plus personne ne regarde.
  useEffect(() => {
    if (drag === null) {
      queued.current = null
      inFlight.current = false
    }
  }, [drag])

  return { video, canvas }
}
