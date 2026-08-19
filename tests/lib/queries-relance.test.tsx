// @vitest-environment jsdom

/**
 * La relance, et ses deux règles de fraîcheur.
 *
 * Fichier séparé de `queries.test.tsx` à dessein : le corps de `useProjets` est
 * édité en parallèle dans la même vague, et deux ajouts propres dans un fichier
 * commun font un conflit pour rien.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { actAsync, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, RESUME_TARGETS, type RunShot } from '@/lib/api'
import { keys, useRetry } from '@/lib/queries'

function response(body: unknown, status = 202): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
  } as Response
}

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const invalid = vi.spyOn(client, 'invalidateQueries')
  const envelope = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { invalid, envelope }
}

function bodySent(call: ReturnType<typeof vi.fn>): unknown {
  const [, options] = call.mock.calls[0] as unknown as [string, RequestInit]
  return JSON.parse(String(options.body))
}

const shot: RunShot = { projectId: 'p1', shot: ['candidates', 'proxy'] }

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
    const call = vi.fn(async () => response(shot))
    vi.stubGlobal('fetch', call)
    const { envelope } = harness()
    const { result } = renderHook(() => useRetry(), { wrapper: envelope })

    await actAsync(async () => {
      result.current.mutate({ projectId: 'p1', targets: RESUME_TARGETS })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(call).toHaveBeenCalledTimes(1)
    const [path, options] = call.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/projects/p1/run')
    expect(JSON.parse(String(options.body))).toEqual({ target: [...RESUME_TARGETS] })
  })

  it('invalide l’état du projet, sans quoi rien ne reprend l’interrogation', async () => {
    // `useProjet` n'interroge en boucle que tant que `running` est non nul :
    // après un 202, le cache porte encore `running: null` et l'écran resterait
    // immobile devant une analyse qui tourne.
    vi.stubGlobal('fetch', vi.fn(async () => response(shot)))
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useRetry(), { wrapper: envelope })

    await actAsync(async () => {
      result.current.mutate({ projectId: 'p1', targets: 'candidates', force: true })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.projet('p1') })
    // Un repérage forcé remplace les propositions en attente : la liste en cache
    // décrit alors la passe d'avant.
    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.candidats('p1') })
  })

  it('transmet `force` tel quel', async () => {
    const call = vi.fn(async () => response(shot))
    vi.stubGlobal('fetch', call)
    const { envelope } = harness()
    const { result } = renderHook(() => useRetry(), { wrapper: envelope })

    await actAsync(async () => {
      result.current.mutate({ projectId: 'p1', targets: 'candidates', force: true })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(bodySent(call)).toEqual({ target: 'candidates', force: true })
  })

  it('remonte un 409 avec son code, pas seulement son message', async () => {
    // `lancer` lève `ExécutionEnCoursError` et la route en fait un 409 : l'écran
    // doit pouvoir dire « une exécution tourne déjà » plutôt que « échec ».
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'Une exécution est déjà en cours' }, 409)),
    )
    const { envelope } = harness()
    const { result } = renderHook(() => useRetry(), { wrapper: envelope })

    await actAsync(async () => {
      result.current.mutate({ projectId: 'p1', targets: 'candidates' })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.error).toBeInstanceOf(ApiError)
    expect((result.current.error as ApiError).status).toBe(409)
  })

  it('invalide l’état du projet même quand la relance échoue', async () => {
    // **Un 409 dit qu'une exécution tourne**, et c'est exactement le moment où
    // l'écran doit aller la chercher. Invalider seulement au succès laissait le
    // cache sur `running: null` — donc `useProjet` sans interrogation en boucle —
    // et le message « l'écran la suivra dès qu'elle se signalera » était faux.
    // (relevé par Copilot)
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'déjà en cours' }, 409)))
    const { invalid, envelope } = harness()
    const { result } = renderHook(() => useRetry(), { wrapper: envelope })

    await actAsync(async () => {
      result.current.mutate({ projectId: 'p1', targets: 'candidates' })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalid).toHaveBeenCalledWith({ queryKey: keys.projet('p1') })
    // Les candidats, eux, n'ont pas bougé : rien n'a été lancé, donc la liste
    // décrit toujours la même passe.
    expect(invalid).not.toHaveBeenCalledWith({ queryKey: keys.candidats('p1') })
  })
})
