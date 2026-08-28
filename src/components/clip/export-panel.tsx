'use client'

import { Check, Copy, Send } from 'lucide-react'
import { useState } from 'react'

import type { Ratio } from '@/core/edl'
import { Button } from '@/components/ui/button'
import type { ClipOutputs } from '@/lib/api'
import type { Clip } from '@/core/edl'
import type { outputNames } from '@/components/clip/texts'

/**
 * L'état de livraison d'un clip.
 *
 * **Une seule dérivation, là où il y en avait deux** (spec du 23 août, §3.4) :
 * le signal qui compte est celui d'une vidéo rendue — `mp4Url` ou
 * `variant9x16Url`, jamais le seul `.txt` — parce que `RENDER_NATIVE` peut
 * laisser `mp4Url` définitivement nul sur un clip pourtant livré.
 */
export type DeliveryState = 'never' | 'stale' | 'delivered'

export function deriveDeliveryState(
  status: Clip['status'],
  outputs: Pick<ClipOutputs, 'mp4Url' | 'variant9x16Url'>,
): DeliveryState {
  const hasRenderedVideo = outputs.mp4Url !== null || outputs.variant9x16Url !== null
  if (hasRenderedVideo) return 'delivered'
  return status === 'exported' ? 'stale' : 'never'
}

/**
 * Le seul geste terminal de l'écran, posé dans la barre d'app.
 *
 * **« Publier » disparaît plutôt que de rester grisé quand il n'y a rien à
 * publier** (spec du 23 août, §3.4) : ce cas n'existe que hors de l'état
 * `delivered`, jamais atteint ici puisque la branche `delivered` est la seule
 * à rendre ce bouton.
 */
export function ClipPrimaryAction({
  state,
  onExport,
  onPublish,
  disabled,
}: {
  state: DeliveryState
  onExport: () => void
  onPublish: () => void
  disabled?: boolean
}) {
  if (state === 'delivered') {
    return (
      <Button size="sm" onClick={onPublish} aria-disabled={disabled || undefined}>
        <Send aria-hidden />
        Publier
      </Button>
    )
  }
  return (
    <Button size="sm" onClick={onExport} aria-disabled={disabled || undefined}>
      {state === 'stale' ? 'Ré-exporter' : 'Exporter'}
    </Button>
  )
}

/**
 * Ce que l'export produira : **les noms, et rien d'autre**.
 *
 * Deux vidéos quand le ratio natif n'est pas 9:16 : le natif pour le feed
 * d'Instagram et de Facebook, la variante floutée pour TikTok et Shorts. Et
 * elles ne montrent pas le même cadre — le natif garde un seul ratio pour tout
 * le clip, la variante pose chaque plan au sien.
 */
export function OutputsList({
  names,
  native,
  outputs,
}: {
  names: ReturnType<typeof outputNames>
  native: Ratio
  outputs: ClipOutputs
}) {
  return (
    <ul className="flex flex-col gap-1">
      {names.mp4 === null ? (
        // **`mp4Due` sépare deux `null` qui ne veulent pas dire la même
        // chose**, comme `variant9x16Due` juste en dessous. Le natif est
        // désactivé (`RENDER_NATIVE`) sur ce clip parce que sa variante 9:16
        // le remplace : son absence n'est pas un rendu manquant.
        <li className="text-[0.75rem] text-muted-foreground">
          Le rendu natif est désactivé : la variante 9:16 sert de livrable.
        </li>
      ) : (
        <li className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-[0.75rem]">{names.mp4}</span>
          <span className="text-[0.75rem] text-muted-foreground">
            le rendu {native}, pour le feed
            {outputs.mp4Url === null && outputs.mp4Due && ' — dû, pas encore produit'}
          </span>
        </li>
      )}

      {names.variant9x16 === null ? (
        // **`variant9x16Due` sépare deux `null` qui ne veulent pas dire la même
        // chose.** Un clip dont le ratio natif est déjà 9:16 n'aura jamais de
        // variante à fond flouté, et annoncer un rendu manquant ici le ferait sur
        // le clip le mieux livré de la bibliothèque.
        <li className="text-[0.75rem] text-muted-foreground">
          Le ratio natif est déjà 9:16 : pas de variante à produire.
        </li>
      ) : (
        <li className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-[0.75rem]">{names.variant9x16}</span>
          <span className="text-[0.75rem] text-muted-foreground">
            la variante sur fond flouté, pour TikTok et Shorts
            {outputs.variant9x16Url === null && outputs.variant9x16Due && ' — due, pas encore produite'}
          </span>
        </li>
      )}

      <li className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-[0.75rem]">{names.texts}</span>
        <span className="text-[0.75rem] text-muted-foreground">titre, description, mots-dièse</span>
      </li>
    </ul>
  )
}

