/**
 * Le modèle de l'écran de tri : les trois vues, et ce que l'écran dit de ce que
 * le repérage n'a pas jugé.
 *
 * Du calcul pur, donc pas de DOM : ce fichier n'a aucune raison de payer
 * `jsdom`. Les composants qui s'en servent sont testés ailleurs.
 */

import { describe, expect, it } from 'vitest'

import type { SelectionReport } from '@/lib/api'
import { accord, idsPourVue, motDuRepérage, vueDepuisUrl } from '@/components/tri/modele'

const clips = [
  { id: 'a', status: 'candidate' as const },
  { id: 'b', status: 'kept' as const },
  { id: 'c', status: 'discarded' as const },
  { id: 'd', status: 'exported' as const },
]

describe('idsPourVue', () => {
  it('range un clip exporté avec les gardés', () => {
    // C'est une décision humaine qui a déjà produit un fichier, pas une
    // proposition en attente. `estGarde` porte cette définition, une seule fois.
    expect(idsPourVue(clips, 'gardes')).toEqual(['b', 'd'])
  })

  it('ne garde à trier que ce qui n’est pas décidé', () => {
    expect(idsPourVue(clips, 'atrier')).toEqual(['a'])
    expect(idsPourVue(clips, 'ecartes')).toEqual(['c'])
  })

  it('rend la liste dans l’ordre reçu', () => {
    // L'ordre des candidats est celui du repérage, qui suit l'émission : le
    // réordonner ferait perdre le fil de ce qu'on vient de voir.
    expect(idsPourVue([...clips].reverse(), 'gardes')).toEqual(['d', 'b'])
  })
})

describe('vueDepuisUrl', () => {
  it('retombe sur « à trier » pour tout ce qu’elle ne connaît pas', () => {
    // Une URL se recopie et se bricole : `?vue=n-importe-quoi` doit rendre un
    // écran, pas une page vide.
    expect(vueDepuisUrl(null)).toBe('atrier')
    expect(vueDepuisUrl('')).toBe('atrier')
    expect(vueDepuisUrl('n’importe quoi')).toBe('atrier')
  })

  it('reconnaît les trois vues', () => {
    expect(vueDepuisUrl('atrier')).toBe('atrier')
    expect(vueDepuisUrl('gardes')).toBe('gardes')
    expect(vueDepuisUrl('ecartes')).toBe('ecartes')
  })
})

function bilan(champs: Partial<SelectionReport> = {}): SelectionReport {
  return {
    windows: 83,
    scored: 83,
    rejectedBatches: 0,
    answeredBatches: 11,
    coverage: 1,
    partial: false,
    ...champs,
  }
}

