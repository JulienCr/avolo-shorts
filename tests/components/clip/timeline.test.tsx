// @vitest-environment jsdom

/**
 * La bande de temps.
 *
 * Elle ajoute le geste que le transcript ne sait pas exprimer — gagner la
 * demi-seconde de silence avant une réplique — et elle le fait **en temps
 * source, coupes visibles**. Ces tests tiennent les trois décisions qui
 * pourraient se défaire par réflexe : une seule écriture par geste, des oreilles
 * libres qui ne s'aimantent à rien, et une fenêtre qui n'enferme pas dans ses
 * trois secondes de contexte.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { Timeline } from '@/components/clip/timeline'
import { usePlayback } from '@/components/clip/playback'
import { framing, shot } from '../../fixtures/framing'

// jsdom n'implémente pas la capture de pointeur : sans ces bouchons, le premier
// `pointerdown` lève et le geste ne commence jamais.
beforeAll(() => {
  Element.prototype.setPointerCapture = function () {}
  Element.prototype.releasePointerCapture = function () {}
  Element.prototype.hasPointerCapture = function () {
    return true
  }
})

/**
 * Un événement de pointeur **qui porte sa coordonnée**.
 *
 * jsdom n'a pas de constructeur `PointerEvent` : `fireEvent.pointerDown(el, {
 * clientX })` fabrique alors un `Event` nu, et `clientX` arrive `undefined` dans
 * le gestionnaire — ce qui rendait tous les calculs de position `NaN` sans que
 * rien ne le dise. Un `MouseEvent` du bon type porte la coordonnée, et React le
 * livre au même `onPointerDown`.
 */
function pointerAt(target: Element | Window, type: string, clientX: number) {
  fireEvent(target, new MouseEvent(type, { clientX, bubbles: true, cancelable: true }))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  usePlayback.getState().reset()
})

/** La bande occupe 1000 px : une fraction lue vaut donc un millième de la fenêtre. */
function measureTrack() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        width: 1000,
        height: 48,
        top: 0,
        left: 0,
        right: 1000,
        bottom: 48,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  )
}

function mount(overrides: Partial<Parameters<typeof Timeline>[0]> = {}) {
  const onScrub = vi.fn()
  const onBoundary = vi.fn()
  render(
    <Timeline
      clipId="c1"
      segments={[{ start: 100, end: 120 }]}
      savedSegments={[{ start: 100, end: 120 }]}
      framing={framing({ shots: [shot(0, 110, '1:1', 0.5), shot(110, 200, '16:9', 0.5)] })}
      proxyUrl="/api/projects/p1/proxy"
      sourceDuration={5940}
      onScrub={onScrub}
      onBoundary={onBoundary}
      lines={[]}
      words={[]}
      firstLine={0}
      duration={20}
      search={false}
      onSearch={vi.fn()}
      onPlay={vi.fn()}
      {...overrides}
    />,
  )
  return { onScrub, onBoundary }
}

function track() {
  const element = document.querySelector('[data-timeline]')
  if (element === null) throw new Error('la bande de temps n’est pas rendue')
  return element
}

function handle(edge: 'start' | 'end') {
  const element = document.querySelector(`[data-edge="${edge}"]`)
  if (element === null) throw new Error(`l’oreille « ${edge} » n’est pas rendue`)
  return element
}

describe('la fenêtre', () => {
  it('montre trois secondes de contexte de chaque côté', () => {
    // Sans ce contexte on ne peut que resserrer, jamais élargir, et la moitié de
    // l'intérêt des oreilles disparaît. Le clip va de 100 à 120.
    mount()
    expect(screen.getByText('0:01:37')).toBeTruthy()
    expect(screen.getByText('0:02:03')).toBeTruthy()
  })

  it('dit que les creux sont les coupes', () => {
    // Une bande en temps source montre les passages retirés à leur vraie place.
    // Sans cette ligne, ils passent pour des blancs de rendu.
    mount()
    expect(screen.getByText(/les creux sont les passages retirés/i)).toBeTruthy()
  })

  it('n’affiche pas de bande quand tout a été retiré', () => {
    // Il n'y a plus de bornes. L'écran dit ailleurs comment en sortir : le
    // répéter ici ferait deux phrases pour un seul état.
    mount({ segments: [] })
    expect(document.querySelector('[data-timeline]')).toBeNull()
    expect(screen.getByText(/réapparaîtra dès qu’un passage sera remonté/i)).toBeTruthy()
  })

  it('garde le mode Mots atteignable quand tout a été retiré', async () => {
    // Sans bornes, le seul chemin de retour est le mot retiré à remonter —
    // c'est le mode Mots qui le porte, il ne peut pas disparaître avec la
    // bande. (relevé par Codex, Aristarque)
    const user = userEvent.setup()
    mount({ segments: [] })

    await user.click(screen.getByRole('tab', { name: 'Mots' }))
    expect(screen.getByRole('group', { name: 'Transcript du clip' })).toBeTruthy()
  })
})

