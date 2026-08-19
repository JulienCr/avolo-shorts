'use client'

import { RefreshCw, RotateCcw, Square } from 'lucide-react'
import { useState } from 'react'

import { ApiError, RESUME_TARGETS } from '@/lib/api'
import { useRetry, useStopAnalysis } from '@/lib/queries'
import { agreement } from '@/components/review/template'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * Les deux gestes qui redemandent du travail au serveur.
 *
 * Ils ne diffèrent que par leurs cibles et par ce qu'ils détruisent, mais cette
 * différence commande tout le reste : la reprise **répare** — elle ne détruit
 * rien, donc elle ne se confirme pas —, la relance forcée **remplace** les
 * propositions en attente, donc elle énonce le partage avant.
 *
 * Et son inverse, `StopButton`, qui rend le travail au serveur.
 */

const REASON_IN_CURRENT = 'Une exécution est déjà en cours ; la relance sera possible à sa fin.'

/**
 * Le bouton de reprise. **L'ajout qui ferme la seule impasse réelle de
 * l'interface.**
 *
 * `progression()` lit une `Map` du processus Next : un redémarrage du serveur —
 * et il y en a un à chaque édition en développement — laisse un projet à moitié
 * analysé, sans erreur, sans rien qui tourne et sans recours. C'est
 * `Analyse: 'interrompu'`.
 *
 * **Il vise `CIBLES_DE_REPRISE`, importé et jamais recopié.** Une cible nomme un
 * résultat à atteindre, pas une étape à refaire : viser la première étape
 * absente reconstruirait celle-là et s'arrêterait, et viser `candidates` seul ne
 * construirait jamais le proxy, puisque rien n'en dépend dans le graphe. La
 * liste écrite à la main est justement la maladie que l'issue #39 a fermée.
 */
export function ButtonResume({ projectId, inCurrent }: { projectId: string; inCurrent: boolean }) {
  const retry = useRetry()
  const blocked = inCurrent || retry.isPending

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant="default"
        aria-disabled={blocked}
        onClick={() => {
          if (blocked) return
          retry.mutate({ projectId, targets: RESUME_TARGETS })
        }}
      >
        <RotateCcw aria-hidden />
        Reprendre l’analyse
      </Button>
      <Reason blocked={blocked} inCurrent={inCurrent} />
      <RetryFailure error={retry.error} />
    </div>
  )
}

/**
 * Arrêter l'analyse en cours.
 *
 * **« Arrêter » et non « pause », et le mot n'est pas cosmétique.** Rien ne
 * reprend un processus exactement là où il s'est interrompu : ffmpeg est tué,
 * WhisperX aussi, et ce qui repart repart du début de son étape. Un bouton
 * « pause » promettrait une reprise au milieu du proxy, et personne ne le
 * découvrirait avant d'avoir attendu six minutes de plus.
 *
 * **Ce qui est déjà sur le disque reste**, et la reprise repart de la première
 * étape manquante — c'est le graphe qui le fait, sans que cet écran ait à
 * énumérer quoi que ce soit.
 *
 * **Aucune confirmation.** L'arrêt ne détruit aucun artefact ni aucune décision
 * humaine : il rend du temps de calcul, et le geste inverse est à un clic. Une
 * boîte de dialogue ne protégerait rien et retarderait le seul geste que
 * quelqu'un qui vient de lancer la mauvaise émission veut faire vite.
 *
 * **`stopped: false` est un succès.** C'est ce que rend la route quand rien ne
 * tournait — l'analyse venait de finir, ou un redémarrage du serveur a emporté
 * l'exécution. Le dire comme un échec ferait chercher un défaut là où il n'y a
 * qu'une course perdue de quelques secondes ; l'écran ne montre donc rien de
 * particulier, et le sondage suivant dit la vérité.
 */
