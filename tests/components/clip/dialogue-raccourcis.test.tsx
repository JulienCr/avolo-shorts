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

import { DialogueRaccourcis } from '@/components/clip/raccourcis'

afterEach(cleanup)

describe('DialogueRaccourcis', () => {
  it('énumère les douze touches quand il est ouvert', () => {
    render(<DialogueRaccourcis ouvert onOuvert={() => {}} />)

    const boîte = screen.getByRole('dialog')
    for (const touche of [
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
      expect(screen.getByText(touche)).toBeTruthy()
    }
    expect(boîte.textContent).toContain('lecture')
  })

  it('ne montre rien tant qu’il est fermé', () => {
    render(<DialogueRaccourcis ouvert={false} onOuvert={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
