// @vitest-environment jsdom

/**
 * La surcharge de cadrage en zone Image de l'écran Clip.
 *
 * Ce que ces tests fixent : le split-screen n'a plus de contrôle ici, la ligne
 * « Montage doublage » n'apparaît que là où elle a quelque chose à dire — et
 * dans son état « désactivé », elle se lit sur `clip.framingStyle`, jamais sur
 * les plans, qui perdent leur `dubbing` dès que la composition est coupée.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FramingFields } from '@/components/clip/framing-fields'
import { FRAMING_SETTINGS_DEFAULTS, type Clip, type FramingSettings, type PublishedFraming } from '@/lib/api'
import { dubbingCells, framing, shot } from '../../fixtures/framing'


function clip(fields: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    projectId: 'p1',
    segments: [{ start: 0, end: 20 }],
    ratio: '1:1',
    cropX: 0.5,
    captions: true,
    branding: true,
    footer: true,
    title: 'La chute',
    description: 'Une impro',
    status: 'kept',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
    ...fields,
  }
}

function mount(props: Partial<Parameters<typeof FramingFields>[0]> = {}) {
  const merged = {
    clip: clip(),
    globals: FRAMING_SETTINGS_DEFAULTS as FramingSettings | undefined,
    framing: framing({ shots: [shot(0, 20, '1:1', 0.5)] }) as PublishedFraming,
    onWrite: vi.fn(),
    ...props,
  }
  return { onWrite: merged.onWrite, ...render(<FramingFields {...merged} />) }
}

afterEach(() => cleanup())

/** Le pli des cinq réglages numériques, fermé par défaut. */
function openPersonalize() {
  fireEvent.click(screen.getByRole('button', { name: /Personnaliser/ }))
}

describe('split-screen', () => {
  it('n’a plus aucun contrôle sur cet écran', () => {
    mount()
    expect(screen.queryByText(/Split-screen/)).toBeNull()
  })
})

describe('montage doublage — état 1 : rien à dire', () => {
  it('ne rend aucune ligne sans plan de doublage ni surcharge', () => {
    mount({
      framing: framing({ shots: [shot(0, 20, '1:1', 0.5)] }),
      clip: clip({ framingStyle: {} }),
    })
    expect(screen.queryByText(/Split-screen/)).toBeNull()
    expect(screen.queryByText(/Montage doublage/)).toBeNull()
  })
})

describe('montage doublage — état 2 : plans détectés', () => {
  it('nomme le nombre de plans de doublage', () => {
    mount({
      framing: framing({
        shots: [
          shot(0, 5, '1:1', 0.5, 'auto', undefined, dubbingCells()),
          shot(5, 10, '1:1', 0.5, 'auto', undefined, dubbingCells()),
          shot(10, 20, '1:1', 0.5),
        ],
      }),
    })
    const row = within(screen.getByText(/Montage doublage/).parentElement!)
    expect(row.getByText(/Montage doublage — 2 plans/)).toBeTruthy()
  })

  it('désactiver pour ce clip écrit `{ dubbingLayout: false }`', () => {
    const onWrite = vi.fn()
    mount({
      framing: framing({ shots: [shot(0, 5, '1:1', 0.5, 'auto', undefined, dubbingCells())] }),
      onWrite,
    })

    fireEvent.click(screen.getByRole('button', { name: /désactiver pour ce clip/ }))
    expect(onWrite).toHaveBeenCalledWith({ framingStyle: { dubbingLayout: false } })
  })
})

describe('montage doublage — état 3 : désactivé pour ce clip', () => {
  /**
   * Le cas central du contrat : désactiver la composition fait perdre le champ
   * `dubbing` aux plans (`computeFraming` arrête de détecter), donc la ligne ne
   * peut pas dépendre des plans pour rester visible — sinon l'opérateur perd
   * tout moyen de revenir en arrière.
   */
  it('reste visible même sans aucun plan de doublage', () => {
    mount({
      framing: framing({ shots: [shot(0, 20, '1:1', 0.5)] }),
      clip: clip({ framingStyle: { dubbingLayout: false } }),
    })
    const row = within(screen.getByText(/Montage doublage/).parentElement!)
    expect(row.getByText(/composition désactivée pour ce clip/)).toBeTruthy()
  })

  it('« revenir à l’héritage » écrit `{ framingStyle: {} }`', () => {
    const onWrite = vi.fn()
    mount({
      framing: framing({ shots: [shot(0, 20, '1:1', 0.5)] }),
      clip: clip({ framingStyle: { dubbingLayout: false } }),
      onWrite,
    })

    fireEvent.click(screen.getByRole('button', { name: /revenir à l’héritage/ }))
    expect(onWrite).toHaveBeenCalledWith({ framingStyle: {} })
  })
})