describe('le ruban', () => {
  it('pose le ruban en fond de piste', () => {
    mount({ clipId: 'c9' })
    const film = screen.getByTestId('filmstrip')
    expect(film.style.backgroundImage).toContain('/api/clips/c9/filmstrip')
  })

  it('ne pose rien sans proxy', () => {
    // La route rend 404 sans proxy ; un composant ne peut pas le savoir à
    // l'avance, donc c'est `proxyUrl` qui décide côté client.
    mount({ proxyUrl: null })
    expect(screen.queryByTestId('filmstrip')).toBeNull()
  })

  it('recharge sur la borne confirmée par le serveur, pas sur celle qui glisse encore', () => {
    // `segments` bouge à chaque frappe, `savedSegments` seulement une fois
    // `useAutosave` parti : lier l'URL au premier redemanderait une image
    // que le serveur ne connaît pas encore. (relevé par Copilot)
    mount({
      segments: [{ start: 100, end: 150 }],
      savedSegments: [{ start: 100, end: 120 }],
    })
    const film = screen.getByTestId('filmstrip')
    expect(film.style.backgroundImage).toContain('bounds=100.00-120.00')
  })
})

describe('les deux familles de repères', () => {
  it('dessine une encoche par coupe, avec sa durée', () => {
    // Un passage retiré, et ça se défait — à l'inverse d'une frontière de plan.
    mount({
      segments: [
        { start: 100, end: 105 },
        { start: 107.4, end: 120 },
      ],
    })
    const cuts = screen.getAllByTestId('cut')
    expect(cuts).toHaveLength(1)
    expect(cuts[0].textContent).toContain('2,4 s')
  })

  it('ne dessine aucune coupe sur un seul segment', () => {
    mount()
    expect(screen.queryAllByTestId('cut')).toHaveLength(0)
  })

  it('ne nomme pas les frontières de plan', () => {
    mount({
      framing: framing({ shots: [shot(0, 110, '1:1', 0.5), shot(110, 200, '16:9', 0.5)] }),
    })
    const marks = screen.getAllByTestId('shot-mark')
    expect(marks).toHaveLength(1)
    expect(marks[0].textContent).toBe('')
  })

  it('reste lisible à trois fois la densité d’aujourd’hui', () => {
    // Le clip de référence porte 7 plans ; la #271 a multiplié les frontières
    // sur une émission re-analysée. Le repère est un trait de 1 px sans
    // étiquette : rien n'y grossit avec le nombre de plans.
    const shots = Array.from({ length: 22 }, (_, i) => shot(i * 10, i * 10 + 10, '1:1', 0.5))
    mount({ framing: framing({ shots }) })
    const marks = screen.getAllByTestId('shot-mark')
    expect(marks).toHaveLength(21)
    for (const mark of marks) expect(mark.textContent).toBe('')
  })
})

