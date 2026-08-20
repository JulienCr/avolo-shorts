'use client'

import { RotateCcw, Sparkles } from 'lucide-react'
import { useCallback, useId, useState } from 'react'

import {
  HOOK_ALIGNMENTS,
  HOOK_BOUNDS,
  HOOK_DEFAULTS,
  HOOK_FONTS,
  HOOK_POSITIONS,
  HOOK_TRANSITIONS,
  resolveHook,
  type HookSettings,
} from '@/core/hook'
import { useTextDeferred } from '@/components/clip/text-fields'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Clip, ClipPatch } from '@/lib/api'
import { useRegenerateHook } from '@/lib/queries'

/**
 * Le hook du clip, en zone **Contenu** de l'écran Clip (retour d'usage §7).
 *
 * **Chaque contrôle dit s'il est hérité ou surchargé.** `clip.hookStyle` est
 * un objet creux : `{}` veut dire « aux valeurs globales », `{ size: 56 }`
 * veut dire « surchargé, et il se trouve que c'est la même valeur que le
 * global ». Un écran qui n'affiche que la valeur effective — celle que
 * `resolveHook` rend — rendrait les deux indiscernables et viderait de son
 * sens tout le travail de persistance de la PR précédente. Chaque contrôle
 * porte donc, à côté de son libellé, un mot qui dit lequel des deux c'est, et
 * un bouton pour rendre un champ isolé à l'héritage.
 *
 * **Les surcharges de style s'écrivent au clic, directement** — comme
 * `BrandingControl` le fait dans `clip-screen.tsx` — et pas par le protocole
 * temporisé de `useTextDeferred` : ce sont des cases, des listes et des
 * couleurs, pas de la frappe. Le texte du hook, lui, suit exactement ce
 * protocole, comme le titre et la description.
 */

type OnWrite = (patch: ClipPatch) => Promise<unknown> | void