/**
 * Un des trois textes de publication, avec son bouton de copie.
 *
 * Vide, le champ le dit plutôt que de rester blanc — et son bouton se désactive
 * : copier le vide efface le presse-papiers, ce qui est le contraire du service
 * rendu, et se remarque au moment de coller.
 */
export function FieldCopyable({
  tag,
  value,
  lines = 1,
  disabled = false,
}: {
  tag: string
  value: string
  /** Une ligne pour un titre ou des mots-dièse, plusieurs pour une description. */
  lines?: number
  /** Réglage pas encore connu (chargement ou échec) : rien à copier ni afficher. */
  disabled?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span aria-hidden className="text-[0.75rem] text-muted-foreground">
          {tag}
        </span>
        <ButtonCopy text={value} label={`Copier ${tag.toLowerCase()}`} size="xs" disabled={disabled} />
      </div>
      <textarea
        aria-label={`${tag} de publication`}
        readOnly
        rows={lines}
        value={value}
        placeholder={disabled ? 'Réglages en cours de chargement…' : `(sans ${tag.toLowerCase()})`}
        className="w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-[0.8rem] leading-relaxed"
      />
    </div>
  )
}

/**
 * Le bouton qui copie, et qui dit qu'il a copié.
 *
 * **Le texte copié, pas un booléen.** « Copié » doit redevenir « Copier » dès
 * que le texte change, sinon le bouton affirme que le presse-papiers porte
 * quelque chose qu'il ne porte plus.
 */
export function ButtonCopy({
  text,
  label,
  size = 'sm',
  disabled = false,
}: {
  text: string
  label: string
  size?: 'xs' | 'sm'
  disabled?: boolean
}) {
  const [copy, setCopy] = useState<string | null>(null)
  const toDay = copy === text && text !== ''
  // Ce que le bouton montre : « Copier », ou « Copier pour publication » pour
  // le bouton du bloc de textes. Son nom accessible, lui, reste complet.
  const court = label.startsWith('Copier pour publication') ? 'Copier pour publication' : 'Copier'

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(text)
      setCopy(text)
    } catch {
      setCopy(null)
    }
  }

  return (
    <Button
      size={size}
      variant="outline"
      onClick={() => void copyToClipboard()}
      // Copier le vide efface le presse-papiers : le contraire du service rendu,
      // et cela ne se remarque qu'au moment de coller.
      disabled={disabled || text === ''}
      // **Le nom complet à la voix, court à l'œil.** Plusieurs boutons
      // « Copier » sur le même écran ne se distinguent qu'à leur place ; un
      // lecteur d'écran n'a pas cette place. Et le nom porte l'état : sans
      // lui, « Copié » ne serait qu'un mot à l'écran, invisible à la voix —
      // un `aria-label` fixe masque le contenu du bouton.
      aria-label={toDay ? `${label} — copié` : label}
    >
      {toDay ? <Check aria-hidden /> : <Copy aria-hidden />}
      <span aria-hidden>{toDay ? 'Copié' : court}</span>
    </Button>
  )
}
