// @vitest-environment jsdom

/**
 * Les champs du hook en zone Contenu.
 *
 * Ce que ces tests fixent : le texte suit exactement le protocole de
 * `useTextDeferred` (temporisation, échec par champ), chaque contrôle de
 * style dit s'il est hérité ou surchargé — **même à valeur égale** — et
 * « Réinitialiser » n'apparaît que s'il y a de quoi.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Clip, ClipDetail } from '@/lib/api'
import { HOOK_DEFAULTS, type HookSettings } from '@/core/hook'
import { HookFields } from '@/components/clip/hook-fields'
import { keys } from '@/lib/queries'
import { installPointerEventPolyfill } from '../../fixtures/pointer-event'

installPointerEventPolyfill()

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
    hookText: 'Ça part en vrille',
    hookStyle: {},
    ...fields,
  }
}

/**
 * Le strict nécessaire pour préseeder `keys.clip(id)` : c'est ce cache que
 * `useRegenerateHook` écrit en `onSuccess`, et qu'un test doit préseeder pour
 * exercer le mécanisme plutôt que de se contenter de l'appel réseau.
 */
function clipDetail(c: Clip): ClipDetail {
  return {
    clip: c,
    project: { id: c.projectId, title: 'La scène du 15 juin', durationSec: 5940, createdAt: '2026-06-15T10:00:00Z' },
    lines: [],
    proxyUrl: null,
    outputs: { mp4Url: null, variant9x16Url: null, variant9x16Due: true, textsUrl: null },
    framing: { ratio: '1:1', shots: [], rejectedOverrides: [], origin: 'computed' },
  }
}

