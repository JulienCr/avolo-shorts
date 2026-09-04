'use client'

import { Check, CircleDashed, Hourglass, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import type { StepName } from '@/core/graph'
import { stepDurationRange, STEPS, LABELS_STEPS, type ShowSize } from '@/core/phase'
import type { Resource, Wait } from '@/core/resources'
import type { ProjectStatus } from '@/lib/api'
import { formatDuration, formatDurationRange } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'

type Running = NonNullable<ProjectStatus['running']>

/** The resource named in a sentence, with its article: « la carte graphique ». */
export const RESOURCE_LABEL: Record<Resource, string> = {
  gpu: 'la carte graphique',
  cpu: 'le processeur',
  net: 'le réseau',
}

/** The resource after « en attente », contracted: « du processeur ». */
export const RESOURCE_OF: Record<Resource, string> = {
  gpu: 'de la carte graphique',
  cpu: 'du processeur',
  net: 'du réseau',
}

/** The resource named on its own, for a badge: « carte graphique ». */
export const RESOURCE_NOUN: Record<Resource, string> = {
  gpu: 'carte graphique',
  cpu: 'processeur',
  net: 'réseau',
}

/**
 * How long a step has been waiting, in whole minutes.
 *
 * @param waitedMs - Measured elapsed wait, never predicted.
 */
function formatWait(waitedMs: number): string {
  // Same guard as `percent`: a non-finite value would print « depuis NaN min ».
  const minutes = Number.isFinite(waitedMs) ? Math.floor(waitedMs / 60_000) : 0
  return minutes < 1 ? 'depuis moins d’une minute' : `depuis ${minutes} min`
}

/**
 * The analysis progress, in its two forms — spec §3.2 for what it may carry.
 *
 * It enumerates no step name: it iterates `STEPS`, so adding a step to the
 * graph is one line of data and forgetting one breaks the type-check instead
 * of rendering « undefined en cours » (issue #39).
 *
 * Never a remaining time: the announced cost is a range sized to this show,
 * because a single measurement on a machine at 40-80 % variance carries none.
 */
export function PanelProgress({
  steps,
  running,
  runningAll,
  error,
  everRan,
  size,
  resume,
  shutdown,
}: {
  // No `phase` here: it would be a second source of truth over the two fields
  // it is itself made of, `error` and `running`.
  steps: Record<StepName, boolean>
  running: Running | null
  /**
   * Every step in flight, at most two: one local and one network step.
   *
   * Required rather than defaulted: a caller that forgets it would silently
   * render every step but the leading one as upcoming.
   */
  runningAll: Running[]
  /** Le message du serveur, ou `null`. Déjà épuré de ses chemins absolus. */
  error: string | null
  /** Distingue `'new'` d'`'interrupted'` (spec §12) ; ne change que le titre. */
  everRan: boolean
  /**
   * Ce qu'on sait de la taille de l'émission, pour dimensionner les durées.
   *
   * Les trois champs peuvent manquer et le panneau n'annonce alors rien — c'est
   * la règle qu'il tenait déjà : une absence se lit mieux qu'un chiffre inventé.
   */
  size: ShowSize
  /** Le bouton de reprise ou de départ. La page le fournit : c'est elle qui porte la mutation. */
  resume: ReactNode
  /**
   * Le bouton d'arrêt, quand une exécution tourne.
   *
   * **« Arrêter » et non « pause »** : rien ne reprend exactement un processus
   * là où il s'est interrompu. Ce qui est gardé, ce sont les artefacts déjà
   * terminés, et la reprise repart de la première étape manquante — ce que le
   * graphe fait déjà.
   */
  shutdown?: ReactNode
}) {
  const tracked = useTimeTracked(running !== null)
  // `progression()` reads a Map of the Next process, which a restart empties
  // without leaving an error — and development restarts on every edit.
  const toResume = running === null
  const all = runningAll
  const leadingWait = running?.waiting ?? null

  return (
    <section className="mx-auto w-full max-w-2xl rounded-xl border px-6 py-8">
      <h1 className="text-base font-semibold tracking-tight">
        {running !== null
          ? leadingWait !== null
            ? `L’analyse attend ${RESOURCE_LABEL[leadingWait.resource]}.`
            : 'L’analyse est en cours.'
          : error !== null
            ? 'La dernière analyse a échoué.'
            : everRan
              ? 'L’analyse s’est arrêtée.'
              : 'L’analyse n’a pas encore commencé.'}
      </h1>

      {running !== null && (
        <div className="mt-4">
          <Progress
            value={percent(running.progress)}
            aria-label={
              leadingWait !== null
                ? `${LABELS_STEPS[running.step]} en attente ${RESOURCE_OF[leadingWait.resource]}`
                : `${LABELS_STEPS[running.step]} en cours`
            }
          />
        </div>
      )}

      <ol className="mt-6 flex flex-col gap-1.5">
        {STEPS.map(({ name, label }) => {
          const entry = all.find((r) => r.step === name) ?? null
          const state = stateDStep(name, steps, entry)
          // La fourchette de **cette** émission, jamais une constante. Chaîne
          // vide quand l'étape n'a jamais été chronométrée, ou que l'émission
          // n'a pas encore livré sa durée.
          const range = formatDurationRange(stepDurationRange(name, size))
          return (
            <li
              key={name}
              data-testid={`step-${name}`}
              data-status={state}
              className={cn(
                'flex items-baseline gap-2 text-sm',
                state === 'upcoming' && 'text-muted-foreground',
              )}
            >
              <Marker state={state} />
              <span className={cn(state === 'running' && 'font-medium')}>{label}</span>
              {/* **L'état, en toutes lettres et pour les seuls lecteurs
                  d'écran.** L'icône est `aria-hidden`, `data-status` sert aux
                  tests et la couleur ne s'entend pas : sans ce mot, la liste
                  donnait les noms et les coûts sans dire ce qui est fait.
                  (relevé par Copilot) */}
              <span className="sr-only">{LABELS_STATE[state]}</span>
              {state === 'running' && entry !== null && (
                <span className="font-mono text-xs tabular-nums">{percent(entry.progress)} %</span>
              )}
              {state === 'queued' && entry?.waiting != null && (
                <span className="text-xs text-muted-foreground">
                  en attente {RESOURCE_OF[entry.waiting.resource]}{' '}
                  {formatWait(entry.waiting.waitedMs)}
                </span>
              )}
              {/* Le coût de cette émission-ci, jamais une estimation du
                  restant. Rien quand personne ne l'a chronométré, ni quand
                  l'ingestion n'a pas encore sondé la durée : une absence se lit
                  mieux qu'un chiffre inventé. */}
              {range !== '' && (
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                  {range}
                </span>
              )}
            </li>
          )
        })}
      </ol>
      <p className="mt-2 text-xs text-muted-foreground">
        Les durées sont proportionnées à cette émission, à partir d’une mesure
        prise sur une autre. Elles disent ce que coûte une étape, pas dans
        combien de temps elle finira.
      </p>

      <p data-testid="next" className="mt-6 text-sm">
        {thisWhichBecomesPossible(steps)}
      </p>

      {running !== null && (
        <p data-testid="elapsed" className="mt-1 text-sm text-muted-foreground">
          Analyse suivie depuis cet écran :{' '}
          <span className="font-mono tabular-nums">{formatDuration(tracked)}</span>
        </p>
      )}

      {error !== null && (
        <Alert variant="destructive" className="mt-5">
          <AlertTitle>Le message du serveur</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* **L'arrêt et la reprise ne coexistent jamais** : l'un s'adresse à une
          exécution qui tourne, l'autre à une exécution qui ne tourne plus. Les
          poser côte à côte demanderait de choisir, alors que l'état du projet a
          déjà choisi. */}
      {(toResume || shutdown != null) && (
        <div className="mt-5">{toResume ? resume : shutdown}</div>
      )}
    </section>
  )
}

/**
 * What a running analysis says out loud: step changes and the end, never
 * progress — the screen polls every two seconds.
 *
 * It sits above the layout, never inside the panel, which is unmounted at the
 * one moment worth announcing. And the text is computed during render, never
 * in an effect: `react-hooks/set-state-in-effect` forbids the reflex, and a
 * direct render already announces exactly what changed.
 */
export function AnnouncementDStep({
  running,
  steps,
  connu,
  everRan = true,
}: {
  running: { step: StepName; waiting?: Wait | null } | null
  steps: Record<StepName, boolean>
  /**
   * L'état du projet a-t-il répondu ?
   *
   * **Elle se tait tant qu'il n'a pas répondu**, et elle reste montée pour
   * autant. Se taire évite d'annoncer « l'analyse s'est arrêtée » sur le seul
   * fait qu'on ne sait encore rien ; rester montée est ce qui fait que le
   * premier vrai message, lui, sera bien annoncé — une région live n'annonce
   * que ce qui change pendant qu'elle est là.
   */
  connu: boolean
  /** Défaut `true`, comme dans `phaseProject` — voir spec §12. */
  everRan?: boolean
}) {
  const waiting = running?.waiting ?? null
  return (
    <p data-testid="announcement" aria-live="polite" className="sr-only">
      {!connu
        ? ''
        : running !== null
          ? waiting !== null
            ? `${LABELS_STEPS[running.step]} : en attente ${RESOURCE_OF[waiting.resource]}.`
            : `${LABELS_STEPS[running.step]} en cours.`
          : STEPS.every(({ name }) => steps[name] === true)
            ? 'L’analyse est terminée.'
            : everRan
              ? 'L’analyse s’est arrêtée.'
              : 'L’analyse n’a pas encore commencé.'}
    </p>
  )
}

/**
 * L'avancement replié, tel que la barre d'application le porte.
 *
 * C'est la forme du régime 2 : les propositions sont là, le proxy s'encode
 * encore, et la grille passe devant. Ce qui tourne reste lisible sans reprendre
 * la page.
 */
export function StripProgress({ running }: { running: { step: StepName; progress: number } }) {
  const part = percent(running.progress)
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <LoaderCircle className="size-3 animate-spin" aria-hidden />
      <span className="text-xs">{LABELS_STEPS[running.step]}</span>
      {/* La primitive, et pas un `role="progressbar"` réécrit à la main : ses
          quatre attributs ARIA vivaient dans un fichier de page, et cette barre
          est précisément le second endroit qui les demandait. */}
      <Progress
        value={part}
        aria-label={`${LABELS_STEPS[running.step]} en cours`}
        className="w-28"
      />
      <span className="font-mono tabular-nums">{part} %</span>
    </div>
  )
}

type StateDStep = 'done' | 'running' | 'queued' | 'upcoming'

const LABELS_STATE: Record<StateDStep, string> = {
  done: 'terminée',
  running: 'en cours',
  queued: 'en attente',
  upcoming: 'à venir',
}

function stateDStep(
  name: StepName,
  steps: Record<StepName, boolean>,
  entry: { step: StepName; waiting: Wait | null } | null,
): StateDStep {
  if (entry?.step === name) return entry.waiting !== null ? 'queued' : 'running'
  // `=== true` et non la vérité de la valeur : le relevé arrive du réseau, et
  // une étape que le client ne connaît pas encore y vaut `undefined`.
  return steps[name] === true ? 'done' : 'upcoming'
}

function Marker({ state }: { state: StateDStep }) {
  if (state === 'done') return <Check className="size-3.5 shrink-0 text-stage-foreground" aria-hidden />
  if (state === 'running') return <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
  // Never the running bar's spinner: an hourglass says the work is waiting,
  // not that it is moving.
  if (state === 'queued') return <Hourglass className="size-3.5 shrink-0 opacity-70" aria-hidden />
  return <CircleDashed className="size-3.5 shrink-0 opacity-50" aria-hidden />
}

/**
 * La progression en pourcentage entier, **bornée**.
 *
 * Elle vient d'une marque de temps de ffmpeg rapportée à une durée sondée : les
 * deux peuvent se contredire d'un cheveu en fin d'encodage, et un
 * `aria-valuenow` de 140 n'est pas une valeur valide.
 */
function percent(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return Math.round(Math.min(1, Math.max(0, progress)) * 100)
}

/**
 * Ce qui devient possible ensuite.
 *
 * **La seule chose qui compte au-delà de l'esthétique**, parce que c'est elle
 * qui détermine si Julien reste ou s'en va : les propositions arrivent avant les
 * images, donc le tri s'ouvre au tiers de l'attente. Et c'est **la cause qu'on
 * nomme, jamais une durée restante**.
 *
 * Elle ne cite que les deux étapes qui changent ce que l'utilisateur peut faire
 * — `candidates` ouvre le tri, `proxy` ouvre le montage —, comme `phaseProject`
 * et pour la même raison : c'est la seule formulation qui survive à l'ajout
 * d'étapes.
 */
function thisWhichBecomesPossible(steps: Record<StepName, boolean>): string {
  if (steps.candidates !== true) {
    return 'Les propositions arrivent avant les images : le tri s’ouvrira dès la fin du repérage, sans attendre le proxy.'
  }
  if (steps.proxy !== true) {
    return 'Le tri est ouvert. Les images et le montage arrivent avec le proxy, en cours d’encodage.'
  }
  return 'Tout est là : les propositions se trient et les clips gardés se montent.'
}

/**
 * Combien de temps cet écran a passé à regarder tourner l'analyse.
 *
 * **Ce n'est pas le temps écoulé depuis le lancement, et le libellé le dit.**
 * `ProjectStatus` ne publie pas l'instant du lancement : `status.json` porte un
 * `updatedAt` et un `finishedAt`, pas un `startedAt`, et la route ne le sert
 * pas. Sur un projet dont l'analyse a démarré avant qu'on ouvre l'écran, « temps
 * écoulé » serait donc une donnée inventée — et il n'y a rien de plus coûteux
 * qu'un chiffre faux à côté d'une attente de neuf minutes. Ce qu'on sait
 * mesurer, c'est le temps qu'on a passé à regarder.
 *
 * Il compte les secondes plutôt que de lire une horloge : `Date.now()` appelé
 * pendant le rendu rendrait le composant impur — la même entrée n'y donnerait
 * pas la même sortie.
 *
 * **Le battement s'arrête avec l'exécution et ne se remet pas à zéro** : ce
 * compteur mesure donc du temps d'analyse observé, et non du temps depuis
 * l'ouverture de la page. Une analyse qui s'arrête puis repart affiche moins que
 * l'horloge du mur, et c'est voulu — le libellé dit « analyse suivie depuis cet
 * écran », qui est exactement ce qui est compté.
 */
function useTimeTracked(active: boolean): number {
  const [seconds, setSeconds] = useState(0)
  // Ce que les périodes d'activité précédentes ont déjà compté. Dans une
  // référence : elle ne s'écrit qu'en effet, jamais pendant le rendu.
  const acquired = useRef(0)

  useEffect(() => {
    if (!active) return
    // **Recalculé depuis un instant de départ, jamais incrémenté d'une unité
    // par battement.** Un onglet en arrière-plan voit ses minuteurs étranglés à
    // une poignée de réveils par minute : un compteur qui ajoute une seconde
    // par réveil sous-estime alors durablement l'attente, et l'écran affirmerait
    // trois minutes là où neuf se sont écoulées. (relevé par Copilot)
    const start = Date.now()
    const elapsed = () => Math.round((Date.now() - start) / 1_000)
    const beat = window.setInterval(() => setSeconds(acquired.current + elapsed()), 1_000)
    return () => {
      // L'exécution s'arrête : on garde ce qu'elle a duré, sans quoi une reprise
      // repartirait de zéro et effacerait ce qu'on avait déjà suivi.
      acquired.current += elapsed()
      window.clearInterval(beat)
    }
  }, [active])

  return seconds
}
