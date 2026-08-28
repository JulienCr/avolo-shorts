'use client'

import { TriangleAlert } from 'lucide-react'

import { unmeasuredShots, shotRatios, anyShotSplit } from '@/components/clip/framing'
import { deriveDeliveryState, FieldCopyable, OutputsList, ButtonCopy } from '@/components/clip/export-panel'
import { Button } from '@/components/ui/button'
import { outputNames, publicationText } from '@/components/clip/texts'
import { wordsHash, composeDescription, clipExportEligibility } from '@/core/publication'
import type { Clip } from '@/core/edl'
import type { ClipOutputs, PublishedFraming } from '@/lib/api'

/**
 * La vue Exports : la livraison courante, et rien d'inventé.
 *
 * **Le dépôt ne conserve aucune version** : quatre tables, aucune pour les
 * rendus, des fichiers nommés par l'identifiant du clip donc écrasés à chaque
 * export. Cette vue montre donc ce qui est livré maintenant — le même parti
 * que la publication, préparée à vide avant ses connecteurs.
 */
export function ExportsView({
  clip,
  outputs,
  framing,
  descriptionFooter,
  onReexport,
  reexportDisabled,
}: {
  /** Le clip **du serveur** : titre, description, marques. */
  clip: Clip
  outputs: ClipOutputs
  /** Le cadrage que le serveur publie : ratio résolu, crop par plan. */
  framing: PublishedFraming
  /**
   * `publication.descriptionFooter`, composé avec la description du clip.
   * `undefined` tant que les réglages n'ont pas répondu — jamais confondu
   * avec un pied de page réellement vide, sous peine de composer et laisser
   * copier un texte de publication incomplet.
   */
  descriptionFooter: string | undefined
  /**
   * Force un nouveau rendu même sur un clip que le système dit à jour.
   *
   * **L'échappatoire qu'aucun champ de `VERSION_FINGERPRINT` ne remplace** :
   * rien dans cette empreinte ne porte la recette ffmpeg, donc un changement de
   * graphe sans bascule de version laisse un clip se dire à jour à tort. Sans
   * ce bouton, rien ne rattrape ce cas.
   */
  onReexport: () => void
  reexportDisabled: boolean
}) {
  const state = deriveDeliveryState(clip.status, outputs)
  const native = framing.ratio
  const names = outputNames(clip.id, native)
  const shotCount = framing.shots.length
  const unmeasured = unmeasuredShots(framing)
  const frames = shotRatios(framing)
  const split = names.variant9x16 !== null && anyShotSplit(framing)
  const eligibility = clipExportEligibility(state === 'delivered')
  const composedDescription =
    descriptionFooter === undefined ? undefined : composeDescription(clip, { footer: descriptionFooter })
  const nothingDelivered = outputs.mp4Url === null && outputs.variant9x16Url === null && outputs.textsUrl === null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6 workbench:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-medium">Livraison courante</h2>
          <span className="font-mono text-[0.75rem] text-muted-foreground">{native}</span>
        </div>
        <p className="text-[0.75rem] text-muted-foreground">
          Une seule version est conservée : un nouvel export remplace la précédente.
        </p>

        <p className="text-[0.75rem] text-muted-foreground">
          {shotCount === 1 ? '1 plan' : `${shotCount} plans`}, cadrés{' '}
          <span className="font-mono">{frames.join(', ') || '—'}</span>
          {frames.length > 1 && ' selon le plan, dans la variante 9:16'}
          {split && ' — dont au moins un en split-screen, deux personnes empilées sur la variante'}
        </p>

        {clip.title.trim() === '' && (
          <p className="flex items-start gap-1.5 text-[0.75rem] text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Le titre est vide : le fichier de textes sortira avec « (sans titre) ».
          </p>
        )}

        {unmeasured > 0 && (
          <p className="text-[0.75rem] text-amber-500 dark:text-amber-400">
            {unmeasured === 1
              ? '1 plan sans mesure, centré par défaut'
              : `${unmeasured} plans sans mesure, centrés par défaut`}
          </p>
        )}

        {!eligibility.eligible && (
          <p className="text-[0.75rem] text-muted-foreground">{eligibility.reason}</p>
        )}

        <OutputsList names={names} native={native} outputs={outputs} />

        {nothingDelivered ? (
          <p className="text-[0.75rem] text-muted-foreground">Aucun fichier livré pour ce clip.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {outputs.mp4Url !== null && (
              <video
                aria-label={`Le rendu ${native} de ${clip.title || 'ce clip'}`}
                src={outputs.mp4Url}
                controls
                preload="metadata"
                className="max-h-[70vh] w-auto rounded-lg bg-zinc-950"
              />
            )}
            {outputs.variant9x16Url !== null && (
              <video
                aria-label="Variante 9:16"
                src={outputs.variant9x16Url}
                controls
                preload="metadata"
                className="max-h-[70vh] w-auto rounded-lg bg-zinc-950"
              />
            )}
          </div>
        )}

        {state === 'delivered' && (
          <Button
            variant="outline"
            onClick={() => !reexportDisabled && onReexport()}
            aria-disabled={reexportDisabled || undefined}
            className="w-fit"
          >
            Forcer un nouvel export
          </Button>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <h3 className="text-sm font-medium">Textes de publication</h3>
        <FieldCopyable tag="Titre" value={clip.title.trim()} />
        <FieldCopyable
          tag="Description"
          value={composedDescription ?? ''}
          lines={6}
          disabled={composedDescription === undefined}
        />
        <FieldCopyable
          tag="Mots-dièse"
          value={
            composedDescription === undefined
              ? ''
              : wordsHash(`${clip.title.trim()}\n${composedDescription}`).join(' ')
          }
          disabled={composedDescription === undefined}
        />
        <ButtonCopy
          text={descriptionFooter === undefined ? '' : publicationText(clip, { footer: descriptionFooter })}
          disabled={descriptionFooter === undefined}
          label="Copier pour publication"
        />
      </div>
    </div>
  )
}
