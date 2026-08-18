'use client'

import { Check, CircleDashed, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import type { StepName } from '@/core/graph'
import { ÉTAPES, LIBELLES_ETAPES } from '@/core/parcours'
import { formatDuration } from '@/lib/format'
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
 * **Le temps restant n'est jamais affiché.** Le coût d'une étape est une mesure
 * — « le proxy coûte environ 6 min sur 1 h 40 d'émission » — ; le restant est une
 * extrapolation à partir de deux points sur une seule émission, et une
 * estimation fausse coûte plus cher qu'une absence d'estimation.
 *
 * **Il n'énumère aucun nom d'étape** : il itère `ÉTAPES`, qui vit à côté de
 * `phaseProjet`. Ajouter une étape au graphe est alors une ligne de données, et
 * en oublier une casse le type-check plutôt que d'afficher « undefined en
 * cours » (issue #39).
 */
export function PanneauAvancement({
  steps,
  running,
  erreur,
  reprise,
}: {
  // Pas de `phase` : elle serait redondante. `interrompu` et `echec` ne se
  // distinguent que par la présence d'`erreur`, et `attente` que par celle de
  // `running` — le panneau lit donc directement les deux champs dont la phase
  // elle-même est faite, sans se donner une seconde source de vérité.
  steps: Record<StepName, boolean>
  running: { step: StepName; progress: number } | null
  /** Le message du serveur, ou `null`. Déjà épuré de ses chemins absolus. */
  erreur: string | null
  /** Le bouton de reprise. La page le fournit : c'est elle qui porte la mutation. */
  reprise: ReactNode
}) {
  const écoulé = useTempsÉcoulé(running)
  // Une exécution morte ou échouée est la seule impasse réelle de l'interface :
  // `progression()` lit une `Map` du processus Next, qu'un redémarrage vide sans
  // laisser d'erreur, et il y a un redémarrage à chaque édition en
  // développement.
  const àReprendre = running === null

  return (
    <section className="mx-auto w-full max-w-2xl rounded-xl border px-6 py-8">
      <h1 className="text-base font-semibold tracking-tight">
        {running !== null
          ? 'L’analyse est en cours.'
          : erreur !== null
            ? 'La dernière analyse a échoué.'
            : 'L’analyse s’est arrêtée.'}
      </h1>

      {/* **Une région polie, et elle n'annonce que l'étape.** L'écran interroge
          l'état toutes les deux secondes : une région live posée sur le
          pourcentage produirait une annonce toutes les deux secondes pendant
          neuf minutes. Quatre annonces sur toute l'analyse suffisent. */}
      <p data-testid="annonce" aria-live="polite" className="sr-only">
        {running !== null ? `${LIBELLES_ETAPES[running.step]} en cours.` : 'Aucune étape en cours.'}
      </p>

      {running !== null && (
        <div className="mt-4">
          <Progress
            value={pourcent(running.progress)}
            aria-label={`${LIBELLES_ETAPES[running.step]} en cours`}
          />
        </div>
      )}

      <ol className="mt-6 flex flex-col gap-1.5">
        {ÉTAPES.map(({ nom, libelle, coûtSec }) => {
          const état = étatDÉtape(nom, steps, running)
          return (
            <li
              key={nom}
              data-testid={`etape-${nom}`}
              data-etat={état}
              className={cn(
                'flex items-baseline gap-2 text-sm',
                état === 'attendue' && 'text-muted-foreground',
              )}
            >
              <Marque état={état} />
              <span className={cn(état === 'encours' && 'font-medium')}>{libelle}</span>
              {état === 'encours' && running !== null && (
                <span className="font-mono text-xs tabular-nums">
                  {pourcent(running.progress)} %
                </span>
              )}
              {/* Le coût **mesuré**, jamais une estimation du restant. Rien
                  quand personne ne l'a chronométré : une absence se lit mieux
                  qu'un chiffre inventé. */}
              {coûtSec !== null && (
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                  environ {formatCoût(coûtSec)}
                </span>
              )}
            </li>
          )
        })}
      </ol>
      <p className="mt-2 text-xs text-muted-foreground">
        Les coûts sont mesurés sur une émission d’1 h 40. Ils décrivent le prix
        d’une étape, jamais une durée d’attente.
      </p>

      <p data-testid="ensuite" className="mt-6 text-sm">
        {ceQuiDevientPossible(steps)}
      </p>

      {écoulé !== null && (
        <p data-testid="ecoule" className="mt-1 text-sm text-muted-foreground">
          {écoulé.depuisLeLancement ? 'Temps écoulé' : 'Suivi depuis l’ouverture de cet écran'} :{' '}
          <span className="font-mono tabular-nums">{formatDuration(écoulé.secondes)}</span>
        </p>
      )}

      {erreur !== null && (
        <Alert variant="destructive" className="mt-5">
          <AlertTitle>Le message du serveur</AlertTitle>
          <AlertDescription>{erreur}</AlertDescription>
        </Alert>
      )}

      {àReprendre && <div className="mt-5">{reprise}</div>}
    </section>
  )
}

/**
 * L'avancement replié, tel que la barre d'application le porte.
 *
 * C'est la forme du régime 2 : les propositions sont là, le proxy s'encode
 * encore, et la grille passe devant. Ce qui tourne reste lisible sans reprendre
 * la page.
 */
export function BandeAvancement({ running }: { running: { step: StepName; progress: number } }) {
  const part = pourcent(running.progress)
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-3 animate-spin" aria-hidden />
      <span className="text-xs">{LIBELLES_ETAPES[running.step]}</span>
      <span
        role="progressbar"
        aria-valuenow={part}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${LIBELLES_ETAPES[running.step]} en cours`}
        className="h-1 w-28 overflow-hidden rounded-full bg-muted"
      >
        <span
          className="block h-full bg-stage transition-[width]"
          style={{ width: `${part}%` }}
        />
      </span>
      <span className="font-mono tabular-nums">{part} %</span>
    </div>
  )
}

type ÉtatDÉtape = 'faite' | 'encours' | 'attendue'

function étatDÉtape(
  nom: StepName,
  steps: Record<StepName, boolean>,
  running: { step: StepName } | null,
): ÉtatDÉtape {
  if (running?.step === nom) return 'encours'
  // `=== true` et non la vérité de la valeur : le relevé arrive du réseau, et
  // une étape que le client ne connaît pas encore y vaut `undefined`.
  return steps[nom] === true ? 'faite' : 'attendue'
}

function Marque({ état }: { état: ÉtatDÉtape }) {
  if (état === 'faite') return <Check className="size-3.5 shrink-0 text-stage-foreground" aria-hidden />
  if (état === 'encours') return <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
  return <CircleDashed className="size-3.5 shrink-0 opacity-50" aria-hidden />
}

/**
 * La progression en pourcentage entier, **bornée**.
 *
 * Elle vient d'une marque de temps de ffmpeg rapportée à une durée sondée : les
 * deux peuvent se contredire d'un cheveu en fin d'encodage, et un
 * `aria-valuenow` de 140 n'est pas une valeur valide.
 */
function pourcent(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return Math.round(Math.min(1, Math.max(0, progress)) * 100)
}

/** Un coût mesuré, en ordre de grandeur : la seconde près ne renseigne personne. */
function formatCoût(secondes: number): string {
  if (secondes < 90) return `${Math.round(secondes)} s`
  return `${Math.round(secondes / 60)} min`
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
function ceQuiDevientPossible(steps: Record<StepName, boolean>): string {
  if (steps.candidates !== true) {
    return 'Les propositions arrivent avant les images : le tri s’ouvrira dès la fin du repérage, sans attendre le proxy.'
  }
  if (steps.proxy !== true) {
    return 'Le tri est ouvert. Les images et le montage arrivent avec le proxy, en cours d’encodage.'
  }
  return 'Tout est là : les propositions se trient et les clips gardés se montent.'
}

/**
 * Depuis combien de temps ça tourne.
 *
 * **Ce qu'on sait mesurer, c'est le temps depuis qu'on regarde.**
 * `ProjectStatus` ne publie pas l'instant du lancement : `status.json` porte un
 * `updatedAt` et un `finishedAt`, pas un `startedAt`, et la route ne le sert pas.
 * Arriver sur un écran dont l'exécution a commencé avant nous ne permet donc pas
 * de dire « temps écoulé » — le dire quand même serait inventer une donnée. On
 * distingue les deux cas, et le libellé change avec.
 */
function useTempsÉcoulé(
  running: { step: StepName } | null,
): { secondes: number; depuisLeLancement: boolean } | null {
  const départ = useRef<{ instant: number; depuisLeLancement: boolean } | null>(null)
  const tournait = useRef<boolean | null>(null)
  const [, retracer] = useState(0)

  const tourne = running !== null
  if (tourne && départ.current === null) {
    // Vrai seulement si on a vu l'exécution démarrer : au tout premier relevé,
    // elle peut très bien tourner depuis huit minutes.
    départ.current = { instant: Date.now(), depuisLeLancement: tournait.current === false }
  }
  if (!tourne) départ.current = null
  tournait.current = tourne

  useEffect(() => {
    if (!tourne) return
    const battement = window.setInterval(() => retracer((n) => n + 1), 1_000)
    return () => window.clearInterval(battement)
  }, [tourne])

  if (départ.current === null) return null
  return {
    secondes: Math.max(0, (Date.now() - départ.current.instant) / 1000),
    depuisLeLancement: départ.current.depuisLeLancement,
  }
}
