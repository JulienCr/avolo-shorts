// @vitest-environment jsdom

/**
 * `useStyleWrites` isolé de `framing-fields.tsx`/`hook-fields.tsx` : la
 * fusion en cas de rollback (issue #189, revue interne). Un `PATCH` refusé
 * fait revenir `usePatchClip` sur `previousClip` — une nouvelle référence, à
 * la valeur du serveur d'avant l'écriture refusée — et c'est sur cette
 * valeur-là que la fusion locale doit reprendre, pas sur l'optimiste rejeté.
 */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useStyleWrites } from '@/components/clip/style-writes'

describe('useStyleWrites', () => {
  it('un PATCH refusé restaure la valeur serveur, dont la prochaine écriture repart', async () => {
    const writeStyle = vi.fn().mockRejectedValueOnce(new Error('refused'))
    const { result, rerender } = renderHook(
      ({ style }: { style: { a: number; b?: number; c?: number } }) => useStyleWrites(style, writeStyle),
      { initialProps: { style: { a: 1 } } },
    )

    act(() => result.current.setStyle('b', 2))
    // Laisse le `.catch` interne se poser avant le rollback simulé.
    await act(async () => {})

    // Le rollback de `usePatchClip` restaure `previousClip` : une nouvelle
    // référence, à la valeur du serveur d'avant l'écriture refusée.
    rerender({ style: { a: 1 } })

    act(() => result.current.setStyle('c', 3))
    expect(writeStyle).toHaveBeenLastCalledWith({ a: 1, c: 3 })
  })

  it('appelle onWriteFailure sur un rejet, jamais sur un succès', async () => {
    const onWriteFailure = vi.fn()
    const writeStyle = vi.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useStyleWrites({ a: 1 }, writeStyle, onWriteFailure))

    act(() => result.current.setStyle('a', 2))
    await act(async () => {})
    expect(onWriteFailure).toHaveBeenCalledTimes(1)

    act(() => result.current.setStyle('a', 3))
    await act(async () => {})
    expect(onWriteFailure).toHaveBeenCalledTimes(1)
  })

  /**
   * Le rejet d'une écriture périmée (issue #283) : sur le modèle de
   * `usePatchClip`, un jeton par écriture fait ignorer le rejet d'une
   * écriture qui n'est plus la dernière partie — sans quoi une réponse
   * tardive fermerait la modale sur un échec déjà réparé par la suivante.
   */
  it('ignore le rejet d’une écriture devenue périmée, mais pas celui de la dernière', async () => {
    const onWriteFailure = vi.fn()
    let rejectStale!: (error: Error) => void
    const stale = new Promise<void>((_resolve, reject) => {
      rejectStale = reject
    })
    const writeStyle = vi.fn().mockReturnValueOnce(stale).mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useStyleWrites({ a: 1 }, writeStyle, onWriteFailure))

    // Deux écritures parties avant que la première ne se règle : la seconde
    // aboutit, puis la première — toujours en vol — est rejetée.
    act(() => result.current.setStyle('a', 2))
    act(() => result.current.setStyle('a', 3))
    await act(async () => {})
    rejectStale(new Error('stale'))
    await act(async () => {})

    expect(onWriteFailure).not.toHaveBeenCalled()

    // Un rejet sur la dernière écriture, lui, doit toujours s'annoncer.
    const writeStyleLast = vi.fn().mockRejectedValueOnce(new Error('refused'))
    const { result: lastResult } = renderHook(() =>
      useStyleWrites({ a: 1 }, writeStyleLast, onWriteFailure),
    )
    act(() => lastResult.current.setStyle('a', 4))
    await act(async () => {})
    expect(onWriteFailure).toHaveBeenCalledTimes(1)
  })
})
