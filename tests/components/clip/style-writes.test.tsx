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
})