describe('motDuRepérage', () => {
  it('ne dit rien quand rien n’a été mesuré', () => {
    // Pas de bilan : la dernière exécution connue ne visait pas le repérage, ou
    // s'est arrêtée avant de l'atteindre. Inventer un compte serait pire que
    // se taire.
    expect(motDuRepérage(null)).toBeNull()
  })

  it('dit la couverture, pas les lots, quand une part n’a pas été jugée', () => {
    // « 7 lots sur 11 » ne fait 64 % de rien : les fenêtres se chevauchent de
    // 30 s et le dernier lot est plus court. La couverture est la mesure ; les
    // lots ne sont là que pour nommer la cause.
    const mot = motDuRepérage(bilan({ scored: 57, rejectedBatches: 4, answeredBatches: 7, coverage: 0.684 }))
    expect(mot?.perte).toBe(true)
    expect(mot?.phrase).toContain('68 %')
    expect(mot?.phrase).toContain('57 fenêtres sur 83')
    expect(mot?.detail).toContain('4 lots')
    expect(mot?.detail).toContain('11')
  })

  it('arrondit la couverture vers le bas tant qu’il manque quelque chose', () => {
    // 99,6 % arrondi au plus proche donne 100 %, c'est-à-dire dément la perte
    // que la même phrase annonce deux mots plus loin.
    const mot = motDuRepérage(bilan({ scored: 82, rejectedBatches: 1, answeredBatches: 10, coverage: 0.996 }))
    expect(mot?.phrase).toContain('99 %')
  })

  it('ne promet aucun recours', () => {
    // `buildWindows` et le découpage en lots sont déterministes, et le serveur
    // traite le refus comme reproductible : une seconde passe soumettrait les
    // mêmes charges pour se faire refuser pareil. Un bouton qui ne répare rien
    // est pire que pas de bouton.
    const mot = motDuRepérage(bilan({ scored: 57, rejectedBatches: 4, answeredBatches: 7, coverage: 0.684 }))
    expect(`${mot?.phrase} ${mot?.detail}`).not.toMatch(/relanc|réessay|recommenc/i)
  })

  it('ne parle pas de refus quand il n’y en a pas eu', () => {
    // Une passe interrompue perd des fenêtres sans qu'aucun lot n'ait été
    // refusé : nommer le filtre de sécurité désignerait le mauvais coupable.
    const mot = motDuRepérage(bilan({ scored: 40, rejectedBatches: 0, answeredBatches: 5, coverage: 0.48, partial: true }))
    expect(mot?.perte).toBe(true)
    expect(mot?.provisoire).toBe(true)
    expect(mot?.detail).toBeNull()
  })

  it('dit aussi quand tout a été jugé', () => {
    // C'est une propriété permanente de cette liste, au même titre que son
    // nombre d'éléments : l'afficher seulement quand ça va mal ferait douter du
    // silence.
    const mot = motDuRepérage(bilan())
    expect(mot?.perte).toBe(false)
    expect(mot?.phrase).toContain('83')
    expect(mot?.detail).toBeNull()
  })

  it('n’annonce pas de perte quand la récupération a tout rattrapé', () => {
    // **Le cas mesuré sur `2025-06-15-cqlp`**, et le défaut de l'issue #57.
    // Depuis que le repérage recoupe les lots refusés par le filtre de sécurité
    // de Gemini et les resoumet un à un — le cas *normal*, livré par la PR #30 —,
    // on arrive régulièrement à `notées === fenêtres` avec `lotsRefusés > 0` :
    // 51 fenêtres notées sur 83 au premier passage, 83 sur 83 après la descente.
    //
    // Le prédicat qui vaut est `notées < fenêtres`, seul. Un lot refusé et jamais
    // rattrapé y tombe déjà, puisqu'il laisse des fenêtres non notées. Compter
    // les lots en plus faisait dire à l'écran « Le repérage n'a jugé que 100 %
    // de ce qui se dit dans l'émission : 83 fenêtres sur 83 », une phrase qui se
    // contredit elle-même — et le détail aggravait en affirmant qu'une nouvelle
    // passe obtiendrait le même refus, ce que la descente venait de démentir.
    const message = motDuRepérage(bilan({ scored: 83, rejectedBatches: 4, answeredBatches: 11 }))
    expect(message?.perte).toBe(false)
    expect(message?.phrase).toContain('83 fenêtres')
    expect(message?.detail).toBeNull()
  })

  it('tient les deux bornes de la couverture', () => {
    // Zéro : tous les lots refusés, rien n'a été jugé.
    const rien = motDuRepérage(bilan({ scored: 0, rejectedBatches: 11, answeredBatches: 0, coverage: 0 }))
    expect(rien?.phrase).toContain('0 %')
    expect(rien?.perte).toBe(true)

    // Cent : les fenêtres se chevauchent d'environ 30 s, donc une fenêtre du
    // milieu peut manquer sans laisser de trou. La couverture est alors
    // sincèrement totale, et ce sont les comptes de fenêtres qui portent la
    // perte.
    const couvert = motDuRepérage(bilan({ scored: 82, rejectedBatches: 1, answeredBatches: 10, coverage: 1 }))
    expect(couvert?.phrase).toContain('100 %')
    expect(couvert?.perte).toBe(true)
    expect(couvert?.detail).toContain('1 lot de fenêtres sur 11')
  })

  it('ne rapporte rien à zéro fenêtre', () => {
    // Un transcript vide : il n'y avait rien à noter, donc aucun pourcentage
    // n'a de dénominateur.
    const mot = motDuRepérage(bilan({ windows: 0, scored: 0, answeredBatches: 0, coverage: 0 }))
    expect(mot?.perte).toBe(false)
    expect(mot?.phrase).not.toContain('%')
  })

  it('accorde le singulier', () => {
    expect(motDuRepérage(bilan({ windows: 1, scored: 1, answeredBatches: 1 }))?.phrase).toContain(
      'la fenêtre',
    )
    const une = motDuRepérage(bilan({ scored: 82, rejectedBatches: 1, answeredBatches: 10, coverage: 0.9 }))
    expect(une?.detail).toContain('1 lot de fenêtres sur 11 a été refusé')
  })
})

describe('accord', () => {
  it('met le singulier à zéro et à un', () => {
    // Le français accorde au singulier jusqu'à un exclu compris : « 0 clip
    // gardé », « 1 clip gardé », « 2 clips gardés ».
    expect(accord(0, 'clip gardé', 'clips gardés')).toBe('0 clip gardé')
    expect(accord(1, 'clip gardé', 'clips gardés')).toBe('1 clip gardé')
    expect(accord(2, 'clip gardé', 'clips gardés')).toBe('2 clips gardés')
  })
})