export function HookFields({
  clip,
  globals,
  onWrite,
  onFailure,
}: {
  clip: Clip
  /** Les réglages globaux du hook. `undefined` tant que `GET /api/settings` n'a pas répondu. */
  globals: HookSettings | undefined
  onWrite: OnWrite
  onFailure?: (field: 'hookText', inFailure: boolean) => void
}) {
  const identifier = useId()

  const hookText = useTextDeferred(
    clip.hookText,
    useCallback((text: string) => onWrite({ hookText: text }), [onWrite]),
    useCallback((inFailure: boolean) => onFailure?.('hookText', inFailure), [onFailure]),
  )

  // **Inerte tant que les globaux n'ont pas chargé**, sans faire clignoter
  // l'écran : les contrôles s'affichent tout de suite avec `HOOK_DEFAULTS`
  // comme base — le même repli que `hook-section.tsx` — et se figent le temps
  // que la vraie valeur arrive, exactement comme pendant une écriture en cours.
  const loading = globals === undefined
  const resolved = resolveHook(globals ?? HOOK_DEFAULTS, clip)
  const hasOverride = Object.keys(clip.hookStyle).length > 0

  const setStyle = useCallback(
    <K extends keyof HookSettings>(field: K, value: HookSettings[K]) => {
      void Promise.resolve(onWrite({ hookStyle: { ...clip.hookStyle, [field]: value } })).catch(
        () => {},
      )
    },
    [clip.hookStyle, onWrite],
  )

  const resetField = useCallback(
    (field: keyof HookSettings) => {
      const rest = { ...clip.hookStyle }
      delete rest[field]
      void Promise.resolve(onWrite({ hookStyle: rest })).catch(() => {})
    },
    [clip.hookStyle, onWrite],
  )

  const regenerate = useRegenerateHook()

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`${identifier}-hook`}>Hook</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={regenerate.isPending}
            onClick={() => void regenerate.mutateAsync(clip.id).catch(() => {})}
          >
            <Sparkles aria-hidden />
            {regenerate.isPending ? 'Génération…' : 'Régénérer'}
          </Button>
        </div>
        <Input
          id={`${identifier}-hook`}
          value={hookText.value}
          onChange={(e) => hookText.input(e.target.value)}
          onBlur={hookText.clear}
          placeholder="Le texte incrusté dès la première image"
        />
        {hookText.failure && (
          <p className="flex items-center gap-2 text-[0.75rem] text-destructive">
            Le hook n’a pas été enregistré.
            <Button size="xs" variant="outline" onClick={hookText.clear}>
              Réessayer
            </Button>
          </p>
        )}
        {regenerate.isError && (
          <p className="text-[0.75rem] text-destructive">
            {regenerate.error instanceof Error
              ? regenerate.error.message
              : 'La génération a échoué.'}
          </p>
        )}
      </div>

      <label className="flex items-center gap-2 text-[0.75rem]">
        <Checkbox
          checked={resolved.enabled}
          disabled={loading}
          onCheckedChange={(value) => setStyle('enabled', value === true)}
        />
        Hook activé
        <FieldOrigin
          overridden={hasOverrideOf(clip, 'enabled')}
          onReset={() => resetField('enabled')}
        />
      </label>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border px-3 py-2.5">
        <SelectField
          label="Police"
          value={resolved.font}
          disabled={loading}
          overridden={hasOverrideOf(clip, 'font')}
          options={HOOK_FONTS.map((f) => ({ value: f, label: f }))}
          onChange={(value) => setStyle('font', value)}
          onReset={() => resetField('font')}
        />
        <NumberField
          label="Taille"
          value={resolved.size}
          unit="pt"
          min={HOOK_BOUNDS.size.min}
          max={HOOK_BOUNDS.size.max}
          disabled={loading}
          overridden={hasOverrideOf(clip, 'size')}
          onCommit={(value) => setStyle('size', value)}
          onReset={() => resetField('size')}
        />
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border px-3 py-2.5">
        <SelectField
          label="Position"
          value={resolved.position}
          disabled={loading}
          overridden={hasOverrideOf(clip, 'position')}
          options={HOOK_POSITIONS.map((p) => ({ value: p, label: POSITION_LABELS[p] }))}
          onChange={(value) => setStyle('position', value)}
          onReset={() => resetField('position')}
        />
        <SelectField
          label="Alignement"
          value={resolved.alignment}
          disabled={loading}
          overridden={hasOverrideOf(clip, 'alignment')}
          options={HOOK_ALIGNMENTS.map((a) => ({ value: a, label: ALIGNMENT_LABELS[a] }))}
          onChange={(value) => setStyle('alignment', value)}
          onReset={() => resetField('alignment')}
        />
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border px-3 py-2.5">
        <ColorField
          label="Texte"
          value={resolved.textColor}
          disabled={loading}
          overridden={hasOverrideOf(clip, 'textColor')}
          onCommit={(value) => setStyle('textColor', value)}
          onReset={() => resetField('textColor')}
        />
        <ColorField
          label="Fond"
          value={resolved.backgroundColor}
          disabled={loading}
          overridden={hasOverrideOf(clip, 'backgroundColor')}
          onCommit={(value) => setStyle('backgroundColor', value)}
          onReset={() => resetField('backgroundColor')}
        />
        <NumberField
          label="Opacité du fond"
          value={resolved.backgroundOpacity}
          unit="%"
          min={HOOK_BOUNDS.backgroundOpacity.min}
          max={HOOK_BOUNDS.backgroundOpacity.max}
          disabled={loading}
          overridden={hasOverrideOf(clip, 'backgroundOpacity')}
          onCommit={(value) => setStyle('backgroundOpacity', value)}
          onReset={() => resetField('backgroundOpacity')}
        />
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border px-3 py-2.5">
        <TransitionField
          label="Apparition"
          value={resolved.enter}
          disabled={loading}
          overridden={hasOverrideOf(clip, 'enter')}
          onChange={(value) => setStyle('enter', value)}
          onReset={() => resetField('enter')}
        />
        <TransitionField
          label="Disparition"
          value={resolved.exit}
          disabled={loading}
          overridden={hasOverrideOf(clip, 'exit')}
          onChange={(value) => setStyle('exit', value)}
          onReset={() => resetField('exit')}
        />
      </div>

      {/* **N'apparaît que s'il y a de quoi.** Même règle que le « Revenir à … »
          de l'écran des réglages : un bouton toujours là ferait croire à une
          action qui n'a rien à défaire. */}
      {hasOverride && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={loading}
          className="w-fit"
          onClick={() => void Promise.resolve(onWrite({ hookStyle: {} })).catch(() => {})}
        >
          <RotateCcw aria-hidden />
          Réinitialiser avec les paramètres globaux
        </Button>
      )}
    </div>
  )
}

function hasOverrideOf(clip: Clip, field: keyof HookSettings): boolean {
  return Object.hasOwn(clip.hookStyle, field)
}


