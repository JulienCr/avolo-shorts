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

import { useShortcuts, wouldSteal } from '@/components/clip/shortcuts'

afterEach(cleanup)

function actions() {
  return {
    playbackOrPause: vi.fn(),
    cancel: vi.fn(),
    restore: vi.fn(),
    remove: vi.fn(),
    escape: vi.fn(),
    poserBound: vi.fn(),
    find: vi.fn(),
    keep: vi.fn(),
    discard: vi.fn(),
    help: vi.fn(),
    aSelection: true,
  }
}

/** Un écran réduit à ce que la garde doit distinguer. */
function Harness(props: ReturnType<typeof actions>) {
  useShortcuts(props)
  return (
    <div>
      <button type="button">Exporter</button>
      <input aria-label="Titre" />
      <div data-surface-transcript tabIndex={-1} data-testid="surface">
        <span role="button" tabIndex={0} data-testid="word">
          bonjour
        </span>
      </div>
    </div>
  )
}

describe('useShortcuts', () => {
  it('lance la lecture sur `Espace` depuis le corps du document', () => {
    const a = actions()
    render(<Harness {...a} />)
    fireEvent.keyDown(document.body, { key: ' ' })
    expect(a.playbackOrPause).toHaveBeenCalledTimes(1)
  })

  it('laisse `Espace` au bouton qui a le focus', () => {
    // Sinon le bouton d'export s'active **et** la lecture démarre.
    const a = actions()
    render(<Harness {...a} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Exporter' }), { key: ' ' })
    expect(a.playbackOrPause).not.toHaveBeenCalled()
  })

  it('retire la sélection sur `Suppr` alors qu’un mot a le focus', () => {
    // Le mot est un `[role="button"]`, et une garde qui écarterait tout élément
    // interactif retirerait ici le geste principal du produit.
    const a = actions()
    render(<Harness {...a} />)
    fireEvent.keyDown(screen.getByTestId('word'), { key: 'Delete' })
    expect(a.remove).toHaveBeenCalledTimes(1)
  })

  it('pose les bornes sur `I` et `O` depuis un mot', () => {
    const a = actions()
    render(<Harness {...a} />)
    const word = screen.getByTestId('word')
    fireEvent.keyDown(word, { key: 'i' })
    fireEvent.keyDown(word, { key: 'o' })
    expect(a.poserBound).toHaveBeenNthCalledWith(1, 'start')
    expect(a.poserBound).toHaveBeenNthCalledWith(2, 'end')
  })

  it('annule sur Ctrl+Z et rétablit sur Ctrl+Shift+Z', () => {
    // Sans garde sur `shiftKey`, `Ctrl+Shift+Z` tombe dans la branche de
    // l'annulation et **annule** — le rétablissement est avalé sans un mot.
    const a = actions()
    render(<Harness {...a} />)
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(a.cancel).toHaveBeenCalledTimes(1)
    expect(a.restore).not.toHaveBeenCalled()

    fireEvent.keyDown(document.body, { key: 'Z', ctrlKey: true, shiftKey: true })
    expect(a.restore).toHaveBeenCalledTimes(1)
    expect(a.cancel).toHaveBeenCalledTimes(1)
  })

  it('ouvre la recherche sur Ctrl+F, à la place de celle du navigateur', () => {
    // La virtualisation neutralise le `Ctrl+F` du navigateur : le transcript
    // rendu ne porte qu'une trentaine de phrases sur quelques centaines.
    const a = actions()
    render(<Harness {...a} />)
    const prevented = !fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true })
    expect(a.find).toHaveBeenCalledTimes(1)
    expect(prevented).toBe(true)
  })

  it('affiche la liste des raccourcis sur `?`', () => {
    const a = actions()
    render(<Harness {...a} />)
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true })
    expect(a.help).toHaveBeenCalledTimes(1)
  })

  it('ne vole aucune frappe à un champ de saisie', () => {
    const a = actions()
    render(<Harness {...a} />)
    const field = screen.getByLabelText('Titre')
    for (const key of [' ', 'Delete', 'i', 'o', '?']) {
      fireEvent.keyDown(field, { key: key })
    }
    expect(a.playbackOrPause).not.toHaveBeenCalled()
    expect(a.remove).not.toHaveBeenCalled()
    expect(a.poserBound).not.toHaveBeenCalled()
    expect(a.help).not.toHaveBeenCalled()
  })

  it('ne retire rien quand il n’y a pas de sélection', () => {
    const a = { ...actions(), aSelection: false }
    render(<Harness {...a} />)
    fireEvent.keyDown(document.body, { key: 'Delete' })
    expect(a.remove).not.toHaveBeenCalled()
  })

  it('garde sur `P`, écarte sur `X`', () => {
    const a = actions()
    render(<Harness {...a} />)
    fireEvent.keyDown(document.body, { key: 'p' })
    fireEvent.keyDown(document.body, { key: 'x' })
    expect(a.keep).toHaveBeenCalledTimes(1)
    expect(a.discard).toHaveBeenCalledTimes(1)
  })

})

describe('volerait', () => {
  it('laisse toutes les touches à une boîte de dialogue', () => {
    // Sinon `Échap` referme la liste des raccourcis **et** vide la sélection du
    // transcript, et `Suppr` monte le clip pendant qu'on lit une confirmation
    // d'écrasement. (relevé par Copilot)
    const box = document.createElement('div')
    box.setAttribute('role', 'dialog')
    const button = document.createElement('button')
    box.append(button)
    for (const key of ['Escape', 'Delete', 'i', 'o', '?', ' ']) {
      expect(wouldSteal(button, key)).toBe(true)
    }
  })

  it('laisse toutes les touches à une boîte d’alerte', () => {
    const box = document.createElement('div')
    box.setAttribute('role', 'alertdialog')
    expect(wouldSteal(box, 'Delete')).toBe(true)
  })

  it('laisse passer une cible qui n’est pas un élément', () => {
    // `window` et `document` sont des cibles d'événement clavier, et `closest`
    // n'existe pas dessus : sans ce contrôle, le gestionnaire levait une
    // `TypeError` et **aucun raccourci ne fonctionnait**.
    expect(wouldSteal(window, ' ')).toBe(false)
  })

  it('rend les touches au modal qui héberge les gestes de l’écran', () => {
    // **Le tiroir de montage est l'exception, et il la déclare.** La règle du
    // dessus vise les boîtes qui interrompent le travail — la liste des
    // raccourcis, la confirmation d'écrasement. Le tiroir, lui, *est* le
    // travail : `Suppr` y retire, `I` et `O` y posent les bornes, `Ctrl+Z` y
    // annule. Le ranger avec les autres tuerait les quatre gestes du produit au
    // moment précis où on les presse.
    const drawer = document.createElement('div')
    drawer.setAttribute('role', 'dialog')
    drawer.setAttribute('data-clip-shortcuts', '')
    const word = document.createElement('span')
    word.setAttribute('role', 'button')
    drawer.append(word)
    for (const key of ['Escape', 'Delete', 'i', 'o', '?']) {
      expect(wouldSteal(word, key)).toBe(false)
    }
    // L'exception ne lève pas les autres règles : `Espace` appartient toujours à
    // l'élément qui s'active avec.
    expect(wouldSteal(word, ' ')).toBe(true)
  })

  it('écarte les flèches d’un curseur de cadrage', () => {
    const cursor = document.createElement('div')
    cursor.setAttribute('role', 'slider')
    expect(wouldSteal(cursor, 'ArrowLeft')).toBe(true)
    expect(wouldSteal(cursor, 'Delete')).toBe(false)
  })
})
