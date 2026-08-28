// @vitest-environment jsdom

/**
 * `export-panel.tsx` — la dérivation de l'état de livraison, le geste
 * terminal présentationnel et les briques réutilisées par `ExportsView`.
 *
 * Depuis la refonte du 28 août, ce module ne porte plus de rail : la
 * mécanique d'export (mutation, confirmation d'écrasement, dialogue de
 * publication) vit dans `ClipScreen`, testée dans `clip-screen.test.tsx`. Le
 * contenu de la livraison — noms de fichiers, lecteurs, textes copiables —
 * vit dans `ExportsView`, testé dans `exports-view.test.tsx`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ButtonCopy,
  ClipPrimaryAction,
  deriveDeliveryState,
  FieldCopyable,
  OutputsList,
} from '@/components/clip/export-panel'
import { outputNames } from '@/components/clip/texts'
import type { ClipOutputs } from '@/lib/api'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const nothingIsProduced: ClipOutputs = {
  mp4Url: null,
  mp4Due: true,
  variant9x16Url: null,
  variant9x16Due: true,
  textsUrl: null,
}

describe('deriveDeliveryState', () => {
  it('n’a jamais été exporté sans rendu ni statut « exported »', () => {
    expect(deriveDeliveryState('kept', nothingIsProduced)).toBe('never')
  })

  it('est périmé quand le statut est « exported » sans rendu disponible', () => {
    expect(deriveDeliveryState('exported', nothingIsProduced)).toBe('stale')
  })

  it('est livré dès qu’une vidéo est disponible, quel que soit le statut', () => {
    expect(
      deriveDeliveryState('kept', { ...nothingIsProduced, variant9x16Url: '/c1-9x16.mp4' }),
    ).toBe('delivered')
  })
})

describe('ClipPrimaryAction', () => {
  it('propose « Exporter » sur un clip jamais exporté', () => {
    render(<ClipPrimaryAction state="never" onExport={vi.fn()} onPublish={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Exporter' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /publier/i })).toBeNull()
  })

  it('propose « Ré-exporter » sur un rendu périmé', () => {
    render(<ClipPrimaryAction state="stale" onExport={vi.fn()} onPublish={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Ré-exporter' })).toBeTruthy()
  })

  it('propose « Publier », et seulement lui, sur un clip livré', () => {
    render(<ClipPrimaryAction state="delivered" onExport={vi.fn()} onPublish={vi.fn()} />)
    expect(screen.getByRole('button', { name: /publier/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Exporter' })).toBeNull()
  })

  it('déclenche le bon geste au clic', () => {
    const onExport = vi.fn()
    const onPublish = vi.fn()
    render(<ClipPrimaryAction state="never" onExport={onExport} onPublish={onPublish} />)
    fireEvent.click(screen.getByRole('button', { name: 'Exporter' }))
    expect(onExport).toHaveBeenCalledTimes(1)
    expect(onPublish).not.toHaveBeenCalled()
  })

  it('reste atteignable au clavier quand désactivé, la valeur portée par aria-disabled', () => {
    render(<ClipPrimaryAction state="never" onExport={vi.fn()} onPublish={vi.fn()} disabled />)
    const button = screen.getByRole('button', { name: 'Exporter' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
  })

  it('est le seul bouton de variante primaire, quel que soit l’état', () => {
    for (const state of ['never', 'stale', 'delivered'] as const) {
      const { unmount } = render(<ClipPrimaryAction state={state} onExport={vi.fn()} onPublish={vi.fn()} />)
      const primaries = screen
        .getAllByRole('button')
        .filter((b) => b.className.includes('bg-primary'))
      expect(primaries).toHaveLength(1)
      unmount()
    }
  })
})

describe('OutputsList', () => {
  it('n’annonce que la variante quand le natif est désactivé', () => {
    const names = outputNames('c1', '1:1')
    render(<OutputsList names={names} native="1:1" outputs={nothingIsProduced} />)
    expect(screen.queryByText('c1.mp4')).toBeNull()
    expect(screen.getByText(/rendu natif est désactivé/i)).toBeTruthy()
    expect(screen.getByText('c1-9x16.mp4')).toBeTruthy()
    expect(screen.getByText('c1.txt')).toBeTruthy()
  })

  it('n’annonce qu’une vidéo quand le ratio natif est déjà 9:16', () => {
    const names = outputNames('c1', '9:16')
    render(<OutputsList names={names} native="9:16" outputs={nothingIsProduced} />)
    expect(screen.getByText('c1.mp4')).toBeTruthy()
    expect(screen.queryByText('c1-9x16.mp4')).toBeNull()
  })

  it('dit qu’une variante due manque encore', () => {
    const names = outputNames('c1', '1:1')
    render(
      <OutputsList
        names={names}
        native="1:1"
        outputs={{ ...nothingIsProduced, variant9x16Due: true, variant9x16Url: null }}
      />,
    )
    expect(screen.getByText(/pas encore produite/i)).toBeTruthy()
  })

  it('ne montre pas de case vide quand la variante n’existera jamais', () => {
    const names = outputNames('c1', '9:16')
    render(
      <OutputsList
        names={names}
        native="9:16"
        outputs={{ ...nothingIsProduced, mp4Url: '/c1.mp4', variant9x16Due: false }}
      />,
    )
    expect(screen.queryByText(/pas encore produite/i)).toBeNull()
  })
})

describe('FieldCopyable', () => {
  it('désactive le champ et sa copie tant que la valeur n’est pas connue', () => {
    render(<FieldCopyable tag="Description" value="" disabled />)
    expect(screen.getByRole('button', { name: /copier description/i }).hasAttribute('disabled')).toBe(true)
    expect((screen.getByLabelText('Description de publication') as HTMLTextAreaElement).placeholder).toContain(
      'chargement',
    )
  })

  it('refuse de copier un texte vide', () => {
    render(<FieldCopyable tag="Description" value="" />)
    expect(screen.getByRole('button', { name: /copier description/i }).hasAttribute('disabled')).toBe(true)
  })
})

describe('ButtonCopy', () => {
  it('copie le texte et le dit, puis redevient « Copier » si le texte change', async () => {
    const write = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    const { rerender } = render(<ButtonCopy text="La chute" label="Copier titre" />)

    fireEvent.click(screen.getByRole('button', { name: 'Copier titre' }))
    await waitFor(() => expect(write).toHaveBeenCalledWith('La chute'))
    await screen.findByRole('button', { name: /copier titre — copié/i })

    rerender(<ButtonCopy text="Un autre titre" label="Copier titre" />)
    expect(screen.getByRole('button', { name: 'Copier titre' })).toBeTruthy()
  })
})
