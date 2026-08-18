// @vitest-environment jsdom

/**
 * Le sélecteur de ratio.
 *
 * Le curseur de cadrage se fige en 16:9 — le cadre occupe alors toute la
 * largeur, il n'y a rien à déplacer — et **rien ne le disait**. Un contrôle
 * inerte sans raison écrite passe pour cassé, et la raison ne peut pas vivre
 * dans une bulle d'aide : elle serait invisible au clavier.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RatioPicker } from '@/components/clip/crop-picker'
import { cadrage, cadrageManuel, plan } from '../../fixtures/cadrage'

afterEach(cleanup)

describe('RatioPicker', () => {
  it('dit pourquoi le cadre ne se déplace pas en 16:9', () => {
    render(
      <RatioPicker
        cadrage={cadrage({ ratio: '16:9', shots: [plan(0, 100, '16:9', 0.5)] })}
        ratio="16:9"
        onRatio={vi.fn()}
      />,
    )
    expect(screen.getByText(/toute la largeur/i)).toBeTruthy()
  })

  it('ne dit rien de tel sur un ratio où le cadre se déplace', () => {
    render(<RatioPicker cadrage={cadrage()} ratio="1:1" onRatio={vi.fn()} />)
    expect(screen.queryByText(/toute la largeur/i)).toBeNull()
  })

  /**
   * **Le message de l'itération 0 disait « auto vaut 9:16 », et c'était faux dès
   * que le calcul est entré en service.** §3.5 demande un mot au même endroit
   * dans les deux cas : ce que « auto » a choisi, ou que le ratio est épinglé.
   */
  it('dit ce que « auto » a choisi pour le plan qu’on regarde', () => {
    render(
      <RatioPicker
        cadrage={cadrage({ ratio: '4:5', shots: [plan(0, 100, '4:5', 0.5)] })}
        ratio="auto"
        onRatio={vi.fn()}
      />,
    )
    expect(screen.getByText(/auto → 4:5/)).toBeTruthy()
    expect(screen.queryByText(/itération 0/i)).toBeNull()
  })

  it('marque un ratio épinglé au lieu de le laisser passer pour un calcul', () => {
    render(<RatioPicker cadrage={cadrage()} ratio="1:1" onRatio={vi.fn()} />)
    expect(screen.getByText(/1:1 · épinglé/)).toBeTruthy()
  })

  /**
   * **Le ratio se choisit par plan, et un cadre qui change de taille en cours de
   * lecture passe pour un défaut de rendu si personne ne le dit.** C'est
   * pourtant le bénéfice qu'on cherche : un ratio unique écraserait chaque plan
   * serré sous le plus large.
   */
  it('annonce que le cadre change avec les plans', () => {
    render(
      <RatioPicker
        cadrage={cadrage({
          ratio: '16:9',
          shots: [plan(0, 50, '9:16', 0.5), plan(50, 100, '16:9', 0.5)],
        })}
        ratio="auto"
        onRatio={vi.fn()}
      />,
    )
    expect(screen.getByText(/change avec les plans/i)).toBeTruthy()
  })

  /**
   * **Le repli se dit, il ne se subit pas.** `renders` ne dépend pas
   * d'`analysis` dans le graphe : rien ne garantit qu'un clip en « auto » ait des
   * plans sous la main, et un 9:16 centré posé sans un mot ne se verrait qu'à
   * l'image, trois minutes d'export plus tard.
   */
  it.each([
    ['sans-analyse', /n’a pas tourné/i],
    ['analyse-illisible', /ne se lit pas/i],
    ['sans-plans', /aucun plan/i],
  ] as const)('dit qu’aucun calcul n’a eu lieu — %s', (origine, motif) => {
    render(
      <RatioPicker cadrage={cadrageManuel('9:16', 0.5, origine)} ratio="auto" onRatio={vi.fn()} />,
    )
    expect(screen.getByText(motif)).toBeTruthy()
  })

  it('ne dit rien de tel quand le cadrage a été calculé', () => {
    render(<RatioPicker cadrage={cadrage()} ratio="auto" onRatio={vi.fn()} />)
    expect(screen.queryByText(/n’a pas tourné/i)).toBeNull()
    expect(screen.getByText(/calculé pour chaque plan/i)).toBeTruthy()
  })

  // **Une seule ligne à la fois.** Quand les cadres varient, la ligne qui
  // l'annonce dit déjà que le calcul décide par plan : la doubler ferait trois
  // paragraphes empilés sous un sélecteur de six pastilles.
  it('n’empile pas deux explications quand le cadre varie', () => {
    render(
      <RatioPicker
        cadrage={cadrage({
          ratio: '16:9',
          shots: [plan(0, 50, '4:5', 0.5), plan(50, 100, '16:9', 0.5)],
        })}
        ratio="auto"
        onRatio={vi.fn()}
      />,
    )
    expect(screen.getByText(/change avec les plans/i)).toBeTruthy()
    expect(screen.queryByText(/calculé pour chaque plan/i)).toBeNull()
  })
})
