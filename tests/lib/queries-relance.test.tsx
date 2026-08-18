// @vitest-environment jsdom

/**
 * La relance, et ses deux règles de fraîcheur.
 *
 * Fichier séparé de `queries.test.tsx` à dessein : le corps de `useProjets` est
 * édité en parallèle dans la même vague, et deux ajouts propres dans un fichier
 * commun font un conflit pour rien.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, CIBLES_DE_REPRISE, type RunPlan } from '@/lib/api'
import { cles, useRelancer } from '@/lib/queries'

function reponse(corps: unknown, status = 202): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => corps,
  } as Response
}

function harnais() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const invalide = vi.spyOn(client, 'invalidateQueries')
  const enveloppe = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { invalide, enveloppe }
}

const plan: RunPlan = { projectId: 'p1', plan: ['candidates', 'proxy'] }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useRelancer', () => {
  it('vise les cibles qu’on lui donne, en une seule requête', async () => {
    // Une cible nomme un résultat à atteindre, pas une étape à refaire : viser
    // `candidates` seul ne construirait jamais le proxy, et l'écran resterait
    // dans l'impasse dont il voulait sortir.
    const appel = vi.fn(async () => reponse(plan))
    vi.stubGlobal('fetch', appel)
    const { enveloppe } = harnais()
    const { result } = renderHook(() => useRelancer(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ projectId: 'p1', targets: CIBLES_DE_REPRISE })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(appel).toHaveBeenCalledTimes(1)
    const [chemin, options] = appel.mock.calls[0] as [string, RequestInit]
    expect(chemin).toBe('/api/projects/p1/run')
    expect(JSON.parse(String(options.body))).toEqual({ target: [...CIBLES_DE_REPRISE] })
  })

  it('invalide l’état du projet, sans quoi rien ne reprend l’interrogation', async () => {
    // `useProjet` n'interroge en boucle que tant que `running` est non nul :
    // après un 202, le cache porte encore `running: null` et l'écran resterait
    // immobile devant une analyse qui tourne.
    vi.stubGlobal('fetch', vi.fn(async () => reponse(plan)))
    const { invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useRelancer(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ projectId: 'p1', targets: 'candidates', force: true })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalide).toHaveBeenCalledWith({ queryKey: cles.projet('p1') })
    // Un repérage forcé remplace les propositions en attente : la liste en cache
    // décrit alors la passe d'avant.
    expect(invalide).toHaveBeenCalledWith({ queryKey: cles.candidats('p1') })
  })

  it('transmet `force` tel quel', async () => {
    const appel = vi.fn(async () => reponse(plan))
    vi.stubGlobal('fetch', appel)
    const { enveloppe } = harnais()
    const { result } = renderHook(() => useRelancer(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ projectId: 'p1', targets: 'candidates', force: true })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const [, options] = appel.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(options.body))).toEqual({ target: 'candidates', force: true })
  })

  it('remonte un 409 avec son code, pas seulement son message', async () => {
    // `lancer` lève `ExécutionEnCoursError` et la route en fait un 409 : l'écran
    // doit pouvoir dire « une exécution tourne déjà » plutôt que « échec ».
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reponse({ error: 'Une exécution est déjà en cours' }, 409)),
    )
    const { enveloppe } = harnais()
    const { result } = renderHook(() => useRelancer(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ projectId: 'p1', targets: 'candidates' })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.error).toBeInstanceOf(ApiError)
    expect((result.current.error as ApiError).status).toBe(409)
  })
})
