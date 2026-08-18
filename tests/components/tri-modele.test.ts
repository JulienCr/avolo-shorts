/**
 * Le modèle de l'écran de tri : les trois vues, et ce que l'écran dit de ce que
 * le repérage n'a pas jugé.
 *
 * Du calcul pur, donc pas de DOM : ce fichier n'a aucune raison de payer
 * `jsdom`. Les composants qui s'en servent sont testés ailleurs.
 */

import { describe, expect, it } from 'vitest'

import type { BilanRepérage } from '@/lib/api'
import { idsPourVue, motDuRepérage, vueDepuisUrl } from '@/components/tri/modele'

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

function bilan(champs: Partial<BilanRepérage> = {}): BilanRepérage {
  return {
    fenêtres: 83,
    notées: 83,
    lotsRefusés: 0,
    lotsRépondus: 11,
    couverture: 1,
    partiel: false,
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
    const mot = motDuRepérage(bilan({ notées: 57, lotsRefusés: 4, lotsRépondus: 7, couverture: 0.684 }))
    expect(mot?.perte).toBe(true)
    expect(mot?.phrase).toContain('68 %')
    expect(mot?.phrase).toContain('57 fenêtres sur 83')
    expect(mot?.detail).toContain('4 lots')
    expect(mot?.detail).toContain('11')
  })

  it('arrondit la couverture vers le bas tant qu’il manque quelque chose', () => {
    // 99,6 % arrondi au plus proche donne 100 %, c'est-à-dire dément la perte
    // que la même phrase annonce deux mots plus loin.
    const mot = motDuRepérage(bilan({ notées: 82, lotsRefusés: 1, lotsRépondus: 10, couverture: 0.996 }))
    expect(mot?.phrase).toContain('99 %')
  })

  it('ne promet aucun recours', () => {
    // `buildWindows` et le découpage en lots sont déterministes, et le serveur
    // traite le refus comme reproductible : une seconde passe soumettrait les
    // mêmes charges pour se faire refuser pareil. Un bouton qui ne répare rien
    // est pire que pas de bouton.
    const mot = motDuRepérage(bilan({ notées: 57, lotsRefusés: 4, lotsRépondus: 7, couverture: 0.684 }))
    expect(`${mot?.phrase} ${mot?.detail}`).not.toMatch(/relanc|réessay|recommenc/i)
  })

  it('ne parle pas de refus quand il n’y en a pas eu', () => {
    // Une passe interrompue perd des fenêtres sans qu'aucun lot n'ait été
    // refusé : nommer le filtre de sécurité désignerait le mauvais coupable.
    const mot = motDuRepérage(bilan({ notées: 40, lotsRefusés: 0, lotsRépondus: 5, couverture: 0.48, partiel: true }))
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

  it('ne rapporte rien à zéro fenêtre', () => {
    // Un transcript vide : il n'y avait rien à noter, donc aucun pourcentage
    // n'a de dénominateur.
    const mot = motDuRepérage(bilan({ fenêtres: 0, notées: 0, lotsRépondus: 0, couverture: 0 }))
    expect(mot?.perte).toBe(false)
    expect(mot?.phrase).not.toContain('%')
  })

  it('accorde le singulier', () => {
    expect(motDuRepérage(bilan({ fenêtres: 1, notées: 1, lotsRépondus: 1 }))?.phrase).toContain(
      'la fenêtre',
    )
    const une = motDuRepérage(bilan({ notées: 82, lotsRefusés: 1, lotsRépondus: 10, couverture: 0.9 }))
    expect(une?.detail).toContain('1 lot de fenêtres sur 11 a été refusé')
  })
})
