'use client'

import { ChevronDown, RotateCcw } from 'lucide-react'
import { useCallback, useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useStyleWrites } from '@/components/clip/style-writes'
import {
  FRAMING_BOUNDS,
  FRAMING_SETTINGS_DEFAULTS,
  type Clip,
  type ClipPatch,
  type FramingSettings,
  type FramingStyleOverride,
} from '@/lib/api'

/**
 * La surcharge de cadrage du clip (issue #180, seconde moitié), sur le patron
 * de `hook-fields.tsx` : `clip.framingStyle` est un objet creux, chaque
 * contrôle dit s'il est hérité ou surchargé, et un bouton isolé le rend à
 * l'héritage.
 *
 * **`splitScreen` et `dubbingLayout` restent visibles en permanence**, les
 * cinq réglages numériques repliés derrière « Personnaliser » — c'est ce que
 * le propriétaire du dépôt a demandé : comparer le cadrage normal et le
 * cadrage avancé sur un seul clip, sans republier tout le panneau Réglages
 * ici.
 */

type OnWrite = (patch: ClipPatch) => Promise<unknown> | void

type NumericKey = Exclude<keyof FramingSettings, 'splitScreen' | 'dubbingLayout'>

const NUMERIC_LABELS: Readonly<Record<NumericKey, { label: string; unit: string }>> = {
  splitMinShotMs: { label: 'Durée minimale du plan', unit: 'ms' },
  splitMinCellWidthPermille: { label: 'Largeur minimale d’une cellule', unit: '‰ largeur' },
  splitBleedTolerancePermille: { label: 'Tolérance au débordement', unit: '‰ largeur' },
  splitBleedSharePermille: { label: 'Part d’images conformes exigée', unit: '‰' },
  sizeFloorPermille: { label: 'Plancher de taille', unit: '‰ de la plus haute boîte' },
}

const NUMERIC_KEYS = Object.keys(NUMERIC_LABELS) as NumericKey[]

export function FramingFields({
  clip,
  globals,
  onWrite,
}: {
  clip: Clip
  /** Les réglages globaux du cadrage. `undefined` tant que `GET /api/settings` n'a pas répondu. */
  globals: FramingSettings | undefined
  onWrite: OnWrite
}) {
  const identifier = useId()
  const [open, setOpen] = useState(false)

  const loading = globals === undefined
  const resolved: FramingSettings = { ...(globals ?? FRAMING_SETTINGS_DEFAULTS), ...clip.framingStyle }
  const overrideCount = NUMERIC_KEYS.filter((field) => hasOverrideOf(clip, field)).length
  const hasOverride = Object.keys(clip.framingStyle).length > 0
  const dubbingLayoutGloballyOn = (globals ?? FRAMING_SETTINGS_DEFAULTS).dubbingLayout

  const { setStyle, resetField, resetAll } = useStyleWrites(
    clip.framingStyle,
    useCallback((framingStyle: FramingStyleOverride) => onWrite({ framingStyle }), [onWrite]),
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[0.75rem]">
        <Checkbox
          id={`${identifier}-split`}
          checked={resolved.splitScreen}
          disabled={loading}
          onCheckedChange={(value) => setStyle('splitScreen', value === true)}
        />
        <Label htmlFor={`${identifier}-split`} className="text-[0.75rem] font-normal">
          Split-screen
        </Label>
        <FieldOrigin
          field="Split-screen"
          overridden={hasOverrideOf(clip, 'splitScreen')}
          onReset={() => resetField('splitScreen')}
        />
      </div>

      <div className="flex items-center gap-2 text-[0.75rem]">
        <Checkbox
          id={`${identifier}-dubbing`}
          checked={resolved.dubbingLayout}
          disabled={loading || !dubbingLayoutGloballyOn}
          onCheckedChange={(value) =>
            // La surcharge ne peut que désactiver (§1 du contrat) : cocher
            // revient à l'héritage plutôt que d'écrire `true`, que le schéma
            // du serveur rejetterait de toute façon (`z.literal(false)`).
            value === true ? resetField('dubbingLayout') : setStyle('dubbingLayout', false)
          }
        />
        <Label htmlFor={`${identifier}-dubbing`} className="text-[0.75rem] font-normal">
          Montage doublage
        </Label>
        <FieldOrigin
          field="Montage doublage"
          overridden={hasOverrideOf(clip, 'dubbingLayout')}
          onReset={() => resetField('dubbingLayout')}
        />
      </div>

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          render={
            <Button type="button" size="sm" variant="ghost" className="w-fit gap-1.5 px-2">
              <ChevronDown
                aria-hidden
                className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
              />
              Personnaliser
              {overrideCount > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums">
                  {overrideCount}
                </span>
              )}
            </Button>
          }
        />
        <CollapsiblePanel className="flex flex-col gap-3 pt-2">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border px-3 py-2.5">
            {NUMERIC_KEYS.map((key) => (
              <NumberField
                key={key}
                label={NUMERIC_LABELS[key].label}
                unit={NUMERIC_LABELS[key].unit}
                value={resolved[key]}
                min={FRAMING_BOUNDS[key].min}
                max={FRAMING_BOUNDS[key].max}
                disabled={loading}
                overridden={hasOverrideOf(clip, key)}
                onCommit={(value) => setStyle(key, value)}
                onReset={() => resetField(key)}
              />
            ))}
          </div>

          {/* N'apparaît que s'il y a de quoi défaire, même règle que le
              « Revenir à … » de l'écran des réglages. */}
          {hasOverride && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={loading}
              className="w-fit"
              onClick={resetAll}
            >
              <RotateCcw aria-hidden />
              Réinitialiser avec les paramètres globaux
            </Button>
          )}
        </CollapsiblePanel>
      </Collapsible>
    </div>
  )
}

