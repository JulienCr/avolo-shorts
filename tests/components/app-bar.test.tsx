// @vitest-environment jsdom

/**
 * Le seul test de composant du socle, et il est là pour prouver que le montage
 * fonctionne : `jsdom` posé par fichier, `@testing-library/react`, un composant
 * du dépôt rendu pour de vrai. La boucle de tri viendra à la vague suivante, et
 * elle n'aura plus à installer quoi que ce soit.
 *
 * `AppBar` est le bon candidat : trois écrans en dépendent — c'est le critère
 * qui l'a placé dans `parcours/` — et aucun ne doit avoir à y toucher.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AppBar } from '@/components/parcours/app-bar'

afterEach(cleanup)

describe('AppBar', () => {
  it('construit son fil d’Ariane depuis le lieu, pas depuis un tableau', () => {
    // Le modèle de navigation était recopié dans les trois pages, sous forme
    // d'un tableau positionnel. La barre le **connaît** désormais.
    render(
      <AppBar
        lieu={{
          kind: 'clip',
          projet: { id: '2025-06-15-cqlp', titre: 'La scène du 15 juin' },
          clip: { titre: 'La chute' },
        }}
      />,
    )

    expect(screen.getByRole('link', { name: 'La scène du 15 juin' })).toHaveProperty(
      'pathname',
      '/projects/2025-06-15-cqlp',
    )
    // Le dernier cran est l'écran où l'on est : un lien vers soi-même n'est pas
    // une navigation.
    expect(screen.queryByRole('link', { name: 'La chute' })).toBeNull()
    expect(screen.getByText('La chute')).toBeTruthy()
  })

  it('garde la racine atteignable, y compris sans fil d’Ariane', () => {
    render(<AppBar lieu={{ kind: 'bibliotheque' }} />)
    expect(screen.getByRole('link', { name: 'avolo·shorts' })).toBeTruthy()
  })

  it('mène aux paramètres depuis n’importe quel écran', () => {
    // La barre est le seul élément que les écrans partagent, et les réglages
    // n'appartiennent à aucun d'eux.
    render(<AppBar lieu={{ kind: 'bibliotheque' }} />)
    expect(screen.getByRole('link', { name: 'Paramètres' })).toHaveProperty(
      'pathname',
      '/settings',
    )
  })

  it('ne pose pas de lien vers l’écran des paramètres depuis lui-même', () => {
    // Un lien vers soi n'est pas une navigation, et il volerait un arrêt de
    // tabulation.
    render(<AppBar lieu={{ kind: 'settings' }} />)
    expect(screen.queryByRole('link', { name: 'Paramètres' })).toBeNull()
    expect(screen.getByText('Paramètres')).toBeTruthy()
  })

  it('porte un emplacement pour l’indicateur d’exécution', () => {
    // La barre laisse la place, elle ne dessine pas l'indicateur : c'est
    // l'écran de projet qui sait ce qui tourne.
    render(
      <AppBar lieu={{ kind: 'projet', projet: { id: 'p1', titre: 'Une émission' } }}>
        <span>proxy, 40 %</span>
      </AppBar>,
    )
    expect(screen.getByText('proxy, 40 %')).toBeTruthy()
  })
})
