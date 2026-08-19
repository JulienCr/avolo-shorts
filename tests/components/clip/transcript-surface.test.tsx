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

import { actAsync, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { indexTranscript, type TranscriptLine } from '@/lib/editing'
import { usePlayback } from '@/components/clip/playback'
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

function mount(props: Partial<Parameters<typeof TranscriptSurface>[0]> = {}) {
  const raw = transcript()
  const { words, lines } = indexTranscript(raw, [{ start: 0, end: 200 }])
  const complete = {
    cle: 'c1',
    raw,
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
  const render = render(<TranscriptSurface {...complete} />)
  const surface = render.container.querySelector('[data-surface-transcript]') as HTMLElement
  return { ...complete, ...render, surface }
}

/** Vide la file d'images : c'est là que le défilement automatique rend la main. */
async function imageNext() {
  await actAsync(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
}

/** Les arrêts de tabulation de la surface elle-même, le conteneur compris. */
function stops(surface: HTMLElement): Element[] {
  return [surface, ...surface.querySelectorAll('*')].filter(
    (element) => element.getAttribute('tabindex') === '0',
  )
}

beforeEach(() => {
  actAsync(() => usePlayback.getState().reset())
})
afterEach(cleanup)

describe('la lecture et le texte', () => {
  it('place la lecture sur le mot cliqué', () => {
    const { onPlace } = mount()
    const word = screen.getByText(/m0-2/)
    fireEvent.pointerDown(word)
    fireEvent.pointerUp(word)
    expect(onPlace).toHaveBeenCalledWith(2)
  })

  it('ne place pas la lecture au bout d’un glissé de sélection', () => {
    // Le glissé sert à sélectionner : déplacer la lecture au relâchement
    // ferait sauter le lecteur à chaque retrait.
    const { onPlace } = mount()
    fireEvent.pointerDown(screen.getByText(/m0-0/))
    fireEvent.pointerEnter(screen.getByText(/m0-2/))
    fireEvent.pointerUp(screen.getByText(/m0-2/))
    expect(onPlace).not.toHaveBeenCalled()
  })

  it('surligne le mot en cours de lecture', () => {
    const { words } = mount()
    actAsync(() => {
      usePlayback.getState().defineWords(words)
      usePlayback.getState().definePosition(3.2)
    })
    expect(screen.getByText(/m0-3/).getAttribute('aria-current')).toBe('location')
    expect(screen.getByText(/m0-2/).getAttribute('aria-current')).toBeNull()
  })
})

describe('le défilement automatique', () => {
  it('suit la lecture, puis se coupe dès qu’on défile à la main', async () => {
    const { words, surface } = mount()
    actAsync(() => usePlayback.getState().defineWords(words))

    actAsync(() => usePlayback.getState().definePosition(80))
    const tracked = surface.scrollTop
    expect(tracked).toBeGreaterThan(0)
    await imageNext()

    // Le geste de l'utilisateur reprend la main : le texte ne doit plus fuir
    // sous les yeux pendant qu'on lit ailleurs.
    fireEvent.scroll(surface)
    actAsync(() => usePlayback.getState().definePosition(160))
    expect(surface.scrollTop).toBe(tracked)
  })

  it('coupe le suivi sur une molette, même quand rien ne défile', async () => {
    // `scroll` ne part que si `scrollTop` bouge : une molette en butée n'émet
    // rien, et le suivi restait actif. (relevé par Copilot)
    const { words, surface } = mount()
    actAsync(() => usePlayback.getState().defineWords(words))
    actAsync(() => usePlayback.getState().definePosition(80))
    await imageNext()
    const frozen = surface.scrollTop

    fireEvent.wheel(surface)
    actAsync(() => usePlayback.getState().definePosition(160))
    expect(surface.scrollTop).toBe(frozen)
  })

  it('reprend au clic sur un mot', async () => {
    const { words, surface } = mount()
    actAsync(() => usePlayback.getState().defineWords(words))
    actAsync(() => usePlayback.getState().definePosition(80))
    await imageNext()
    fireEvent.scroll(surface)
    const frozen = surface.scrollTop

    // Le clic sur un mot est le geste par lequel on redit « je regarde la
    // lecture ».
    const word = screen.getByText(/m8-1/)
    fireEvent.pointerDown(word)
    fireEvent.pointerUp(word)

    actAsync(() => usePlayback.getState().definePosition(160))
    expect(surface.scrollTop).toBeGreaterThan(frozen)
  })
})

describe('le tabindex glissant', () => {
  it('n’offre qu’un seul arrêt de tabulation', () => {
    // Traverser le transcript pour atteindre la barre d'outils demandait une
    // centaine de `Tab`, et le nombre dépendait de la position de défilement.
    const { surface } = mount()
    expect(stops(surface).length).toBe(1)
  })

  it('déplace le mot actif aux flèches, et le focus avec', () => {
    mount()
    const first = screen.getByText(/m0-0/)
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })

    const next = screen.getByText(/m0-1/)
    expect(next.getAttribute('tabindex')).toBe('0')
    expect(document.activeElement).toBe(next)
    expect(first.getAttribute('tabindex')).toBe('-1')
  })

  it('referme le glissé après une activation au clavier', () => {
    // `commencerSelection` ouvre un glissé ; sans le refermer, passer la souris
    // sur un mot voisin étend la sélection alors qu'aucun bouton n'est enfoncé.
    // (relevé par Codex)
    const { onFinish } = mount()
    fireEvent.keyDown(screen.getByText(/m0-2/), { key: 'Enter' })
    expect(onFinish).toHaveBeenCalled()
  })

  it('sélectionne le mot atteint à la flèche', () => {
    // Le curseur du clavier et la sélection doivent coïncider, sinon `I` et `O`
    // posent la borne sur un mot cliqué il y a trois gestes — silencieusement.
    // (relevé par Copilot)
    const { onSelect, onFinish } = mount()
    const first = screen.getByText(/m0-0/)
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })

    expect(onSelect).toHaveBeenLastCalledWith(1, false)
    // Et le glissé se referme : sans cela, un survol à la souris étendrait
    // ensuite la sélection sans qu'on ait rien pressé.
    expect(onFinish).toHaveBeenCalled()
  })

  it('reste franchissable quand le mot actif est sorti du champ rendu', () => {
    // Le virtualiseur ne rend qu'une trentaine de phrases : l'index du mot actif
    // se garde dans l'état, pas dans le DOM, et la surface doit garder un arrêt
    // de tabulation même quand ce mot n'existe plus dans la page.
    const { surface } = mount({ search: true })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'm19-0' } })
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
    expect(stops(surface).length).toBe(1)
  })
})

