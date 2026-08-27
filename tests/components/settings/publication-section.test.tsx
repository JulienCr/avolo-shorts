// @vitest-environment jsdom

/**
 * `PublicationSection` : le drapeau `autoPublish` (contrat PR F), ajouté
 * au-dessus des quatre lignes de connecteur déjà couvertes ailleurs.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { PublicationSection } from '@/components/settings/publication-section'
import { DEFAULT_SCHEDULE_HOURS, type PublicationSettings } from '@/lib/api'
import { installPointerEventPolyfill } from '../../fixtures/pointer-event'

// La `Checkbox` de Base UI dispatche son propre `PointerEvent`, que `jsdom` n'a pas.
installPointerEventPolyfill()

afterEach(() => {
  cleanup()
})

const VALUES: PublicationSettings = {
  instagram: 'auto',
  facebook: 'auto',
  tiktok: 'auto',
  youtube: 'auto',
  scheduleHours: DEFAULT_SCHEDULE_HOURS,
  autoPublish: true,
}

const toggle = () => screen.getByRole('checkbox', { name: /Publication automatique à l’échéance/ })

it('reflète le drapeau du serveur', () => {
  const { rerender } = render(<PublicationSection values={VALUES} onChange={() => {}} />)
  expect(toggle().getAttribute('aria-checked')).toBe('true')

  rerender(<PublicationSection values={{ ...VALUES, autoPublish: false }} onChange={() => {}} />)
  expect(toggle().getAttribute('aria-checked')).toBe('false')
})

it('envoie `autoPublish` seul quand la case bascule', () => {
  const onChange = vi.fn()
  render(<PublicationSection values={VALUES} onChange={onChange} />)
  fireEvent.click(toggle())
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ autoPublish: false })
})

it('se laisse désactiver le temps d’une écriture en vol', () => {
  render(<PublicationSection values={VALUES} onChange={() => {}} disabled />)
  expect(toggle().getAttribute('data-disabled')).toBe('')
})