function hasOverrideOf(clip: Clip, field: keyof FramingSettings): boolean {
  return Object.hasOwn(clip.framingStyle, field)
}

/**
 * « hérité » à côté d'un libellé, et le bouton qui rend le champ à l'héritage.
 * Dupliqué de `hook-fields.tsx` plutôt qu'importé : les deux écrans ne
 * partagent aucun autre composant de champ.
 */
function FieldOrigin({
  field,
  overridden,
  onReset,
}: {
  field: string
  overridden: boolean
  onReset: () => void
}) {
  if (!overridden) {
    return <span className="text-muted-foreground">— hérité</span>
  }
  return (
    <button
      type="button"
      aria-label={`${field} : revenir à l’héritage`}
      onClick={onReset}
      className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
    >
      <RotateCcw aria-hidden className="size-3" />
      revenir à l’héritage
    </button>
  )
}

function NumberField({
  label,
  value,
  unit,
  min,
  max,
  disabled,
  overridden,
  onCommit,
  onReset,
}: {
  label: string
  value: number
  unit: string
  min: number
  max: number
  disabled: boolean
  overridden: boolean
  onCommit: (value: number) => void
  onReset: () => void
}) {
  const id = useId()
  const [draft, setDraft] = useState(String(value))
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(String(value))
  }

  function commit() {
    const parsed = draft.trim() === '' ? Number.NaN : Number(draft)
    if (!Number.isFinite(parsed)) return setDraft(String(value))
    // `Math.trunc`, jamais `Math.round` : une valeur saisie se tronque vers le
    // bas avant d'être bornée, comme partout ailleurs dans ce registre.
    const bounded = Math.min(max, Math.max(min, Math.trunc(parsed)))
    setDraft(String(bounded))
    if (bounded !== value) onCommit(bounded)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <div className="flex items-center gap-2 text-[0.75rem]">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          disabled={disabled}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          className="h-8 w-20 tabular-nums"
        />
        <span className="text-muted-foreground">{unit}</span>
        <FieldOrigin field={label} overridden={overridden} onReset={onReset} />
      </div>
    </div>
  )
}
