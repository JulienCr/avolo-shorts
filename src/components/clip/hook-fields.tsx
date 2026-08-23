'use client'

import { ChevronDown, RotateCcw, Sparkles } from 'lucide-react'
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
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
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
 * un objet creux : `{}` veut dire « aux valeurs globales », `{ enabled: true }`
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
 *
 * **Douze réglages sont repliés derrière un bouton, fermé par
 * défaut.** Le propriétaire du dépôt a regardé l'écran Clip et constaté que
 * les contrôles de surcharge republiaient à plat tout le panneau
 * Réglages — un écran qui existe pour monter un clip, pas pour régler le
 * hook. Restent visibles en permanence : le texte, l'activation et
 * « Régénérer », les trois gestes qu'on fait à chaque clip. Le bouton qui
 * révèle le reste dit d'un coup d'œil s'il y a des surcharges, pour qu'on
 * n'ait pas à l'ouvrir pour le savoir.
 */

type OnWrite = (patch: ClipPatch) => Promise<unknown> | void

/**
 * Les quatorze champs de `HookSettings` que le panneau replié couvre — ni
 * `enabled` (visible en permanence, à côté du texte) ni les deux textes,
 * qui n'appartiennent pas à `HookSettings`.
 *
 * **Un `Record` et non un tableau, depuis le 20 août 2026.** Un
 * `readonly (keyof HookSettings)[]` ne casse pas au type-check quand un
 * réglage neuf est oublié : il atterrit en base, se surcharge par l'API,
 * entre dans l'empreinte du rendu — et reste invisible ici, sans que rien ne
 * le dise. C'est exactement ce qui est arrivé à `durationMs` (relevé par
 * Copilot, PR #117), et `CLAUDE.md` demande de se poser la question qui suit
 * un défaut de forme : « quels autres champs ont cette forme ». Le `Record`
 * exige toutes les clés et n'en accepte aucune de plus, donc l'oubli ne
 * compile plus.
 *
 * **`durationMs` manquait à cette liste** (PR #117, seconde manche) : le
 * réglage existait déjà dans `HookSettings`, bornait déjà une surcharge côté
 * serveur, mais n'avait aucun contrôle ni badge de surcharge dans cet écran —
 * relevé par Copilot, `hook-fields.tsx:70`. Il redevient un réglage actif
 * dans ce même correctif : le PNG en `overlay` porte désormais lui-même la
 * borne temporelle (`src/core/ffmpeg/args.ts`), ce qui n'était pas vrai
 * avant.
 */
const COLLAPSIBLE: Record<Exclude<keyof HookSettings, 'enabled'>, true> = {
  font: true,
  sizePermille: true,
  cornerRadiusPermille: true,
  uppercase: true,
  position: true,
  alignment: true,
  textColor: true,
  backgroundColor: true,
  backgroundOpacity: true,
  durationMs: true,
  enter: true,
  exit: true,
  badgeColor: true,
  badgeBackground: true,
}

