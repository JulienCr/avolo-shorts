// @vitest-environment jsdom

/**
 * `usePlanningUrlParam` : poser ou retirer un paramètre **sans effacer les
 * autres**. C'est la raison d'être du module — l'onglet et l'aperçu
 * s'écrasaient l'un l'autre quand chacun refaisait la manœuvre de son côté —
 * et rien ne l'exerçait, donc une régression serait passée verte.
 */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const replaceMock = vi.fn()
let query = ''
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(query),
}))

const { usePlanningUrlParam } = await import('@/components/planning/url-state')

afterEach(() => {
  cleanup()
  replaceMock.mockClear()
  query = ''
})

describe('usePlanningUrlParam', () => {
  it('lit la valeur du paramètre nommé, `null` en son absence', () => {
    query = 'view=published'
    const { result } = renderHook(() => usePlanningUrlParam('view'))
    expect(result.current[0]).toBe('published')

    const absent = renderHook(() => usePlanningUrlParam('preview'))
    expect(absent.result.current[0]).toBeNull()
  })

  it('pose un paramètre sans effacer l’autre', () => {
    query = 'preview=c1'
    const { result } = renderHook(() => usePlanningUrlParam('view'))

    act(() => result.current[1]('errors'))

    expect(replaceMock).toHaveBeenCalledWith('/planning?preview=c1&view=errors', { scroll: false })
  })

  it('retire un paramètre sans effacer l’autre', () => {
    query = 'preview=c1&view=errors'
    const { result } = renderHook(() => usePlanningUrlParam('preview'))

    act(() => result.current[1](null))

    expect(replaceMock).toHaveBeenCalledWith('/planning?view=errors', { scroll: false })
  })

  it('retirer le dernier paramètre laisse une URL nue, sans `?` pendant', () => {
    query = 'preview=c1'
    const { result } = renderHook(() => usePlanningUrlParam('preview'))

    act(() => result.current[1](null))

    expect(replaceMock).toHaveBeenCalledWith('/planning', { scroll: false })
  })
})
