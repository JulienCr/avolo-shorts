// @vitest-environment jsdom

/**
 * Les raccourcis de l'écran de clip, et surtout leur garde.
 *
 * « Interactif » ne veut pas dire « champ de saisie » (spec §4.1) : `Espace` sur
 * un bouton qui a le focus l'active **et** lancerait la lecture si la garde ne
 * regardait que les champs. Mais la garde ne peut pas non plus écarter tout
 * élément interactif, sans quoi elle tuerait le geste principal du produit —
 * chaque mot du transcript est un `[role="button"]`, et `Suppr` s'y presse
 * précisément pour retirer la sélection. Elle est donc **par touche**, et ces
 * tests sont ce qui tient les deux bouts.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useRaccourcis, volerait } from '@/components/clip/raccourcis'

afterEach(cleanup)

function actions() {
  return {
    lectureOuPause: vi.fn(),
    annuler: vi.fn(),
    retablir: vi.fn(),
    retirer: vi.fn(),
    echapper: vi.fn(),
    poserBorne: vi.fn(),
    chercher: vi.fn(),
    aide: vi.fn(),
    aSelection: true,
  }
}

/** Un écran réduit à ce que la garde doit distinguer. */
function Harnais(props: ReturnType<typeof actions>) {
  useRaccourcis(props)
  return (
    <div>
      <button type="button">Exporter</button>
      <input aria-label="Titre" />
      <div data-surface-transcript tabIndex={-1} data-testid="surface">
        <span role="button" tabIndex={0} data-testid="mot">
          bonjour
        </span>
      </div>
    </div>
  )
}

describe('useRaccourcis', () => {
  it('lance la lecture sur `Espace` depuis le corps du document', () => {
    const a = actions()
    render(<Harnais {...a} />)
    fireEvent.keyDown(document.body, { key: ' ' })
    expect(a.lectureOuPause).toHaveBeenCalledTimes(1)
  })

  it('laisse `Espace` au bouton qui a le focus', () => {
    // Sinon le bouton d'export s'active **et** la lecture démarre.
    const a = actions()
    render(<Harnais {...a} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Exporter' }), { key: ' ' })
    expect(a.lectureOuPause).not.toHaveBeenCalled()
  })

  it('retire la sélection sur `Suppr` alors qu’un mot a le focus', () => {
    // Le mot est un `[role="button"]`, et une garde qui écarterait tout élément
    // interactif retirerait ici le geste principal du produit.
    const a = actions()
    render(<Harnais {...a} />)
    fireEvent.keyDown(screen.getByTestId('mot'), { key: 'Delete' })
    expect(a.retirer).toHaveBeenCalledTimes(1)
  })

  it('pose les bornes sur `I` et `O` depuis un mot', () => {
    const a = actions()
    render(<Harnais {...a} />)
    const mot = screen.getByTestId('mot')
    fireEvent.keyDown(mot, { key: 'i' })
    fireEvent.keyDown(mot, { key: 'o' })
    expect(a.poserBorne).toHaveBeenNthCalledWith(1, 'start')
    expect(a.poserBorne).toHaveBeenNthCalledWith(2, 'end')
  })

  it('annule sur Ctrl+Z et rétablit sur Ctrl+Shift+Z', () => {
    // Sans garde sur `shiftKey`, `Ctrl+Shift+Z` tombe dans la branche de
    // l'annulation et **annule** — le rétablissement est avalé sans un mot.
    const a = actions()
    render(<Harnais {...a} />)
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(a.annuler).toHaveBeenCalledTimes(1)
    expect(a.retablir).not.toHaveBeenCalled()

    fireEvent.keyDown(document.body, { key: 'Z', ctrlKey: true, shiftKey: true })
    expect(a.retablir).toHaveBeenCalledTimes(1)
    expect(a.annuler).toHaveBeenCalledTimes(1)
  })

  it('ouvre la recherche sur Ctrl+F, à la place de celle du navigateur', () => {
    // La virtualisation neutralise le `Ctrl+F` du navigateur : le transcript
    // rendu ne porte qu'une trentaine de phrases sur quelques centaines.
    const a = actions()
    render(<Harnais {...a} />)
    const empêché = !fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true })
    expect(a.chercher).toHaveBeenCalledTimes(1)
    expect(empêché).toBe(true)
  })

  it('affiche la liste des raccourcis sur `?`', () => {
    const a = actions()
    render(<Harnais {...a} />)
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true })
    expect(a.aide).toHaveBeenCalledTimes(1)
  })

  it('ne vole aucune frappe à un champ de saisie', () => {
    const a = actions()
    render(<Harnais {...a} />)
    const champ = screen.getByLabelText('Titre')
    for (const touche of [' ', 'Delete', 'i', 'o', '?']) {
      fireEvent.keyDown(champ, { key: touche })
    }
    expect(a.lectureOuPause).not.toHaveBeenCalled()
    expect(a.retirer).not.toHaveBeenCalled()
    expect(a.poserBorne).not.toHaveBeenCalled()
    expect(a.aide).not.toHaveBeenCalled()
  })

  it('ne retire rien quand il n’y a pas de sélection', () => {
    const a = { ...actions(), aSelection: false }
    render(<Harnais {...a} />)
    fireEvent.keyDown(document.body, { key: 'Delete' })
    expect(a.retirer).not.toHaveBeenCalled()
  })
})

describe('volerait', () => {
  it('laisse passer une cible qui n’est pas un élément', () => {
    // `window` et `document` sont des cibles d'événement clavier, et `closest`
    // n'existe pas dessus : sans ce contrôle, le gestionnaire levait une
    // `TypeError` et **aucun raccourci ne fonctionnait**.
    expect(volerait(window, ' ')).toBe(false)
  })

  it('écarte les flèches d’un curseur de cadrage', () => {
    const curseur = document.createElement('div')
    curseur.setAttribute('role', 'slider')
    expect(volerait(curseur, 'ArrowLeft')).toBe(true)
    expect(volerait(curseur, 'Delete')).toBe(false)
  })
})
