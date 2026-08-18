// @vitest-environment jsdom

/**
 * Le transcript comme organe de navigation (lot 6).
 *
 * C'était le manque fonctionnel le plus important de l'écran : cliquer un mot ne
 * déplaçait pas la lecture, et la lecture ne surlignait pas le mot en cours. Le
 * combler ne contredit pas « la surface d'édition est le transcript » — c'est
 * l'inverse : plus rien ne réclame de tête de lecture, puisque la position se
 * lit dans le texte.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { indexTranscript, type TranscriptLine } from '@/lib/editing'
import { useLecture } from '@/components/clip/lecture'
import { TranscriptSurface } from '@/components/clip/transcript-surface'

// Le virtualiseur mesure l'élément de défilement par `offsetHeight`, et chaque
// phrase par `getBoundingClientRect`. jsdom rend zéro pour les deux, donc rien
// ne serait jamais rendu — ni ici, ni pour personne qui testerait cette surface.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 })
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 })
// Le virtualiseur borne ses défilements à `scrollHeight - clientHeight` : les
// deux valant zéro sous jsdom, tout défilement programmé retomberait à zéro.
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 10_000 })
// Et jsdom n'implémente aucun défilement : `scrollTo` ne bouge pas `scrollTop`,
// donc le suivi de lecture serait invisible ici alors qu'il marche pour de vrai.
Element.prototype.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
  this.scrollTop = typeof options === 'object' ? (options.top ?? this.scrollTop) : this.scrollTop
}

vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
  () => ({ height: 40, width: 800, top: 0, left: 0, right: 800, bottom: 40, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
)

/** Vingt phrases de cinq mots : de quoi sortir du champ rendu. */
function transcript(): TranscriptLine[] {
  return Array.from({ length: 20 }, (_, l) => ({
    id: `l${l}`,
    start: l * 10,
    end: l * 10 + 5,
    words: Array.from({ length: 5 }, (_, m) => ({
      word: `m${l}-${m}`,
      start: l * 10 + m,
      end: l * 10 + m + 0.5,
    })),
  }))
}

function monter(props: Partial<Parameters<typeof TranscriptSurface>[0]> = {}) {
  const lignes = transcript()
  const { words, lines } = indexTranscript(lignes, [{ start: 0, end: 200 }])
  const complet = {
    cle: 'c1',
    lines,
    words,
    selection: null,
    onSelectionner: vi.fn(),
    onEtendre: vi.fn(),
    onTerminer: vi.fn(),
    onRemonter: vi.fn(),
    onPlacer: vi.fn(),
    recherche: false,
    onRecherche: vi.fn(),
    ...props,
  }
  const rendu = render(<TranscriptSurface {...complet} />)
  const surface = rendu.container.querySelector('[data-surface-transcript]') as HTMLElement
  return { ...complet, ...rendu, surface }
}

/** Vide la file d'images : c'est là que le défilement automatique rend la main. */
async function imageSuivante() {
  await act(async () => {
    await new Promise((résoudre) => requestAnimationFrame(() => résoudre(null)))
  })
}

/** Les arrêts de tabulation de la surface elle-même, le conteneur compris. */
function arrêts(surface: HTMLElement): Element[] {
  return [surface, ...surface.querySelectorAll('*')].filter(
    (element) => element.getAttribute('tabindex') === '0',
  )
}

beforeEach(() => {
  act(() => useLecture.getState().reinitialiser())
})
afterEach(cleanup)

describe('la lecture et le texte', () => {
  it('place la lecture sur le mot cliqué', () => {
    const { onPlacer } = monter()
    const mot = screen.getByText(/m0-2/)
    fireEvent.pointerDown(mot)
    fireEvent.pointerUp(mot)
    expect(onPlacer).toHaveBeenCalledWith(2)
  })

  it('ne place pas la lecture au bout d’un glissé de sélection', () => {
    // Le glissé sert à sélectionner : déplacer la lecture au relâchement
    // ferait sauter le lecteur à chaque retrait.
    const { onPlacer } = monter()
    fireEvent.pointerDown(screen.getByText(/m0-0/))
    fireEvent.pointerEnter(screen.getByText(/m0-2/))
    fireEvent.pointerUp(screen.getByText(/m0-2/))
    expect(onPlacer).not.toHaveBeenCalled()
  })

  it('surligne le mot en cours de lecture', () => {
    const { words } = monter()
    act(() => {
      useLecture.getState().definirMots(words)
      useLecture.getState().definirPosition(3.2)
    })
    expect(screen.getByText(/m0-3/).getAttribute('aria-current')).toBe('location')
    expect(screen.getByText(/m0-2/).getAttribute('aria-current')).toBeNull()
  })
})

