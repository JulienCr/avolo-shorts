// @vitest-environment jsdom

/**
 * La garde des raccourcis du tri.
 *
 * Elle a coûté deux défauts réels : sans le contrôle `instanceof HTMLElement`,
 * **aucun raccourci ne fonctionnait** — la cible d'un événement clavier n'est
 * pas toujours un élément, et `closest` n'existe pas sur `window` ; et avec une
 * garde limitée aux champs de saisie, les flèches sur les onglets déplaçaient à
 * la fois l'onglet actif et la carte sélectionnée.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { processAlreadyKey, useShortcutsReview } from '@/components/review/shortcuts'

afterEach(cleanup)

/** Le même élément, monté pour de vrai : `closest` remonte l'arbre. */
function mount(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.append(host)
  return host.firstElementChild as HTMLElement
}

describe('traiteDéjàLaTouche', () => {
  it('écarte ce qui n’est pas un élément', () => {
    // `window` est une cible d'événement clavier parfaitement ordinaire, et
    // `closest` n'existe pas dessus : sans ce contrôle, le gestionnaire lève une
    // `TypeError` et plus un seul raccourci ne passe.
    expect(processAlreadyKey(null)).toBe(true)
    expect(processAlreadyKey(document)).toBe(true)
  })

  it('écarte les champs de saisie et le contenu éditable', () => {
    expect(processAlreadyKey(mount('<input />'))).toBe(true)
    expect(processAlreadyKey(mount('<textarea></textarea>'))).toBe(true)
    expect(processAlreadyKey(mount('<select></select>'))).toBe(true)
    const editable = mount('<div contenteditable="true"><span>mot</span></div>')
    expect(processAlreadyKey(editable.firstElementChild)).toBe(true)
  })

  it('écarte le contenu d’une boîte de dialogue', () => {
    // Le popup de Base UI porte `role="dialog"` et `tabIndex={-1}` : cliquer son
    // texte en fait l'élément actif. Sans lui dans la garde, `G` déciderait une
    // carte qu'on ne voit pas — et l'écran invite précisément à ce geste, en
    // affichant « G — garder » dans une boîte qu'on vient d'ouvrir.
    const popup = mount('<div role="dialog"><p>G — garder</p></div>')
    expect(processAlreadyKey(popup)).toBe(true)
    expect(processAlreadyKey(popup.firstElementChild)).toBe(true)
    expect(processAlreadyKey(mount('<div role="alertdialog"></div>'))).toBe(true)
  })

  it('écarte tout élément qui traite déjà la touche', () => {
    // Pas seulement les champs : `Espace` sur un bouton l'active, les flèches
    // sur un onglet changent d'onglet.
    expect(processAlreadyKey(mount('<button>Garder</button>'))).toBe(true)
    expect(processAlreadyKey(mount('<a href="/clips/c1">Ouvrir</a>'))).toBe(true)
    expect(processAlreadyKey(mount('<div role="button"></div>'))).toBe(true)
    expect(processAlreadyKey(mount('<div role="tab"></div>'))).toBe(true)
    expect(processAlreadyKey(mount('<div role="slider"></div>'))).toBe(true)
    expect(processAlreadyKey(mount('<details><summary>x</summary></details>').firstElementChild)).toBe(
      true,
    )
  })

  it('écarte la case de sélection en masse (publication §2.4)', () => {
    // Base UI rend une case à cocher en `<span role="checkbox">`, jamais en
    // `<button>` : sans cette entrée, le focus resterait dessus après un clic
    // et plus aucun raccourci ne répondrait, alors que la carte garderait son
    // anneau de sélection — l'écran affirmerait le contraire de son état.
    expect(processAlreadyKey(mount('<span role="checkbox"></span>'))).toBe(true)
  })

  it('laisse passer une ancre sans cible et le corps du document', () => {
    // Une ancre sans `href` n'est pas un lien : elle ne traite aucune touche.
    expect(processAlreadyKey(mount('<a>pas un lien</a>'))).toBe(false)
    expect(processAlreadyKey(mount('<article tabindex="0"></article>'))).toBe(false)
    expect(processAlreadyKey(document.body)).toBe(false)
  })
})

function Harness({ actions }: { actions: Record<string, () => void> }) {
  useShortcutsReview({
    previous: actions.precedent,
    next: actions.suivant,
    keep: actions.garder,
    discard: actions.ecarter,
    open: actions.ouvrir,
    undo: actions.defaire,
    help: actions.aide,
  })
  return (
    <div>
      <article tabIndex={0} data-testid="carte" />
      <button type="button">Relancer</button>
    </div>
  )
}

function actionsMute() {
  return {
    precedent: vi.fn(),
    suivant: vi.fn(),
    garder: vi.fn(),
    ecarter: vi.fn(),
    ouvrir: vi.fn(),
    defaire: vi.fn(),
    aide: vi.fn(),
  }
}

describe('useRaccourcisTri', () => {
  it('lie les sept touches du tri', async () => {
    const actions = actionsMute()
    render(<Harness actions={actions} />)
    const user = userEvent.setup()

    await user.click(screen.getByTestId('carte'))
    await user.keyboard('jk{ArrowDown}{ArrowUp}ge{Enter}u?')

    expect(actions.suivant).toHaveBeenCalledTimes(2)
    expect(actions.precedent).toHaveBeenCalledTimes(2)
    expect(actions.garder).toHaveBeenCalledTimes(1)
    expect(actions.ecarter).toHaveBeenCalledTimes(1)
    expect(actions.ouvrir).toHaveBeenCalledTimes(1)
    expect(actions.defaire).toHaveBeenCalledTimes(1)
    expect(actions.aide).toHaveBeenCalledTimes(1)
  })

  it('rend la main dès qu’un modificateur est enfoncé', async () => {
    // `Ctrl+E` ouvre la barre d'adresse, `Cmd+G` cherche à nouveau : voler ces
    // touches-là ferait perdre un geste du navigateur pour rien.
    //
    // **La frappe part d'une carte, pas de `document`.** Dispatché sur
    // `document`, l'événement était déjà écarté par la garde des cibles — qui
    // rend `true` sur tout ce qui n'est pas un `HTMLElement` —, donc le test
    // restait vert même en retirant la garde des modificateurs.
    const actions = actionsMute()
    render(<Harness actions={actions} />)
    const user = userEvent.setup()

    await user.click(screen.getByTestId('carte'))
    await user.keyboard('{Control>}e{/Control}')
    expect(actions.ecarter).not.toHaveBeenCalled()

    // Et la même touche sans modificateur passe : c'est ce qui prouve que la
    // frappe atteignait bien le gestionnaire.
    await user.keyboard('e')
    expect(actions.ecarter).toHaveBeenCalledTimes(1)
  })

  it('ne vole aucune frappe à un bouton qui a le focus', async () => {
    const actions = actionsMute()
    render(<Harness actions={actions} />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Relancer' }))
    await user.keyboard('j')

    expect(actions.suivant).not.toHaveBeenCalled()
  })
})
