// @vitest-environment jsdom

/**
 * Le sélecteur de ratio.
 *
 * Le curseur de cadrage se fige en 16:9 — le cadre occupe alors toute la
 * largeur, il n'y a rien à déplacer — et **rien ne le disait**. Un contrôle
 * inerte sans raison écrite passe pour cassé, et la raison ne peut pas vivre
 * dans une bulle d'aide : elle serait invisible au clavier.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RatioPicker } from '@/components/clip/crop-picker'

afterEach(cleanup)

describe('RatioPicker', () => {
  it('dit pourquoi le cadre ne se déplace pas en 16:9', () => {
    render(<RatioPicker ratio="16:9" onRatio={vi.fn()} />)
    expect(screen.getByText(/toute la largeur/i)).toBeTruthy()
  })

  it('ne dit rien de tel sur un ratio où le cadre se déplace', () => {
    render(<RatioPicker ratio="1:1" onRatio={vi.fn()} />)
    expect(screen.queryByText(/toute la largeur/i)).toBeNull()
  })
})
