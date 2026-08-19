// @vitest-environment jsdom

/**
 * Le transcript de l'émission : le chargement entier, et la correction
 * manuelle. Fichier séparé, comme `queries-relance.test.tsx` — même raison :
 * ne pas faire porter un ajout de plus à `queries.test.tsx`, édité en
 * parallèle par une autre PR.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, type TranscriptCorrectionResult } from '@/lib/api'
import type { TranscriptLine } from '@/lib/editing'
import { cles, useCorrectTranscript, useTranscript } from '@/lib/queries'

function reponse(corps: unknown, status = 200): Response {
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
  const enveloppe = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, enveloppe }
}

const lignes: TranscriptLine[] = [
  { id: 'l0', start: 0, end: 2, words: [{ word: 'Bonjour', start: 0, end: 1 }] },
  { id: 'l1', start: 5, end: 6, words: [{ word: 'Suite', start: 5, end: 6 }] },
]

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useTranscript', () => {
  it('charge le transcript de l’émission', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reponse(lignes)))
    const { enveloppe } = harnais()
    const { result } = renderHook(() => useTranscript('p1'), { wrapper: enveloppe })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(lignes)
  })
})

describe('useCorrectTranscript', () => {
  it('envoie l’empan et son remplacement, à la phrase visée', async () => {
    const appel = vi.fn(async () =>
      reponse({ line: { ...lignes[0], words: [{ word: 'Salut', start: 0, end: 1 }] }, clipsTouched: [] }),
    )
    vi.stubGlobal('fetch', appel)
    const { enveloppe } = harnais()
    const { result } = renderHook(() => useCorrectTranscript(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({
        projectId: 'p1',
        correction: { lineId: 'l0', from: 0, to: 0, expected: ['Bonjour'], replacement: ['Salut'] },
      })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const [chemin, options] = appel.mock.calls[0] as unknown as [string, RequestInit]
    expect(chemin).toBe('/api/projects/p1/transcript')
    expect(JSON.parse(String(options.body))).toEqual({
      lineId: 'l0',
      from: 0,
      to: 0,
      expected: ['Bonjour'],
      replacement: ['Salut'],
    })
  })

  it('remplace la phrase corrigée dans le cache, sans redemander tout le transcript', async () => {
    const résultat: TranscriptCorrectionResult = {
      line: { id: 'l1', start: 5, end: 6, words: [{ word: 'Suivant', start: 5, end: 6 }] },
      clipsTouched: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => reponse(résultat)))
    const { client, enveloppe } = harnais()
    client.setQueryData(cles.transcript('p1'), lignes)

    const { result } = renderHook(() => useCorrectTranscript(), { wrapper: enveloppe })
    await act(async () => {
      result.current.mutate({
        projectId: 'p1',
        correction: { lineId: 'l1', from: 0, to: 0, expected: ['Suite'], replacement: ['Suivant'] },
      })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(client.getQueryData(cles.transcript('p1'))).toEqual([lignes[0], résultat.line])
  })

  it('remonte un 409 quand le texte a changé sous les yeux', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reponse({ error: 'Le texte a changé sous vos yeux.' }, 409)),
    )
    const { enveloppe } = harnais()
    const { result } = renderHook(() => useCorrectTranscript(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({
        projectId: 'p1',
        correction: { lineId: 'l0', from: 0, to: 0, expected: ['pas-le-bon-mot'], replacement: ['x'] },
      })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.error).toBeInstanceOf(ApiError)
    expect((result.current.error as ApiError).status).toBe(409)
  })
})