describe('la recherche', () => {
  it('compte les occurrences et se déplace de l’une à l’autre', () => {
    const { surface } = mount({ search: true })
    const field = screen.getByRole('searchbox')
    fireEvent.change(field, { target: { value: 'm0-' } })

    expect(within(surface.parentElement as HTMLElement).getByText('1 sur 5')).toBeTruthy()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(within(surface.parentElement as HTMLElement).getByText('2 sur 5')).toBeTruthy()
  })

  it('coupe le suivi de lecture, comme tout geste de navigation', async () => {
    // Chercher, c'est aller voir ailleurs. Laisser le défilement suivre la
    // lecture ramènerait le texte sous les yeux au moment où on lit l'occurrence.
    const { words, surface } = mount({ search: true })
    actAsync(() => usePlayback.getState().defineWords(words))
    actAsync(() => usePlayback.getState().definePosition(80))
    await imageNext()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'm2-0' } })
    await imageNext()
    const stopped = surface.scrollTop

    actAsync(() => usePlayback.getState().definePosition(160))
    expect(surface.scrollTop).toBe(stopped)
  })

  it('dit quand rien ne correspond', () => {
    mount({ search: true })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'incendie' } })
    expect(screen.getByText(/aucune/i)).toBeTruthy()
  })

  it('se ferme sur Échap', () => {
    const { onSearch } = mount({ search: true })
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    expect(onSearch).toHaveBeenCalledWith(false)
  })
})