function mount(
  props: Partial<Parameters<typeof HookFields>[0]> = {},
  /**
   * Préseeder `keys.clip(id)` avant le montage : c'est le cache que
   * `useRegenerateHook` écrit en `onSuccess`, et un test qui veut l'exercer
   * — pas seulement l'appel réseau — doit lui donner une entrée à écraser.
   */
  seedCache = false,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const merged = {
    clip: clip(),
    globals: HOOK_DEFAULTS,
    canRegenerate: true,
    onWrite: vi.fn(),
    ...props,
  }
  if (seedCache) client.setQueryData(keys.clip(merged.clip.id), clipDetail(merged.clip))
  const envelope = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, ...render(<HookFields {...merged} />, { wrapper: envelope }) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('le texte du hook', () => {
  it('montre ce que le clip porte', () => {
    mount({ clip: clip({ hookText: 'Regarde ça' }) })
    expect((screen.getByLabelText('Hook') as HTMLInputElement).value).toBe('Regarde ça')
  })

  it('temporise l’écriture, comme le titre et la description', () => {
    const onWrite = vi.fn()
    mount({ onWrite })

    fireEvent.change(screen.getByLabelText('Hook'), { target: { value: 'Un nouveau texte' } })
    expect(onWrite).not.toHaveBeenCalled()

    act(() => void vi.advanceTimersByTime(600))
    expect(onWrite).toHaveBeenCalledWith({ hookText: 'Un nouveau texte' })
  })

  it('affiche un échec par champ et propose de réessayer', async () => {
    vi.useRealTimers()
    const onWrite = vi.fn().mockRejectedValue(new Error('boom'))
    mount({ onWrite })

    fireEvent.change(screen.getByLabelText('Hook'), { target: { value: 'Texte refusé' } })
    fireEvent.blur(screen.getByLabelText('Hook'))

    await waitFor(() => expect(screen.getByText(/n’a pas été enregistré/)).toBeTruthy())
  })
})

describe('hérité vs surchargé', () => {
  it('un champ non surchargé se dit hérité', () => {
    mount({ clip: clip({ hookStyle: {} }) })
    // `size` n'est pas dans `hookStyle` : hérité.
    expect(screen.getAllByText('— hérité').length).toBeGreaterThan(0)
  })

  it('un champ surchargé à la MÊME valeur que le global ne se dit plus hérité', () => {
    // Le cas central du contrat : `{ size: 56 }` sur un global à 56 doit rester
    // distinguable de `{}` — sans quoi la persistance de la PR précédente ne
    // sert à rien.
    mount({ clip: clip({ hookStyle: { size: HOOK_DEFAULTS.size } }) })
    expect(screen.queryByText('revenir à l’héritage')).toBeTruthy()
  })

  it('« Réinitialiser » n’apparaît que s’il y a de quoi', () => {
    const { rerender } = mount({ clip: clip({ hookStyle: {} }) })
    expect(screen.queryByText('Réinitialiser avec les paramètres globaux')).toBeNull()

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(
      <QueryClientProvider client={client}>
        <HookFields
          clip={clip({ hookStyle: { size: 80 } })}
          globals={HOOK_DEFAULTS}
          canRegenerate
          onWrite={vi.fn()}
        />
      </QueryClientProvider>,
    )
    expect(screen.getByText('Réinitialiser avec les paramètres globaux')).toBeTruthy()
  })

  it('« Réinitialiser » envoie `PATCH { hookStyle: {} }`', async () => {
    vi.useRealTimers()
    const onWrite = vi.fn()
    const user = userEvent.setup({ delay: null })
    mount({ clip: clip({ hookStyle: { size: 80, position: 'bottom' } }), onWrite })

    await user.click(screen.getByText('Réinitialiser avec les paramètres globaux'))
    expect(onWrite).toHaveBeenCalledWith({ hookStyle: {} })
  })

  it('rendre un seul champ à l’héritage ne retire que lui', async () => {
    vi.useRealTimers()
    const onWrite = vi.fn()
    const user = userEvent.setup({ delay: null })
    mount({ clip: clip({ hookStyle: { size: 80, position: 'bottom' } }), onWrite })

    const [resetButton] = screen.getAllByText('revenir à l’héritage')
    await user.click(resetButton)
    const call = onWrite.mock.calls[0][0] as { hookStyle: Partial<HookSettings> }
    expect(Object.keys(call.hookStyle)).toHaveLength(1)
  })

  it('la case « Hook activé » écrit `hookStyle.enabled` directement, au clic', async () => {
    vi.useRealTimers()
    const onWrite = vi.fn()
    const user = userEvent.setup({ delay: null })
    mount({ onWrite })

    await user.click(screen.getByRole('checkbox', { name: /Hook activé/ }))
    expect(onWrite).toHaveBeenCalledWith({ hookStyle: { enabled: false } })
  })
})

describe('Régénérer', () => {
  it('produit un texte et le pose dans le cache de `useClip` — pas seulement l’appel réseau', async () => {
    vi.useRealTimers()
    const regenerated = clip({ hookText: 'Un texte régénéré' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ clip: regenerated }),
      })),
    )
    const user = userEvent.setup({ delay: null })
    // **Préseedé** : sans entrée existante pour `keys.clip('c1')`, le
    // `setQueryData` de `onSuccess` est un no-op silencieux, et le test
    // passerait sans jamais avoir exercé le mécanisme qu'il annonce.
    const { client } = mount({}, true)

    await user.click(screen.getByRole('button', { name: /Régénérer/ }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const [url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/clips/c1/hook')
    expect(options.method).toBe('POST')

    await waitFor(() =>
      expect(client.getQueryData<ClipDetail>(keys.clip('c1'))?.clip.hookText).toBe(
        'Un texte régénéré',
      ),
    )
  })

  it('affiche une erreur lisible, pas un `console.error` muet', async () => {
    vi.useRealTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: 'Le fournisseur ne répond pas.' }),
      })),
    )
    const user = userEvent.setup({ delay: null })
    mount()

    await user.click(screen.getByRole('button', { name: /Régénérer/ }))
    await waitFor(() => expect(screen.getByText('Le fournisseur ne répond pas.')).toBeTruthy())
  })

  it("se désactive pour un clip que le serveur refuserait (candidat, écarté)", () => {
    mount({ canRegenerate: false })
    const button = screen.getByRole('button', { name: /Régénérer/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })
})
