// @vitest-environment jsdom

/**
 * Le titre et la description.
 *
 * **Ce sont des livrables du produit, au même titre que le MP4** (spec §3) : ce
 * qui se colle dans Instagram sort de là. Ils s'affichaient en lecture seule.
 *
 * Ce que ces tests fixent, c'est le protocole d'écriture : une frappe n'est pas
 * une écriture, une écriture ne se perd pas quand on quitte, et la valeur du
 * serveur ne vient jamais écraser une frappe en cours.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Clip } from '@/core/edl'
import type { ClipPatch } from '@/lib/api'
import { ChampsTextes } from '@/components/clip/champs-textes'

function clip(champs: Partial<Clip> = {}): Clip {
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
    ...champs,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ChampsTextes', () => {
  it('montre ce que le clip porte', () => {
    render(<ChampsTextes clip={clip()} onEcrire={vi.fn()} />)
    expect((screen.getByLabelText('Titre') as HTMLInputElement).value).toBe('La chute')
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Une impro')
  })

  it('laisse le geste se poser avant d’écrire', () => {
    // Une écriture par frappe, ce sont quarante requêtes pour un titre, et
    // autant d'occasions de se croiser.
    const onEcrire = vi.fn()
    render(<ChampsTextes clip={clip()} onEcrire={onEcrire} />)

    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'La chut' } })
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'La chute finale' } })
    expect(onEcrire).not.toHaveBeenCalled()

    act(() => void vi.advanceTimersByTime(600))
    expect(onEcrire).toHaveBeenCalledTimes(1)
    expect(onEcrire.mock.calls[0][0]).toEqual({ title: 'La chute finale' })
  })

  it('n’écrit que le champ qui a changé', () => {
    // Le serveur ordonne les écritures champ par champ : renvoyer un champ
    // inchangé le ferait écarter en son nom, ou écraser un geste plus récent.
    const onEcrire = vi.fn()
    render(<ChampsTextes clip={clip()} onEcrire={onEcrire} />)

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Autre chose' } })
    act(() => void vi.advanceTimersByTime(600))
    expect(onEcrire.mock.calls[0][0]).toEqual({ description: 'Autre chose' })
  })

  it('écrit tout de suite quand le champ perd le focus', () => {
    const onEcrire = vi.fn()
    render(<ChampsTextes clip={clip()} onEcrire={onEcrire} />)

    const titre = screen.getByLabelText('Titre')
    fireEvent.change(titre, { target: { value: 'Un autre titre' } })
    fireEvent.blur(titre)
    expect(onEcrire.mock.calls[0][0]).toEqual({ title: 'Un autre titre' })
  })

  it('n’écrit rien quand la valeur revient à celle du serveur', () => {
    const onEcrire = vi.fn()
    render(<ChampsTextes clip={clip()} onEcrire={onEcrire} />)

    const titre = screen.getByLabelText('Titre')
    fireEvent.change(titre, { target: { value: 'La chut' } })
    fireEvent.change(titre, { target: { value: 'La chute' } })
    act(() => void vi.advanceTimersByTime(600))
    expect(onEcrire).not.toHaveBeenCalled()
  })

  it('vide son écriture au démontage', () => {
    // On quitte l'écran de clip plus souvent qu'on ne le ferme : la dernière
    // frappe ne doit pas rester dans une temporisation qui n'arrivera jamais.
    const onEcrire = vi.fn()
    const { unmount } = render(<ChampsTextes clip={clip()} onEcrire={onEcrire} />)

    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Presque' } })
    unmount()
    expect(onEcrire.mock.calls[0][0]).toEqual({ title: 'Presque' })
  })

  it('garde la frappe quand l’écriture échoue', () => {
    // `usePatchClip` remet l'ancienne version en cache quand le `PATCH` échoue.
    // Si la valeur locale était déjà tenue pour synchronisée, l'adoption la
    // remplace par celle d'avant : le texte est perdu **en silence**, et la
    // barre affiche « enregistré » puisqu'elle ne suit que le montage.
    // (relevé par Codex)
    const onEcrire = vi.fn(
      (_champs: ClipPatch, suites?: { onSuccess?: () => void; onError?: () => void }) =>
        suites?.onError?.(),
    )
    const { rerender } = render(<ChampsTextes clip={clip()} onEcrire={onEcrire} />)

    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Le vrai titre' } })
    act(() => void vi.advanceTimersByTime(600))
    // Le rollback du cache : le clip repasse à la version du serveur.
    rerender(<ChampsTextes clip={clip()} onEcrire={onEcrire} />)

    expect((screen.getByLabelText('Titre') as HTMLInputElement).value).toBe('Le vrai titre')
    expect(screen.getByText(/n’a pas été enregistré/i)).toBeTruthy()
  })

  it('renvoie la frappe restée en plan quand on le lui demande', () => {
    const onEcrire = vi.fn(
      (_champs: ClipPatch, suites?: { onSuccess?: () => void; onError?: () => void }) =>
        suites?.onError?.(),
    )
    render(<ChampsTextes clip={clip()} onEcrire={onEcrire} />)

    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Le vrai titre' } })
    act(() => void vi.advanceTimersByTime(600))
    expect(onEcrire).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /réessayer/i }))
    expect(onEcrire).toHaveBeenCalledTimes(2)
    expect(onEcrire.mock.calls[1][0]).toEqual({ title: 'Le vrai titre' })
  })

  it('n’adopte rien tant que son écriture est en vol', () => {
    // L'écriture optimiste fait passer le clip par la valeur qu'on vient
    // d'envoyer : avancer la référence dessus rendrait le rollback
    // indiscernable d'une écriture venue d'ailleurs.
    const onEcrire = vi.fn(() => {})
    const { rerender } = render(<ChampsTextes clip={clip()} onEcrire={onEcrire} />)

    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Le vrai titre' } })
    act(() => void vi.advanceTimersByTime(600))
    rerender(<ChampsTextes clip={clip({ title: 'Le vrai titre' })} onEcrire={onEcrire} />)
    rerender(<ChampsTextes clip={clip()} onEcrire={onEcrire} />)

    expect((screen.getByLabelText('Titre') as HTMLInputElement).value).toBe('Le vrai titre')
  })

  it('adopte la valeur du serveur quand rien n’est en attente', () => {
    // Une écriture venue d'ailleurs — un autre onglet, une réconciliation —
    // revient par le clip. Rien de local ne s'y oppose.
    const { rerender } = render(<ChampsTextes clip={clip()} onEcrire={vi.fn()} />)
    rerender(<ChampsTextes clip={clip({ title: 'Le titre du serveur' })} onEcrire={vi.fn()} />)
    expect((screen.getByLabelText('Titre') as HTMLInputElement).value).toBe('Le titre du serveur')
  })

  it('ne perd pas la frappe en cours quand le serveur en dit autre chose', () => {
    // La frappe est **postérieure** : personne ne l'a refusée, et l'écraser
    // serait perdre un geste au milieu d'un mot.
    const { rerender } = render(<ChampsTextes clip={clip()} onEcrire={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'En train d’écrire' } })
    rerender(<ChampsTextes clip={clip({ title: 'Le titre du serveur' })} onEcrire={vi.fn()} />)
    expect((screen.getByLabelText('Titre') as HTMLInputElement).value).toBe('En train d’écrire')
  })
})
