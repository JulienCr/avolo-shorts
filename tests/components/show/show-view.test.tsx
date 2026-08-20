// @vitest-environment jsdom

/**
 * La vue Émission : le proxy, et la bande qui dit ce qu'on en a tiré.
 *
 * Trois propriétés portent ce fichier. **La bande ouvre le bon clip** — c'est sa
 * raison d'être comme surface de navigation. **Les chevauchements restent
 * lisibles**, ce qui suppose des voies et non une seule ligne. Et **un clic hors
 * bloc déplace la lecture**, ce qui suppose que le lecteur et la bande partagent
 * un instant et rien d'autre.
 *
 * Le `<video>` n'est jamais joué : jsdom n'implémente ni `play()` ni le
 * décodage. Ce qui se teste ici est ce qui se calcule, et il se calcule en
 * dehors de lui.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Segment } from '@/core/edl'
import type { CandidateClip } from '@/lib/api'

// `ShowView` porte désormais `TranscriptTrigger`, qui a besoin des deux :
// `next/navigation` pour `?transcript=1`, un `QueryClient` pour `useTranscript`.
// On ne teste pas ces deux-là ici — ils ont leurs propres fichiers — mais la
// vue ne se monte pas sans eux.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const { ShowView } = await import('@/components/show/show-view')

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const DURATION = 6_000

function clip(
  id: string,
  segments: Segment[],
  partial: Partial<CandidateClip> = {},
): CandidateClip {
  return {
    id,
    projectId: 'cqlp',
    segments,
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: `Le clip ${id}`,
    description: '',
    status: 'kept',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    preview: 'Trois premières phrases.',
    thumbnailUrl: `/api/clips/${id}/thumb`,
    ...partial,
  }
}

function renderView(partial: Partial<Parameters<typeof ShowView>[0]> = {}) {
  return render(
    <ShowView
      projectId="cqlp"
      durationSec={DURATION}
      proxyReady
      clips={[clip('a', [{ start: 600, end: 660 }])]}
      {...partial}
    />,
    { wrapper },
  )
}

/** Les blocs de la band, dans l'ordre du DOM. */
function blocks(): HTMLElement[] {
  return Array.from(
    screen.getByTestId('coverage-timeline').querySelectorAll<HTMLElement>('[data-clip]'),
  )
}

describe('la bande de couverture', () => {
  it('ne pose un bloc que pour les clips gardés', () => {
    // Une proposition ni gardée ni écartée n'a rien extrait de l'émission, et un
    // écarté encore moins.
    renderView({
      clips: [
        clip('gardé', [{ start: 0, end: 60 }]),
        clip('proposé', [{ start: 600, end: 660 }], { status: 'candidate' }),
        clip('écarté', [{ start: 1200, end: 1260 }], { status: 'discarded' }),
        clip('exporté', [{ start: 1800, end: 1860 }], { status: 'exported' }),
      ],
    })
    expect(blocks().map((b) => b.getAttribute('data-clip'))).toEqual(['gardé', 'exporté'])
  })

  it('mène au clip qu’on clique', () => {
    renderView()
    expect(blocks()[0]).toHaveProperty('pathname', '/clips/a')
  })

  it('place le bloc à sa position dans l’émission', () => {
    // 600 s sur 6 000 : un dixième, et un centième de large.
    renderView()
    expect(blocks()[0].style.left).toBe('10%')
    expect(blocks()[0].style.width).toBe('1%')
  })

  it('couvre le trou d’un passage retiré, sans le combler', () => {
    // Un clip est une liste de segments : retirer un passage par le milieu
    // laisse un trou, mais le clip occupe toujours la même place dans
    // l'émission. La bande décrit la couverture, la durée se lit à côté.
    renderView({ clips: [clip('a', [{ start: 600, end: 660 }, { start: 1_200, end: 1_260 }])] })
    expect(blocks()[0].style.left).toBe('10%')
    expect(blocks()[0].style.width).toBe('11%')
  })

  it('sépare en voies deux clips qui se chevauchent', () => {
    // L'exigence explicite du retour d'usage : empilés sur une ligne, le second
    // efface le premier et le survol n'en désigne qu'un sans dire lequel.
    renderView({
      clips: [
        clip('a', [{ start: 600, end: 1_200 }]),
        clip('b', [{ start: 900, end: 1_500 }]),
      ],
    })
    const [a, b] = blocks()
    expect(a.style.top).not.toBe(b.style.top)
  })

  it('garde dans le cadre un clip qui déborde de la durée sondée', () => {
    // La durée vient de `ProjectSummary`, les bornes du repérage : les deux se
    // sont déjà contredites en fin d'émission. Posé à `left: 100%`, le bloc de
    // largeur nulle partait entièrement hors d'un conteneur en `overflow-hidden`
    // — invisible et inatteignable, le contraire de ce que `min-w` promet.
    // (relevé par Copilot)
    renderView({ clips: [clip('a', [{ start: 9_000, end: 9_100 }])] })
    const block = blocks()[0]
    expect(block.style.right).toBe('0px')
    expect(block.style.left).toBe('')
  })

  it('compte ce qui a été gardé, en toutes lettres', () => {
    renderView({
      clips: [clip('a', [{ start: 0, end: 60 }]), clip('b', [{ start: 600, end: 660 }])],
    })
    expect(screen.getByText('2 clips gardés sur 1:40:00 d’émission.')).toBeTruthy()
  })

  it('dit qu’il n’y a rien d’extrait plutôt que de rendre une bande muette', () => {
    renderView({ clips: [] })
    expect(screen.getByText(/Aucun clip gardé pour l’instant/)).toBeTruthy()
  })

  it('se tait sur la durée tant que l’ingestion ne l’a pas sondée', () => {
    // `durationSec` vaut zéro sur un projet créé il y a trois secondes : dessiner
    // une bande sans échelle placerait tous les blocs au même endroit.
    renderView({ durationSec: 0 })
    expect(screen.queryByTestId('coverage-timeline')).toBeNull()
    expect(screen.getByText(/n’est pas encore connue/)).toBeTruthy()
  })
})

