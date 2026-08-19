'use client'

import { RotateCcw } from 'lucide-react'
import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  clipCountTargets,
  shortlistSize,
  DIMENSIONS_PAR_DÉFAUT,
  type DimensionsRepérage,
} from '@/core/transcript'

/**
 * Les cinq réglages du repérage, **en unités qu'une personne peut régler**.
 *
 * Ils vivaient en constantes puis en base, et n'avaient aucune surface. Ce qui
 * les rend réglables ici n'est pas la boîte de saisie mais les trois choses qui
 * l'accompagnent : un libellé qui ne soit pas le nom de la clé, une phrase qui
 * dit ce que le réglage fait, et le moyen de revenir au défaut. Un écran qui
 * afficherait `fenetresParClip: 2` demanderait d'aller lire le code pour savoir
 * s'il faut monter ou descendre.
 *
 * **L'estimation résultante fait le reste.** Cinq nombres qui se règlent
 * séparément ne disent rien de ce qu'ils produisent ensemble ; une phrase qui
 * annonce « pour une émission avec environ 90 min de parole : ~15 à 23 clips
 * demandés » rend l'effet lisible au moment du geste. Elle sort de
 * `clipCountTargets` et `shortlistSize`, les fonctions que le repérage utilise
 * réellement — pas d'une formule recopiée qui divergerait.
 */

/**
 * L'émission de référence de l'estimation : **90 minutes de parole**.
 *
 * C'est l'ordre de grandeur des deux émissions du dépôt — `2025-06-15-cqlp` en
 * porte 1 h 32, `2026-22-02-entre-nous` 1 h 51 — et c'est le chiffre que le
 * retour d'usage donne en exemple. Une seule référence, nommée dans la phrase :
 * un curseur qui montrerait son effet sur « une émission » sans dire laquelle
 * ferait croire à une prédiction.
 */
const REFERENCE_SPEECH_SEC = 90 * 60

/**
 * Assez de fenêtres pour que la présélection ne soit pas bornée par l'émission.
 *
 * `shortlistSize` plafonne au nombre de fenêtres qui existent réellement. Pour
 * une estimation, ce plafond ne renseigne pas — il dirait ce que la plus courte
 * des émissions permet, pas ce que le réglage demande. La phrase le dit :
 * « si l'émission en compte assez ».
 */
const UNBOUNDED_WINDOWS = 10_000

/** Un réglage, tel que l'écran le présente. */
type Field = {
  key: keyof DimensionsRepérage
  label: string
  help: string
  /** L'unité qui suit la boîte de saisie, ou `null`. */
  unit: string | null
  /** La plus petite valeur qui ait un sens. */
  minimum: number
}

const FIELDS: readonly Field[] = [
  {
    key: 'minutesParClip',
    label: 'Une proposition par tranche de',
    help:
      'Le repérage demande au modèle un extrait par tranche de parole. Plus la valeur est basse, plus il en propose sur une même émission.',
    unit: 'minutes de parole',
    minimum: 1,
  },
  {
    key: 'clipsMinimum',
    label: 'Propositions demandées au minimum',
    help:
      'Le modèle s’assied sur le minimum qu’on lui donne : mesuré en production, 95 % des passes rendaient trois extraits ou moins alors que le prompt était libre d’en rendre bien plus. C’est ce nombre-là qui décide, pas la consigne.',
    unit: null,
    minimum: 1,
  },
  {
    key: 'clipsMaximum',
    label: 'Propositions demandées au maximum',
    help:
      'Borne les deux bouts de la fourchette envoyée au modèle. À zéro, aucune limite ne s’applique.',
    unit: '0 = illimité',
    minimum: 0,
  },
  {
    key: 'fenetresParClip',
    label: 'Fenêtres examinées par proposition demandée',
    help:
      'L’émission est notée par fenêtres de 90 secondes, puis seules les meilleures partent à la passe de détail. Ce nombre dit combien de fenêtres accompagnent chaque extrait demandé : plus haut, le modèle a plus de matière — et une charge trop grosse dilue son attention.',
    unit: null,
    minimum: 1,
  },
  {
    key: 'fenetresMinimum',
    label: 'Fenêtres examinées au minimum',
    help:
      'Un plancher, pour qu’une émission courte ne parte pas avec trop peu de matière. Il ne s’applique pas au-delà de ce que l’émission contient.',
    unit: null,
    minimum: 1,
  },
]

export function SelectionSection({
  values,
  onChange,
  disabled = false,
}: {
  values: DimensionsRepérage
  /**
   * Écrit un ou plusieurs champs. L'écran décide quand et comment.
   *
   * **Rendre une promesse est ce qui permet au champ de se recaler sur un
   * refus.** L'écriture n'est pas optimiste : un `PUT` en 400 ne touche pas au
   * cache, donc `values` ne bouge pas — et un champ qui n'écoute que `values`
   * garde éternellement le nombre que le serveur vient de rejeter, sous un
   * bandeau qui déclare qu'il n'est pas enregistré. Un appelant qui ne rend rien
   * garde l'ancien comportement. (relevé par Copilot)
   */
  onChange: (patch: Partial<DimensionsRepérage>) => void | Promise<unknown>
  /** Le temps qu'une lecture ou une écriture soit en vol. */
  disabled?: boolean
}) {
  return (
    <section aria-labelledby="titre-reperage" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="titre-reperage" className="text-base font-semibold tracking-tight">
          Repérage
        </h2>
        <p className="text-sm text-muted-foreground">
          Ce que l’application demande au modèle quand elle cherche les extraits
          d’une émission. Changer un réglage ne recalcule rien : les émissions
          déjà analysées se relancent à la main, depuis leur écran.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {FIELDS.map((field) => (
          <SettingField
            key={field.key}
            field={field}
            value={values[field.key]}
            defaultValue={DIMENSIONS_PAR_DÉFAUT[field.key]}
            disabled={disabled}
            onChange={(value) => onChange({ [field.key]: value })}
          />
        ))}
      </div>

      <Estimate values={values} />
    </section>
  )
}