describe('le défilement automatique', () => {
  it('suit la lecture, puis se coupe dès qu’on défile à la main', async () => {
    const { words, surface } = monter()
    act(() => useLecture.getState().definirMots(words))

    act(() => useLecture.getState().definirPosition(80))
    const suivi = surface.scrollTop
    expect(suivi).toBeGreaterThan(0)
    await imageSuivante()

    // Le geste de l'utilisateur reprend la main : le texte ne doit plus fuir
    // sous les yeux pendant qu'on lit ailleurs.
    fireEvent.scroll(surface)
    act(() => useLecture.getState().definirPosition(160))
    expect(surface.scrollTop).toBe(suivi)
  })

  it('reprend au clic sur un mot', async () => {
    const { words, surface } = monter()
    act(() => useLecture.getState().definirMots(words))
    act(() => useLecture.getState().definirPosition(80))
    await imageSuivante()
    fireEvent.scroll(surface)
    const gelé = surface.scrollTop

    // Le clic sur un mot est le geste par lequel on redit « je regarde la
    // lecture ».
    const mot = screen.getByText(/m8-1/)
    fireEvent.pointerDown(mot)
    fireEvent.pointerUp(mot)

    act(() => useLecture.getState().definirPosition(160))
    expect(surface.scrollTop).toBeGreaterThan(gelé)
  })
})

describe('le tabindex glissant', () => {
  it('n’offre qu’un seul arrêt de tabulation', () => {
    // Traverser le transcript pour atteindre la barre d'outils demandait une
    // centaine de `Tab`, et le nombre dépendait de la position de défilement.
    const { surface } = monter()
    expect(arrêts(surface).length).toBe(1)
  })

  it('déplace le mot actif aux flèches, et le focus avec', () => {
    monter()
    const premier = screen.getByText(/m0-0/)
    premier.focus()
    fireEvent.keyDown(premier, { key: 'ArrowRight' })

    const suivant = screen.getByText(/m0-1/)
    expect(suivant.getAttribute('tabindex')).toBe('0')
    expect(document.activeElement).toBe(suivant)
    expect(premier.getAttribute('tabindex')).toBe('-1')
  })

  it('reste franchissable quand le mot actif est sorti du champ rendu', () => {
    // Le virtualiseur ne rend qu'une trentaine de phrases : l'index du mot actif
    // se garde dans l'état, pas dans le DOM, et la surface doit garder un arrêt
    // de tabulation même quand ce mot n'existe plus dans la page.
    const { surface } = monter({ recherche: true })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'm19-0' } })
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
    expect(arrêts(surface).length).toBe(1)
  })
})

describe('la recherche', () => {
  it('compte les occurrences et se déplace de l’une à l’autre', () => {
    const { surface } = monter({ recherche: true })
    const champ = screen.getByRole('searchbox')
    fireEvent.change(champ, { target: { value: 'm0-' } })

    expect(within(surface.parentElement as HTMLElement).getByText('1 sur 5')).toBeTruthy()
    fireEvent.keyDown(champ, { key: 'Enter' })
    expect(within(surface.parentElement as HTMLElement).getByText('2 sur 5')).toBeTruthy()
  })

  it('coupe le suivi de lecture, comme tout geste de navigation', async () => {
    // Chercher, c'est aller voir ailleurs. Laisser le défilement suivre la
    // lecture ramènerait le texte sous les yeux au moment où on lit l'occurrence.
    const { words, surface } = monter({ recherche: true })
    act(() => useLecture.getState().definirMots(words))
    act(() => useLecture.getState().definirPosition(80))
    await imageSuivante()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'm2-0' } })
    await imageSuivante()
    const arrêté = surface.scrollTop

    act(() => useLecture.getState().definirPosition(160))
    expect(surface.scrollTop).toBe(arrêté)
  })

  it('dit quand rien ne correspond', () => {
    monter({ recherche: true })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'incendie' } })
    expect(screen.getByText(/aucune/i)).toBeTruthy()
  })

  it('se ferme sur Échap', () => {
    const { onRecherche } = monter({ recherche: true })
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    expect(onRecherche).toHaveBeenCalledWith(false)
  })
})
