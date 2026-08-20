'use client'

import { RotateCcw } from 'lucide-react'
import { useId, useState } from 'react'

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
import {
  HOOK_ALIGNMENTS,
  HOOK_BOUNDS,
  HOOK_DEFAULTS,
  HOOK_FONTS,
  HOOK_POSITIONS,
  HOOK_TRANSITIONS,
  type HookSettings,
} from '@/lib/api'

/**
 * Les défauts globaux du hook (retour d'usage §6.3) : le texte court affiché
 * dès la première image d'un clip, pour accrocher dans le fil avant que le
 * spectateur comprenne le contexte.
 *
 * **Chaque champ s'édite et s'enregistre, désormais.** Le bandeau « ne
 * s'enregistrent pas encore » et le `fieldset disabled` inconditionnel ont
 * disparu avec lui : ce que cette PR livre, c'est le stockage. Voir
 * `src/server/db.ts` (famille `hook` du registre) et `src/core/hook.ts`
 * (`HookSettings`, `HOOK_DEFAULTS`).
 *
 * **`values` peut être `undefined`.** Contrairement à `SelectionSection` et
 * `AiSection`, cette section reste montée avant que `GET /api/settings` n'ait
 * répondu — c'est le comportement d'avant cette PR, conservé — donc elle doit
 * savoir s'afficher sans données. Elle montre alors `HOOK_DEFAULTS` et force
 * l'inertie, qui se lève dès que `values` arrive.
 *
 * **La leçon d'Aristarque doit survivre** : `fieldset[disabled]` ne désactive
 * que les contrôles de formulaire natifs — le déclencheur de `Select` rend un
 * `<button role="combobox">` et tombe sous la règle, la `Checkbox` de Base UI
 * rend un `<span role="checkbox">` qu'elle ignore complètement. L'inertie
 * pendant le chargement (`values === undefined`) est donc portée par
 * **chaque contrôle**, pas par un `fieldset` global — exactement comme
 * pendant une écriture en cours (`disabled` prop).
 */

/** Les quatre transitions du premier lot. `glitch` et `scanline` restent visibles, mais inertes : rien ne les rend encore. */
const TRANSITION_LABELS: Record<(typeof HOOK_TRANSITIONS)[number], string> = {
  none: 'Aucune',
  fade: 'Fondu',
  glitch: 'Glitch',
  scanline: 'Scanline',
}

/** Pourquoi `glitch` et `scanline` restent choisissables à l'œil, mais pas au clic. */
const TRANSITION_COMING_SOON: ReadonlySet<(typeof HOOK_TRANSITIONS)[number]> = new Set([
  'glitch',
  'scanline',
])

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

type OnChange = (patch: Partial<HookSettings>) => void | Promise<unknown>

