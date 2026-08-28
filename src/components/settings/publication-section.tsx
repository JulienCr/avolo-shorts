'use client'

import { RotateCcw } from 'lucide-react'
import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { PLATFORM_LABELS, PLATFORMS, type Platform } from '@/core/publication'
import {
  DEFAULT_DESCRIPTION_FOOTER,
  DEFAULT_PUBLICATION_PREFERENCE,
  PUBLICATION_ADAPTER_CHOICES,
  type PublicationPreference,
  type PublicationSettings,
} from '@/lib/api'

/**
 * La section « Publication » des réglages : quel connecteur porte chaque
 * plateforme.
 *
 * **Le choix engage un quota, pas seulement une méthode.** Meta direct est
 * gratuit et autorise cent publications par 24 h ; le compte Upload Post est
 * sur l'offre gratuite, dix par mois pour les quatre plateformes réunies.
 * `auto` — le défaut — reproduit l'ordre de priorité du registre, qui préfère
 * déjà Meta à Upload Post sur Instagram et Facebook pour cette raison.
 */

const DEFAULT_PREFERENCE: PublicationPreference = DEFAULT_PUBLICATION_PREFERENCE

const ADAPTER_LABELS: Record<PublicationPreference, string> = {
  auto: 'Automatique',
  meta: 'Meta (direct)',
  'upload-post': 'Upload Post',
  tiktok: 'TikTok (direct)',
}

const ADAPTER_HELP: Record<PublicationPreference, string> = {
  auto: 'Laisse l’ordre de priorité choisir — le comportement d’aujourd’hui.',
  meta: 'Gratuit, jusqu’à 100 publications par 24 h.',
  'upload-post': 'Offre gratuite du compte : 10 publications par mois, pour les quatre plateformes réunies.',
  tiktok: 'Dépose un brouillon dans l’app TikTok ; publier reste un geste manuel (spec §6.3).',
}

export function PublicationSection({
  values,
  onChange,
  disabled = false,
}: {
  values: PublicationSettings
  onChange: (patch: Partial<PublicationSettings>) => void | Promise<unknown>
  disabled?: boolean
}) {
  return (
    <section aria-labelledby="publication-title" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="publication-title" className="text-base font-semibold tracking-tight">
          Publication
        </h2>
        <p className="text-sm text-muted-foreground">
          Le connecteur qui publie chaque plateforme. Deux comptes se recoupent
          sur Instagram et Facebook, avec des quotas très différents : le
          choisir évite de brûler par mégarde le quota mensuel d’un compte
          dont YouTube a aussi besoin.
        </p>
      </div>

      <AutoPublishToggle checked={values.autoPublish} disabled={disabled} onChange={onChange} />

      <div className="flex flex-col gap-3">
        {PLATFORMS.map((platform) => (
          <PlatformRow
            key={platform}
            platform={platform}
            value={values[platform]}
            disabled={disabled}
            onChange={onChange}
          />
        ))}
      </div>

      <DescriptionFooterField
        value={values.descriptionFooter}
        disabled={disabled}
        onChange={onChange}
      />
    </section>
  )
}

/**
 * Le pied de page commun (BACKLOG « pied de page commun ») : composé avec la
 * description de chaque clip qui le demande (`composeDescription`,
 * `@/core/publication`), une seule fonction pour l'aperçu, le planning et les
 * connecteurs.
 */
function DescriptionFooterField({
  value,
  disabled,
  onChange,
}: {
  value: string
  disabled: boolean
  onChange: (patch: Partial<PublicationSettings>) => void | Promise<unknown>
}) {
  const id = useId()
  const helpId = `${id}-help`
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }

  function commit() {
    if (draft === value) return
    void Promise.resolve(onChange({ descriptionFooter: draft })).catch(() => setDraft(value))
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border px-4 py-3">
      <Label htmlFor={id} className="text-sm font-medium">
        Pied de page des descriptions
      </Label>
      <Textarea
        id={id}
        disabled={disabled}
        aria-describedby={helpId}
        value={draft}
        rows={4}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className="font-mono text-sm"
      />
      {value !== DEFAULT_DESCRIPTION_FOOTER && (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() =>
            void Promise.resolve(onChange({ descriptionFooter: DEFAULT_DESCRIPTION_FOOTER })).catch(() => {})
          }
          className="self-start text-xs"
        >
          <RotateCcw aria-hidden />
          Revenir au pied de page par défaut
        </Button>
      )}
      <p id={helpId} className="text-xs text-muted-foreground">
        Ajouté à la description de chaque clip qui l’active (case « Pied de page » de l’écran de
        clip). Vide : aucun pied de page n’est ajouté, même pour un clip qui le demande.
      </p>
    </div>
  )
}

/**
 * Le drapeau de l'ordonnanceur (contrat PR F) : la tâche planifiée continue
 * de se réveiller toutes les cinq minutes, ce réglage décide seule si une
 * passe publie. Le manuel (`POST /api/clips/:id/publish`) ne le lit jamais.
 */
function AutoPublishToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled: boolean
  onChange: (patch: Partial<PublicationSettings>) => void | Promise<unknown>
}) {
  const id = useId()
  const helpId = `${id}-help`
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border px-4 py-3">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          aria-describedby={helpId}
          onCheckedChange={(value) =>
            void Promise.resolve(onChange({ autoPublish: value === true })).catch(() => {})
          }
        />
        <Label htmlFor={id} className="text-sm font-medium">
          Publication automatique à l’échéance
        </Label>
      </div>
      <p id={helpId} className="text-xs text-muted-foreground">
        La tâche planifiée continue de tourner toutes les cinq minutes ; décochée, cette option
        l’empêche de publier quoi que ce soit.
      </p>
    </div>
  )
}

function PlatformRow({
  platform,
  value,
  disabled,
  onChange,
}: {
  platform: Platform
  value: PublicationPreference
  disabled: boolean
  onChange: (patch: Partial<PublicationSettings>) => void | Promise<unknown>
}) {
  const id = useId()
  const helpId = `${id}-help`
  const choices = PUBLICATION_ADAPTER_CHOICES[platform]

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Label htmlFor={id} className="w-32 shrink-0 text-sm font-medium">
          {PLATFORM_LABELS[platform]}
        </Label>
        <Select
          value={value}
          disabled={disabled}
          onValueChange={(next) =>
            void Promise.resolve(
              onChange({ [platform]: next as PublicationPreference }),
            ).catch(() => {})
          }
        >
          <SelectTrigger id={id} aria-describedby={helpId} className="w-56">
            <SelectValue>{ADAPTER_LABELS[value]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {choices.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {ADAPTER_LABELS[choice]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {value !== DEFAULT_PREFERENCE && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={`Revenir à Automatique pour ${PLATFORM_LABELS[platform]}`}
            onClick={() =>
              void Promise.resolve(onChange({ [platform]: DEFAULT_PREFERENCE })).catch(() => {})
            }
            className="ml-auto text-xs"
          >
            <RotateCcw aria-hidden />
            Revenir à Automatique
          </Button>
        )}
      </div>
      <p id={helpId} className="text-xs text-muted-foreground">
        {ADAPTER_HELP[value]}
      </p>
    </div>
  )
}
