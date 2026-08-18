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

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ShowView } from '@/components/show/show-view'
import type { Segment } from '@/core/edl'
import type { CandidateClip } from '@/lib/api'

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
    preview: 'Trois premières phrases.',
    thumbnailUrl: `/api/clips/${id}/thumb`,
    ...partial,
  }
}

function vue(partial: Partial<Parameters<typeof ShowView>[0]> = {}) {
  return render(
    <ShowView
      projectId="cqlp"
      durationSec={DURATION}
      proxyReady
      clips={[clip('a', [{ start: 600, end: 660 }])]}
      {...partial}
    />,
  )
}

/** Les blocs de la bande, dans l'ordre du DOM. */
function blocs(): HTMLElement[] {
  return Array.from(
    screen.getByTestId('coverage-timeline').querySelectorAll<HTMLElement>('[data-clip]'),
  )
}

describe('la bande de couverture', () => {
  it('ne pose un bloc que pour les clips gardés', () => {
    // Une proposition ni gardée ni écartée n'a rien extrait de l'émission, et un
    // écarté encore moins.
    vue({
      clips: [
        clip('gardé', [{ start: 0, end: 60 }]),
        clip('proposé', [{ start: 600, end: 660 }], { status: 'candidate' }),
        clip('écarté', [{ start: 1200, end: 1260 }], { status: 'discarded' }),
        clip('exporté', [{ start: 1800, end: 1860 }], { status: 'exported' }),
      ],
    })
    expect(blocs().map((b) => b.getAttribute('data-clip'))).toEqual(['gardé', 'exporté'])
  })

  it('mène au clip qu’on clique', () => {
    vue()
    expect(blocs()[0]).toHaveProperty('pathname', '/clips/a')
  })

  it('place le bloc à sa position dans l’émission', () => {
    // 600 s sur 6 000 : un dixième, et un centième de large.
    vue()
    expect(blocs()[0].style.left).toBe('10%')
    expect(blocs()[0].style.width).toBe('1%')
  })

  it('couvre le trou d’un passage retiré, sans le combler', () => {
    // Un clip est une liste de segments : retirer un passage par le milieu
    // laisse un trou, mais le clip occupe toujours la même place dans
    // l'émission. La bande décrit la couverture, la durée se lit à côté.
    vue({ clips: [clip('a', [{ start: 600, end: 660 }, { start: 1_200, end: 1_260 }])] })
    expect(blocs()[0].style.left).toBe('10%')
    expect(blocs()[0].style.width).toBe('11%')
  })

  it('sépare en voies deux clips qui se chevauchent', () => {
    // L'exigence explicite du retour d'usage : empilés sur une ligne, le second
    // efface le premier et le survol n'en désigne qu'un sans dire lequel.
    vue({
      clips: [
        clip('a', [{ start: 600, end: 1_200 }]),
        clip('b', [{ start: 900, end: 1_500 }]),
      ],
    })
    const [a, b] = blocs()
    expect(a.style.top).not.toBe(b.style.top)
  })

  it('compte ce qui a été gardé, en toutes lettres', () => {
    vue({
      clips: [clip('a', [{ start: 0, end: 60 }]), clip('b', [{ start: 600, end: 660 }])],
    })
    expect(screen.getByText('2 clips gardés sur 1:40:00 d’émission.')).toBeTruthy()
  })

  it('dit qu’il n’y a rien d’extrait plutôt que de rendre une bande muette', () => {
    vue({ clips: [] })
    expect(screen.getByText(/Aucun clip gardé pour l’instant/)).toBeTruthy()
  })

  it('se tait sur la durée tant que l’ingestion ne l’a pas sondée', () => {
    // `durationSec` vaut zéro sur un projet créé il y a trois secondes : dessiner
    // une bande sans échelle placerait tous les blocs au même endroit.
    vue({ durationSec: 0 })
    expect(screen.queryByTestId('coverage-timeline')).toBeNull()
    expect(screen.getByText(/n’est pas encore connue/)).toBeTruthy()
  })
})

describe('le lecteur et la bande', () => {
  it('déplace la lecture au clic hors bloc', async () => {
    vue()
    const bande = screen.getByTestId('coverage-timeline')
    // jsdom ne met rien en page : le rectangle est nul, et `instantAuClic` rend
    // alors 0 plutôt qu'un infini. Ce qui se vérifie ici est le câblage —
    // l'arithmétique est éprouvée dans `tests/core/couverture.test.ts`.
    vi.spyOn(bande, 'getBoundingClientRect').mockReturnValue({
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

    await userEvent.pointer({ target: bande, coords: { clientX: 250, clientY: 5 }, keys: '[MouseLeft]' })

    const vidéo = screen.getByTestId('lecteur-emission') as HTMLVideoElement
    expect(vidéo.currentTime).toBe(1_500)
    expect(screen.getByTestId('playhead').style.left).toBe('25%')
  })

  it('ne promet aucun déplacement quand le proxy n’est pas encodé', async () => {
    // Un curseur qui change de forme sur une surface inerte est la façon la plus
    // sûre de faire cliquer trois fois.
    vue({ proxyReady: false })
    expect(screen.queryByTestId('lecteur-emission')).toBeNull()
    expect(screen.getByTestId('proxy-absent').textContent).toContain(
      'Les images arrivent avec le proxy',
    )
    expect(screen.getByTestId('coverage-timeline').className).not.toContain('cursor-pointer')
  })

  it('sert le proxy par la route qui répond aux requêtes partielles', () => {
    // Sans réponse aux plages d'octets, un `<video>` ne peut pas sauter et la
    // barre de lecture reste inerte.
    vue()
    const vidéo = screen.getByTestId('lecteur-emission')
    expect(vidéo.getAttribute('src')).toBe('/api/projects/cqlp/proxy')
    expect(vidéo.getAttribute('preload')).toBe('metadata')
  })
})