/**
 * Un réglage : sa boîte, son explication, et le retour à son défaut.
 *
 * **La saisie se valide en quittant le champ, jamais à la frappe.** Un `4`
 * tapé pour faire `45` passerait sinon par une valeur écrite, envoyée et
 * appliquée ; et une boîte vidée pour être réécrite enverrait un zéro. Le brouillon
 * vit donc ici, et ne remonte qu'au `blur` ou à `Entrée`.
 *
 * **Et il se recale sur la valeur du serveur.** C'est elle qui fait autorité :
 * une écriture refusée, une valeur bornée côté serveur ou un autre onglet
 * doivent se voir ici plutôt que de laisser un brouillon divergent à l'écran.
 */
function SettingField({
  field,
  value,
  defaultValue,
  disabled,
  onChange,
}: {
  field: Field
  value: number
  defaultValue: number
  disabled: boolean
  onChange: (value: number) => void | Promise<unknown>
}) {
  const id = useId()
  const helpId = `${id}-help`
  const [draft, setDraft] = useState(String(value))
  // **Le recalage se fait pendant le rendu, pas dans un effet.** Un effet qui
  // appelle `setState` déclenche un rendu en cascade — `react-hooks/set-state-in-effect`
  // le refuse — et il repeindrait l'ancienne valeur une image avant la nouvelle.
  // C'est le motif documenté par React pour l'état qui se recale sur ses props :
  // on compare à ce qu'on avait vu, on met à jour, React relance le rendu avant
  // de valider quoi que ce soit.
  //
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(String(value))
  }

  /**
   * Écrit, et ramène la valeur qui s'applique si le serveur refuse.
   *
   * **Le rejet est consommé ici, pas relevé** : le bandeau de l'écran le porte
   * déjà. Et il passe par cette porte-là quel que soit le geste — la saisie
   * validée comme le retour au défaut : le bouton appelait `onChange` sans rien
   * faire de la promesse, ce qui produisait un rejet non géré en plus du bandeau.
   * (relevé par Copilot)
   */
  function submit(next: number) {
    if (next === value) return
    void Promise.resolve(onChange(next)).catch(() => setDraft(String(value)))
  }

  function commit() {
    // **Une boîte vide n'est pas un zéro**, et c'est le piège de `Number` :
    // `Number('')` vaut `0`, un nombre fini. Effacer un champ puis en sortir
    // enregistrait donc son minimum en silence — et sur « Propositions demandées
    // au maximum », dont le plancher est zéro, ça activait « illimité » sans que
    // personne ne l'ait demandé. Le blanc se traite comme le reste de ce qui ne
    // décrit aucun nombre : on revient à la valeur en place, parce que l'écran
    // n'a aucune autre façon de dire ce qui s'applique. (relevé par Copilot)
    const parsed = draft.trim() === '' ? Number.NaN : Number(draft)
    if (!Number.isFinite(parsed)) return setDraft(String(value))
    const bounded = Math.max(field.minimum, Math.round(parsed))
    setDraft(String(bounded))
    submit(bounded)
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Label htmlFor={id} className="text-sm font-medium">
          {field.label}
        </Label>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={field.minimum}
          step={1}
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
        {field.unit !== null && <span className="text-sm text-muted-foreground">{field.unit}</span>}

        {/* **Le retour au défaut ne s'affiche que s'il y a quelque chose à
            défaire.** Un bouton toujours présent et sans effet sur quatre
            réglages sur cinq apprend à ne plus le lire. Sa valeur est écrite
            dessus : « revenir à 6 » dit à la fois ce qu'il fera et ce que le
            défaut vaut, ce qui économise une ligne par réglage. */}
        {value !== defaultValue && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => submit(defaultValue)}
            className="ml-auto text-xs"
          >
            <RotateCcw aria-hidden />
            Revenir à {defaultValue}
          </Button>
        )}
      </div>
      <p id={helpId} className="text-xs text-muted-foreground">
        {field.help}
      </p>
    </div>
  )
}

/**
 * Ce que les cinq réglages produisent ensemble.
 *
 * **Calculée par les fonctions du repérage lui-même**, `clipCountTargets` et
 * `shortlistSize` : elles sont pures, elles ne dépendent d'aucune base, et
 * c'est ce qui garantit que la phrase dit ce que l'application fera. Une formule
 * recopiée dans l'écran aurait divergé au premier réglage de la règle — c'est
 * arrivé une fois, entre le plancher de clips et la taille de présélection, et
 * `shortlistSize` dérive du premier depuis.
 */
function Estimate({ values }: { values: DimensionsRepérage }) {
  const [low, high] = clipCountTargets(REFERENCE_SPEECH_SEC, values)
  const windows = shortlistSize(REFERENCE_SPEECH_SEC, UNBOUNDED_WINDOWS, values)

  return (
    <div
      data-testid="selection-estimate"
      className="rounded-xl border border-stage/50 bg-stage-muted px-4 py-3 text-sm"
    >
      <p className="font-medium">Pour une émission avec environ 90 min de parole</p>
      <ul className="mt-1 flex flex-col gap-0.5 text-sm tabular-nums">
        <li>
          {low === high
            ? `~${low} clips demandés au modèle`
            : `~${low} à ${high} clips demandés au modèle`}
        </li>
        <li>~{windows} fenêtres examinées en détail, si l’émission en compte assez</li>
      </ul>
    </div>
  )
}
