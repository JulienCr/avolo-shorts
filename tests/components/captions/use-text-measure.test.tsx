// @vitest-environment jsdom

/**
 * `useFontReady` sonde `document.fonts`, absent sous jsdom : `fontIsReady`
 * y rend vrai par construction et ne passe jamais par `check()` réel — donc
 * jamais par le piège qui a masqué tous les calques en passe 4. Ce fichier
 * pose un faux `document.fonts` conforme à la spec (`check()` ne rend vrai
 * que si TOUTES les familles listées sont chargées) pour l'exercer.
 */

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useFontReady } from '@/components/captions/use-text-measure'

/** `"16px 'hookFont', 'hookFont Fallback'"` → `["hookFont", "hookFont Fallback"]`. */
function parseFamilies(font: string): string[] {
  return font
    .replace(/^\S+\s+/, '')
    .split(',')
    .map((f) => f.trim().replace(/^['"]|['"]$/g, ''))
}

/** Une `FontFaceSet` minimale, conforme sur le seul point qui compte ici. */
function fakeFontFaceSet(loaded: Set<string>) {
  return {
    status: 'loaded',
    check: (font: string) => parseFamilies(font).every((f) => loaded.has(f)),
    load: () => Promise.resolve([]),
  } as unknown as FontFaceSet
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(document, 'fonts')
})

describe('useFontReady', () => {
  it("rend prêt même quand le repli next/font/local ('hookFont Fallback') ne charge jamais", async () => {
    // Le repli synthétique n'est utilisé nulle part : il ne devient jamais
    // 'loaded'. `document.fonts.check()` sur la liste ENTIÈRE rendrait donc
    // faux pour toujours si `useFontReady` la sondait telle quelle.
    Object.defineProperty(document, 'fonts', {
      value: fakeFontFaceSet(new Set(['hookFont'])),
      configurable: true,
    })

    const { result } = renderHook(() => useFontReady("'hookFont', 'hookFont Fallback'"))

    await waitFor(() => expect(result.current).toBe(true))
  })

  it("reste faux si la première famille elle-même n'est jamais chargée", async () => {
    Object.defineProperty(document, 'fonts', {
      value: fakeFontFaceSet(new Set()),
      configurable: true,
    })

    const { result } = renderHook(() => useFontReady("'hookFont', 'hookFont Fallback'"))

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.current).toBe(false)
  })
})
