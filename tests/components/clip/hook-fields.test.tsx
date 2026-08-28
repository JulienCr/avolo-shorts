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
import { HOOK_BOUNDS, HOOK_DEFAULTS, type HookSettings } from '@/core/hook'
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
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
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
    outputs: { mp4Url: null, mp4Due: true, variant9x16Url: null, variant9x16Due: true, textsUrl: null },
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

/**
 * Ouvre le panneau replié des quatorze surcharges — fermé par défaut (voir la
 * doc de `HookFields`). Tout ce qui n'est ni le texte, ni « Hook activé », ni
 * « Régénérer » vit dedans, donc un test qui les interroge doit d'abord
 * cliquer sur « Personnaliser », comme le ferait quelqu'un devant l'écran.
 */
function openPersonalize() {
  fireEvent.click(screen.getByRole('button', { name: /Personnaliser/ }))
}

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
    openPersonalize()
    // `sizePermille` n'est pas dans `hookStyle` : hérité.
    expect(screen.getAllByText('— hérité').length).toBeGreaterThan(0)
  })

  it('un champ surchargé à la MÊME valeur que le global ne se dit plus hérité', () => {
    // Le cas central du contrat : `{ sizePermille: 90 }` sur un global à 90
    // doit rester distinguable de `{}` — sans quoi la persistance de la PR
    // précédente ne sert à rien.
    mount({ clip: clip({ hookStyle: { sizePermille: HOOK_DEFAULTS.sizePermille } }) })
    openPersonalize()
    expect(screen.queryByText('revenir à l’héritage')).toBeTruthy()
  })

  it('le bouton « Personnaliser » affiche le nombre de surcharges', () => {
    mount({ clip: clip({ hookStyle: { sizePermille: 150, position: 'bottom' } }) })
    const trigger = screen.getByRole('button', { name: /Personnaliser/ })
    expect(trigger.textContent).toContain('2')
  })

  // **`aria-expanded` est toujours posé** (Base UI, `Collapsible.Trigger`) ;
  // `aria-controls` ne l'est que le panneau ouvert — c'est
  // `'aria-controls': open ? panelId : undefined` dans
  // `useCollapsibleRoot`, indexé sur `open` et non sur le montage du
  // panneau. Une version antérieure de `ui/collapsible.tsx` posait
  // `keepMounted` en croyant que c'était lui qui manquait ; revenir dessus
  // ne change rien à ce test, ce qui a confirmé que ce n'était pas la cause
  // (relevé en review). L'absence d'`aria-controls` fermé n'est donc pas
  // vérifiée ici : ce n'est pas un défaut, c'est le choix de Base UI.
  it('« Personnaliser » annonce son état : aria-expanded toujours, aria-controls une fois ouvert', () => {
    mount()
    const trigger = screen.getByRole('button', { name: /Personnaliser/ })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const panelId = trigger.getAttribute('aria-controls')
    expect(panelId).toBeTruthy()
    // La cible existe réellement : un `aria-controls` qui pointe dans le vide
    // ne vaudrait pas mieux que son absence.
    expect(document.getElementById(panelId as string)).toBeTruthy()
  })

  it('« Réinitialiser » n’apparaît que s’il y a de quoi', () => {
    const { rerender } = mount({ clip: clip({ hookStyle: {} }) })
    openPersonalize()
    expect(screen.queryByText('Réinitialiser avec les paramètres globaux')).toBeNull()

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(
      <QueryClientProvider client={client}>
        <HookFields
          clip={clip({ hookStyle: { sizePermille: 150 } })}
          globals={HOOK_DEFAULTS}
          onWrite={vi.fn()}
        />
      </QueryClientProvider>,
    )
    openPersonalize()
    expect(screen.getByText('Réinitialiser avec les paramètres globaux')).toBeTruthy()
  })

  it('« Réinitialiser » envoie `PATCH { hookStyle: {} }`', async () => {
    vi.useRealTimers()
    const onWrite = vi.fn()
    const user = userEvent.setup({ delay: null })
    mount({ clip: clip({ hookStyle: { sizePermille: 150, position: 'bottom' } }), onWrite })
    openPersonalize()

    await user.click(screen.getByText('Réinitialiser avec les paramètres globaux'))
    expect(onWrite).toHaveBeenCalledWith({ hookStyle: {} })
  })

  it('rendre un seul champ à l’héritage ne retire que lui', async () => {
    vi.useRealTimers()
    const onWrite = vi.fn()
    const user = userEvent.setup({ delay: null })
    mount({ clip: clip({ hookStyle: { sizePermille: 150, position: 'bottom' } }), onWrite })
    openPersonalize()

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

describe('deux écritures avant que la première ne se pose (issue #189)', () => {
  it('activer le hook puis changer la taille, sans attendre entre les deux, garde les deux surcharges', () => {
    const onWrite = vi.fn()
    mount({ clip: clip({ hookStyle: {} }), onWrite })
    openPersonalize()

    fireEvent.click(screen.getByRole('checkbox', { name: /Hook activé/ }))
    const input = screen.getByLabelText('Taille')
    fireEvent.change(input, { target: { value: '150' } })
    fireEvent.blur(input)

    expect(onWrite).toHaveBeenLastCalledWith({
      hookStyle: expect.objectContaining({ enabled: expect.any(Boolean), sizePermille: 150 }),
    })
  })

  it('rendre « Hook activé » à l’héritage pendant qu’une autre surcharge n’est pas posée ne le fait pas réapparaître', () => {
    const onWrite = vi.fn()
    mount({ clip: clip({ hookStyle: { enabled: true } }), onWrite })
    openPersonalize()

    fireEvent.click(screen.getByRole('button', { name: /Hook activé.*revenir à l’héritage/ }))
    const input = screen.getByLabelText('Taille')
    fireEvent.change(input, { target: { value: '150' } })
    fireEvent.blur(input)

    const last = onWrite.mock.calls.at(-1)?.[0] as { hookStyle: Partial<HookSettings> }
    expect(last).toEqual({ hookStyle: { sizePermille: 150 } })
  })

  it('une réinitialisation complète suivie d’une nouvelle surcharge ne ressuscite pas les anciens champs', () => {
    const onWrite = vi.fn()
    mount({ clip: clip({ hookStyle: { enabled: true, sizePermille: 200 } }), onWrite })
    openPersonalize()

    fireEvent.click(screen.getByText('Réinitialiser avec les paramètres globaux'))
    const input = screen.getByLabelText('Taille')
    fireEvent.change(input, { target: { value: '150' } })
    fireEvent.blur(input)

    expect(onWrite).toHaveBeenLastCalledWith({ hookStyle: { sizePermille: 150 } })
  })
})

/**
 * **`durationMs` a rejoint le panneau replié** (PR #117, seconde manche) :
 * le PNG en `overlay` ne portait plus la borne temporelle du tout, et ce
 * réglage n'avait donc aucun contrôle dans cet écran. `DurationField`
 * reprend la conversion secondes/millisecondes de `hook-section.tsx`
 * (`src/components/settings/hook-section.tsx`), testée là pour le réglage
 * global — même comportement ici, pour la surcharge par clip.
 */
describe('Durée', () => {
  it('affiche durationMs converti en secondes', () => {
    mount({ clip: clip({ hookStyle: { durationMs: 2_500 } }) })
    openPersonalize()
    expect((screen.getByLabelText('Durée') as HTMLInputElement).value).toBe('2.5')
  })

  it('convertit les secondes saisies en millisecondes, à `hookStyle.durationMs`', async () => {
    vi.useRealTimers()
    const onWrite = vi.fn()
    const user = userEvent.setup({ delay: null })
    mount({ onWrite })
    openPersonalize()

    const field = screen.getByLabelText('Durée')
    await user.clear(field)
    await user.type(field, '3.2')
    await user.tab()

    expect(onWrite).toHaveBeenCalledWith({ hookStyle: { durationMs: 3_200 } })
  })

  it('borne la durée saisie aux limites du registre avant de l’écrire', async () => {
    vi.useRealTimers()
    const onWrite = vi.fn()
    const user = userEvent.setup({ delay: null })
    mount({ onWrite })
    openPersonalize()

    const field = screen.getByLabelText('Durée')
    await user.clear(field)
    await user.type(field, '99')
    await user.tab()

    expect(onWrite).toHaveBeenCalledWith({
      hookStyle: { durationMs: HOOK_BOUNDS.durationMs.max },
    })
  })

  it('se dit surchargé même à la MÊME valeur que le global (le cas central du contrat)', () => {
    mount({ clip: clip({ hookStyle: { durationMs: HOOK_DEFAULTS.durationMs } }) })
    openPersonalize()
    expect(screen.queryByLabelText('Durée : revenir à l’héritage')).toBeTruthy()
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

  it("reste actif sur un clip candidat — la génération manuelle s'autorise sur n'importe quel statut", () => {
    mount({ clip: clip({ status: 'candidate' }) })
    const button = screen.getByRole('button', { name: /Régénérer/ }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })
})

describe('le badge', () => {
  it('son champ est visible sans ouvrir « Personnaliser » — c’est du contenu', () => {
    mount({ clip: clip({ hookBadge: 'DÉFI 10' }) })
    expect((screen.getByLabelText('Badge') as HTMLInputElement).value).toBe('DÉFI 10')
  })

  it('temporise l’écriture, exactement comme l’accroche', () => {
    const onWrite = vi.fn()
    mount({ onWrite })

    fireEvent.change(screen.getByLabelText('Badge'), { target: { value: 'DÉFI 11' } })
    expect(onWrite).not.toHaveBeenCalled()

    act(() => void vi.advanceTimersByTime(600))
    expect(onWrite).toHaveBeenCalledWith({ hookBadge: 'DÉFI 11' })
  })

  it('a son propre échec, indépendant de celui de l’accroche', async () => {
    vi.useRealTimers()
    const onWrite = vi.fn().mockRejectedValue(new Error('boom'))
    mount({ onWrite })

    fireEvent.change(screen.getByLabelText('Badge'), { target: { value: 'DÉFI 11' } })
    fireEvent.blur(screen.getByLabelText('Badge'))

    await waitFor(() => expect(screen.getByText(/badge n’a pas été enregistré/i)).toBeTruthy())
  })

  /**
   * `hookIsBurned` (`@/core/hook`) n'incruste rien sans accroche. Sans cette
   * phrase, quelqu'un qui saisit un badge et ne voit rien apparaître ne peut
   * que conclure que le champ est cassé — c'est le silence qui serait le
   * défaut, pas le comportement.
   */
  it('prévient quand un badge est saisi sur une accroche vide', () => {
    mount({ clip: clip({ hookText: '', hookBadge: 'DÉFI 10' }) })
    expect(screen.getByText(/le badge n’est pas incrusté/i)).toBeTruthy()
  })

  it('ne prévient pas quand l’accroche est là', () => {
    mount({ clip: clip({ hookText: 'Une accroche', hookBadge: 'DÉFI 10' }) })
    expect(screen.queryByText(/le badge n’est pas incrusté/i)).toBeNull()
  })

  it('ses deux couleurs se surchargent depuis le panneau replié', () => {
    const onWrite = vi.fn()
    mount({ onWrite })
    openPersonalize()

    expect(screen.getByLabelText('Badge — texte')).toBeTruthy()
    const background = screen.getByLabelText('Badge — fond')
    fireEvent.change(background, { target: { value: '#00FF00' } })
    fireEvent.blur(background)

    expect(onWrite).toHaveBeenCalledWith({ hookStyle: { badgeBackground: '#00FF00' } })
  })

  /**
   * **Le compteur suit `COLLAPSIBLE_FIELDS`, qui est désormais un `Record`.**
   * Un réglage ajouté à `HookSettings` et oublié dans cette liste ne compile
   * plus ; ce test vérifie l'autre moitié — que la liste est bien celle que le
   * panneau affiche.
   */
  it('les deux couleurs du badge comptent dans les surcharges annoncées', () => {
    mount({
      clip: clip({ hookStyle: { badgeColor: '#000000', badgeBackground: '#00FF00' } }),
    })
    expect(screen.getByRole('button', { name: /Personnaliser/ }).textContent).toContain('2')
  })
})
