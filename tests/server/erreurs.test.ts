import { afterEach, describe, expect, it } from 'vitest'

import { messageSûr } from '@/server/erreurs'

/**
 * **Ce que `racines()` sait et que la grammaire d'`épurerChemins` ne peut pas
 * savoir : où une référence finit.**
 *
 * Hors citation, `src/core/erreurs.ts` arrête une référence au premier espace,
 * exactement comme un chemin nu — et pour la même raison. La grammaire qui
 * traversait les espaces a été écrite puis retirée : elle avalait la prose
 * derrière une référence incomplète, diagnostic et remède compris, et un
 * caviardage qui rend l'erreur inutile finit par sauter.
 *
 * La fermeture est donc ici. Une référence lue dans l'environnement **est** une
 * chaîne littérale, au même titre que `REPLAY_DIR` : on sait où elle finit
 * parce qu'on la tient en entier, espaces compris. `racines()` la passe en
 * racine, `épurerChemins` la retire littéralement, et la queue du coffre ne
 * sort plus.
 *
 * **Aucune valeur de secret n'entre là-dedans** : seule une valeur qui *est*
 * une référence est retenue, et une référence n'est pas une valeur — elle nomme
 * le coffre, la fiche et le champ. Le contrôle négatif du bas le fige.
 */

const envDépart = { ...process.env }

afterEach(() => {
  process.env = { ...envDépart }
})

/** Un coffre et une fiche à espaces, et rien qui ressemble à une vraie fiche. */
const RÉFÉRENCE = 'op://Coffre de démonstration/Fiche imaginaire/CHAMP'

describe('messageSûr, sur les références de secret', () => {
  it('caviarde une référence à espaces, hors citation comme entre guillemets', () => {
    process.env.AVOLO_TEST_SECRET = RÉFÉRENCE

    expect(messageSûr(new Error(`lecture de ${RÉFÉRENCE} refusée`))).toBe(
      'lecture de op://… refusée',
    )
    expect(messageSûr(new Error(`valeur "${RÉFÉRENCE}" refusée`))).toBe('valeur "op://…" refusée')
    expect(messageSûr(new Error(`could not read secret '${RÉFÉRENCE}'`))).toBe(
      "could not read secret 'op://…'",
    )
  })

  /**
   * Les deux bouts de la chaîne : rien derrière la référence, et une phrase qui
   * se termine sur elle. La ponctuation revient à la phrase — l'emporter ferait
   * passer le message pour tronqué.
   */
  it('caviarde une référence en fin de chaîne, avec ou sans point', () => {
    process.env.AVOLO_TEST_SECRET = RÉFÉRENCE

    expect(messageSûr(new Error(`lecture de ${RÉFÉRENCE}`))).toBe('lecture de op://…')
    expect(messageSûr(new Error(`lecture de ${RÉFÉRENCE}.`))).toBe('lecture de op://….')
  })

  /**
   * Deux variables peuvent pointer le même coffre, l'une nommant le champ et
   * l'autre s'arrêtant à la fiche : la plus courte est alors un préfixe de la
   * plus longue. `épurerChemins` traite les racines de la plus longue à la plus
   * courte, sans quoi la plus courte laisserait la queue de l'autre.
   */
  it('caviarde deux références dont l’une est le préfixe de l’autre', () => {
    process.env.AVOLO_TEST_FICHE = 'op://Coffre de démonstration/Fiche imaginaire'
    process.env.AVOLO_TEST_CHAMP = RÉFÉRENCE

    expect(
      messageSûr(
        new Error(`${RÉFÉRENCE} et op://Coffre de démonstration/Fiche imaginaire échouent`),
      ),
    ).toBe('op://… et op://… échouent')
  })

  /**
   * **Le préfixe nu ne nomme rien**, donc il n'y a rien à en retirer — et une
   * racine vide découperait le message entre chacun de ses caractères, ce qui
   * est le mode d'échec le plus bruyant qu'un caviardage puisse avoir.
   */
  it('ne fait rien d’une variable qui ne porte que le préfixe', () => {
    process.env.AVOLO_TEST_SECRET = 'op://'

    expect(messageSûr(new Error('une adresse commence par op://'))).toBe(
      'une adresse commence par op://',
    )
    expect(messageSûr(new Error('boum'))).toBe('boum')
  })

  /**
   * Le contrôle négatif, et le seul qui dise quelque chose sur les secrets :
   * une valeur littérale n'est pas une racine. Si elle l'était, tout message
   * qui la contient sortirait haché — et le balayage de l'environnement se
   * mettrait à dépendre de ce qu'il y a dedans plutôt que de sa forme.
   */
  it('ne prend pas une valeur littérale pour une racine', () => {
    process.env.AVOLO_TEST_MODELE = 'un-modele-litteral'

    expect(messageSûr(new Error('le modèle un-modele-litteral a refusé la requête'))).toBe(
      'le modèle un-modele-litteral a refusé la requête',
    )
  })
})
