// @vitest-environment jsdom

/**
 * Les deux gestes qui relancent le serveur, et ce qu'ils disent avant.
 *
 * La reprise ferme la seule impasse réelle de l'interface. La relance forcée,
 * elle, est destructrice : elle remplace les propositions en attente, et une
 * confirmation qui ne dit pas ce qui va disparaître ne fait que retarder le clic.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RESUME_TARGETS } from '@/lib/api'
import { ButtonRetry, ButtonResume, StopButton } from '@/components/review/retry'

function response(body: unknown, status = 202): Response {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body } as Response
}

function envelope({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function bodySent(call: ReturnType<typeof vi.fn>): unknown {
  const [, options] = call.mock.calls[0] as unknown as [string, RequestInit]
  return JSON.parse(String(options.body))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('StopButton', () => {
  it('demande l’arrêt au serveur, sans confirmation', async () => {
    // L'arrêt ne détruit aucun artefact ni aucune décision humaine : il rend du
    // temps de calcul, et le geste inverse est à un clic. Une boîte de dialogue
    // ne protégerait rien et retarderait le seul geste que quelqu'un qui vient
    // de lancer la mauvaise émission veut faire vite.
    const call = vi.fn(async () => response({ stopped: true }, 200))
    vi.stubGlobal('fetch', call)
    render(<StopButton projectId="p1" />, { wrapper: envelope })

    await userEvent.setup().click(screen.getByRole('button', { name: /arrêter/i }))

    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const [url] = call.mock.calls[0] as unknown as [string]
    expect(url).toBe('/api/projects/p1/stop')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('dit « arrêter » et jamais « pause »', async () => {
    // Rien ne reprend un processus exactement là où il s'est interrompu : ffmpeg
    // est tué, WhisperX aussi, et ce qui repart repart du début de son étape.
    vi.stubGlobal('fetch', vi.fn(async () => response({ stopped: true }, 200)))
    render(<StopButton projectId="p1" />, { wrapper: envelope })

    expect(document.body.textContent).not.toMatch(/pause|suspendre/i)
  })

  it('ne présente pas « rien ne tournait » comme un échec', async () => {
    // `stopped: false` est un succès : l'analyse venait de finir, ou un
    // redémarrage du serveur a emporté l'exécution. Le dire comme un échec
    // ferait chercher un défaut là où il n'y a qu'une course perdue.
    vi.stubGlobal('fetch', vi.fn(async () => response({ stopped: false }, 200)))
    render(<StopButton projectId="p1" />, { wrapper: envelope })

    await userEvent.setup().click(screen.getByRole('button', { name: /arrêter/i }))

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('dit l’échec quand la demande elle-même ne part pas', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'Le serveur ne répond pas.' }, 500)),
    )
    render(<StopButton projectId="p1" />, { wrapper: envelope })

    await userEvent.setup().click(screen.getByRole('button', { name: /arrêter/i }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/n’est pas parti/))
  })
})

describe('ButtonResume', () => {
  it('vise les mêmes cibles que la création', async () => {
    // **Recopier la liste à la main est la maladie que l'issue #39 vient de
    // fermer.** Une cible nomme un résultat à atteindre : viser `candidates`
    // seul ne construit jamais le proxy, et laisserait le projet dans l'impasse
    // dont on voulait le sortir.
    const call = vi.fn(async () => response({ projectId: 'p1', plan: ['candidates'] }))
    vi.stubGlobal('fetch', call)
    render(<ButtonResume projectId="p1" inCurrent={false} />, { wrapper: envelope })

    await userEvent.setup().click(screen.getByRole('button', { name: /reprendre/i }))

    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(bodySent(call)).toEqual({ target: [...RESUME_TARGETS] })
  })

  it('reste atteignable au clavier quand une exécution tourne, avec sa raison à côté', async () => {
    // `disabled` sort du parcours de tabulation : l'utilisateur au clavier ne
    // découvrirait ni le bouton ni sa raison.
    const call = vi.fn(async () => response({ projectId: 'p1', plan: [] }))
    vi.stubGlobal('fetch', call)
    render(<ButtonResume projectId="p1" inCurrent />, { wrapper: envelope })

    const button = screen.getByRole('button', { name: /reprendre/i })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('reason-retry').textContent).toMatch(/en cours/i)

    await userEvent.setup().click(button)
    expect(call).not.toHaveBeenCalled()
  })

  it('dit qu’une exécution a démarré entre-temps plutôt que « échec »', async () => {
    // `launch` lève `ExecutionInCurrentError`, et la route en fait un 409. C'est
    // une course perdue, pas une panne.
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'déjà en cours' }, 409)))
    render(<ButtonResume projectId="p1" inCurrent={false} />, { wrapper: envelope })

    await userEvent.setup().click(screen.getByRole('button', { name: /reprendre/i }))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/exécution.*(tourne|cours)/i),
    )
  })
})

describe('ButtonRetry', () => {
  function mount(count: { guards: number; discarded: number; aSort: number }, inCurrent = false) {
    return render(<ButtonRetry projectId="p1" count={count} inCurrent={inCurrent} />, {
      wrapper: envelope,
    })
  }

  it('n’envoie rien avant la confirmation', async () => {
    const call = vi.fn(async () => response({ projectId: 'p1', plan: ['candidates'] }))
    vi.stubGlobal('fetch', call)
    mount({ guards: 4, discarded: 7, aSort: 19 })

    await userEvent.setup().click(screen.getByRole('button', { name: /relancer/i }))

    expect(call).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('énonce exactement le partage', async () => {
    // « vos 4 clips gardés sont conservés, les 19 propositions en attente sont
    // remplacées » — sans quoi la confirmation ne fait que retarder le clic.
    mount({ guards: 4, discarded: 7, aSort: 19 })
    await userEvent.setup().click(screen.getByRole('button', { name: /relancer/i }))

    const text = screen.getByRole('dialog').textContent ?? ''
    expect(text).toContain('4 clips gardés')
    expect(text).toContain('7 écartés')
    expect(text).toContain('19 propositions en attente')
  })

  it('accorde le singulier et le vide', async () => {
    mount({ guards: 1, discarded: 0, aSort: 1 })
    await userEvent.setup().click(screen.getByRole('button', { name: /relancer/i }))

    const text = screen.getByRole('dialog').textContent ?? ''
    expect(text).toContain('1 clip gardé')
    expect(text).toContain('0 écarté')
    expect(text).toContain('1 proposition en attente')
  })

  it('force le repérage une fois confirmé', async () => {
    const call = vi.fn(async () => response({ projectId: 'p1', plan: ['candidates'] }))
    vi.stubGlobal('fetch', call)
    mount({ guards: 4, discarded: 7, aSort: 19 })
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /relancer/i }))
    await user.click(screen.getByRole('button', { name: /^relancer le repérage$/i }))

    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(bodySent(call)).toEqual({ target: 'candidates', force: true })
  })

  it('ne s’ouvre pas tant qu’une exécution tourne', async () => {
    mount({ guards: 4, discarded: 7, aSort: 19 }, true)

    const button = screen.getByRole('button', { name: /relancer/i })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    await userEvent.setup().click(button)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
