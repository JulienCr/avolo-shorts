// @vitest-environment jsdom

/**
 * L'écran de planning : le vivier, la saisie de date/heure et le bandeau de
 * cinq semaines. Le critère le plus contre-intuitif — un rendu périmé se
 * signale sans bloquer — a son propre test, ainsi que celui qui le complète :
 * une échéance déjà résolue n'offre pas de déprogrammer.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PublicationStatus } from '@/core/publication'
import { DEFAULT_SELECTION_DIMENSIONS } from '@/core/transcript'
import {
  DEFAULT_DESCRIPTION_FOOTER,
  DEFAULT_SCHEDULE_HOURS,
  FRAMING_SETTINGS_DEFAULTS,
  HOOK_DEFAULTS,
  type PlanningPendingClip,
  type PlanningPoolClip,
  type PublicationDetail,
  type ScheduledEntry,
  type Settings,
} from '@/lib/api'
import { installPointerEventPolyfill } from '../../fixtures/pointer-event'

installPointerEventPolyfill()

// `PoolPreview` lit `?preview=` par `useSearchParams` : même mock que
// `transcript-panel.test.tsx`, une variable de module pour changer la
// requête entre deux rendus.
const replaceMock = vi.fn()
let query = ''
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(query),
}))

const { PlanningScreen } = await import('@/components/planning/planning-screen')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  query = ''
})

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body } as Response
}

const SETTINGS: Settings = {
  selection: { ...DEFAULT_SELECTION_DIMENSIONS },
  ai: {
    selectionProvider: 'gemini',
    selectionModel: 'gemini-3.1-flash-lite',
    correctionProvider: 'gemini',
    correctionModel: 'gemini-3.1-flash-lite',
    hookProvider: 'gemini',
    hookModel: 'gemini-3.1-flash-lite',
    ollamaBaseUrl: '',
  },
  ingestion: { copySourceLocally: true },
  hook: { ...HOOK_DEFAULTS },
  publication: {
    instagram: 'auto',
    facebook: 'auto',
    tiktok: 'auto',
    youtube: 'auto',
    scheduleHours: DEFAULT_SCHEDULE_HOURS,
    autoPublish: true,
    descriptionFooter: DEFAULT_DESCRIPTION_FOOTER,
  },
  framing: { ...FRAMING_SETTINGS_DEFAULTS },
}

function clip(fields: Partial<PlanningPoolClip> = {}): PlanningPoolClip {
  return {
    clipId: 'c1',
    projectId: '2026-06-15-cqlp',
    title: 'La chute',
    duration: 42,
    thumbnailUrl: null,
    description: '',
    outputs: { mp4Url: null, mp4Due: false, variant9x16Url: null, variant9x16Due: false, textsUrl: null },
    statuses: {},
    ...fields,
  }
}

function detail(status: PublicationStatus, fields: Partial<Omit<PublicationDetail, 'status'>> = {}): PublicationDetail {
  return { status, error: null, updatedAt: Date.now(), remoteUrl: null, ...fields }
}

function entry(fields: Partial<ScheduledEntry> = {}): ScheduledEntry {
  return {
    clipId: 'c1',
    projectId: '2026-06-15-cqlp',
    title: 'La chute',
    scheduledAt: Date.now() + 3_600_000,
    statuses: {
      instagram: detail('planned'),
      facebook: detail('planned'),
      tiktok: detail('planned'),
      youtube: detail('planned'),
    },
    stale: false,
    ...fields,
  }
}

/** Un serveur réduit aux quatre routes du planning et à `/api/settings`. */
function server(options: {
  pool?: PlanningPoolClip[]
  pending?: PlanningPendingClip[]
  schedule?: ScheduledEntry[]
  settings?: Settings
  onSchedule?: (body: unknown) => ScheduledEntry[]
  onUnschedule?: (body: unknown) => number
}) {
  const calls: { path: string; init?: RequestInit }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ path: url, init })
    if (url === '/api/settings') return response(options.settings ?? SETTINGS)
    if (url === '/api/planning/pool') {
      return response({ clips: options.pool ?? [], pending: options.pending ?? [] })
    }
    if (url.startsWith('/api/planning/schedule?')) {
      return response({ entries: options.schedule ?? [] })
    }
    if (url === '/api/planning/schedule' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      return response({ entries: options.onSchedule?.(body) ?? [] })
    }
    if (url === '/api/planning/unschedule' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      return response({ removed: options.onUnschedule?.(body) ?? 0 })
    }
    throw new Error(`Route inattendue : ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return Wrapper
}

describe('PlanningScreen', () => {
  it('se monte sans la route, hors état de chargement', async () => {
    server({ pool: [] })
    render(<PlanningScreen />, { wrapper: wrapper() })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Planning' })).toBeTruthy())
  })

  it('le vivier vide affiche un bloc en pointillés avec ce qu’il faut faire', async () => {
    server({ pool: [] })
    render(<PlanningScreen />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByText(/Aucun clip à programmer/)).toBeTruthy())
    expect(screen.getByText(/Exportez un clip/)).toBeTruthy()
  })

  // Le cas qui a produit ce bouton : une recette de rendu montée d'un cran
  // périme tous les rendus d'un coup, et le vivier se vide sans rien dire de
  // ce qu'il faut faire pour le remplir (28 août 2026).
  it('vivier vide mais des clips en attente : le bloc dit quoi faire et propose de le faire', async () => {
    server({
      pool: [],
      pending: [
        { clipId: 'c1', projectId: '2026-06-15-cqlp', title: 'La chute', reason: 'stale' },
        { clipId: 'c2', projectId: '2026-06-15-cqlp', title: 'Le silence', reason: 'unedited' },
      ],
    })
    render(<PlanningScreen />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByText(/Aucun clip à programmer/)).toBeTruthy())
    expect(screen.getByText(/Des clips gardés n’ont pas de vidéo à jour/)).toBeTruthy()
    expect(screen.queryByText(/Exportez un clip depuis son émission/)).toBeNull()
    expect(screen.getByRole('button', { name: /Exporter les 2 clips manquants/ })).toBeTruthy()
    expect(screen.getByText(/1 jamais monté, 1 rendu périmé/)).toBeTruthy()
  })

  it('coche deux clips et confirme une date : un seul appel, une échéance unique', async () => {
    const user = userEvent.setup()
    const calls = server({
      pool: [clip({ clipId: 'c1', title: 'La chute' }), clip({ clipId: 'c2', title: 'Le silence' })],
    })
    render(<PlanningScreen />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByText('La chute')).toBeTruthy())
    await user.click(screen.getByRole('checkbox', { name: /La chute/ }))
    await user.click(screen.getByRole('checkbox', { name: /Le silence/ }))

    await waitFor(() => expect(screen.getByText('2 clips sélectionnés')).toBeTruthy())
    await user.click(screen.getByRole('button', { name: /Programmer 2 clips/ }))

    await waitFor(() => {
      const posted = calls.find((c) => c.path === '/api/planning/schedule' && c.init?.method === 'POST')
      expect(posted).toBeTruthy()
    })
    const posted = calls.find((c) => c.path === '/api/planning/schedule' && c.init?.method === 'POST')!
    const body = JSON.parse(String(posted.init?.body)) as { clipIds: string[]; scheduledAt: number }
    expect(body.clipIds.sort()).toEqual(['c1', 'c2'])
    expect(typeof body.scheduledAt).toBe('number')
    expect(calls.filter((c) => c.path === '/api/planning/schedule' && c.init?.method === 'POST')).toHaveLength(1)
  })

  it('une échéance périmée signale, sans rien désactiver', async () => {
    server({ pool: [], schedule: [entry({ stale: true })] })
    render(<PlanningScreen />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByText('rendu périmé')).toBeTruthy())
    const unschedule = screen.getByRole('button', { name: 'Déprogrammer' })
    expect(unschedule.hasAttribute('disabled')).toBe(false)
  })

  it('déprogrammer appelle unschedule avec l’identifiant du clip', async () => {
    const user = userEvent.setup()
    const calls = server({ pool: [], schedule: [entry({ clipId: 'c9' })], onUnschedule: () => 1 })
    render(<PlanningScreen />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Déprogrammer' })).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'Déprogrammer' }))

    await waitFor(() => {
      const posted = calls.find((c) => c.path === '/api/planning/unschedule')
      expect(posted).toBeTruthy()
    })
    const posted = calls.find((c) => c.path === '/api/planning/unschedule')!
    expect(JSON.parse(String(posted.init?.body))).toEqual({ clipIds: ['c9'] })
  })

  it('une échéance dont les quatre plateformes portent un résultat n’offre pas de déprogrammer', async () => {
    server({
      pool: [],
      schedule: [
        entry({
          statuses: {
            instagram: detail('published'),
            facebook: detail('published'),
            tiktok: detail('failed'),
            youtube: detail('submitted'),
          },
        }),
      ],
    })
    render(<PlanningScreen />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByText('La chute')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Déprogrammer' })).toBeNull()
  })

  it('la publication automatique coupée affiche le bandeau et pointe vers l’onglet Publication', async () => {
    server({ pool: [], settings: { ...SETTINGS, publication: { ...SETTINGS.publication, autoPublish: false } } })
    render(<PlanningScreen />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByText('Publication automatique désactivée.')).toBeTruthy())
    const link = screen.getByRole('link', { name: 'Ouvrir les réglages de publication' })
    expect(link.getAttribute('href')).toBe('/settings?tab=publication')
  })

  it('la publication automatique active n’affiche pas le bandeau', async () => {
    server({ pool: [] })
    render(<PlanningScreen />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Planning' })).toBeTruthy())
    expect(screen.queryByText('Publication automatique désactivée.')).toBeNull()
  })

  it('?preview= ouvre l’aperçu du clip visé', async () => {
    query = 'preview=c1'
    server({ pool: [clip({ clipId: 'c1', title: 'La chute' })] })
    render(<PlanningScreen />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(screen.getAllByText('La chute').length).toBeGreaterThan(0)
  })

  it('?preview= visant un clip absent du vivier n’ouvre rien', async () => {
    query = 'preview=introuvable'
    server({ pool: [clip({ clipId: 'c1', title: 'La chute' })] })
    render(<PlanningScreen />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByText('La chute')).toBeTruthy())
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
