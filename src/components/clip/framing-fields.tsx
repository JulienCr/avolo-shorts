'use client'

import { RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { dubbingShotCount } from '@/components/clip/framing'
import { useStyleWrites } from '@/components/clip/style-writes'
import {
  FRAMING_BOUNDS,
  FRAMING_SETTINGS_DEFAULTS,
  type Clip,
  type ClipPatch,
  type FramingSettings,
  type FramingStyleOverride,
  type PublishedFraming,
} from '@/lib/api'

/**
 * La surcharge de cadrage du clip : `clip.framingStyle` est un objet creux,
 * chaque contrôle dit s'il est hérité ou surchargé, un bouton isolé le rend à
 * l'héritage.
 *
 * **Montage doublage** ne s'affiche que là où il y a quelque chose à dire : un
 * clip qui porte des plans de doublage, ou dont la composition a été
 * désactivée. Le split-screen n'a plus de contrôle ici.
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
  framing,
  onWrite,
}: {
  clip: Clip
  /** Les réglages globaux du cadrage. `undefined` tant que `GET /api/settings` n'a pas répondu. */
  globals: FramingSettings | undefined
  /** Le cadrage publié par le serveur, pour savoir si ce clip porte du doublage. */
  framing: PublishedFraming
  onWrite: OnWrite
}) {
  const [open, setOpen] = useState(false)

  const loading = globals === undefined
  const resolved: FramingSettings = { ...(globals ?? FRAMING_SETTINGS_DEFAULTS), ...clip.framingStyle }
  // Toutes les clés de `framingStyle`, pas seulement `NUMERIC_KEYS` : un
  // clip surchargeant seulement `dubbingLayout` doit se voir sur le
  // déclencheur. (relevé par Copilot et Codex)
  const overrideCount = Object.keys(clip.framingStyle).length
  const hasOverride = overrideCount > 0

  const { setStyle, resetField, resetAll } = useStyleWrites(
    clip.framingStyle,
    useCallback((framingStyle: FramingStyleOverride) => onWrite({ framingStyle }), [onWrite]),
    // Une écriture refusée ferme la modale : le bandeau d'échec et « Réessayer »
    // vivent dans l'AppBar, rendue inerte tant que la modale reste ouverte.
    // (relevé par Copilot)
    useCallback(() => setOpen(false), []),
  )

  const dubbingCount = dubbingShotCount(framing)
  // La présence de la clé équivaut à `false` : `src/server/db.ts` la type en
  // `z.literal(false)` et `FramingStyleOverride.dubbingLayout` en `false`.
  const dubbingDisabledForClip = hasOverrideOf(clip, 'dubbingLayout')

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" size="sm" variant="ghost" className="w-fit gap-1.5 px-2">
            Personnaliser
            {overrideCount > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums">
                {overrideCount}
              </span>
            )}
          </Button>
        }
      />
      {/* **Bornée et défilable**, même borne que `hook-fields.tsx` : cinq
          `NumberField` se replient souvent sur plusieurs lignes et
          dépassaient un viewport bas sans hauteur maximale. (relevé par
          Copilot) */}
      <DialogContent className="flex max-h-[85vh] flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Cadrage — réglages avancés</DialogTitle>
        </DialogHeader>

        {dubbingDisabledForClip ? (
          <div className="flex items-center gap-2 text-[0.75rem] text-muted-foreground">
            <span>Montage doublage — composition désactivée pour ce clip</span>
            <button
              type="button"
              aria-label="Montage doublage : revenir à l’héritage"
              onClick={() => resetField('dubbingLayout')}
              className="flex items-center gap-1 hover:text-foreground"
            >
              <RotateCcw aria-hidden className="size-3" />
              revenir à l’héritage
            </button>
          </div>
        ) : (
          dubbingCount > 0 && (
            <div className="flex items-center gap-2 text-[0.75rem]">
              <span>
                Montage doublage — {dubbingCount} plan{dubbingCount > 1 ? 's' : ''}
              </span>
              <button
                type="button"
                onClick={() => setStyle('dubbingLayout', false)}
                className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
              >
                désactiver pour ce clip
              </button>
            </div>
          )
        )}

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
      </DialogContent>
    </Dialog>
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

  // Échap démonte le champ sans laisser React déclencher `onBlur` : sans ce
  // filet, une valeur tapée non validée se perdait à la fermeture de la
  // modale par Échap. (relevé par Aristarque)
  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  })
  useEffect(() => () => commitRef.current(), [])

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
