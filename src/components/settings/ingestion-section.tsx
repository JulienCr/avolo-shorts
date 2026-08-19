'use client'

import { RotateCcw } from 'lucide-react'
import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { type IngestionSettings } from '@/lib/api'

/**
 * La section « Source » des réglages : faut-il copier le replay en local avant
 * de l'exploiter ?
 *
 * **Le réglage existe parce que la règle qu'il remplace supposait le Drive.**
 * Tout le dépôt est écrit autour d'un `REPLAY_DIR` monté en 9p, lent et
 * capricieux, où une recopie de 45 secondes s'amortit dix fois. Cette
 * supposition ne tient plus dès que la source est déjà sur un disque rapide :
 * on paie alors une copie qui ne gagne rien, et plusieurs gigaoctets par
 * émission dans `stage/`.
 *
 * **La case dit son coût dans les deux sens**, et c'est ce qui la rend réglable
 * sans lire le code. Un libellé seul laisserait deviner lequel des deux états
 * est le rapide — et la réponse dépend d'où vit le fichier, donc personne ne
 * peut la deviner à notre place.
 *
 * **Changer un réglage ne recalcule rien**, comme le reste de cet écran : une
 * émission déjà analysée garde ses artefacts, et décocher n'efface aucune copie
 * — c'est le TTL de huit heures qui s'en charge.
 */

/** Le défaut du registre (`INGESTION_FIELD_SHAPES`, `src/server/db.ts`). */
const DEFAULT_COPY_SOURCE_LOCALLY = true

export function IngestionSection({
  values,
  onChange,
  disabled = false,
}: {
  values: IngestionSettings
  /**
   * Écrit le réglage. **Rend une promesse**, comme `SelectionSection` : l'écran
   * n'écrit pas en optimiste, donc un `PUT` refusé ne touche pas au cache et
   * `values` ne bouge pas. Sans cette promesse, la case garderait éternellement
   * l'état que le serveur vient de rejeter, sous un bandeau qui déclare qu'il
   * n'est pas enregistré.
   */
  onChange: (patch: Partial<IngestionSettings>) => void | Promise<unknown>
  /** Le temps qu'une lecture ou une écriture soit en vol. */
  disabled?: boolean
}) {
  const id = useId()
  const helpId = `${id}-help`

  // Le recalage pendant le rendu, pas dans un effet — le motif de
  // `SelectionSection` : un effet qui appelle `setState` repeindrait l'ancien
  // état une image avant le nouveau, et `react-hooks/set-state-in-effect` le
  // refuse.
  const value = values.copySourceLocally
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }

  /**
   * Écrit, et ramène l'état qui s'applique si le serveur refuse.
   *
   * Le rejet est consommé ici et non relevé : le bandeau de l'écran le porte
   * déjà, et un rejet non géré couperait le processus en développement.
   */
  function submit(next: boolean) {
    if (next === value) return
    setDraft(next)
    void Promise.resolve(onChange({ copySourceLocally: next })).catch(() => setDraft(value))
  }

  return (
    <section aria-labelledby="titre-source" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="titre-source" className="text-base font-semibold tracking-tight">
          Source
        </h2>
        <p className="text-sm text-muted-foreground">
          Comment le replay arrive jusqu’à l’encodage. Le réglage vaut pour toute
          la chaîne : le proxy, l’audio, le relevé des dimensions et l’export
          d’un clip.
        </p>
      </div>

      <div className="flex flex-col gap-1.5 rounded-xl border px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={draft}
              disabled={disabled}
              aria-describedby={helpId}
              onCheckedChange={(checked) => submit(checked === true)}
            />
            <Label htmlFor={id} className="text-sm font-medium">
              Copier la source en local avant de la traiter
            </Label>
          </div>

          {/* Le retour au défaut ne s'affiche que s'il y a quelque chose à
              défaire, comme dans la section du repérage : un bouton toujours
              présent et sans effet apprend à ne plus le lire. */}
          {value !== DEFAULT_COPY_SOURCE_LOCALLY && (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => submit(DEFAULT_COPY_SOURCE_LOCALLY)}
              className="ml-auto text-xs"
            >
              <RotateCcw aria-hidden />
              Revenir au défaut
            </Button>
          )}
        </div>
        <p id={helpId} className="text-xs text-muted-foreground">
          Coché, le replay est d’abord recopié dans <code>stage/</code> — environ
          45 s pour 4,3 Go depuis le Drive partagé — puis toutes les étapes lisent
          ce fichier local. C’est ce qu’il faut quand la source vit sur le Drive :
          il est monté en 9p, et l’analyse la relit une dizaine de fois. Décoché,
          rien n’est dupliqué et chaque étape relit l’original ; c’est le bon
          choix quand la source est déjà sur un disque rapide, et le mauvais
          sinon — l’extraction audio devient extrêmement lente sur un montage
          9p. Une copie déjà présente continue d’être utilisée dans les deux cas :
          décocher n’efface rien.
        </p>
      </div>
    </section>
  )
}
