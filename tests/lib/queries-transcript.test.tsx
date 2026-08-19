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

import { ApiError, type ProjectStatus, type TranscriptCorrectionResult } from '@/lib/api'
import type { TranscriptLine } from '@/lib/editing'
import { keys, useCorrectTranscript, useProject, useTranscript } from '@/lib/queries'

function response(body: unknown, status = 200): Response {
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
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

const lines: TranscriptLine[] = [
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
    vi.stubGlobal('fetch', vi.fn(async () => response(lines)))
    const { wrapper } = harness()
    const { result } = renderHook(() => useTranscript('p1'), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(lines)
  })
})

describe('useCorrectTranscript', () => {
  it('envoie l’empan et son remplacement, à la phrase visée', async () => {
    const call = vi.fn(async () =>
      response({ line: { ...lines[0], words: [{ word: 'Salut', start: 0, end: 1 }] }, clipsTouched: [] }),
    )
    vi.stubGlobal('fetch', call)
    const { wrapper } = harness()
    const { result } = renderHook(() => useCorrectTranscript(), { wrapper })

    await act(async () => {
      result.current.mutate({
        projectId: 'p1',
        correction: { lineId: 'l0', from: 0, to: 0, expected: ['Bonjour'], replacement: ['Salut'] },
      })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const [urlPath, options] = call.mock.calls[0] as unknown as [string, RequestInit]
    expect(urlPath).toBe('/api/projects/p1/transcript')
    expect(JSON.parse(String(options.body))).toEqual({
      lineId: 'l0',
      from: 0,
      to: 0,
      expected: ['Bonjour'],
      replacement: ['Salut'],
    })
  })

  it('remplace la phrase corrigée dans le cache, sans redemander tout le transcript', async () => {
    const correctionResult: TranscriptCorrectionResult = {
      line: { id: 'l1', start: 5, end: 6, words: [{ word: 'Suivant', start: 5, end: 6 }] },
      clipsTouched: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => response(correctionResult)))
    const { client, wrapper } = harness()
    client.setQueryData(keys.transcript('p1'), lines)

    const { result } = renderHook(() => useCorrectTranscript(), { wrapper })
    await act(async () => {
      result.current.mutate({
        projectId: 'p1',
        correction: { lineId: 'l1', from: 0, to: 0, expected: ['Suite'], replacement: ['Suivant'] },
      })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(client.getQueryData(keys.transcript('p1'))).toEqual([lines[0], correctionResult.line])
  })

  it('remonte un 409 quand le texte a changé sous les yeux', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'Le texte a changé sous vos yeux.' }, 409)),
    )
    const { wrapper } = harness()
    const { result } = renderHook(() => useCorrectTranscript(), { wrapper })

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

  it('invalide le cache du transcript sur un 409 — la version qu’il tient a causé le refus', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'Le texte a changé sous vos yeux.' }, 409)),
    )
    const { client, wrapper } = harness()
    client.setQueryData(keys.transcript('p1'), lines)
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    const { result } = renderHook(() => useCorrectTranscript(), { wrapper })
    await act(async () => {
      result.current.mutate({
        projectId: 'p1',
        correction: { lineId: 'l0', from: 0, to: 0, expected: ['pas-le-bon-mot'], replacement: ['x'] },
      })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.transcript('p1') })
  })

  it('retire du cache une phrase vidée de tous ses mots — pas de ligne fantôme', async () => {
    // `transcriptLines` (src/server/views.ts) écarte une phrase sans mot
    // aligné : c'est ce qu'un `GET` frais rendrait après cette correction.
    // Le cache doit dire la même chose, sans attendre un rechargement complet.
    const correctionResult: TranscriptCorrectionResult = {
      line: { id: 'l0', start: 0, end: 2, words: [] },
      clipsTouched: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => response(correctionResult)))
    const { client, wrapper } = harness()
    client.setQueryData(keys.transcript('p1'), lines)

    const { result } = renderHook(() => useCorrectTranscript(), { wrapper })
    await act(async () => {
      result.current.mutate({
        projectId: 'p1',
        correction: { lineId: 'l0', from: 0, to: 0, expected: ['Bonjour'], replacement: [] },
      })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(client.getQueryData(keys.transcript('p1'))).toEqual([lines[1]])
  })
})

const runningStatus: ProjectStatus = {
  project: { id: 'p1', title: 'Un projet', durationSec: 100, createdAt: '2026-01-01' },
  steps: { proxy: false, audio: false, transcript: false, analysis: false, candidates: false, renders: false },
  running: { step: 'transcript', progress: 0.4 },
  error: null,
  stopped: false,
  selectionReport: null,
  sizeBytes: null,
}

describe('useProject', () => {
  it('invalide le transcript quand une exécution se termine, comme les candidats', async () => {
    // Le panneau de transcript reste monté et sa requête reste fraîche trente
    // secondes (`src/app/providers.tsx`) : sans cette invalidation, la fin
    // d'une retranscription laisse le cache sur l'ancien texte. (relevé par
    // Copilot et par Aristarque)
    vi.stubGlobal('fetch', vi.fn(async () => response(runningStatus)))
    const { client, wrapper } = harness()
    client.setQueryData(keys.projet('p1'), runningStatus)
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    const { result } = renderHook(() => useProject('p1'), { wrapper })
    await waitFor(() => expect(result.current.data?.running).not.toBeNull())

    await act(async () => {
      client.setQueryData(keys.projet('p1'), { ...runningStatus, running: null })
    })
    await waitFor(() => expect(result.current.data?.running).toBeNull())

    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.candidats('p1') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.transcript('p1') })
  })
})