export function HookSection({
  values,
  disabled = false,
  onChange,
}: {
  /** `undefined` tant que `GET /api/settings` n'a pas répondu. */
  values: HookSettings | undefined
  /** Le temps qu'une écriture soit en vol — s'ajoute à l'inertie du chargement, ne la remplace pas. */
  disabled?: boolean
  onChange: OnChange
}) {
  const shown = values ?? HOOK_DEFAULTS
  const inert = disabled || values === undefined

  return (
    <section aria-labelledby="titre-hook" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="titre-hook" className="text-base font-semibold tracking-tight">
          Hook
        </h2>
        <p className="text-sm text-muted-foreground">
          Le texte court affiché dès la première image d’un clip, pour accrocher
          dans le fil avant que le contexte n’arrive. Ces valeurs sont les
          défauts ; un clip pourra les surcharger.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <Row>
          <ToggleField
            label="Hook activé par défaut"
            checked={shown.enabled}
            defaultValue={HOOK_DEFAULTS.enabled}
            disabled={inert}
            onChange={(value) => onChange({ enabled: value })}
          />
          <DurationField
            value={shown.durationMs}
            disabled={inert}
            onCommit={(value) => onChange({ durationMs: value })}
          />
        </Row>

        <Row>
          <SelectField
            label="Police"
            value={shown.font}
            defaultValue={HOOK_DEFAULTS.font}
            disabled={inert}
            options={HOOK_FONTS.map((f) => ({ value: f, label: `${f} — la seule police embarquée` }))}
            onChange={(value) => onChange({ font: value })}
          />
          <NumberField
            label="Taille"
            value={shown.size}
            defaultValue={HOOK_DEFAULTS.size}
            unit="points"
            min={HOOK_BOUNDS.size.min}
            max={HOOK_BOUNDS.size.max}
            step={1}
            disabled={inert}
            onCommit={(value) => onChange({ size: value })}
          />
        </Row>

        <Row>
          <SelectField
            label="Position"
            value={shown.position}
            defaultValue={HOOK_DEFAULTS.position}
            disabled={inert}
            options={HOOK_POSITIONS.map((p) => ({ value: p, label: POSITION_LABELS[p] }))}
            onChange={(value) => onChange({ position: value })}
          />
          <SelectField
            label="Alignement"
            value={shown.alignment}
            defaultValue={HOOK_DEFAULTS.alignment}
            disabled={inert}
            options={HOOK_ALIGNMENTS.map((a) => ({ value: a, label: ALIGNMENT_LABELS[a] }))}
            onChange={(value) => onChange({ alignment: value })}
          />
        </Row>

        <Row>
          <ColorField
            label="Couleur du texte"
            value={shown.textColor}
            defaultValue={HOOK_DEFAULTS.textColor}
            disabled={inert}
            onCommit={(value) => onChange({ textColor: value })}
          />
          <ColorField
            label="Couleur du fond"
            value={shown.backgroundColor}
            defaultValue={HOOK_DEFAULTS.backgroundColor}
            disabled={inert}
            onCommit={(value) => onChange({ backgroundColor: value })}
          />
          <NumberField
            label="Opacité du fond"
            value={shown.backgroundOpacity}
            defaultValue={HOOK_DEFAULTS.backgroundOpacity}
            unit="%"
            min={HOOK_BOUNDS.backgroundOpacity.min}
            max={HOOK_BOUNDS.backgroundOpacity.max}
            step={5}
            disabled={inert}
            onCommit={(value) => onChange({ backgroundOpacity: value })}
          />
        </Row>

        <Row>
          <TransitionField
            label="Effet d’apparition"
            value={shown.enter}
            defaultValue={HOOK_DEFAULTS.enter}
            disabled={inert}
            onChange={(value) => onChange({ enter: value })}
          />
          <TransitionField
            label="Effet de disparition"
            value={shown.exit}
            defaultValue={HOOK_DEFAULTS.exit}
            disabled={inert}
            onChange={(value) => onChange({ exit: value })}
          />
        </Row>
      </div>

      {/* Vrai à partir de la PR qui écrit le fichier ASS du hook — l'écrire
          maintenant évite de rouvrir ce fichier pour une phrase. */}
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
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      <RotateCcw aria-hidden className="size-3" />
      {label}
    </button>
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
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => void Promise.resolve(onChange(value === true)).catch(() => {})}
      />
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
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
 * La durée, affichée en secondes — **`durationMs` est ce qui se stocke et se
 * valide**, la conversion vit ici parce que c'est déjà l'endroit de toute la
 * prose de cette section (voir `src/core/hook.ts`, doc de `HookSettings`).
 */
function DurationField({
  value,
  disabled,
  onCommit,
}: {
  /** En millisecondes — l'unité stockée. */
  value: number
  disabled: boolean
  onCommit: (valueMs: number) => void | Promise<unknown>
}) {
  const id = useId()
  const helpId = `${id}-help`
  const seconds = value / 1000
  const defaultSeconds = HOOK_DEFAULTS.durationMs / 1000
  const minSeconds = HOOK_BOUNDS.durationMs.min / 1000
  const maxSeconds = HOOK_BOUNDS.durationMs.max / 1000

  const [draft, setDraft] = useState(String(seconds))
  const [seen, setSeen] = useState(seconds)
  if (seen !== seconds) {
    setSeen(seconds)
    setDraft(String(seconds))
  }

  function submit(nextMs: number) {
    if (nextMs === value) return
    void Promise.resolve(onCommit(nextMs)).catch(() => setDraft(String(seconds)))
  }

  function commit() {
    const parsed = draft.trim() === '' ? Number.NaN : Number(draft)
    if (!Number.isFinite(parsed)) return setDraft(String(seconds))
    const bounded = Math.min(maxSeconds, Math.max(minSeconds, parsed))
    const ms = Math.round(bounded * 1000)
    setDraft(String(ms / 1000))
    submit(ms)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        Durée
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          step={0.5}
          min={minSeconds}
          max={maxSeconds}
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
          className="h-8 w-20 text-sm tabular-nums"
        />
        <span className="text-xs text-muted-foreground">secondes</span>
        {value !== HOOK_DEFAULTS.durationMs && (
          <ResetButton
            disabled={disabled}
            onClick={() => submit(HOOK_DEFAULTS.durationMs)}
            label={`Revenir à ${defaultSeconds}`}
          />
        )}
      </div>
      <p id={helpId} className="text-xs text-muted-foreground">
        Combien de temps le hook reste à l’image, dès la première image.
      </p>
    </div>
  )
}

function NumberField({
  label,
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
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          className="h-8 w-20 text-sm tabular-nums"
        />
        <span className="text-xs text-muted-foreground">{unit}</span>
        {value !== defaultValue && (
          <ResetButton
            disabled={disabled}
            onClick={() => submit(defaultValue)}
            label={`Revenir à ${defaultValue}`}
          />
        )}
      </div>
    </div>
  )
}

function SelectField<T extends string>({
  label,
  value,
  defaultValue,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: T
  defaultValue: T
  options: readonly { value: T; label: string }[]
  disabled: boolean
  onChange: (value: T) => void | Promise<unknown>
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <Select
          value={value}
          disabled={disabled}
          onValueChange={(next) => void Promise.resolve(onChange(next as T)).catch(() => {})}
        >
          <SelectTrigger id={id} className="w-52">
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
        {value !== defaultValue && (
          <ResetButton
            disabled={disabled}
            onClick={() => void Promise.resolve(onChange(defaultValue)).catch(() => {})}
            label="Revenir au défaut"
          />
        )}
      </div>
    </div>
  )
}

/**
 * Une transition : les quatre options du premier lot restent **visibles**,
 * mais `glitch` et `scanline` sont `disabled` avec la raison — une valeur
 * choisissable qui rendrait un fondu en silence serait un mensonge, et ce
 * dépôt en refuse ailleurs. `SelectItem` porte alors `aria-disabled` (mesuré
 * sur Base UI : un item non natif se rend inerte par cet attribut, jamais par
 * `disabled` nu) et refuse le clic.
 */
function TransitionField({
  label,
  value,
  defaultValue,
  disabled,
  onChange,
}: {
  label: string
  value: (typeof HOOK_TRANSITIONS)[number]
  defaultValue: (typeof HOOK_TRANSITIONS)[number]
  disabled: boolean
  onChange: (value: (typeof HOOK_TRANSITIONS)[number]) => void | Promise<unknown>
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <Select
          value={value}
          disabled={disabled}
          onValueChange={(next) =>
            void Promise.resolve(onChange(next as (typeof HOOK_TRANSITIONS)[number])).catch(() => {})
          }
        >
          <SelectTrigger id={id} className="w-52">
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
        {value !== defaultValue && (
          <ResetButton
            disabled={disabled}
            onClick={() => void Promise.resolve(onChange(defaultValue)).catch(() => {})}
            label="Revenir au défaut"
          />
        )}
      </div>
    </div>
  )
}

/**
 * Une couleur `#RRGGBB` : un aperçu, une boîte de texte, un brouillon validé
 * au blur — même geste que les champs numériques.
 */
function ColorField({
  label,
  value,
  defaultValue,
  disabled,
  onCommit,
}: {
  label: string
  value: string
  defaultValue: string
  disabled: boolean
  onCommit: (value: string) => void | Promise<unknown>
}) {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }

  function submit(next: string) {
    if (next === value) return
    void Promise.resolve(onCommit(next)).catch(() => setDraft(value))
  }

  function commit() {
    const trimmed = draft.trim().toUpperCase()
    if (!/^#[0-9A-F]{6}$/.test(trimmed)) return setDraft(value)
    setDraft(trimmed)
    submit(trimmed)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <div className="flex items-center gap-2">
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
          className="h-8 w-24 font-mono text-sm uppercase"
        />
        {value !== defaultValue && (
          <ResetButton
            disabled={disabled}
            onClick={() => submit(defaultValue)}
            label={`Revenir à ${defaultValue}`}
          />
        )}
      </div>
    </div>
  )
}
