import { describe, expect, it } from 'vitest'

import type { StepName as ÉtapeDuGraphe } from '@/core/graph'
import { DIMENSIONS_PAR_DÉFAUT, type DimensionsRepérage } from '@/core/transcript'
import {
  CIBLES_DE_REPRISE,
  type ChampsRepérage,
  type RunTarget,
  type StepName,
} from '@/lib/api'
import { REGISTRE_RÉGLAGES } from '@/server/db'
import { CIBLES_INITIALES, CIBLES_LANÇABLES, type CibleLançable } from '@/server/run'

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
type Identiques<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

describe("le vocabulaire d'étapes", () => {
  /**
   * `analysis` a manqué au client pendant toute une PR (#31), et rien n'a
   * échoué : ni la compilation, ni les tests, ni le serveur. Seul l'écran le
   * disait, en affichant « undefined en cours ».
   */
  it("est celui du graphe, pas une union qui lui ressemble", () => {
    const mêmeUnion: Identiques<StepName, ÉtapeDuGraphe> = true
    expect(mêmeUnion).toBe(true)
  })

  /**
   * `RunTarget` et `CIBLES_LANÇABLES` décrivent la même chose de deux côtés :
   * un type pour le client, une liste de valeurs pour le lanceur et pour le
   * schéma de la route. Les deux affectations sont le contrôle — la première
   * attrape une cible que le client ignore, la seconde une étape du graphe que
   * le lanceur ne sait pas fabriquer.
   */
  it('couvre exactement les cibles que le lanceur sait fabriquer', () => {
    const versLeClient: RunTarget[] = [...CIBLES_LANÇABLES]
    const versLeServeur: CibleLançable[] = versLeClient
    expect(versLeServeur).toContain('analysis')
  })
})

describe('les cibles de reprise', () => {
  /**
   * `CIBLES_DE_REPRISE` est une recopie délibérée de `CIBLES_INITIALES` :
   * `src/server/run.ts` ne peut pas entrer dans le paquet du navigateur. Ce
   * test est ce qui rend la duplication tenable — sans lui, la reprise
   * viserait un jour autre chose que la création, et le projet resterait dans
   * l'impasse dont le bouton devait le sortir.
   */
  it("sont celles d'une création, dans le même ordre", () => {
    expect([...CIBLES_DE_REPRISE]).toEqual([...CIBLES_INITIALES])
  })

  /** Viser `candidates` seul ne construit jamais le proxy : rien n'en dépend. */
  it('portent le proxy, dont aucune autre cible ne dépend', () => {
    expect(CIBLES_DE_REPRISE).toContain('proxy')
  })
})

describe('les champs de repérage', () => {
  /**
   * `ChampsRepérage` est ce que l'API promet, `DimensionsRepérage` est ce qu'un
   * calcul pur reçoit. Les deux affectations sont le contrôle : l'une attrape un
   * champ que le client ignorerait, l'autre un champ que le client inventerait.
   * Sans elles, un réglage ajouté au calcul serait réglable nulle part, et un
   * réglage retiré du calcul resterait réglable en pure perte.
   */
  it('sont les mêmes des deux côtés de la frontière', () => {
    const versLeClient: ChampsRepérage = DIMENSIONS_PAR_DÉFAUT
    const versLeCalcul: DimensionsRepérage = versLeClient
    expect(versLeCalcul).toEqual(DIMENSIONS_PAR_DÉFAUT)
  })

  /**
   * Et le registre les couvre tous. `REGISTRE_RÉGLAGES` se dérive des clés de
   * `DIMENSIONS_PAR_DÉFAUT`, donc l'égalité est vraie par construction — ce test
   * la tient le jour où quelqu'un remplacera la dérivation par une liste écrite
   * à la main, ce qui est exactement la forme qu'avait le code d'avant.
   */
  it('sont tous décrits par le registre, et lui seul', () => {
    expect(REGISTRE_RÉGLAGES.filter((c) => c.famille === 'selection').map((c) => c.nom).sort()).toEqual(
      Object.keys(DIMENSIONS_PAR_DÉFAUT).sort(),
    )
    expect(REGISTRE_RÉGLAGES.length).toBe(Object.keys(DIMENSIONS_PAR_DÉFAUT).length)
  })
})
