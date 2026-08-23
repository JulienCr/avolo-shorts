'use client'

import { Check, CircleDashed, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import type { StepName } from '@/core/graph'
import { stepDurationRange, STEPS, LABELS_STEPS, type ShowSize } from '@/core/phase'
import { formatDuration, formatDurationRange } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'

/**
 * L'avancement de l'analyse, sous ses deux formes.
 *
 * **Le panneau porte quatre choses et pas une de plus** (spec §3.2) : l'étape en
 * cours et sa progression, la liste ordonnée des étapes avec celles déjà faites,
 * le temps écoulé, et une phrase qui dit ce qui devient possible ensuite.
 *
 * **Le temps restant n'est jamais affiché, et le coût annoncé est celui de
 * cette émission-ci.** Le panneau donnait cinq durées mesurées une seule fois
 * sur une émission d'1 h 40, à l'identique pour une capsule de vingt minutes :
 * `stepDurationRange` les rapporte à la taille de l'émission, et les rend en
 * fourchettes — « environ 2–3 min », jamais « 2 min 17 s restantes ». La
 * précision d'une seconde affirmerait ce qu'une mesure unique, sur une machine à
 * 40-80 % de variance, ne porte pas.
 *
 * **Il n'énumère aucun nom d'étape** : il itère `STEPS`, qui vit à côté de
 * `phaseProject`. Ajouter une étape au graphe est alors une ligne de données, et
 * en oublier une casse le type-check plutôt que d'afficher « undefined en
 * cours » (issue #39).
 */
export function PanelProgress({
  steps,
  running,
  error,
  everRan,
  size,
  resume,
  shutdown,
}: {
  // Pas de `phase` : elle serait redondante. `interrompu` et `failure` ne se
  // distinguent que par la présence d'`error`, et `wait` que par celle de
  // `running` — le panneau lit donc directement les deux champs dont la phase
  // elle-même est faite, sans se donner une seconde source de vérité.
  steps: Record<StepName, boolean>
  running: { step: StepName; progress: number } | null
  /** Le message du serveur, ou `null`. Déjà épuré de ses chemins absolus. */
  error: string | null
  /** Distingue `'neuf'` d'`'interrompu'` (spec §12) ; ne change que le titre. */
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
  // Une exécution morte ou échouée est la seule impasse réelle de l'interface :
  // `progression()` lit une `Map` du processus Next, qu'un redémarrage vide sans
  // laisser d'erreur, et il y a un redémarrage à chaque édition en
  // développement.
  const toResume = running === null

  return (
    <section className="mx-auto w-full max-w-2xl rounded-xl border px-6 py-8">
      <h1 className="text-base font-semibold tracking-tight">
        {running !== null
          ? 'L’analyse est en cours.'
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
            aria-label={`${LABELS_STEPS[running.step]} en cours`}
          />
        </div>
      )}

      <ol className="mt-6 flex flex-col gap-1.5">
        {STEPS.map(({ name, label }) => {
          const state = stateDStep(name, steps, running)
          // La fourchette de **cette** émission, jamais une constante. Chaîne
          // vide quand l'étape n'a jamais été chronométrée, ou que l'émission
          // n'a pas encore livré sa durée.
          const range = formatDurationRange(stepDurationRange(name, size))
          return (
            <li
              key={name}
              data-testid={`etape-${name}`}
              data-etat={state}
              className={cn(
                'flex items-baseline gap-2 text-sm',
                state === 'attendue' && 'text-muted-foreground',
              )}
            >
              <Marker state={state} />
              <span className={cn(state === 'encours' && 'font-medium')}>{label}</span>
              {/* **L'état, en toutes lettres et pour les seuls lecteurs
                  d'écran.** L'icône est `aria-hidden`, `data-etat` sert aux
                  tests et la couleur ne s'entend pas : sans ce mot, la liste
                  donnait les noms et les coûts sans dire ce qui est fait.
                  (relevé par Copilot) */}
              <span className="sr-only">{LABELS_STATE[state]}</span>
              {state === 'encours' && running !== null && (
                <span className="font-mono text-xs tabular-nums">
                  {percent(running.progress)} %
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

      <p data-testid="ensuite" className="mt-6 text-sm">
        {thisWhichBecomesPossible(steps)}
      </p>

      {running !== null && (
        <p data-testid="ecoule" className="mt-1 text-sm text-muted-foreground">
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
 * Ce qui se dit à voix haute d'une analyse en cours.
 *
 * **Elle n'annonce que les changements d'étape, et la fin.** L'écran interroge
 * l'état toutes les deux secondes : une région live posée sur le pourcentage
 * produirait une annonce toutes les deux secondes pendant neuf minutes. Le
 * `progressbar`, lui, met `aria-valuenow` à jour en silence. `ÉTAPES` en compte
 * cinq : six annonces sur toute l'analyse, la fin comprise.
 *
 * **Elle se pose au-dessus de la disposition, jamais dans le panneau.** Le
 * panneau disparaît au moment précis où le repérage rend ses propositions — la
 * grille le remplace —, donc une région qui vivrait dedans serait démontée
 * pendant le seul changement qui vaille d'être annoncé. Une région live n'annonce
 * que ce qui change **pendant qu'elle est là**.
 *
 * **Le texte s'ajuste pendant le rendu, pas dans un effet.** Comparer l'étape
 * précédente dans un `useEffect` pour poser un message d'état est le réflexe, et
 * il est interdit ici (`react-hooks/set-state-in-effect`) — pour une bonne
 * raison : React ne réécrit le nœud de texte que si son contenu a changé, donc
 * un rendu direct annonce déjà exactement les changements, sans second état à
 * tenir d'accord.
 */
export function AnnouncementDStep({
  running,
  steps,
  connu,
  everRan = true,
}: {
  running: { step: StepName } | null
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
  return (
    <p data-testid="annonce" aria-live="polite" className="sr-only">
      {!connu
        ? ''
        : running !== null
          ? `${LABELS_STEPS[running.step]} en cours.`
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

type StateDStep = 'faite' | 'encours' | 'attendue'

const LABELS_STATE: Record<StateDStep, string> = {
  faite: 'terminée',
  encours: 'en cours',
  attendue: 'à venir',
}

function stateDStep(
  name: StepName,
  steps: Record<StepName, boolean>,
  running: { step: StepName } | null,
): StateDStep {
  if (running?.step === name) return 'encours'
  // `=== true` et non la vérité de la valeur : le relevé arrive du réseau, et
  // une étape que le client ne connaît pas encore y vaut `undefined`.
  return steps[name] === true ? 'faite' : 'attendue'
}

function Marker({ state }: { state: StateDStep }) {
  if (state === 'faite') return <Check className="size-3.5 shrink-0 text-stage-foreground" aria-hidden />
  if (state === 'encours') return <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
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
 * — `candidates` ouvre le tri, `proxy` ouvre le montage —, comme `phaseProjet`
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
