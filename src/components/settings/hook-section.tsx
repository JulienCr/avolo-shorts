'use client'

import { Info } from 'lucide-react'
import { useId } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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

/**
 * Les valeurs par défaut du hook — **en lecture seule, et c'est délibéré**.
 *
 * Le hook est le texte court affiché dès la première image d'un clip, pour
 * accrocher dans le fil avant même que le spectateur comprenne le contexte. Ces
 * réglages en sont les défauts ; un clip pourra ensuite les surcharger.
 *
 * **Rien ne s'écrit ici tant que le serveur ne sait pas les stocker.** Le
 * contrat des réglages ne porte aujourd'hui que la section « repérage »
 * (`Réglages = { selection: ChampsRepérage }`), et le rendu du hook appartient à
 * une livraison ultérieure. Deux mauvaises réponses étaient possibles : inventer
 * une seconde voie d'écriture — un endroit de plus où le même réglage vivrait,
 * donc un endroit de plus d'où il divergerait —, ou ne rien montrer et laisser
 * la prochaine livraison redécouvrir la forme. Celle-ci montre la forme, dit
 * qu'elle ne s'enregistre pas encore, et n'ouvre aucune porte.
 *
 * **Quatre transitions, pas dix.** Le retour d'usage le dit : « éviter
 * d'implémenter dix effets avant d'avoir validé visuellement les quatre
 * premiers ». Chacune coûte un filtre ffmpeg à écrire, à mesurer et à regarder.
 */

/** Les quatre seules transitions du premier lot. */
export const TRANSITIONS = [
  { value: 'none', label: 'Aucune' },
  { value: 'fade', label: 'Fondu' },
  { value: 'glitch', label: 'Glitch' },
  { value: 'scanline', label: 'Scanline' },
] as const

const POSITIONS = [
  { value: 'top', label: 'Tiers supérieur' },
  { value: 'center', label: 'Centre' },
  { value: 'bottom', label: 'Tiers inférieur' },
] as const

const ALIGNMENTS = [
  { value: 'left', label: 'À gauche' },
  { value: 'center', label: 'Centré' },
  { value: 'right', label: 'À droite' },
] as const

/**
 * Ce que l'écran propose, **et ce que rien n'enregistre encore**.
 *
 * Écrit en un seul objet pour que la livraison qui branchera le stockage ait un
 * seul endroit à déplacer, et pour que ces valeurs ne se retrouvent pas
 * dispersées dans le JSX.
 *
 * `police` ne propose qu'Anton : c'est la seule police embarquée dans `fonts/`,
 * celle que les sous-titres utilisent déjà, et la seule que le rendu sache
 * résoudre. En proposer d'autres inviterait à choisir une police que ffmpeg ne
 * trouverait pas — un rendu correct à l'écran et faux dans le fichier.
 */
export const HOOK_DEFAULTS = {
  enabled: true,
  durationSec: 2,
  font: 'Anton',
  size: 56,
  position: 'top',
  textColor: '#FFFFFF',
  backgroundColor: '#000000',
  backgroundOpacity: 60,
  alignment: 'center',
  enter: 'fade',
  exit: 'fade',
} as const

export function HookSection() {
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

      <Alert>
        <Info aria-hidden />
        <AlertTitle>Ces réglages ne s’enregistrent pas encore.</AlertTitle>
        <AlertDescription>
          Le rendu du hook et le stockage de ses défauts arrivent dans une
          livraison suivante. Ce qui est montré ici est la forme retenue, pas un
          état enregistré.
        </AlertDescription>
      </Alert>

      {/* **Le `fieldset` ne suffit pas, et c'est mesuré.** `fieldset[disabled]`
          ne désactive que les contrôles de formulaire natifs. Le déclencheur de
          `Select` rend un `<button role="combobox">` et tombe donc bien sous la
          règle — vérifié : le clic n'ouvre pas la liste. La case, elle, rend un
          `<span role="checkbox">`, que le `fieldset` ignore complètement. Chaque
          contrôle porte donc aussi son propre `disabled` : c'est ce qui rend
          l'inertie indépendante du tag que la primitive choisit de rendre, et un
          changement de version ne la défera pas en silence.
          (relevé par Aristarque) */}
      <fieldset
        disabled
        aria-describedby="hook-inerte"
        className="flex flex-col gap-4 opacity-70"
      >
        <legend className="sr-only">Valeurs par défaut du hook</legend>
        <p id="hook-inerte" className="sr-only">
          Ces contrôles sont inertes : les valeurs ne sont pas encore
          enregistrées.
        </p>

        <Row>
          <CheckboxField label="Hook activé par défaut" checked={HOOK_DEFAULTS.enabled} />
          <NumberField
            label="Durée"
            value={HOOK_DEFAULTS.durationSec}
            unit="secondes"
            step={0.5}
          />
        </Row>

        <Row>
          <SelectField
            label="Police"
            value={HOOK_DEFAULTS.font}
            options={[{ value: 'Anton', label: 'Anton — la seule police embarquée' }]}
          />
          <NumberField label="Taille" value={HOOK_DEFAULTS.size} unit="points" step={1} />
        </Row>

        <Row>
          <SelectField label="Position" value={HOOK_DEFAULTS.position} options={POSITIONS} />
          <SelectField label="Alignement" value={HOOK_DEFAULTS.alignment} options={ALIGNMENTS} />
        </Row>

        <Row>
          <ColorField label="Couleur du texte" value={HOOK_DEFAULTS.textColor} />
          <ColorField label="Couleur du fond" value={HOOK_DEFAULTS.backgroundColor} />
          <NumberField
            label="Opacité du fond"
            value={HOOK_DEFAULTS.backgroundOpacity}
            unit="%"
            step={5}
          />
        </Row>

        <Row>
          <SelectField
            label="Effet d’apparition"
            value={HOOK_DEFAULTS.enter}
            options={TRANSITIONS}
          />
          <SelectField
            label="Effet de disparition"
            value={HOOK_DEFAULTS.exit}
            options={TRANSITIONS}
          />
        </Row>
      </fieldset>
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

function CheckboxField({ label, checked }: { label: string; checked: boolean }) {
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} disabled />
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
    </div>
  )
}

function NumberField({
  label,
  value,
  unit,
  step,
}: {
  label: string
  value: number
  unit: string
  step: number
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          step={step}
          value={value}
          readOnly
          className="h-8 w-20 text-sm tabular-nums"
        />
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
    </div>
  )
}

function SelectField({
  label,
  value,
  options,
}: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <Select value={value} disabled>
        <SelectTrigger id={id} className="w-52">
          {/* Le libellé, pas la valeur : sans lui la boîte affiche `fade` là où
              l'écran dit « Fondu » partout ailleurs. */}
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
    </div>
  )
}

function ColorField({ label, value }: { label: string; value: string }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-6 shrink-0 rounded-md border"
          style={{ backgroundColor: value }}
        />
        <Input id={id} value={value} readOnly className="h-8 w-24 font-mono text-sm uppercase" />
      </div>
    </div>
  )
}
