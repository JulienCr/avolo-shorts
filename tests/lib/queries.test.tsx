// @vitest-environment jsdom

/**
 * Ce que ces tests regardent, ce sont les **règles de fraîcheur** — quand
 * redemander quoi —, pas la provenance des données : `@/lib/api` fait son
 * travail pour de vrai ici, seul `fetch` est remplacé.
 *
 * Les deux mutations ajoutées ferment deux parcours orphelins : l'export, qui
 * s'affichait comme une étiquette sans jamais pouvoir être déclenché, et la
 * création d'un projet, qui se faisait en `curl`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExportResult, RunPlan } from '@/lib/api'
import { cles, useCreerProjet, useExporter } from '@/lib/queries'

/** Une réponse HTTP, réduite à ce que `@/lib/api` en lit. */
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
  const invalide = vi.spyOn(client, 'invalidateQueries')
  const enveloppe = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, invalide, enveloppe }
}

const exportComplet: ExportResult = {
  clip: {
    id: 'c1',
    projectId: 'p1',
    segments: [{ start: 0, end: 20 }],
    ratio: '1:1',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'Un titre',
    description: '',
    status: 'exported',
    pass: 1,
  },
  mp4: 'c1.mp4',
  variant9x16: 'c1-9x16.mp4',
  texts: 'c1.txt',
  skipped: false,
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useExporter', () => {
  it('invalide le clip, parce que l’export ne rend que des noms de fichiers', async () => {
    // `ExportResult` porte des noms ; ce sont les `ClipOutputs` de
    // `GET /api/clips/:id` qui portent les URL lisibles par un `<video>`.
    vi.stubGlobal('fetch', vi.fn(async () => reponse(exportComplet)))
    const { invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useExporter(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ clipId: 'c1' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalide).toHaveBeenCalledWith({ queryKey: cles.clip('c1') })
  })

  it('traite `skipped: true` comme un succès', async () => {
    // C'est la réponse la plus fréquente dès qu'on rouvre un clip déjà exporté :
    // rien n'a été refait, tout est en place. La traiter comme une erreur ferait
    // passer un export réussi pour un échec.
    vi.stubGlobal('fetch', vi.fn(async () => reponse({ ...exportComplet, skipped: true })))
    const { enveloppe } = harnais()
    const { result } = renderHook(() => useExporter(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ clipId: 'c1' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.skipped).toBe(true)
    expect(result.current.isError).toBe(false)
  })

  it('ne bronche pas quand la réponse ne porte pas de clip', async () => {
    // Une passe de repérage qui se termine pendant les dix à soixante secondes
    // du rendu réécrit le jeu de clips : `renderClip` prévoit que le clip ait
    // disparu à la relecture, et la route sérialise alors un corps sans ce
    // champ. Lire `clip.status` sans garde y planterait un export réussi.
    const sansClip = { ...exportComplet }
    delete sansClip.clip
    vi.stubGlobal('fetch', vi.fn(async () => reponse(sansClip)))
    const { invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useExporter(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ clipId: 'c1' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.clip).toBeUndefined()
    expect(invalide).toHaveBeenCalledWith({ queryKey: cles.clip('c1') })
  })

  it('remonte l’échec du serveur, avec son message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reponse({ error: 'ffmpeg a rendu 1' }, 500)))
    const { invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useExporter(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate({ clipId: 'c1' })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('ffmpeg a rendu 1')
    expect(invalide).not.toHaveBeenCalled()
  })
})

describe('useCreerProjet', () => {
  const plan: RunPlan = { projectId: 'p1', plan: ['audio', 'transcript'] }

  it('invalide la liste des projets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reponse(plan, 202)))
    const { invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useCreerProjet(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate('2025-06-15-cqlp.mp4')
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalide).toHaveBeenCalledWith({ queryKey: cles.projets })
  })

  it('rend le plan, et laisse la redirection à l’écran', async () => {
    // La réponse est un 202 : elle confirme que l'analyse est acceptée et
    // lancée, pas qu'elle est faite. Où l'on va ensuite est une décision
    // d'écran, pas de hook.
    vi.stubGlobal('fetch', vi.fn(async () => reponse(plan, 202)))
    const { enveloppe } = harnais()
    const { result } = renderHook(() => useCreerProjet(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate('2025-06-15-cqlp.mp4')
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(plan)
  })

  it('remonte le message du serveur quand le Drive ne répond pas', async () => {
    // Le 503 sur un Drive muet a son propre texte, déjà écrit côté serveur :
    // l'écran le reprend tel quel plutôt que d'en composer un depuis une
    // exception.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reponse({ error: 'le dossier des replays n’est pas monté' }, 503)),
    )
    const { invalide, enveloppe } = harnais()
    const { result } = renderHook(() => useCreerProjet(), { wrapper: enveloppe })

    await act(async () => {
      result.current.mutate('2025-06-15-cqlp.mp4')
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('le dossier des replays n’est pas monté')
    expect(invalide).not.toHaveBeenCalled()
  })
})
