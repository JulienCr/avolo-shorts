// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ExportsView } from '@/components/clip/exports-view'
import { clipFixture } from '../../fixtures/clip'
import { framing, shot, splitCells } from '../../fixtures/framing'
import type { ClipOutputs } from '@/lib/api'

const nothingIsProduced: ClipOutputs = {
  mp4Url: null,
  mp4Due: true,
  variant9x16Url: null,
  variant9x16Due: true,
  textsUrl: null,
}

function mount(overrides: Partial<Parameters<typeof ExportsView>[0]> = {}) {
  render(
    <ExportsView
      clip={clipFixture()}
      outputs={nothingIsProduced}
      framing={framing()}
      descriptionFooter=""
      onReexport={vi.fn()}
      reexportDisabled={false}
      {...overrides}
    />,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ExportsView', () => {
  it('montre la livraison courante et son lecteur, en pleine largeur', () => {
    mount({
      outputs: {
        ...nothingIsProduced,
        variant9x16Url: '/api/clips/c1/renders/c1-9x16.mp4',
        variant9x16Due: true,
        textsUrl: '/api/clips/c1/renders/c1.txt',
      },
    })

    expect(screen.getByRole('heading', { name: 'Livraison courante' })).toBeTruthy()
    const player = screen.getByLabelText('Variante 9:16')
    expect(player.getAttribute('src')).toBe('/api/clips/c1/renders/c1-9x16.mp4')
    expect(player.className).not.toMatch(/max-w-64/)
  })

  it('dit qu’il n’y a rien plutôt que d’inventer une version', () => {
    mount({ outputs: nothingIsProduced })

    expect(screen.getByText(/aucun fichier livré/i)).toBeTruthy()
    expect(screen.queryByRole('video')).toBeNull()
  })

  it('énonce le cadrage que l’export a appliqué', () => {
    mount({
      framing: framing({ shots: [shot(0, 10, '1:1', 0.4), shot(10, 20, '16:9', 0.5)] }),
    })
    expect(screen.getByText(/2 plans/)).toBeTruthy()
    expect(screen.getByText(/1:1, 16:9/)).toBeTruthy()
  })

  it('signale le split-screen sur au moins un plan de la variante', () => {
    mount({
      framing: framing({
        shots: [shot(0, 10, '16:9', 0.5, 'auto', splitCells()), shot(10, 20, '1:1', 0.5)],
      }),
    })
    expect(screen.getByText(/split-screen/)).toBeTruthy()
  })

  it('ne signale pas de split quand le natif est déjà 9:16', () => {
    // Sans variante due (natif déjà 9:16), le split ne se rend jamais : rien
    // ne le produit côté rendu. L'annoncer décrirait un fichier qui n'existe
    // pas. (relevé par Aristarque, préexistant)
    mount({
      framing: framing({
        ratio: '9:16',
        shots: [shot(0, 20, '9:16', 0.5, 'auto', splitCells())],
      }),
    })
    expect(screen.queryByText(/split-screen/)).toBeNull()
  })

  it('avertit d’un titre vide', () => {
    mount({ clip: clipFixture({ title: '' }) })
    expect(screen.getByText(/le titre est vide/i)).toBeTruthy()
  })

  it('signale les plans sans mesure', () => {
    mount({
      framing: framing({
        shots: [shot(0, 10, '1:1', 0.4), shot(10, 20, '1:1', 0.5, 'default')],
      }),
    })
    expect(screen.getByText(/1 plan sans mesure/)).toBeTruthy()
  })

  it('n’en signale aucun quand tous les plans ont été mesurés', () => {
    mount({ framing: framing() })
    expect(screen.queryByText(/sans mesure/)).toBeNull()
  })

  it('dit pourquoi la publication n’est pas possible, quand le clip n’est pas livré', () => {
    mount({ outputs: nothingIsProduced })
    expect(screen.getByText(/exporter avant de publier/i)).toBeTruthy()
  })

  it('copie les trois textes de publication séparément', async () => {
    const write = vi.fn(async (text: string) => {
      void text
    })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    mount({ clip: clipFixture({ title: 'La chute', description: 'Une impro #impro' }) })

    fireEvent.click(screen.getByRole('button', { name: /copier titre/i }))
    expect(write).toHaveBeenLastCalledWith('La chute')

    fireEvent.click(screen.getByRole('button', { name: /copier mots-dièse/i }))
    expect(write).toHaveBeenLastCalledWith('#impro')
  })

  it('copie le `.txt` entier via le bouton du bloc de textes', async () => {
    const write = vi.fn(async (text: string) => {
      void text
    })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    mount({ clip: clipFixture({ title: 'La chute' }) })

    fireEvent.click(screen.getByRole('button', { name: /copier pour publication/i }))
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toContain('Titre : La chute')
  })

  describe('forcer un nouvel export', () => {
    it('n’offre le geste que sur un clip livré', () => {
      mount({ outputs: nothingIsProduced })
      expect(screen.queryByRole('button', { name: /forcer un nouvel export/i })).toBeNull()
    })

    it('l’offre en secondaire, jamais en primaire, sur un clip livré', () => {
      mount({
        outputs: { ...nothingIsProduced, variant9x16Url: '/api/clips/c1/renders/c1-9x16.mp4' },
      })
      const button = screen.getByRole('button', { name: /forcer un nouvel export/i })
      expect(button.className).not.toMatch(/bg-primary/)
    })

    it('appelle le geste fourni par l’écran, désactivé selon l’état d’enregistrement', () => {
      const onReexport = vi.fn()
      mount({
        outputs: { ...nothingIsProduced, variant9x16Url: '/api/clips/c1/renders/c1-9x16.mp4' },
        onReexport,
      })
      fireEvent.click(screen.getByRole('button', { name: /forcer un nouvel export/i }))
      expect(onReexport).toHaveBeenCalledTimes(1)
    })

    it('ne déclenche rien quand désactivé, la raison restant lisible au clavier', () => {
      const onReexport = vi.fn()
      mount({
        outputs: { ...nothingIsProduced, variant9x16Url: '/api/clips/c1/renders/c1-9x16.mp4' },
        onReexport,
        reexportDisabled: true,
      })
      const button = screen.getByRole('button', { name: /forcer un nouvel export/i })
      expect(button.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(button)
      expect(onReexport).not.toHaveBeenCalled()
    })
  })
})
