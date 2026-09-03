import { describe, expect, it } from 'vitest'

import type { StepName as GraphStep } from '@/core/graph'
import type { LibraryProject } from '@/core/library'
import { DEFAULT_SELECTION_DIMENSIONS, type SelectionDimensions } from '@/core/transcript'
import {
  RESUME_TARGETS,
  type ProjectListItem,
  type ProjectStatus,
  type SelectionSettings,
  type RunTarget,
  type StepName,
} from '@/lib/api'
import { SETTING_FIELDS } from '@/server/db'
import {
  TARGETS_INITIAL,
  TARGETS_LAUNCHABLE,
  type Progression,
  type TargetLaunchable,
} from '@/server/run'

/**
 * Les endroits où le client et le serveur disent la même chose deux fois.
 *
 * **Ce fichier se lit avec `tsc` autant qu'avec `vitest`.** Un vocabulaire
 * recopié ne produit aucune erreur d'exécution : il produit un libellé vide à
 * l'écran six mois plus tard. La plupart des vérifications ci-dessous sont donc
 * des affectations qui ne compilent pas quand les deux côtés divergent, et leur
 * `expect` ne fait que les exécuter pour qu'elles apparaissent dans la suite.
 *
 * C'est le critère de sortie de l'issue #39 : ajouter une étape dans
 * `src/core/graph.ts` sans toucher au reste doit **casser le `type-check`**.
 */

/** Vrai seulement si chaque union accepte l'autre entièrement. */
type Identical<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

describe("le vocabulaire d'étapes", () => {
  /**
   * `analysis` a manqué au client pendant toute une PR (#31), et rien n'a
   * échoué : ni la compilation, ni les tests, ni le serveur. Seul l'écran le
   * disait, en affichant « undefined en cours ».
   */
  it("est celui du graphe, pas une union qui lui ressemble", () => {
    const sameUnion: Identical<StepName, GraphStep> = true
    expect(sameUnion).toBe(true)
  })

  /**
   * `RunTarget` et `TARGETS_LAUNCHABLE` décrivent la même chose de deux côtés :
   * un type pour le client, une liste de valeurs pour le lanceur et pour le
   * schéma de la route. Les deux affectations sont le contrôle — la première
   * attrape une cible que le client ignore, la seconde une étape du graphe que
   * le lanceur ne sait pas fabriquer.
   */
  it('couvre exactement les cibles que le lanceur sait fabriquer', () => {
    const towardClient: RunTarget[] = [...TARGETS_LAUNCHABLE]
    const towardServer: TargetLaunchable[] = towardClient
    expect(towardServer).toContain('analysis')
  })
})

describe('les cibles de reprise', () => {
  /**
   * `RESUME_TARGETS` est une recopie délibérée de `TARGETS_INITIAL` :
   * `src/server/run.ts` ne peut pas entrer dans le paquet du navigateur. Ce
   * test est ce qui rend la duplication tenable — sans lui, la reprise
   * viserait un jour autre chose que la création, et le projet resterait dans
   * l'impasse dont le bouton devait le sortir.
   */
  it("sont celles d'une création, dans le même ordre", () => {
    expect([...RESUME_TARGETS]).toEqual([...TARGETS_INITIAL])
  })

  /** Viser `candidates` seul ne construit jamais le proxy : rien n'en dépend. */
  it('portent le proxy, dont aucune autre cible ne dépend', () => {
    expect(RESUME_TARGETS).toContain('proxy')
  })
})

describe('les champs de repérage', () => {
  /**
   * `SelectionSettings` est ce que l'API promet, `SelectionDimensions` est ce
   * qu'un calcul pur reçoit. Les deux affectations sont le contrôle : l'une
   * attrape un champ que le client ignorerait, l'autre un champ que le client
   * inventerait. Sans elles, un réglage ajouté au calcul serait réglable nulle
   * part, et un réglage retiré du calcul resterait réglable en pure perte.
   */
  it('sont les mêmes des deux côtés de la frontière', () => {
    const towardClient: SelectionSettings = DEFAULT_SELECTION_DIMENSIONS
    const towardComputation: SelectionDimensions = towardClient
    expect(towardComputation).toEqual(DEFAULT_SELECTION_DIMENSIONS)
  })

  /**
   * Et le registre les couvre tous. `SETTING_FIELDS` se dérive des clés de
   * `DEFAULT_SELECTION_DIMENSIONS`, donc l'égalité est vraie par construction — ce test
   * la tient le jour où quelqu'un remplacera la dérivation par une liste écrite
   * à la main, ce qui est exactement la forme qu'avait le code d'avant.
   */
  it('sont tous décrits par le registre, et lui seul', () => {
    expect(SETTING_FIELDS.filter((f) => f.family === 'selection').map((f) => f.name).sort()).toEqual(
      Object.keys(DEFAULT_SELECTION_DIMENSIONS).sort(),
    )
    // **La longueur totale, pas seulement celle de la famille `selection`** :
    // le registre porte aussi `ai` depuis la PR C, donc l'égalité se vérifie
    // sur la sous-liste filtrée ci-dessus, et non plus sur `SETTING_FIELDS`
    // entier.
    expect(SETTING_FIELDS.filter((f) => f.family === 'selection').length).toBe(
      Object.keys(DEFAULT_SELECTION_DIMENSIONS).length,
    )
  })
})

describe("l'avancement publié", () => {
  /**
   * `Progression` (`src/server/run.ts`) est structurellement dupliqué à trois
   * endroits — issue #39, comme `StepName` ci-dessus. `waiting` a manqué à
   * l'un d'eux, ce test aurait cassé le `type-check` avant que quiconque ne
   * le remarque à l'écran.
   */
  it('est identique à ses trois miroirs côté client', () => {
    const towardStatus: Identical<Progression, NonNullable<ProjectStatus['running']>> = true
    const towardListItem: Identical<Progression, NonNullable<ProjectListItem['running']>> = true
    const towardLibrary: Identical<Progression, NonNullable<LibraryProject['running']>> = true
    expect(towardStatus && towardListItem && towardLibrary).toBe(true)
  })
})