describe('le clic sur un bloc', () => {
  it('ouvre le clip sans déplacer la lecture', async () => {
    // Le contrat est de ne déplacer la tête que sur un clic **hors** bloc. Sans
    // arrêt de propagation, le clic remontait jusqu'au `onClick` de la bande et
    // faisait les deux — la navigation masquait le déplacement, ce qui ne le
    // rendait pas moins faux. (relevé par Copilot)
    renderView()
    const band = screen.getByTestId('coverage-timeline')
    vi.spyOn(band, 'getBoundingClientRect').mockReturnValue({
      left: 0, width: 1_000, top: 0, right: 1_000, bottom: 24, height: 24, x: 0, y: 0,
      toJSON: () => ({}),
    })

    await userEvent.click(blocks()[0])

    const video = screen.getByTestId('lecteur-emission') as HTMLVideoElement
    expect(video.currentTime).toBe(0)
  })

  it('annonce son départ, pour que l’écran pose la marque de retour', async () => {
    // Sans elle, revenir d'un clip ouvert depuis la bande retombait sur la vue
    // par défaut, alors que le même clip ouvert d'une carte rendait la vue d'où
    // l'on venait : deux chemins vers le même endroit, deux retours différents.
    const onOpenClip = vi.fn()
    renderView({ onOpenClip })

    await userEvent.click(blocks()[0])

    expect(onOpenClip).toHaveBeenCalledWith('a')
  })
})

describe('la liste des clips', () => {
  it('dit qu’elle ne se charge pas, plutôt que d’annoncer une couverture nulle', () => {
    // Une liste qui n'a pas pu se charger n'est pas une liste vide : « aucun
    // clip gardé » affirmerait une couverture que la bande n'a pas mesurée.
    // (relevé par Copilot)
    renderView({ clips: [], clipsKnown: false })
    expect(screen.getByText(/ne se chargent pas/)).toBeTruthy()
    expect(screen.queryByText(/Aucun clip gardé/)).toBeNull()
  })
})

describe('le lecteur et la bande', () => {
  it('déplace la lecture au clic hors bloc', async () => {
    renderView()
    const band = screen.getByTestId('coverage-timeline')
    // jsdom ne met rien en page : le rectangle est nul, et `instantAuClic` rend
    // alors 0 plutôt qu'un infini. Ce qui se vérifie ici est le câblage —
    // l'arithmétique est éprouvée dans `tests/core/coverage.test.ts`.
    vi.spyOn(band, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width: 1_000,
      top: 0,
      right: 1_000,
      bottom: 24,
      height: 24,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    await userEvent.pointer({ target: band, coords: { clientX: 250, clientY: 5 }, keys: '[MouseLeft]' })

    const video = screen.getByTestId('lecteur-emission') as HTMLVideoElement
    expect(video.currentTime).toBe(1_500)
    expect(screen.getByTestId('playhead').style.left).toBe('25%')
  })

  it('ne promet aucun déplacement quand le proxy n’est pas encodé', async () => {
    // Un curseur qui change de forme sur une surface inerte est la façon la plus
    // sûre de faire cliquer trois fois.
    renderView({ proxyReady: false })
    expect(screen.queryByTestId('lecteur-emission')).toBeNull()
    expect(screen.getByTestId('proxy-absent').textContent).toContain(
      'Les images arrivent avec le proxy',
    )
    expect(screen.getByTestId('coverage-timeline').className).not.toContain('cursor-pointer')
  })

  it('sert le proxy par la route qui répond aux requêtes partielles', () => {
    // Sans réponse aux plages d'octets, un `<video>` ne peut pas sauter et la
    // barre de lecture reste inerte.
    renderView()
    const video = screen.getByTestId('lecteur-emission')
    expect(video.getAttribute('src')).toBe('/api/projects/cqlp/proxy')
    expect(video.getAttribute('preload')).toBe('metadata')
  })
})