/** « hérité » à côté d'un libellé, et le bouton qui rend le champ à l'héritage. */
function FieldOrigin({ overridden, onReset }: { overridden: boolean; onReset: () => void }) {
  if (!overridden) {
    return <span className="text-muted-foreground">— hérité</span>
  }
  return (
    <button
      type="button"
      onClick={onReset}
      className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
    >
      <RotateCcw aria-hidden className="size-3" />
      revenir à l’héritage
    </button>
  )
}

const POSITION_LABELS: Record<(typeof HOOK_POSITIONS)[number], string> = {
  top: 'Tiers supérieur',
  center: 'Centre',
  bottom: 'Tiers inférieur',
}

const ALIGNMENT_LABELS: Record<(typeof HOOK_ALIGNMENTS)[number], string> = {
  left: 'À gauche',
  center: 'Centré',
  right: 'À droite',
}

const TRANSITION_LABELS: Record<(typeof HOOK_TRANSITIONS)[number], string> = {
  none: 'Aucune',
  fade: 'Fondu',
  glitch: 'Glitch',
  scanline: 'Scanline',
}

/**
 * `glitch` et `scanline` restent proposés, mais **désactivés**. La PR de rendu
 * n'implémente que `none` et `fade` : un choix qui rendrait un fondu en
 * silence serait un mensonge, la même règle que `hook-section.tsx` applique
 * déjà aux réglages globaux.
 */
const TRANSITION_COMING_SOON: ReadonlySet<(typeof HOOK_TRANSITIONS)[number]> = new Set([
  'glitch',
  'scanline',
])

function SelectField<T extends string>({
  label,
  value,
  disabled,
  overridden,
  options,
  onChange,
  onReset,
}: {
  label: string
  value: T
  disabled: boolean
  overridden: boolean
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  onReset: () => void
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <div className="flex items-center gap-2 text-[0.75rem]">
        <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next as T)}>
          <SelectTrigger id={id} className="w-40">
            <SelectValue>{options.find((o) => o.value === value)?.label ?? value}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldOrigin overridden={overridden} onReset={onReset} />
      </div>
    </div>
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
    const bounded = Math.min(max, Math.max(min, Math.round(parsed)))
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
        <FieldOrigin overridden={overridden} onReset={onReset} />
      </div>
    </div>
  )
}

function ColorField({
  label,
  value,
  disabled,
  overridden,
  onCommit,
  onReset,
}: {
  label: string
  value: string
  disabled: boolean
  overridden: boolean
  onCommit: (value: string) => void
  onReset: () => void
}) {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }

  function commit() {
    const trimmed = draft.trim().toUpperCase()
    if (!/^#[0-9A-F]{6}$/.test(trimmed)) return setDraft(value)
    setDraft(trimmed)
    if (trimmed !== value) onCommit(trimmed)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <div className="flex items-center gap-2 text-[0.75rem]">
        <span
          aria-hidden
          className="size-6 shrink-0 rounded-md border"
          style={{ backgroundColor: /^#[0-9A-Fa-f]{6}$/.test(draft) ? draft : value }}
        />
        <Input
          id={id}
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
          className="h-8 w-24 font-mono uppercase"
        />
        <FieldOrigin overridden={overridden} onReset={onReset} />
      </div>
    </div>
  )
}

function TransitionField({
  label,
  value,
  disabled,
  overridden,
  onChange,
  onReset,
}: {
  label: string
  value: (typeof HOOK_TRANSITIONS)[number]
  disabled: boolean
  overridden: boolean
  onChange: (value: (typeof HOOK_TRANSITIONS)[number]) => void
  onReset: () => void
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <div className="flex items-center gap-2 text-[0.75rem]">
        <Select
          value={value}
          disabled={disabled}
          onValueChange={(next) => onChange(next as (typeof HOOK_TRANSITIONS)[number])}
        >
          <SelectTrigger id={id} className="w-40">
            <SelectValue>{TRANSITION_LABELS[value]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {HOOK_TRANSITIONS.map((t) => (
              <SelectItem key={t} value={t} disabled={TRANSITION_COMING_SOON.has(t)}>
                {TRANSITION_LABELS[t]}
                {TRANSITION_COMING_SOON.has(t) && (
                  <span className="text-xs text-muted-foreground"> — à venir</span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldOrigin overridden={overridden} onReset={onReset} />
      </div>
    </div>
  )
}