describe('Personnaliser', () => {
  it('un champ numérique non surchargé se dit hérité, une fois le pli ouvert', () => {
    mount({ clip: clip({ framingStyle: {} }) })
    openPersonalize()
    expect(screen.getAllByText('— hérité').length).toBeGreaterThan(0)
  })

  it('« Réinitialiser avec les paramètres globaux » n’apparaît que s’il y a une surcharge', () => {
    const { rerender } = mount({ clip: clip({ framingStyle: {} }) })
    openPersonalize()
    expect(screen.queryByText(/Réinitialiser avec les paramètres globaux/)).toBeNull()

    rerender(
      <FramingFields
        clip={clip({ framingStyle: { sizeFloorPermille: 200 } })}
        globals={FRAMING_SETTINGS_DEFAULTS}
        framing={framing({ shots: [shot(0, 20, '1:1', 0.5)] })}
        onWrite={vi.fn()}
      />,
    )
    expect(screen.getByText(/Réinitialiser avec les paramètres globaux/)).toBeTruthy()
  })

  it('« Réinitialiser » envoie `PATCH { framingStyle: {} }`', () => {
    const onWrite = vi.fn()
    mount({ clip: clip({ framingStyle: { sizeFloorPermille: 200 } }), onWrite })
    openPersonalize()

    fireEvent.click(screen.getByText(/Réinitialiser avec les paramètres globaux/))
    expect(onWrite).toHaveBeenCalledWith({ framingStyle: {} })
  })

  it('un champ surchargé à la MÊME valeur que le global ne se dit plus hérité', () => {
    mount({
      clip: clip({ framingStyle: { sizeFloorPermille: FRAMING_SETTINGS_DEFAULTS.sizeFloorPermille } }),
    })
    openPersonalize()
    const row = within(screen.getByLabelText('Plancher de taille').closest('div')!)
    expect(row.queryByText('— hérité')).toBeNull()
    expect(row.getByRole('button', { name: /revenir à l’héritage/ })).toBeTruthy()
  })
})

describe('deux écritures avant que la première ne se pose (issue #189)', () => {
  it('réinitialiser un champ pendant qu’un autre est en surcharge non posée garde la surcharge posée ensuite', () => {
    const onWrite = vi.fn()
    mount({ clip: clip({ framingStyle: { sizeFloorPermille: 200 } }), onWrite })
    openPersonalize()

    fireEvent.click(screen.getByRole('button', { name: /revenir à l’héritage/ }))
    const input = screen.getByLabelText('Durée minimale du plan')
    fireEvent.change(input, { target: { value: '250' } })
    fireEvent.blur(input)

    const last = onWrite.mock.calls.at(-1)?.[0]
    expect(last).toEqual({ framingStyle: { splitMinShotMs: 250 } })
  })

  it('une réinitialisation complète suivie d’une nouvelle surcharge ne ressuscite pas les anciens champs', () => {
    const onWrite = vi.fn()
    mount({
      clip: clip({ framingStyle: { sizeFloorPermille: 300, splitMinShotMs: 400 } }),
      onWrite,
    })
    openPersonalize()

    fireEvent.click(screen.getByText(/Réinitialiser avec les paramètres globaux/))
    const input = screen.getByLabelText('Plancher de taille')
    fireEvent.change(input, { target: { value: '250' } })
    fireEvent.blur(input)

    expect(onWrite).toHaveBeenLastCalledWith({ framingStyle: { sizeFloorPermille: 250 } })
  })
})

describe('sans réglages globaux chargés', () => {
  it('reste inerte plutôt que de planter', () => {
    mount({ globals: undefined })
    openPersonalize()
    expect(
      screen.getByLabelText('Plancher de taille').getAttribute('disabled'),
    ).not.toBeNull()
  })
})