describe('Temps | Mots', () => {
  it('commute entre la piste et les mots', async () => {
    const user = userEvent.setup()
    mount()
    expect(screen.queryByTestId('filmstrip')).not.toBeNull()

    await user.click(screen.getByRole('tab', { name: 'Mots' }))
    expect(screen.queryByTestId('filmstrip')).toBeNull()
    expect(screen.getByRole('group', { name: 'Transcript du clip' })).toBeTruthy()
  })

  it('bascule en mode Mots quand la recherche est demandée', () => {
    // `Ctrl+F`, côté écran : `search` porte la demande, la bande suit.
    const { rerender } = render(
      <Timeline
        clipId="c1"
        segments={[{ start: 100, end: 120 }]}
        savedSegments={[{ start: 100, end: 120 }]}
        framing={framing()}
        proxyUrl="/api/projects/p1/proxy"
        sourceDuration={5940}
        onScrub={vi.fn()}
        onBoundary={vi.fn()}
        lines={[]}
        words={[]}
        firstLine={0}
        duration={20}
        search={false}
        onSearch={vi.fn()}
        onPlay={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('filmstrip')).not.toBeNull()
    rerender(
      <Timeline
        clipId="c1"
        segments={[{ start: 100, end: 120 }]}
        savedSegments={[{ start: 100, end: 120 }]}
        framing={framing()}
        proxyUrl="/api/projects/p1/proxy"
        sourceDuration={5940}
        onScrub={vi.fn()}
        onBoundary={vi.fn()}
        lines={[]}
        words={[]}
        firstLine={0}
        duration={20}
        search
        onSearch={vi.fn()}
        onPlay={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('filmstrip')).toBeNull()
  })
})

describe('les champs de bornes', () => {
  it('affiche la borne retenue, pas celle qui a été demandée', async () => {
    const user = userEvent.setup()
    // Le clip va de 100 à 120 ; 108 tombe dans le trou retiré de 105 à 110.
    // `onBoundary` est un bouchon : sans état à écrire, le champ ne peut que
    // relire la même borne — la preuve qu'il ne recopie pas la saisie.
    mount({
      segments: [
        { start: 100, end: 105 },
        { start: 110, end: 120 },
      ],
    })

    const start = screen.getByRole<HTMLInputElement>('textbox', { name: 'Borne d’entrée' })
    expect(start.value).toBe('1:40')
    await user.clear(start)
    await user.type(start, '0:01:48{Enter}')

    expect(start.value).toBe('1:40')
  })

  it('écrit par le même chemin qu’un glissé, une fois validé', async () => {
    const user = userEvent.setup()
    const { onBoundary } = mount()

    const end = screen.getByRole('textbox', { name: 'Borne de sortie' })
    await user.clear(end)
    await user.type(end, '1:50{Enter}')

    expect(onBoundary).toHaveBeenCalledTimes(1)
    expect(onBoundary.mock.calls[0]).toEqual([110, 'end'])
  })

  it('rejette une partie mm/ss qui dépasse 59, plutôt que de la relire à sa place', async () => {
    // `1:90` ne vaut pas 150 s : la partie `ss` déborde de ce que le format
    // permet, la saisie doit être refusée comme n'importe quelle ambiguïté.
    const user = userEvent.setup()
    const { onBoundary } = mount()

    const end = screen.getByRole('textbox', { name: 'Borne de sortie' })
    await user.clear(end)
    await user.type(end, '1:90{Enter}')

    expect(onBoundary).not.toHaveBeenCalled()
  })

  it('rejette une saisie dont la valeur déborde en Infinity', async () => {
    // Un nombre de trois cents chiffres passe le regex `\d+` mais son
    // `Number()` vaut `Infinity`, qu'`onBoundary` ne doit jamais recevoir.
    const user = userEvent.setup()
    const { onBoundary } = mount()

    const end = screen.getByRole('textbox', { name: 'Borne de sortie' })
    await user.clear(end)
    await user.type(end, `${'9'.repeat(320)}{Enter}`)

    expect(onBoundary).not.toHaveBeenCalled()
  })
})

describe('les oreilles', () => {
  it('portent le timecode plutôt qu’un nombre de secondes', () => {
    // « 100 » ne se compare à rien ; « 0:01:40 » se compare à ce qu'on lit
    // partout ailleurs à l'écran.
    mount()
    expect(handle('start').getAttribute('aria-valuetext')).toBe('0:01:40, image 0')
    expect(handle('end').getAttribute('aria-valuetext')).toBe('0:02:00, image 0')
  })

  it('annoncent l’image, faute de quoi vingt-neuf flèches ne disent rien', () => {
    // Le clavier déplace d'un trentième de seconde ; arrondie à la seconde, la
    // valeur annoncée restait identique pendant vingt-neuf frappes — et
    // l'ajustement image par image, qui est la raison d'être de ces flèches, ne
    // se disait nulle part. (relevé par Copilot)
    mount({ segments: [{ start: 100.4, end: 120 }] })
    expect(handle('start').getAttribute('aria-valuetext')).toBe('0:01:40, image 12')
    expect(Number(handle('start').getAttribute('aria-valuenow'))).toBeCloseTo(100.4, 3)
  })

  it('n’écrivent qu’une fois par geste, pas une fois par mouvement', () => {
    // Poser la borne à chaque `pointermove` empilerait soixante instantanés dans
    // la pile d'annulation pour un seul glissé, et `Ctrl+Z` défairait alors un
    // soixantième de geste.
    measureTrack()
    const { onBoundary } = mount()
    const grip = handle('start')
    pointerAt(grip, 'pointerdown', 115)
    pointerAt(grip, 'pointermove', 200)
    pointerAt(grip, 'pointermove', 300)
    expect(onBoundary).not.toHaveBeenCalled()

    pointerAt(window, 'pointerup', 300)
    expect(onBoundary).toHaveBeenCalledTimes(1)
  })

  it('sont libres à l’image près, sans aimantation', () => {
    // Le contrôle est celui d'un banc de montage : la borne vaut exactement ce
    // que la main a demandé, quitte à tomber au milieu d'un mot. La fenêtre va
    // de 97 à 123, sur 1000 px : 500 px valent donc 110 s.
    measureTrack()
    const { onBoundary } = mount()
    const grip = handle('start')
    pointerAt(grip, 'pointerdown', 500)
    pointerAt(window, 'pointerup', 500)

    const [time, edge] = onBoundary.mock.calls[0]
    expect(edge).toBe('start')
    expect(time).toBeCloseTo(110, 5)
  })

  it('ne traversent pas l’autre borne', () => {
    // Une borne d'entrée posée après la sortie laisserait une durée négative.
    measureTrack()
    const { onBoundary } = mount()
    pointerAt(handle('start'), 'pointerdown', 990)
    pointerAt(window, 'pointerup', 990)
    expect(onBoundary.mock.calls[0][0]).toBeLessThan(120)
  })

  it('avancent d’une image à la flèche, d’un pas large sous Maj', () => {
    const { onBoundary } = mount()
    fireEvent.keyDown(handle('start'), { key: 'ArrowLeft' })
    expect(onBoundary.mock.calls[0][0]).toBeCloseTo(100 - 1 / 30, 5)

    fireEvent.keyDown(handle('start'), { key: 'ArrowRight', shiftKey: true })
    expect(onBoundary.mock.calls[1][0]).toBeCloseTo(100.5, 5)
  })

  it('laissent les flèches à l’oreille et non à l’écran', () => {
    // `role="slider"` : la garde des raccourcis écarte déjà les flèches d'un
    // curseur, donc une oreille focalisée les reçoit sans se les faire voler.
    mount()
    expect(handle('start').getAttribute('role')).toBe('slider')
    expect(handle('start').getAttribute('tabindex')).toBe('0')
  })

  it('ne sortent pas de la source', () => {
    // Tirer loin à gauche ne demande pas un temps négatif : il n'y a rien avant
    // le début de l'émission.
    measureTrack()
    const { onBoundary } = mount({ segments: [{ start: 1, end: 20 }] })
    pointerAt(handle('start'), 'pointerdown', -5000)
    pointerAt(window, 'pointerup', -5000)
    expect(onBoundary.mock.calls[0][0]).toBe(0)
  })
})

describe('la vignette de scrub', () => {
  /**
   * **Le défaut que ce test ferme ne levait rien et ne se voyait qu'à l'écran.**
   *
   * Le `<video>` caché n'existe pas au premier rendu : le store n'a pas encore
   * chargé le clip. Un effet qui branchait `seeked` sur une *référence*
   * tournait alors dans le vide — une référence ne réveille aucun effet. La
   * vignette restait noire pendant tous les glissés, sans erreur nulle part.
   * Le montage en deux temps ci-dessous est la reproduction exacte.
   */
  it('peint la position demandée, même montée après le premier rendu', () => {
    measureTrack()
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D)

    const { rerender } = render(
      <Timeline
        clipId="c1"
        segments={[]}
        savedSegments={[]}
        framing={framing()}
        proxyUrl="/api/projects/p1/proxy"
        sourceDuration={5940}
        onScrub={vi.fn()}
        onBoundary={vi.fn()}
        lines={[]}
        words={[]}
        firstLine={0}
        duration={20}
        search={false}
        onSearch={vi.fn()}
        onPlay={vi.fn()}
      />,
    )
    rerender(
      <Timeline
        clipId="c1"
        segments={[{ start: 100, end: 120 }]}
        savedSegments={[{ start: 100, end: 120 }]}
        framing={framing()}
        proxyUrl="/api/projects/p1/proxy"
        sourceDuration={5940}
        onScrub={vi.fn()}
        onBoundary={vi.fn()}
        lines={[]}
        words={[]}
        firstLine={0}
        duration={20}
        search={false}
        onSearch={vi.fn()}
        onPlay={vi.fn()}
      />,
    )

    const source = document.querySelector('video')
    if (source === null) throw new Error('le lecteur de vignettes n’est pas monté')
    // jsdom ne décode rien : on lui donne des dimensions, faute de quoi la garde
    // contre une source de 0x0 écarte la peinture à juste titre.
    Object.defineProperty(source, 'videoWidth', { value: 960, configurable: true })
    Object.defineProperty(source, 'videoHeight', { value: 540, configurable: true })

    pointerAt(handle('start'), 'pointerdown', 400)
    drawImage.mockClear()
    fireEvent(source, new Event('seeked'))
    expect(drawImage).toHaveBeenCalledTimes(1)
  })

  it('ne cherche pas sans proxy', () => {
    // Un projet dont le proxy n'est pas encodé : la bande reste utilisable, il
    // n'y a simplement pas d'image à montrer.
    mount({ proxyUrl: null })
    expect(document.querySelector('video')).toBeNull()
  })
})

describe('la tête de lecture', () => {
  it('se promène au clavier, pas seulement au pointeur', () => {
    // **Le geste que la bande apporte n'existe pas dans le transcript.** Celui-ci
    // place la lecture sur un *mot* ; se poser dans un silence, ou dans un
    // passage retiré pour aller voir ce qu'il contient, ne s'y exprime pas. Un
    // contrôle réservé au pointeur retirerait donc au clavier une capacité neuve.
    // (relevé par Copilot)
    const { onScrub } = mount()
    act(() => usePlayback.getState().definePosition(110))
    const head = document.querySelector('[data-playhead]')
    if (head === null) throw new Error('la tête de lecture n’est pas rendue')

    fireEvent.keyDown(head, { key: 'ArrowRight' })
    expect(onScrub.mock.calls[0][0]).toBeCloseTo(110 + 1 / 30, 5)

    fireEvent.keyDown(head, { key: 'ArrowLeft', shiftKey: true })
    expect(onScrub.mock.calls[1][0]).toBeCloseTo(109.5, 5)
  })

  it('compte l’image dès la première flèche, malgré les flottants', () => {
    // `(100 + 1/30 - 100) / (1/30)` vaut un cheveu de moins que 1 en binaire :
    // sans tolérance, la première flèche depuis une seconde entière annonce
    // encore « image 0 » — exactement le silence que cette annonce rompt.
    // (relevé par Copilot)
    mount({ segments: [{ start: 100 + 1 / 30, end: 120 }] })
    expect(handle('start').getAttribute('aria-valuetext')).toBe('0:01:40, image 1')
  })

  it('annonce sa position en timecode', () => {
    mount()
    act(() => usePlayback.getState().definePosition(110.4))
    const head = document.querySelector('[data-playhead]')
    expect(head?.getAttribute('aria-valuetext')).toBe('0:01:50, image 12')
  })
})

describe('le scrub', () => {
  it('confie la position au lecteur à la fin du geste', () => {
    // Pendant le geste, c'est la vignette qui montre l'image : faire chercher le
    // lecteur principal soixante fois par seconde tuerait la lecture et ferait
    // sauter l'aperçu de sortie, qui s'accroche à ses trames.
    measureTrack()
    const { onScrub } = mount()
    pointerAt(track(), 'pointerdown', 500)
    expect(onScrub).not.toHaveBeenCalled()
    pointerAt(window, 'pointerup', 500)
    expect(onScrub).toHaveBeenCalledTimes(1)
    expect(onScrub.mock.calls[0][0]).toBeCloseTo(110, 5)
  })

  it('atteint un passage retiré', () => {
    // C'est tout l'intérêt d'une bande en temps source : on regarde ce qu'il y a
    // dans le trou avant de décider de le remonter. La lecture, elle, saute les
    // retraits — c'est l'écran qui le tranche, pas la bande.
    measureTrack()
    const { onScrub } = mount({
      segments: [
        { start: 100, end: 105 },
        { start: 115, end: 120 },
      ],
    })
    pointerAt(track(), 'pointerdown', 500)
    pointerAt(window, 'pointerup', 500)
    const time = onScrub.mock.calls[0][0]
    expect(time).toBeGreaterThan(105)
    expect(time).toBeLessThan(115)
  })
})
