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
  { valeur: 'aucune', libelle: 'Aucune' },
  { valeur: 'fade', libelle: 'Fondu' },
  { valeur: 'glitch', libelle: 'Glitch' },
  { valeur: 'scanline', libelle: 'Scanline' },
] as const

const POSITIONS = [
  { valeur: 'haut', libelle: 'Tiers supérieur' },
  { valeur: 'centre', libelle: 'Centre' },
  { valeur: 'bas', libelle: 'Tiers inférieur' },
] as const

const ALIGNEMENTS = [
  { valeur: 'gauche', libelle: 'À gauche' },
  { valeur: 'centre', libelle: 'Centré' },
  { valeur: 'droite', libelle: 'À droite' },
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
export const HOOK_PAR_DÉFAUT = {
  activé: true,
  duréeSec: 2,
  police: 'Anton',
  taille: 56,
  position: 'haut',
  couleurTexte: '#FFFFFF',
  couleurFond: '#000000',
  opacitéFond: 60,
  alignement: 'centre',
  apparition: 'fade',
  disparition: 'fade',
} as const

export function SectionHook() {
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

        <Ligne>
          <ChampCase libelle="Hook activé par défaut" coché={HOOK_PAR_DÉFAUT.activé} />
          <ChampNombre
            libelle="Durée"
            valeur={HOOK_PAR_DÉFAUT.duréeSec}
            unité="secondes"
            pas={0.5}
          />
        </Ligne>

        <Ligne>
          <ChampChoix
            libelle="Police"
            valeur={HOOK_PAR_DÉFAUT.police}
            options={[{ valeur: 'Anton', libelle: 'Anton — la seule police embarquée' }]}
          />
          <ChampNombre libelle="Taille" valeur={HOOK_PAR_DÉFAUT.taille} unité="points" pas={1} />
        </Ligne>

        <Ligne>
          <ChampChoix
            libelle="Position"
            valeur={HOOK_PAR_DÉFAUT.position}
            options={POSITIONS}
          />
          <ChampChoix
            libelle="Alignement"
            valeur={HOOK_PAR_DÉFAUT.alignement}
            options={ALIGNEMENTS}
          />
        </Ligne>

        <Ligne>
          <ChampCouleur libelle="Couleur du texte" valeur={HOOK_PAR_DÉFAUT.couleurTexte} />
          <ChampCouleur libelle="Couleur du fond" valeur={HOOK_PAR_DÉFAUT.couleurFond} />
          <ChampNombre
            libelle="Opacité du fond"
            valeur={HOOK_PAR_DÉFAUT.opacitéFond}
            unité="%"
            pas={5}
          />
        </Ligne>

        <Ligne>
          <ChampChoix
            libelle="Effet d’apparition"
            valeur={HOOK_PAR_DÉFAUT.apparition}
            options={TRANSITIONS}
          />
          <ChampChoix
            libelle="Effet de disparition"
            valeur={HOOK_PAR_DÉFAUT.disparition}
            options={TRANSITIONS}
          />
        </Ligne>
      </fieldset>
    </section>
  )
}

function Ligne({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-4 rounded-xl border px-4 py-3">
      {children}
    </div>
  )
}

function ChampCase({ libelle, coché }: { libelle: string; coché: boolean }) {
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={coché} />
      <Label htmlFor={id} className="text-sm font-normal">
        {libelle}
      </Label>
    </div>
  )
}

function ChampNombre({
  libelle,
  valeur,
  unité,
  pas,
}: {
  libelle: string
  valeur: number
  unité: string
  pas: number
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {libelle}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          step={pas}
          value={valeur}
          readOnly
          className="h-8 w-20 text-sm tabular-nums"
        />
        <span className="text-xs text-muted-foreground">{unité}</span>
      </div>
    </div>
  )
}

function ChampChoix({
  libelle,
  valeur,
  options,
}: {
  libelle: string
  valeur: string
  options: readonly { valeur: string; libelle: string }[]
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {libelle}
      </Label>
      <Select value={valeur}>
        <SelectTrigger id={id} className="w-52">
          {/* Le libellé, pas la valeur : sans lui la boîte affiche `fade` là où
              l'écran dit « Fondu » partout ailleurs. */}
          <SelectValue>{options.find((o) => o.valeur === valeur)?.libelle ?? valeur}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.valeur} value={o.valeur}>
              {o.libelle}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function ChampCouleur({ libelle, valeur }: { libelle: string; valeur: string }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {libelle}
      </Label>
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-6 shrink-0 rounded-md border"
          style={{ backgroundColor: valeur }}
        />
        <Input
          id={id}
          value={valeur}
          readOnly
          className="h-8 w-24 font-mono text-sm uppercase"
        />
      </div>
    </div>
  )
}
