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
const PAROLE_DE_RÉFÉRENCE_SEC = 90 * 60

/**
 * Assez de fenêtres pour que la présélection ne soit pas bornée par l'émission.
 *
 * `shortlistSize` plafonne au nombre de fenêtres qui existent réellement. Pour
 * une estimation, ce plafond ne renseigne pas — il dirait ce que la plus courte
 * des émissions permet, pas ce que le réglage demande. La phrase le dit :
 * « si l'émission en compte assez ».
 */
const FENÊTRES_À_VOLONTÉ = 10_000

/** Un réglage, tel que l'écran le présente. */
type Champ = {
  clé: keyof DimensionsRepérage
  libelle: string
  explication: string
  /** L'unité qui suit la boîte de saisie, ou `null`. */
  unité: string | null
  /** La plus petite valeur qui ait un sens. */
  minimum: number
}

const CHAMPS: readonly Champ[] = [
  {
    clé: 'minutesParClip',
    libelle: 'Une proposition par tranche de',
    explication:
      'Le repérage demande au modèle un extrait par tranche de parole. Plus la valeur est basse, plus il en propose sur une même émission.',
    unité: 'minutes de parole',
    minimum: 1,
  },
  {
    clé: 'clipsMinimum',
    libelle: 'Propositions demandées au minimum',
    explication:
      'Le modèle s’assied sur le minimum qu’on lui donne : mesuré en production, 95 % des passes rendaient trois extraits ou moins alors que le prompt était libre d’en rendre bien plus. C’est ce nombre-là qui décide, pas la consigne.',
    unité: null,
    minimum: 1,
  },
  {
    clé: 'clipsMaximum',
    libelle: 'Propositions demandées au maximum',
    explication:
      'Borne les deux bouts de la fourchette envoyée au modèle. À zéro, aucune limite ne s’applique.',
    unité: '0 = illimité',
    minimum: 0,
  },
  {
    clé: 'fenetresParClip',
    libelle: 'Fenêtres examinées par proposition demandée',
    explication:
      'L’émission est notée par fenêtres de 90 secondes, puis seules les meilleures partent à la passe de détail. Ce nombre dit combien de fenêtres accompagnent chaque extrait demandé : plus haut, le modèle a plus de matière — et une charge trop grosse dilue son attention.',
    unité: null,
    minimum: 1,
  },
  {
    clé: 'fenetresMinimum',
    libelle: 'Fenêtres examinées au minimum',
    explication:
      'Un plancher, pour qu’une émission courte ne parte pas avec trop peu de matière. Il ne s’applique pas au-delà de ce que l’émission contient.',
    unité: null,
    minimum: 1,
  },
]

export function SectionRepérage({
  valeurs,
  onChanger,
  désactivé = false,
}: {
  valeurs: DimensionsRepérage
  /** Écrit un ou plusieurs champs. L'écran décide quand et comment. */
  onChanger: (patch: Partial<DimensionsRepérage>) => void
  /** Le temps qu'une lecture ou une écriture soit en vol. */
  désactivé?: boolean
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
        {CHAMPS.map((champ) => (
          <Réglage
            key={champ.clé}
            champ={champ}
            valeur={valeurs[champ.clé]}
            défaut={DIMENSIONS_PAR_DÉFAUT[champ.clé]}
            désactivé={désactivé}
            onChanger={(valeur) => onChanger({ [champ.clé]: valeur })}
          />
        ))}
      </div>

      <Estimation valeurs={valeurs} />
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
function Réglage({
  champ,
  valeur,
  défaut,
  désactivé,
  onChanger,
}: {
  champ: Champ
  valeur: number
  défaut: number
  désactivé: boolean
  onChanger: (valeur: number) => void
}) {
  const id = useId()
  const aide = `${id}-aide`
  const [brouillon, setBrouillon] = useState(String(valeur))
  // **Le recalage se fait pendant le rendu, pas dans un effet.** Un effet qui
  // appelle `setState` déclenche un rendu en cascade — `react-hooks/set-state-in-effect`
  // le refuse — et il repeindrait l'ancienne valeur une image avant la nouvelle.
  // C'est le motif documenté par React pour l'état qui se recale sur ses props :
  // on compare à ce qu'on avait vu, on met à jour, React relance le rendu avant
  // de valider quoi que ce soit.
  const [vue, setVue] = useState(valeur)
  if (vue !== valeur) {
    setVue(valeur)
    setBrouillon(String(valeur))
  }

  function valider() {
    const lu = Number(brouillon)
    // Une saisie qui ne décrit aucun nombre revient à la valeur en place :
    // refuser en silence laisserait une boîte vide sur un écran qui n'a aucune
    // autre façon de dire ce qui s'applique.
    if (!Number.isFinite(lu)) return setBrouillon(String(valeur))
    const borné = Math.max(champ.minimum, Math.round(lu))
    setBrouillon(String(borné))
    if (borné !== valeur) onChanger(borné)
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Label htmlFor={id} className="text-sm font-medium">
          {champ.libelle}
        </Label>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={champ.minimum}
          step={1}
          disabled={désactivé}
          aria-describedby={aide}
          value={brouillon}
          onChange={(e) => setBrouillon(e.target.value)}
          onBlur={valider}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              valider()
            }
          }}
          className="h-8 w-24 text-sm tabular-nums"
        />
        {champ.unité !== null && (
          <span className="text-sm text-muted-foreground">{champ.unité}</span>
        )}

        {/* **Le retour au défaut ne s'affiche que s'il y a quelque chose à
            défaire.** Un bouton toujours présent et sans effet sur quatre
            réglages sur cinq apprend à ne plus le lire. Sa valeur est écrite
            dessus : « revenir à 6 » dit à la fois ce qu'il fera et ce que le
            défaut vaut, ce qui économise une ligne par réglage. */}
        {valeur !== défaut && (
          <Button
            variant="ghost"
            size="sm"
            disabled={désactivé}
            onClick={() => onChanger(défaut)}
            className="ml-auto text-xs"
          >
            <RotateCcw aria-hidden />
            Revenir à {défaut}
          </Button>
        )}
      </div>
      <p id={aide} className="text-xs text-muted-foreground">
        {champ.explication}
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
function Estimation({ valeurs }: { valeurs: DimensionsRepérage }) {
  const [plancher, plafond] = clipCountTargets(PAROLE_DE_RÉFÉRENCE_SEC, valeurs)
  const fenêtres = shortlistSize(PAROLE_DE_RÉFÉRENCE_SEC, FENÊTRES_À_VOLONTÉ, valeurs)

  return (
    <div
      data-testid="estimation-reperage"
      className="rounded-xl border border-stage/50 bg-stage-muted px-4 py-3 text-sm"
    >
      <p className="font-medium">Pour une émission avec environ 90 min de parole</p>
      <ul className="mt-1 flex flex-col gap-0.5 text-sm tabular-nums">
        <li>
          {plancher === plafond
            ? `~${plancher} clips demandés au modèle`
            : `~${plancher} à ${plafond} clips demandés au modèle`}
        </li>
        <li>~{fenêtres} fenêtres examinées en détail, si l’émission en compte assez</li>
      </ul>
    </div>
  )
}
