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
import { FieldsTexts } from '@/components/clip/text-fields'

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
    ...fields,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ChampsTextes', () => {
  it('montre ce que le clip porte', () => {
    render(<FieldsTexts clip={clip()} onWrite={vi.fn()} />)
    expect((screen.getByLabelText('Titre') as HTMLInputElement).value).toBe('La chute')
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Une impro')
  })

  it('laisse le geste se poser avant d’écrire', () => {
    // Une écriture par frappe, ce sont quarante requêtes pour un titre, et
    // autant d'occasions de se croiser.
    const onWrite = vi.fn()
    render(<FieldsTexts clip={clip()} onWrite={onWrite} />)

    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'La chut' } })
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'La chute finale' } })
    expect(onWrite).not.toHaveBeenCalled()

    act(() => void vi.advanceTimersByTime(600))
    expect(onWrite).toHaveBeenCalledTimes(1)
    expect(onWrite.mock.calls[0][0]).toEqual({ title: 'La chute finale' })
  })

  it('n’écrit que le champ qui a changé', () => {
    // Le serveur ordonne les écritures champ par champ : renvoyer un champ
    // inchangé le ferait écarter en son nom, ou écraser un geste plus récent.
    const onWrite = vi.fn()
    render(<FieldsTexts clip={clip()} onWrite={onWrite} />)

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Autre chose' } })
    act(() => void vi.advanceTimersByTime(600))
    expect(onWrite.mock.calls[0][0]).toEqual({ description: 'Autre chose' })
  })

  it('écrit tout de suite quand le champ perd le focus', () => {
    const onWrite = vi.fn()
    render(<FieldsTexts clip={clip()} onWrite={onWrite} />)

    const title = screen.getByLabelText('Titre')
    fireEvent.change(title, { target: { value: 'Un autre titre' } })
    fireEvent.blur(title)
    expect(onWrite.mock.calls[0][0]).toEqual({ title: 'Un autre titre' })
  })

  it('n’écrit rien quand la valeur revient à celle du serveur', () => {
    const onWrite = vi.fn()
    render(<FieldsTexts clip={clip()} onWrite={onWrite} />)

    const title = screen.getByLabelText('Titre')
    fireEvent.change(title, { target: { value: 'La chut' } })
    fireEvent.change(title, { target: { value: 'La chute' } })
    act(() => void vi.advanceTimersByTime(600))
    expect(onWrite).not.toHaveBeenCalled()
  })

  it('vide son écriture au démontage', () => {
    // On quitte l'écran de clip plus souvent qu'on ne le ferme : la dernière
    // frappe ne doit pas rester dans une temporisation qui n'arrivera jamais.
    const onWrite = vi.fn()
    const { unmount } = render(<FieldsTexts clip={clip()} onWrite={onWrite} />)

    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Presque' } })
    unmount()
    expect(onWrite.mock.calls[0][0]).toEqual({ title: 'Presque' })
  })

  it('garde la frappe quand l’écriture échoue', async () => {
    // `usePatchClip` remet l'ancienne version en cache quand le `PATCH` échoue.
    // Si la valeur locale était déjà tenue pour synchronisée, l'adoption la
    // remplace par celle d'avant : le texte est perdu **en silence**, et la
    // barre affiche « enregistré » puisqu'elle ne suit que le montage.
    // (relevé par Codex)
    const onWrite = vi.fn(async (fields: ClipPatch) => {
      void fields
      throw new Error('réseau coupé')
    })
    const { rerender } = render(<FieldsTexts clip={clip()} onWrite={onWrite} />)

    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Le vrai titre' } })
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    // Le rollback du cache : le clip repasse à la version du serveur.
    rerender(<FieldsTexts clip={clip()} onWrite={onWrite} />)

    expect((screen.getByLabelText('Titre') as HTMLInputElement).value).toBe('Le vrai titre')
    expect(screen.getByText(/n’a pas été enregistré/i)).toBeTruthy()
  })

  it('renvoie la frappe restée en plan quand on le lui demande', async () => {
    const onWrite = vi.fn(async (fields: ClipPatch) => {
      void fields
      throw new Error('réseau coupé')
    })
    render(<FieldsTexts clip={clip()} onWrite={onWrite} />)

    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Le vrai titre' } })
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(onWrite).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /réessayer/i }))
    expect(onWrite).toHaveBeenCalledTimes(2)
    expect(onWrite.mock.calls[1][0]).toEqual({ title: 'Le vrai titre' })
  })

  it('n’adopte rien tant que son écriture est en vol', () => {
    // L'écriture optimiste fait passer le clip par la valeur qu'on vient
    // d'envoyer : avancer la référence dessus rendrait le rollback
    // indiscernable d'une écriture venue d'ailleurs.
    const onWrite = vi.fn(() => new Promise<void>(() => {}))
    const { rerender } = render(<FieldsTexts clip={clip()} onWrite={onWrite} />)

    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Le vrai titre' } })
    act(() => void vi.advanceTimersByTime(600))
    rerender(<FieldsTexts clip={clip({ title: 'Le vrai titre' })} onWrite={onWrite} />)
    rerender(<FieldsTexts clip={clip()} onWrite={onWrite} />)

    expect((screen.getByLabelText('Titre') as HTMLInputElement).value).toBe('Le vrai titre')
  })

  it('ne reste pas bloqué quand une autre écriture prend l’observateur', async () => {
    // Les rappels passés à `mutate` sont attachés à **la dernière** mutation de
    // l'observateur : une écriture de marques partie entre-temps efface ceux du
    // titre, qui ne se règle alors jamais — le champ reste « en vol » à jamais
    // et refuse toute écriture suivante. La promesse, elle, appartient à la
    // mutation. (relevé par Copilot)
    const onWrite = vi.fn(async (fields: ClipPatch) => {
      void fields
    })
    render(<FieldsTexts clip={clip()} onWrite={onWrite} />)

    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Un' } })
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Deux' } })
    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    expect(onWrite).toHaveBeenCalledTimes(2)
    expect(onWrite.mock.calls[1][0]).toEqual({ title: 'Deux' })
  })

  it('adopte la valeur du serveur quand rien n’est en attente', () => {
    // Une écriture venue d'ailleurs — un autre onglet, une réconciliation —
    // revient par le clip. Rien de local ne s'y oppose.
    const { rerender } = render(<FieldsTexts clip={clip()} onWrite={vi.fn()} />)
    rerender(<FieldsTexts clip={clip({ title: 'Le titre du serveur' })} onWrite={vi.fn()} />)
    expect((screen.getByLabelText('Titre') as HTMLInputElement).value).toBe('Le titre du serveur')
  })

  it('ne perd pas la frappe en cours quand le serveur en dit autre chose', () => {
    // La frappe est **postérieure** : personne ne l'a refusée, et l'écraser
    // serait perdre un geste au milieu d'un mot.
    const { rerender } = render(<FieldsTexts clip={clip()} onWrite={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'En train d’écrire' } })
    rerender(<FieldsTexts clip={clip({ title: 'Le titre du serveur' })} onWrite={vi.fn()} />)
    expect((screen.getByLabelText('Titre') as HTMLInputElement).value).toBe('En train d’écrire')
  })
})
