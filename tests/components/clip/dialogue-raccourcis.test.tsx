// @vitest-environment jsdom

/**
 * La liste des raccourcis.
 *
 * Douze raccourcis qui ne se découvrent que dans un attribut `title` sont douze
 * raccourcis que personne n'utilise (spec §4.1). Ce test vérifie qu'ils sont
 * lisibles pour de bon, pas qu'une boîte s'ouvre.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { DialogueShortcuts } from '@/components/clip/shortcuts'

afterEach(cleanup)

describe('DialogueShortcuts', () => {
  it('énumère les douze touches quand il est ouvert', () => {
    render(<DialogueShortcuts open onOpen={() => {}} />)

    const box = screen.getByRole('dialog')
    for (const key of [
      'Espace',
      'Ctrl+Z',
      'Ctrl+Shift+Z',
      'Suppr',
      'Échap',
      'I',
      'O',
      'Ctrl+F',
      '?',
    ]) {
      expect(screen.getByText(key)).toBeTruthy()
    }
    expect(box.textContent).toContain('lecture')
  })

  it('ne montre rien tant qu’il est fermé', () => {
    render(<DialogueShortcuts open={false} onOpen={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
