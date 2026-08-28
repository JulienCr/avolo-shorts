// @vitest-environment jsdom

/**
 * La surcharge de cadrage en zone Image de l'écran Clip.
 *
 * Ce que ces tests fixent : `splitScreen` reste visible sans ouvrir le pli,
 * chaque champ dit s'il est hérité ou surchargé — même à valeur égale —, et
 * « Réinitialiser » n'apparaît que s'il y a de quoi défaire.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FramingFields } from '@/components/clip/framing-fields'
import { FRAMING_SETTINGS_DEFAULTS, type Clip, type FramingSettings } from '@/lib/api'
import { installPointerEventPolyfill } from '../../fixtures/pointer-event'

installPointerEventPolyfill()

function clip(fields: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    projectId: 'p1',
    segments: [{ start: 0, end: 20 }],
    ratio: '1:1',
    cropX: 0.5,
    captions: true,
    branding: true,
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

describe('le switch split-screen', () => {
  it('montre la valeur globale sans qu’il faille ouvrir le pli', () => {
    mount({ globals: { ...FRAMING_SETTINGS_DEFAULTS, splitScreen: true } })
    expect(screen.getByRole('checkbox', { name: 'Split-screen' }).getAttribute('aria-checked')).toBe('true')
  })

  it('écrit une surcharge au clic', () => {
    const onWrite = vi.fn()
    mount({ globals: { ...FRAMING_SETTINGS_DEFAULTS, splitScreen: true }, onWrite })

    fireEvent.click(screen.getByRole('checkbox', { name: 'Split-screen' }))
    expect(onWrite).toHaveBeenCalledWith({ framingStyle: { splitScreen: false } })
  })

  it('se dit hérité tant qu’aucune surcharge n’existe', () => {
    mount({ clip: clip({ framingStyle: {} }) })
    const row = within(screen.getByRole('checkbox', { name: 'Split-screen' }).parentElement!)
    expect(row.getByText('— hérité')).toBeTruthy()
  })
})

describe('le switch montage doublage', () => {
  it('montre la valeur globale sans qu’il faille ouvrir le pli', () => {
    mount({ globals: { ...FRAMING_SETTINGS_DEFAULTS, dubbingLayout: false } })
    expect(screen.getByRole('checkbox', { name: 'Montage doublage' }).getAttribute('aria-checked')).toBe(
      'false',
    )
  })

  it('écrit une surcharge au clic', () => {
    const onWrite = vi.fn()
    mount({ globals: { ...FRAMING_SETTINGS_DEFAULTS, dubbingLayout: true }, onWrite })

    fireEvent.click(screen.getByRole('checkbox', { name: 'Montage doublage' }))
    expect(onWrite).toHaveBeenCalledWith({ framingStyle: { dubbingLayout: false } })
  })

  it('se dit hérité tant qu’aucune surcharge n’existe', () => {
    mount({ clip: clip({ framingStyle: {} }) })
    const row = within(screen.getByRole('checkbox', { name: 'Montage doublage' }).parentElement!)
    expect(row.getByText('— hérité')).toBeTruthy()
  })
})

describe('hérité vs surchargé', () => {
  it('un champ surchargé à la MÊME valeur que le global ne se dit plus hérité', () => {
    // Le cas central du contrat (voir hook-fields.test.tsx) : `{ splitScreen:
    // true }` sur un global déjà à `true` doit rester distinguable de `{}`.
    mount({
      clip: clip({ framingStyle: { splitScreen: true } }),
      globals: { ...FRAMING_SETTINGS_DEFAULTS, splitScreen: true },
    })
    const row = within(screen.getByRole('checkbox', { name: 'Split-screen' }).parentElement!)
    expect(row.queryByText('— hérité')).toBeNull()
    expect(row.getByRole('button', { name: /revenir à l’héritage/ })).toBeTruthy()
  })

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
})

describe('deux écritures avant que la première ne se pose (issue #189)', () => {
  it('surcharger le split-screen puis un champ numérique, sans attendre entre les deux, garde les deux surcharges', () => {
    const onWrite = vi.fn()
    mount({ clip: clip({ framingStyle: {} }), onWrite })
    openPersonalize()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Split-screen' }))
    const input = screen.getByLabelText('Plancher de taille')
    fireEvent.change(input, { target: { value: '250' } })
    fireEvent.blur(input)

    expect(onWrite).toHaveBeenLastCalledWith({
      framingStyle: expect.objectContaining({ splitScreen: expect.any(Boolean), sizeFloorPermille: 250 }),
    })
  })

  it('réinitialiser un champ pendant qu’un autre est en surcharge non posée ne le fait pas réapparaître', () => {
    const onWrite = vi.fn()
    mount({ clip: clip({ framingStyle: { splitScreen: true } }), onWrite })
    openPersonalize()

    fireEvent.click(screen.getByRole('button', { name: /revenir à l’héritage/ }))
    const input = screen.getByLabelText('Plancher de taille')
    fireEvent.change(input, { target: { value: '250' } })
    fireEvent.blur(input)

    const last = onWrite.mock.calls.at(-1)?.[0]
    expect(last).toEqual({ framingStyle: { sizeFloorPermille: 250 } })
  })

  it('une réinitialisation complète suivie d’une nouvelle surcharge ne ressuscite pas les anciens champs', () => {
    const onWrite = vi.fn()
    mount({ clip: clip({ framingStyle: { splitScreen: true, sizeFloorPermille: 300 } }), onWrite })
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
    expect(
      screen.getByRole('checkbox', { name: 'Split-screen' }).getAttribute('aria-disabled'),
    ).toBe('true')
  })
})