const COLLAPSIBLE_FIELDS = Object.keys(COLLAPSIBLE) as (keyof HookSettings)[]

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
  onFailure?: (field: 'hookText' | 'hookBadge', inFailure: boolean) => void
}) {
  const identifier = useId()
  const [open, setOpen] = useState(false)

  const hookText = useTextDeferred(
    clip.hookText,
    useCallback((text: string) => onWrite({ hookText: text }), [onWrite]),
    useCallback((inFailure: boolean) => onFailure?.('hookText', inFailure), [onFailure]),
  )

  const hookBadge = useTextDeferred(
    clip.hookBadge,
    useCallback((text: string) => onWrite({ hookBadge: text }), [onWrite]),
    useCallback((inFailure: boolean) => onFailure?.('hookBadge', inFailure), [onFailure]),
  )

  // **Inerte tant que les globaux n'ont pas chargé**, sans faire clignoter
  // l'écran : les contrôles s'affichent tout de suite avec `HOOK_DEFAULTS`
  // comme base — le même repli que `hook-section.tsx` — et se figent le temps
  // que la vraie valeur arrive, exactement comme pendant une écriture en cours.
  const loading = globals === undefined
  const resolved = resolveHook(globals ?? HOOK_DEFAULTS, clip)
  const overrideCount = COLLAPSIBLE_FIELDS.filter((field) => hasOverrideOf(clip, field)).length
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

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${identifier}-badge`}>Badge</Label>
        <Input
          id={`${identifier}-badge`}
          value={hookBadge.value}
          onChange={(e) => hookBadge.input(e.target.value)}
          onBlur={hookBadge.clear}
          placeholder="Le petit libellé au-dessus — « DÉFI 10 », facultatif"
        />
        {hookBadge.failure && (
          <p className="flex items-center gap-2 text-[0.75rem] text-destructive">
            Le badge n’a pas été enregistré.
            <Button size="xs" variant="outline" onClick={hookBadge.clear}>
              Réessayer
            </Button>
          </p>
        )}
        {/* **Dire ce que le rendu fera, plutôt que de le taire.** Un badge
            posé sur une accroche vide n'est pas incrusté (`hookIsBurned`,
            `@/core/hook`) : sans cette phrase, quelqu'un qui saisit
            « DÉFI 10 » et ne voit rien apparaître ne peut que conclure que le
            champ est cassé. Pas un `disabled` pour autant — le badge a le
            droit de se saisir avant l'accroche. */}
        {hookBadge.value.trim() !== '' && hookText.value.trim() === '' && (
          <p className="text-[0.75rem] text-muted-foreground">
            Sans texte de hook, le badge n’est pas incrusté.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 text-[0.75rem]">
        <Checkbox
          id={`${identifier}-enabled`}
          checked={resolved.enabled}
          disabled={loading}
          onCheckedChange={(value) => setStyle('enabled', value === true)}
        />
        <Label htmlFor={`${identifier}-enabled`} className="text-[0.75rem] font-normal">
          Hook activé
        </Label>
        <FieldOrigin
          field="Hook activé"
          overridden={hasOverrideOf(clip, 'enabled')}
          onReset={() => resetField('enabled')}
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
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.6875rem] font-medium tabular-nums">
                  {overrideCount}
                </span>
              )}
            </Button>
          }
        />
        <CollapsiblePanel className="flex flex-col gap-3 pt-2">
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
              value={resolved.sizePermille}
              unit="‰ largeur"
              min={HOOK_BOUNDS.sizePermille.min}
              max={HOOK_BOUNDS.sizePermille.max}
              disabled={loading}
              overridden={hasOverrideOf(clip, 'sizePermille')}
              onCommit={(value) => setStyle('sizePermille', value)}
              onReset={() => resetField('sizePermille')}
            />
            <NumberField
              label="Rayon des coins"
              value={resolved.cornerRadiusPermille}
              unit="‰ largeur"
              min={HOOK_BOUNDS.cornerRadiusPermille.min}
              max={HOOK_BOUNDS.cornerRadiusPermille.max}
              disabled={loading}
              overridden={hasOverrideOf(clip, 'cornerRadiusPermille')}
              onCommit={(value) => setStyle('cornerRadiusPermille', value)}
              onReset={() => resetField('cornerRadiusPermille')}
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
            <div className="flex items-center gap-2 text-[0.75rem]">
              <Checkbox
                id={`${identifier}-uppercase`}
                checked={resolved.uppercase}
                disabled={loading}
                onCheckedChange={(value) => setStyle('uppercase', value === true)}
              />
              <Label htmlFor={`${identifier}-uppercase`} className="text-[0.75rem] font-normal">
                Capitales
              </Label>
              <FieldOrigin
                field="Capitales"
                overridden={hasOverrideOf(clip, 'uppercase')}
                onReset={() => resetField('uppercase')}
              />
            </div>
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

          {/* Une ligne à part, pas cinq couleurs dans la précédente : les
              deux premières habillent le carton, celles-ci la pastille, et
              les mêler ferait lire cinq réglages du même objet. */}
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border px-3 py-2.5">
            <ColorField
              label="Badge — texte"
              value={resolved.badgeColor}
              disabled={loading}
              overridden={hasOverrideOf(clip, 'badgeColor')}
              onCommit={(value) => setStyle('badgeColor', value)}
              onReset={() => resetField('badgeColor')}
            />
            <ColorField
              label="Badge — fond"
              value={resolved.badgeBackground}
              disabled={loading}
              overridden={hasOverrideOf(clip, 'badgeBackground')}
              onCommit={(value) => setStyle('badgeBackground', value)}
              onReset={() => resetField('badgeBackground')}
            />
          </div>

          <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border px-3 py-2.5">
            <DurationField
              value={resolved.durationMs}
              disabled={loading}
              overridden={hasOverrideOf(clip, 'durationMs')}
              onCommit={(value) => setStyle('durationMs', value)}
              onReset={() => resetField('durationMs')}
            />
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
        </CollapsiblePanel>
      </Collapsible>
    </div>
  )
}

function hasOverrideOf(clip: Clip, field: keyof HookSettings): boolean {
  return Object.hasOwn(clip.hookStyle, field)
}


/**
 * « hérité » à côté d'un libellé, et le bouton qui rend le champ à l'héritage.
 *
 * **`field` porte le nom accessible du bouton.** Sans lui, tous les boutons de
 * réinitialisation partagent le même nom « revenir à l’héritage » : un lecteur
 * d'écran ne peut alors pas distinguer celui de la taille de celui de la
 * position. Le libellé visuel reste générique, l'`aria-label` seul est
 * contextualisé. (relevé par Copilot)
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
        <FieldOrigin field={label} overridden={overridden} onReset={onReset} />
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
        <FieldOrigin field={label} overridden={overridden} onReset={onReset} />
      </div>
    </div>
  )
}

/**
 * La durée, affichée en secondes — **`durationMs` est ce qui se stocke et se
 * valide**, la même conversion que `hook-section.tsx` tient déjà pour le
 * réglage global (voir sa doc). Dupliquée plutôt qu'importée : ce fichier
 * porte sa propre variante de `NumberField` avec `FieldOrigin`, et les deux
 * écrans ne partagent aucun autre composant de champ.
 */
function DurationField({
  value,
  disabled,
  overridden,
  onCommit,
  onReset,
}: {
  /** En millisecondes — l'unité stockée. */
  value: number
  disabled: boolean
  overridden: boolean
  onCommit: (valueMs: number) => void
  onReset: () => void
}) {
  const id = useId()
  const seconds = value / 1000
  const minSeconds = HOOK_BOUNDS.durationMs.min / 1000
  const maxSeconds = HOOK_BOUNDS.durationMs.max / 1000

  const [draft, setDraft] = useState(String(seconds))
  const [seen, setSeen] = useState(seconds)
  if (seen !== seconds) {
    setSeen(seconds)
    setDraft(String(seconds))
  }

  function commit() {
    const parsed = draft.trim() === '' ? Number.NaN : Number(draft)
    if (!Number.isFinite(parsed)) return setDraft(String(seconds))
    const bounded = Math.min(maxSeconds, Math.max(minSeconds, parsed))
    const ms = Math.round(bounded * 1000)
    setDraft(String(ms / 1000))
    if (ms !== value) onCommit(ms)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        Durée
      </Label>
      <div className="flex items-center gap-2 text-[0.75rem]">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          // 0,1 et non 0,5 : la grille HTML part de `min` (0,2) par pas de
          // `step`, et 0,2 + n × 0,5 ne retombe jamais sur le défaut (2 s) —
          // même correctif que `hook-section.tsx` (relevé par Copilot).
          step={0.1}
          min={minSeconds}
          max={maxSeconds}
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
        <span className="text-muted-foreground">secondes</span>
        <FieldOrigin field="Durée" overridden={overridden} onReset={onReset} />
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
        <FieldOrigin field={label} overridden={overridden} onReset={onReset} />
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
        <FieldOrigin field={label} overridden={overridden} onReset={onReset} />
      </div>
    </div>
  )
}
