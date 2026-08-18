'use client'

import { RefreshCw, RotateCcw } from 'lucide-react'
import { useState } from 'react'

import { ApiError, CIBLES_DE_REPRISE } from '@/lib/api'
import { useRelancer } from '@/lib/queries'
import { accord } from '@/components/tri/modele'
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
 */

const RAISON_EN_COURS = 'Une exécution est déjà en cours ; la relance sera possible à sa fin.'

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
export function BoutonReprise({ projectId, enCours }: { projectId: string; enCours: boolean }) {
  const relance = useRelancer()
  const bloqué = enCours || relance.isPending

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant="default"
        aria-disabled={bloqué}
        onClick={() => {
          if (bloqué) return
          relance.mutate({ projectId, targets: CIBLES_DE_REPRISE })
        }}
      >
        <RotateCcw aria-hidden />
        Reprendre l’analyse
      </Button>
      <Raison bloqué={bloqué} enCours={enCours} />
      <ÉchecDeRelance erreur={relance.error} />
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
export function BoutonRelance({
  projectId,
  compte,
  enCours,
}: {
  projectId: string
  compte: { gardes: number; ecartes: number; aTrier: number }
  enCours: boolean
}) {
  const relance = useRelancer()
  const [ouvert, setOuvert] = useState(false)
  const bloqué = enCours || relance.isPending

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        variant="outline"
        size="sm"
        aria-disabled={bloqué}
        onClick={() => {
          if (bloqué) return
          setOuvert(true)
        }}
      >
        <RefreshCw aria-hidden />
        Relancer le repérage
      </Button>
      <Raison bloqué={bloqué} enCours={enCours} />
      <ÉchecDeRelance erreur={relance.error} />

      <Dialog open={ouvert} onOpenChange={setOuvert}>
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
              Vos décisions sont conservées : {accord(compte.gardes, 'clip gardé', 'clips gardés')}{' '}
              et {accord(compte.ecartes, 'écarté', 'écartés')}.
            </li>
            <li>
              {accord(compte.aTrier, 'proposition en attente', 'propositions en attente')}{' '}
              {compte.aTrier <= 1 ? 'est remplacée' : 'sont remplacées'}.
            </li>
          </ul>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Annuler</DialogClose>
            <Button
              onClick={() => {
                setOuvert(false)
                // `force: true` vaut « les cibles » : c'est le cas courant —
                // redemander d'autres propositions sans avoir changé un
                // paramètre, sur un artefact pourtant présent.
                relance.mutate({ projectId, targets: 'candidates', force: true })
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
function Raison({ bloqué, enCours }: { bloqué: boolean; enCours: boolean }) {
  if (!bloqué) return null
  return (
    <p data-testid="raison-relance" className="max-w-xs text-xs text-muted-foreground">
      {enCours ? RAISON_EN_COURS : 'Demande en cours d’envoi.'}
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
function ÉchecDeRelance({ erreur }: { erreur: Error | null }) {
  if (erreur === null) return null
  const conflit = erreur instanceof ApiError && erreur.status === 409
  return (
    <Alert variant="destructive" className="max-w-sm">
      <AlertDescription>
        {conflit
          ? 'Une exécution tourne déjà sur ce projet ; l’écran la suivra dès qu’elle se signalera.'
          : `La relance n’est pas partie : ${erreur.message}`}
      </AlertDescription>
    </Alert>
  )
}
