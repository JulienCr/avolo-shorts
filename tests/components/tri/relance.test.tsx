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

import { CIBLES_DE_REPRISE } from '@/lib/api'
import { BoutonRelance, BoutonReprise } from '@/components/tri/relance'

function reponse(corps: unknown, status = 202): Response {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => corps } as Response
}

function enveloppe({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function corpsEnvoyé(appel: ReturnType<typeof vi.fn>): unknown {
  const [, options] = appel.mock.calls[0] as unknown as [string, RequestInit]
  return JSON.parse(String(options.body))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('BoutonReprise', () => {
  it('vise les mêmes cibles que la création', async () => {
    // **Recopier la liste à la main est la maladie que l'issue #39 vient de
    // fermer.** Une cible nomme un résultat à atteindre : viser `candidates`
    // seul ne construit jamais le proxy, et laisserait le projet dans l'impasse
    // dont on voulait le sortir.
    const appel = vi.fn(async () => reponse({ projectId: 'p1', plan: ['candidates'] }))
    vi.stubGlobal('fetch', appel)
    render(<BoutonReprise projectId="p1" enCours={false} />, { wrapper: enveloppe })

    await userEvent.setup().click(screen.getByRole('button', { name: /reprendre/i }))

    await waitFor(() => expect(appel).toHaveBeenCalledTimes(1))
    expect(corpsEnvoyé(appel)).toEqual({ target: [...CIBLES_DE_REPRISE] })
  })

  it('reste atteignable au clavier quand une exécution tourne, avec sa raison à côté', async () => {
    // `disabled` sort du parcours de tabulation : l'utilisateur au clavier ne
    // découvrirait ni le bouton ni sa raison.
    const appel = vi.fn(async () => reponse({ projectId: 'p1', plan: [] }))
    vi.stubGlobal('fetch', appel)
    render(<BoutonReprise projectId="p1" enCours />, { wrapper: enveloppe })

    const bouton = screen.getByRole('button', { name: /reprendre/i })
    expect(bouton.getAttribute('aria-disabled')).toBe('true')
    expect(bouton.hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('raison-relance').textContent).toMatch(/en cours/i)

    await userEvent.setup().click(bouton)
    expect(appel).not.toHaveBeenCalled()
  })

  it('dit qu’une exécution a démarré entre-temps plutôt que « échec »', async () => {
    // `lancer` lève `ExécutionEnCoursError`, et la route en fait un 409. C'est
    // une course perdue, pas une panne.
    vi.stubGlobal('fetch', vi.fn(async () => reponse({ error: 'déjà en cours' }, 409)))
    render(<BoutonReprise projectId="p1" enCours={false} />, { wrapper: enveloppe })

    await userEvent.setup().click(screen.getByRole('button', { name: /reprendre/i }))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/exécution.*(tourne|cours)/i),
    )
  })
})

describe('BoutonRelance', () => {
  function monter(compte: { gardes: number; ecartes: number; aTrier: number }, enCours = false) {
    return render(<BoutonRelance projectId="p1" compte={compte} enCours={enCours} />, {
      wrapper: enveloppe,
    })
  }

  it('n’envoie rien avant la confirmation', async () => {
    const appel = vi.fn(async () => reponse({ projectId: 'p1', plan: ['candidates'] }))
    vi.stubGlobal('fetch', appel)
    monter({ gardes: 4, ecartes: 7, aTrier: 19 })

    await userEvent.setup().click(screen.getByRole('button', { name: /relancer/i }))

    expect(appel).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('énonce exactement le partage', async () => {
    // « vos 4 clips gardés sont conservés, les 19 propositions en attente sont
    // remplacées » — sans quoi la confirmation ne fait que retarder le clic.
    monter({ gardes: 4, ecartes: 7, aTrier: 19 })
    await userEvent.setup().click(screen.getByRole('button', { name: /relancer/i }))

    const texte = screen.getByRole('dialog').textContent ?? ''
    expect(texte).toContain('4 clips gardés')
    expect(texte).toContain('7 écartés')
    expect(texte).toContain('19 propositions en attente')
  })

  it('accorde le singulier et le vide', async () => {
    monter({ gardes: 1, ecartes: 0, aTrier: 1 })
    await userEvent.setup().click(screen.getByRole('button', { name: /relancer/i }))

    const texte = screen.getByRole('dialog').textContent ?? ''
    expect(texte).toContain('1 clip gardé')
    expect(texte).toContain('0 écarté')
    expect(texte).toContain('1 proposition en attente')
  })

  it('force le repérage une fois confirmé', async () => {
    const appel = vi.fn(async () => reponse({ projectId: 'p1', plan: ['candidates'] }))
    vi.stubGlobal('fetch', appel)
    monter({ gardes: 4, ecartes: 7, aTrier: 19 })
    const utilisateur = userEvent.setup()

    await utilisateur.click(screen.getByRole('button', { name: /relancer/i }))
    await utilisateur.click(screen.getByRole('button', { name: /^relancer le repérage$/i }))

    await waitFor(() => expect(appel).toHaveBeenCalledTimes(1))
    expect(corpsEnvoyé(appel)).toEqual({ target: 'candidates', force: true })
  })

  it('ne s’ouvre pas tant qu’une exécution tourne', async () => {
    monter({ gardes: 4, ecartes: 7, aTrier: 19 }, true)

    const bouton = screen.getByRole('button', { name: /relancer/i })
    expect(bouton.getAttribute('aria-disabled')).toBe('true')
    await userEvent.setup().click(bouton)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
