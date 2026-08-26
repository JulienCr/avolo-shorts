'use client'

import { RotateCcw } from 'lucide-react'
import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FRAMING_BOUNDS, FRAMING_SETTINGS_DEFAULTS, type FramingSettings } from '@/lib/api'

/**
 * La section « Cadrage » : split-screen (PR #176) et plancher de taille
 * (PR #177), jusqu'ici en dur et hors d'atteinte depuis l'écran (issue #180).
 *
 * **Entiers et millièmes** (le registre n'a pas de type décimal) : la
 * conversion vers `FramingOptions` vit dans `clip-framing.ts`. **`values`
 * peut être `undefined`**, comme `HookSection` : avant la réponse de
 * `GET /api/settings`, la section montre les défauts, tout inerte.
 */

type NumericKey = Exclude<keyof FramingSettings, 'splitScreen'>

type NumericField = {
  key: NumericKey
  label: string
  help: string
  unit: string
  step: number
}

const NUMERIC_FIELDS: readonly NumericField[] = [
  {
    key: 'splitMinShotMs',
    label: 'Durée minimale du plan',
    help: 'En dessous de cette durée, un plan à deux personnes garde un crop unique plutôt qu’un split.',
    unit: 'ms',
    step: 100,
  },
  {
    key: 'splitMinCellWidthPermille',
    label: 'Largeur minimale d’une cellule',
    help: 'Le plancher qui empêche un tronc étroit de produire un grossissement absurde, en millièmes de la largeur source.',
    unit: '‰ largeur source',
    step: 5,
  },
  {
    key: 'splitBleedTolerancePermille',
    label: 'Tolérance au débordement',
    help: 'La part de la boîte de l’autre personne qu’une cellule peut recouvrir sans faire refuser le split, en millièmes de la largeur source.',
    unit: '‰ largeur source',
    step: 5,
  },
  {
    key: 'splitBleedSharePermille',
    label: 'Part d’images conformes exigée',
    help: 'La part des images appariées qui doivent tenir sous la tolérance ci-dessus pour que le split soit retenu.',
    unit: '‰',
    step: 10,
  },
  {
    key: 'sizeFloorPermille',
    label: 'Plancher de taille',
    help: 'Une boîte plus petite que cette part de la plus haute boîte retenue de la même image n’est plus quelqu’un à cadrer — exclut par exemple un visage imprimé sur un vêtement.',
    unit: '‰ de la plus haute boîte',
    step: 10,
  },
]

type OnChange = (patch: Partial<FramingSettings>) => void | Promise<unknown>

export function FramingSection({
  values,
  disabled = false,
  onChange,
}: {
  /** `undefined` tant que `GET /api/settings` n'a pas répondu. */
  values: FramingSettings | undefined
  /** Le temps qu'une écriture soit en vol — s'ajoute à l'inertie du chargement, ne la remplace pas. */
  disabled?: boolean
  onChange: OnChange
}) {
  const shown = values ?? FRAMING_SETTINGS_DEFAULTS
  const inert = disabled || values === undefined

  return (
    <section aria-labelledby="titre-framing" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="titre-framing" className="text-base font-semibold tracking-tight">
          Cadrage
        </h2>
        <p className="text-sm text-muted-foreground">
          Les réglages globaux du cadrage automatique : le split-screen d’un
          plan à deux personnes, et le plancher qui exclut une boîte trop
          petite pour être quelqu’un à cadrer. Changer une valeur ne recalcule
          rien — un clip déjà cadré garde son crop jusqu’à sa prochaine
          ouverture.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <Row>
          <ToggleField
            label="Split-screen activé par défaut"
            checked={shown.splitScreen}
            defaultValue={FRAMING_SETTINGS_DEFAULTS.splitScreen}
            disabled={inert}
            onChange={(value) => onChange({ splitScreen: value })}
          />
        </Row>

        {NUMERIC_FIELDS.map((field) => (
          <Row key={field.key}>
            <NumberField
              label={field.label}
              help={field.help}
              value={shown[field.key]}
              defaultValue={FRAMING_SETTINGS_DEFAULTS[field.key]}
              unit={field.unit}
              min={FRAMING_BOUNDS[field.key].min}
              max={FRAMING_BOUNDS[field.key].max}
              step={field.step}
              disabled={inert}
              onCommit={(value) => onChange({ [field.key]: value })}
            />
          </Row>
        ))}
      </div>

      {/* Vrai depuis que le split entre dans l'empreinte (#176). */}
      <p className="text-xs text-muted-foreground">
        Changer ces valeurs périme les exports des clips qui ne les ont pas
        surchargées. Ils seront réencodés au prochain export.
      </p>
    </section>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-4 rounded-xl border px-4 py-3">
      {children}
    </div>
  )
}

/** Le bouton « Revenir à … », affiché seulement s'il y a de quoi défaire. */
function ResetButton({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) {
  return (
    <Button variant="ghost" size="sm" disabled={disabled} onClick={onClick} className="ml-auto text-xs">
      <RotateCcw aria-hidden />
      {label}
    </Button>
  )
}

function ToggleField({
  label,
  checked,
  defaultValue,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  defaultValue: boolean
  disabled: boolean
  onChange: (value: boolean) => void | Promise<unknown>
}) {
  const id = useId()
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => void Promise.resolve(onChange(value === true)).catch(() => {})}
        />
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
      </div>
      {checked !== defaultValue && (
        <ResetButton
          disabled={disabled}
          onClick={() => void Promise.resolve(onChange(defaultValue)).catch(() => {})}
          label={`Revenir à ${defaultValue ? 'activé' : 'désactivé'}`}
        />
      )}
    </div>
  )
}

/**
 * Un champ numérique du cadrage : sa boîte, son unité, son explication, et le
 * retour à son défaut.
 *
 * **La saisie se valide en quittant le champ, jamais à la frappe**, comme
 * `SelectionSection` : un brouillon vidé pour être réécrit ne doit pas partir
 * en écriture sur un zéro qu'on n'a pas demandé.
 */
function NumberField({
  label,
  help,
  value,
  defaultValue,
  unit,
  min,
  max,
  step,
  disabled,
  onCommit,
}: {
  label: string
  help: string
  value: number
  defaultValue: number
  unit: string
  min: number
  max: number
  step: number
  disabled: boolean
  onCommit: (value: number) => void | Promise<unknown>
}) {
  const id = useId()
  const helpId = `${id}-help`
  const [draft, setDraft] = useState(String(value))
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(String(value))
  }

  function submit(next: number) {
    if (next === value) return
    void Promise.resolve(onCommit(next)).catch(() => setDraft(String(value)))
  }

  function commit() {
    const parsed = draft.trim() === '' ? Number.NaN : Number(draft)
    if (!Number.isFinite(parsed)) return setDraft(String(value))
    const bounded = Math.min(max, Math.max(min, Math.round(parsed)))
    setDraft(String(bounded))
    submit(bounded)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-describedby={helpId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          className="h-8 w-24 text-sm tabular-nums"
        />
        <span className="text-xs text-muted-foreground">{unit}</span>
        {value !== defaultValue && (
          <ResetButton disabled={disabled} onClick={() => submit(defaultValue)} label={`Revenir à ${defaultValue}`} />
        )}
      </div>
      <p id={helpId} className="text-xs text-muted-foreground">
        {help}
      </p>
    </div>
  )
}
