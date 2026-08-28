// @vitest-environment jsdom

/**
 * `FramingSection` : les six leviers globaux du cadrage automatique
 * (split-screen, PR #176 ; plancher de taille, PR #177), exposés à l'écran
 * pour la première fois (issue #180, première moitié).
 *
 * **Ce qu'un écran de réglages numériques rate le plus souvent**, et que ces
 * tests tiennent : accepter une saisie hors bornes, écrire à chaque frappe
 * plutôt qu'en quittant le champ, et proposer un « Revenir au défaut » qui ne
 * défait rien.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { FramingSection } from '@/components/settings/framing-section'
import { FRAMING_SETTINGS_DEFAULTS, type FramingSettings } from '@/lib/api'
import { installPointerEventPolyfill } from '../../fixtures/pointer-event'

// La `Checkbox` de Base UI dispatche son propre `PointerEvent`, que `jsdom` n'a pas.
installPointerEventPolyfill()

afterEach(() => {
  cleanup()
})

const DEFAULTS: FramingSettings = { ...FRAMING_SETTINGS_DEFAULTS }

const box = () => screen.getByRole('checkbox', { name: /Split-screen activé par défaut/ })
const dubbingBox = () => screen.getByRole('checkbox', { name: /Montage doublage activé par défaut/ })
const minShotInput = () => screen.getByRole('spinbutton', { name: /Durée minimale du plan/ })

it('affiche les défauts pendant le chargement, tout inerte', () => {
  render(<FramingSection values={undefined} onChange={() => {}} />)
  expect(box().getAttribute('data-checked')).not.toBeNull()
  expect(box().getAttribute('data-disabled')).toBe('')
  expect(minShotInput()).toHaveProperty('value', String(DEFAULTS.splitMinShotMs))
  expect(minShotInput().getAttribute('disabled')).toBe('')
})

it('reflète les valeurs du serveur, pas les défauts du code', () => {
  const values: FramingSettings = { ...DEFAULTS, splitScreen: false, splitMinShotMs: 6000 }
  render(<FramingSection values={values} onChange={() => {}} />)
  expect(box().getAttribute('data-checked')).toBeNull()
  expect(minShotInput()).toHaveProperty('value', '6000')
})

it('n’envoie que le champ touché quand la case bascule', () => {
  const onChange = vi.fn()
  render(<FramingSection values={DEFAULTS} onChange={onChange} />)
  fireEvent.click(box())
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ splitScreen: false })
})

it('borne une saisie numérique hors plage à la sortie du champ', () => {
  const onChange = vi.fn()
  render(<FramingSection values={DEFAULTS} onChange={onChange} />)
  const input = minShotInput()
  fireEvent.change(input, { target: { value: '999999' } })
  fireEvent.blur(input)
  // 60 000 ms : la borne haute de `FRAMING_BOUNDS.splitMinShotMs`.
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ splitMinShotMs: 60_000 })
})

it('ne propose de revenir au défaut que si on s’en est écarté', () => {
  const onChange = vi.fn()
  const { rerender } = render(<FramingSection values={DEFAULTS} onChange={onChange} />)
  expect(screen.queryByRole('button', { name: /Revenir à/ })).toBeNull()

  rerender(<FramingSection values={{ ...DEFAULTS, splitMinShotMs: 6000 }} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: `Revenir à ${DEFAULTS.splitMinShotMs}` }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ splitMinShotMs: DEFAULTS.splitMinShotMs })
})

it('expose le switch du montage doublage, et n’envoie que ce champ au clic', () => {
  const onChange = vi.fn()
  render(<FramingSection values={DEFAULTS} onChange={onChange} />)
  expect(dubbingBox().getAttribute('data-checked')).not.toBeNull()
  fireEvent.click(dubbingBox())
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ dubbingLayout: false })
})

it('se laisse désactiver le temps d’une écriture en vol', () => {
  render(<FramingSection values={DEFAULTS} onChange={() => {}} disabled />)
  expect(box().getAttribute('data-disabled')).toBe('')
  expect(minShotInput().getAttribute('disabled')).toBe('')
})
