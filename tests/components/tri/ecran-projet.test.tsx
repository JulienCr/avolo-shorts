// @vitest-environment jsdom

/**
 * L'écran de projet, monté pour de vrai.
 *
 * `dispositionAvancement` est testée seule ailleurs, et c'est le bon endroit
 * pour l'invariant lui-même. **Mais les trois violations que les relectures ont
 * trouvées étaient dans le raccordement**, pas dans la règle : un panneau qui
 * mange la grille, un squelette qui passe pour une attente de neuf minutes, une
 * erreur qui en efface une autre. Ce fichier monte donc l'écran entier, avec ses
 * requêtes, pour regarder ce qui s'affiche en même temps que quoi.
 *
 * **C'est `EcranDeProjet` qu'on monte, pas la route.** La route lit ses `params`
 * par `use()`, et sous `jsdom` une limite de Suspense ainsi tenue ne se relève
 * jamais : la promesse se tient, React ne rejoue pas, et le repli reste seul à
 * l'écran. Mesuré sur un composant de trois lignes avant de conclure.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CandidateClip, ProjectStatus } from '@/lib/api'

// Le routeur n'existe pas hors d'une application Next montée. On ne teste pas
// la navigation ici — la vue dans l'URL a son propre test — mais l'écran ne
// peut pas se rendre sans ces deux hooks.
const remplacer = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: remplacer, push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}))

const { EcranDeProjet } = await import('@/components/tri/ecran-projet')
const { TooltipProvider } = await import('@/components/ui/tooltip')

function etat(champs: Partial<ProjectStatus> = {}): ProjectStatus {
  return {
    project: { id: 'p1', title: 'La scène du 15 juin', durationSec: 5940, createdAt: '2026-08-18' },
    steps: {
      audio: true,
      transcript: true,
      candidates: false,
      proxy: false,
      analysis: false,
      renders: false,
    },
    running: { step: 'candidates', progress: 0.5 },
    error: null,
    repérage: null,
    ...champs,
  }
}

function candidat(n: number): CandidateClip {
  return {
    id: `c${n}`,
    projectId: 'p1',
    segments: [{ start: n * 100, end: n * 100 + 30 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: `Extrait ${n}`,
    description: '',
    status: 'candidate',
    pass: 1,
    preview: 'Ce qui se dit.',
    thumbnailUrl: null,
  }
}

/**
 * Le serveur, réduit à ses deux routes. `null` fait échouer la route concernée
 * — c'est ainsi qu'on distingue les origines d'erreur.
 */
function servir(projet: ProjectStatus | null, candidats: CandidateClip[] | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (chemin: string) => {
      const [corps, ok] = chemin.endsWith('/candidates')
        ? [candidats ?? { error: 'liste indisponible' }, candidats !== null]
        : [projet ?? { error: 'projet introuvable' }, projet !== null]
      return {
        ok,
        status: ok ? 200 : 500,
        statusText: '',
        json: async () => corps,
      } as Response
    }),
  )
}

function monter() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const enveloppe = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  )
  return render(<EcranDeProjet id="p1" />, { wrapper: enveloppe })
}

beforeEach(() => {
  remplacer.mockClear()
})

afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('l’écran de projet', () => {
  it('donne la page au panneau tant qu’il n’y a rien à trier', async () => {
    servir(etat(), [])
    monter()

    await waitFor(() => expect(screen.getByText(/l’analyse est en cours/i)).toBeTruthy())
    expect(screen.queryByRole('tab', { name: /à trier/i })).toBeNull()
  })

  it('rend la page à la grille dès qu’il y a quelque chose à trier', async () => {
    // Régime 2 : les propositions arrivent avant les images, et le panneau se
    // replie dans la barre d'application au lieu de manger la grille.
    servir(etat({ steps: { ...etat().steps, candidates: true }, running: { step: 'proxy', progress: 0.3 } }), [
      candidat(1),
    ])
    monter()

    await waitFor(() => expect(screen.getByRole('article', { name: 'Extrait 1' })).toBeTruthy())
    expect(screen.queryByText(/l’analyse est en cours/i)).toBeNull()
    // La bande, elle, reste : ce qui tourne doit rester lisible.
    expect(screen.getByRole('progressbar')).toBeTruthy()
  })

  it('ne laisse pas un projet introuvable sur un squelette éternel', async () => {
    // Troisième origine d'erreur, distincte des deux autres : ce n'est ni
    // l'analyse qui a échoué ni la liste qui ne charge pas, c'est l'état du
    // projet lui-même.
    servir(null, [])
    monter()

    await waitFor(() => expect(screen.getByText(/ne se charge pas/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /réessayer/i })).toBeTruthy()
  })

  it('laisse trier ce qui est chargé même si l’état du projet manque', async () => {
    // L'invariant : la phase choisit ce que l'écran met en avant, elle ne retire
    // jamais ce qui existe. Une requête d'état en échec ne doit pas emporter une
    // liste parfaitement utilisable.
    servir(null, [candidat(1)])
    monter()

    await waitFor(() => expect(screen.getByRole('article', { name: 'Extrait 1' })).toBeTruthy())
    expect(screen.getByText(/ne se charge pas/i)).toBeTruthy()
  })

  it('affiche les deux origines d’erreur à la fois', async () => {
    // « La seconde n'efface pas la première. »
    servir(etat({ steps: { ...etat().steps, candidates: true }, running: null, error: 'ffmpeg a rendu 1' }), null)
    monter()

    await waitFor(() => expect(screen.getByText('ffmpeg a rendu 1')).toBeTruthy())
    expect(screen.getByText(/les propositions ne se chargent pas/i)).toBeTruthy()
  })

  it('porte une seule région d’annonce, et polie', async () => {
    servir(etat(), [])
    monter()

    // Muette d'abord — on ne sait rien —, puis un seul message, et un seul
    // endroit d'où il vienne.
    expect(screen.getByTestId('annonce').textContent).toBe('')
    await waitFor(() => expect(screen.getByTestId('annonce').textContent).toContain('Repérage'))
    expect(document.querySelectorAll('[aria-live="polite"]').length).toBe(1)
  })
})
