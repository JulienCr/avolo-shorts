// @vitest-environment jsdom

/**
 * La carte d'une source, c'est-à-dire l'entrée du tunnel.
 *
 * Ce que ces tests tiennent : une source déjà analysée **mène à son projet** et
 * n'en recrée pas un, et la carte sur laquelle on vient de cliquer ne peut pas
 * être cliquée deux fois. Les deux défauts sont invisibles à la relecture et
 * coûteux à l'usage — le second traverse un `lstat` sur un montage 9p qui met
 * parfois plusieurs secondes.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SourceCard, type Creation } from '@/components/sources/source-card'
import type { Source } from '@/lib/api'

afterEach(cleanup)

const NEUVE: Source = {
  name: '2025-06-15-cqlp.mp4',
  sizeBytes: 4_300_000_000,
  modifiedAt: '2025-06-15T19:04:00.000Z',
  projectId: null,
}

function creation(partiel: Partial<Creation> = {}): Creation {
  return { enCours: null, erreur: null, lancer: vi.fn(), ...partiel }
}

describe('SourceCard', () => {
  it('dit ce qu’il faut pour reconnaître un replay : son nom, son poids, sa date', () => {
    render(<SourceCard source={NEUVE} creation={creation()} />)

    expect(screen.getByText('2025-06-15-cqlp.mp4')).toBeTruthy()
    expect(screen.getByText(/4,3 Go/)).toBeTruthy()
    expect(screen.getByText(/15 juin 2025/)).toBeTruthy()
  })

  it('crée un projet sur une source neuve', async () => {
    const c = creation()
    render(<SourceCard source={NEUVE} creation={c} />)

    await userEvent.click(screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ }))
    expect(c.lancer).toHaveBeenCalledWith(NEUVE)
  })

  it('mène au projet d’une source déjà analysée, au lieu d’en relancer un', async () => {
    // `créerProjet` est idempotent sur ce cas — le plan revient vide —, mais
    // proposer deux chemins vers le même endroit sans le dire fait douter de ce
    // qu'on vient de déclencher.
    const c = creation()
    render(
      <SourceCard source={{ ...NEUVE, projectId: '2025-06-15-cqlp' }} creation={c} />,
    )

    expect(screen.queryByRole('button')).toBeNull()
    const lien = screen.getByRole('link', { name: /2025-06-15-cqlp\.mp4/ })
    expect(lien).toHaveProperty('pathname', '/projects/2025-06-15-cqlp')

    await userEvent.click(lien)
    expect(c.lancer).not.toHaveBeenCalled()
  })

  it('porte la marque de son projet, pour qu’on sache avant de cliquer', () => {
    render(<SourceCard source={{ ...NEUVE, projectId: 'p1' }} creation={creation()} />)
    expect(screen.getByText('Analysée')).toBeTruthy()
  })

  it('se désactive le temps que la création réponde', async () => {
    // Sans cet état, on clique deux fois : la réponse arrive en quelques
    // centaines de millisecondes, mais elle traverse un `lstat` sur un montage
    // 9p qui peut mettre plusieurs secondes.
    const c = creation({ enCours: NEUVE.name })
    render(<SourceCard source={NEUVE} creation={c} />)

    const carte = screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ })
    expect(carte).toHaveProperty('disabled', true)
    expect(screen.getByText('Création…')).toBeTruthy()

    await userEvent.click(carte)
    expect(c.lancer).not.toHaveBeenCalled()
  })

  it('se désactive aussi pendant la création d’une autre source', async () => {
    // Deux créations en vol se disputeraient la redirection : on atterrirait
    // sur celle qui a répondu la dernière, sans que rien ne le dise.
    const c = creation({ enCours: 'une-autre.mp4' })
    render(<SourceCard source={NEUVE} creation={c} />)

    const carte = screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ })
    expect(carte).toHaveProperty('disabled', true)
    // Mais c'est bien l'autre carte qui affiche l'attente, pas celle-ci.
    expect(screen.queryByText('Création…')).toBeNull()

    await userEvent.click(carte)
    expect(c.lancer).not.toHaveBeenCalled()
  })

  it('reste ouverte vers son projet pendant qu’une création tourne ailleurs', () => {
    // Une navigation ne se dispute rien : la bloquer priverait du seul geste
    // encore utile pendant l'attente.
    render(
      <SourceCard
        source={{ ...NEUVE, projectId: 'p1' }}
        creation={creation({ enCours: 'une-autre.mp4' })}
      />,
    )
    expect(screen.getByRole('link', { name: /2025-06-15-cqlp\.mp4/ })).toBeTruthy()
  })

  it('affiche une source vide sans se casser', () => {
    // Un fichier de 0 octet existe : un enregistrement qui vient de commencer.
    render(<SourceCard source={{ ...NEUVE, sizeBytes: 0 }} creation={creation()} />)
    expect(screen.getByText(/0 octet/)).toBeTruthy()
  })
})