export function StopButton({
  projectId,
  compact = false,
}: {
  projectId: string
  /**
   * La forme que porte la barre d'application quand le panneau s'est replié.
   *
   * Même geste, même mutation, moins de place — et l'échec en une ligne plutôt
   * qu'en bandeau, parce qu'une alerte dans une barre de douze unités de haut
   * la ferait grandir sous le contenu.
   */
  compact?: boolean
}) {
  const stop = useStopAnalysis()

  const button = (
    <Button
      variant="outline"
      size={compact ? 'sm' : 'default'}
      aria-disabled={stop.isPending}
      onClick={() => {
        if (stop.isPending) return
        stop.mutate(projectId)
      }}
    >
      <Square aria-hidden />
      Arrêter l’analyse
    </Button>
  )

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        {button}
        {stop.isError && (
          // **Le message du serveur est dans le DOM, `truncate` ne borne que la
          // largeur.** La forme compacte est le seul contrôle d'arrêt tant que
          // la grille est visible — c'est-à-dire pendant les six minutes de
          // proxy —, et y perdre la cause laissait « l'arrêt n'est pas parti »
          // sans rien pour savoir pourquoi. Le `title` la rend au survol, le
          // lecteur d'écran la lit en entier. (relevé par Copilot)
          <span
            role="alert"
            title={stop.error.message}
            className="max-w-48 truncate text-xs text-destructive"
          >
            L’arrêt n’est pas parti : {stop.error.message}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {button}
      {stop.isPending && (
        <p className="max-w-xs text-xs text-muted-foreground">Demande en cours d’envoi.</p>
      )}
      {stop.isError && (
        <Alert variant="destructive" className="max-w-sm">
          <AlertDescription>L’arrêt n’est pas parti : {stop.error.message}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

/**
 * Le repérage forcé, et sa confirmation.
 *
 * **Elle énonce exactement le partage.** `mergeCandidates` garde tout ce qui est
 * humain — gardés comme écartés — et remplace ce qui ne l'est pas. Une
 * confirmation qui ne dit pas ce qui va disparaître ne fait que retarder le
 * clic ; celle-ci dit les deux moitiés, avec leurs comptes.
 */
export function ButtonRetry({
  projectId,
  count,
  inCurrent,
}: {
  projectId: string
  count: { guards: number; discarded: number; aSort: number }
  inCurrent: boolean
}) {
  const retry = useRetry()
  const [open, setOpen] = useState(false)
  const blocked = inCurrent || retry.isPending

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        variant="outline"
        size="sm"
        aria-disabled={blocked}
        onClick={() => {
          if (blocked) return
          setOpen(true)
        }}
      >
        <RefreshCw aria-hidden />
        Relancer le repérage
      </Button>
      <Reason blocked={blocked} inCurrent={inCurrent} />
      <RetryFailure error={retry.error} />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Relancer le repérage ?</DialogTitle>
            <DialogDescription>
              Le modèle reprend l’émission depuis le transcript et propose une
              nouvelle série d’extraits.
            </DialogDescription>
          </DialogHeader>

          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            <li>
              Vos décisions sont conservées : {agreement(count.guards, 'clip gardé', 'clips gardés')}{' '}
              et {agreement(count.discarded, 'écarté', 'écartés')}.
            </li>
            <li>
              {agreement(count.aSort, 'proposition en attente', 'propositions en attente')}{' '}
              {count.aSort <= 1 ? 'est remplacée' : 'sont remplacées'}.
            </li>
          </ul>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Annuler</DialogClose>
            <Button
              onClick={() => {
                setOpen(false)
                // `force: true` vaut « les cibles » : c'est le cas courant —
                // redemander d'autres propositions sans avoir changé un
                // paramètre, sur un artefact pourtant présent.
                retry.mutate({ projectId, targets: 'candidates', force: true })
              }}
            >
              Relancer le repérage
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * La raison d'un contrôle inerte, **écrite à côté de lui**.
 *
 * Jamais dans une bulle d'aide : une bulle qui n'apparaît qu'au survol est
 * invisible au clavier, et la raison d'un blocage doit se lire avant d'essayer,
 * pas après avoir cherché pourquoi rien ne se passe.
 */
function Reason({ blocked, inCurrent }: { blocked: boolean; inCurrent: boolean }) {
  if (!blocked) return null
  return (
    <p data-testid="raison-relance" className="max-w-xs text-xs text-muted-foreground">
      {inCurrent ? REASON_IN_CURRENT : 'Demande en cours d’envoi.'}
    </p>
  )
}

/**
 * L'échec d'une relance.
 *
 * **Un 409 n'est pas une panne**, c'est une course perdue : une autre exécution
 * a démarré entre l'affichage de l'écran et le clic. Le dire comme un échec
 * ferait chercher un défaut là où il suffit d'attendre.
 */
function RetryFailure({ error }: { error: Error | null }) {
  if (error === null) return null
  const conflict = error instanceof ApiError && error.status === 409
  return (
    <Alert variant="destructive" className="max-w-sm">
      <AlertDescription>
        {conflict
          ? 'Une exécution tourne déjà sur ce projet ; l’écran la suivra dès qu’elle se signalera.'
          : `La relance n’est pas partie : ${error.message}`}
      </AlertDescription>
    </Alert>
  )
}
