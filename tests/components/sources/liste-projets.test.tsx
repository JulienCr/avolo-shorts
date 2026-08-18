// @vitest-environment jsdom

/**
 * La section des projets : **ce qui rend supportable de lancer une analyse puis
 * d'aller trier ailleurs**.
 *
 * Trois choses s'y jouent, et aucune n'existe dans l'écran d'aujourd'hui : un
 * projet dit ce qui tourne, un projet dit ce qui a échoué, et la section
 * disparaît quand il n'y a rien — au lieu d'afficher un titre au-dessus du vide.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ListeProjets } from '@/components/sources/liste-projets'
import type { ProjectListItem } from '@/lib/api'

afterEach(cleanup)

const CQLP: ProjectListItem = {
  id: '2025-06-15-cqlp',
  title: 'La scène du 15 juin',
  durationSec: 5_940,
  createdAt: '2025-06-15T19:04:00.000Z',
  running: null,
  error: null,
}

function liste(props: Partial<Parameters<typeof ListeProjets>[0]> = {}) {
  return render(
    <ListeProjets
      projets={[CQLP]}
      chargement={false}
      erreur={null}
      onReessayer={vi.fn()}
      {...props}
    />,
  )
}

describe('ListeProjets', () => {
  it('mène à chaque projet', () => {
    liste()
    expect(screen.getByRole('link', { name: /La scène du 15 juin/ })).toHaveProperty(
      'pathname',
      '/projects/2025-06-15-cqlp',
    )
  })

  it('disparaît entièrement quand il n’y a aucun projet', () => {
    // La grille prend alors toute la place. Un titre « Projets » au-dessus d'un
    // vide occuperait le haut de l'écran pour ne rien dire.
    const { container } = liste({ projets: [] })
    expect(container.firstChild).toBeNull()
  })

  it('pose des squelettes le temps que la liste arrive', () => {
    const { container } = liste({ projets: undefined, chargement: true })
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })
})

describe('ListeProjets, ce qui tourne', () => {
  it('dit l’étape en cours et son avancement', () => {
    liste({ projets: [{ ...CQLP, running: { step: 'transcript', progress: 0.4 } }] })

    const barre = screen.getByRole('progressbar')
    expect(barre.getAttribute('aria-valuenow')).toBe('40')
    expect(barre.getAttribute('aria-label')).toBe('Transcription en cours')
  })

  it('ne montre pas de barre sur un projet au repos', () => {
    liste()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('compte les analyses en cours et les échecs, au pluriel juste', () => {
    liste({
      projets: [
        { ...CQLP, running: { step: 'proxy', progress: 0.1 } },
        { ...CQLP, id: 'b', title: 'B', running: { step: 'audio', progress: 0.5 } },
        { ...CQLP, id: 'c', title: 'C', error: 'ffmpeg a rendu 1.' },
        { ...CQLP, id: 'd', title: 'D' },
      ],
    })

    expect(screen.getByText('4 émissions · 2 analyses en cours · 1 en échec')).toBeTruthy()
  })
})

describe('ListeProjets, ce qui a échoué', () => {
  it('affiche le message du serveur, pas une phrase à nous', () => {
    // `ProjectStatus.error` est déjà épuré de ses chemins absolus. C'est le seul
    // chemin par lequel l'échec d'une tâche de fond revient jusqu'à l'écran :
    // le lanceur rend la main bien après la réponse 202.
    liste({ projets: [{ ...CQLP, error: 'Le repérage n’a rien rendu : quota Gemini épuisé.' }] })
    expect(screen.getByText('Le repérage n’a rien rendu : quota Gemini épuisé.')).toBeTruthy()
  })

  it('laisse le message aller à la ligne plutôt que de le couper', () => {
    // **Un message présent dans le DOM mais coupé à l'écran n'est pas affiché.**
    // La cause utile d'un échec est au bout de la phrase, pas au début, et une
    // ligne tronquée n'a aucun moyen de la révéler. La rangée grandit, c'est
    // tout — c'est ce que `min-h` permet. (relevé par Copilot)
    //
    // L'assertion porte sur la classe faute de mieux : jsdom ne calcule aucune
    // mise en page, donc la troncature elle-même n'y est pas observable.
    liste({ projets: [{ ...CQLP, error: 'Un message assez long pour déborder d’une rangée.' }] })
    const message = screen.getByText('Un message assez long pour déborder d’une rangée.')
    expect(message.className).not.toContain('truncate')
  })

  it('affiche le message du serveur quand la liste elle-même échoue', async () => {
    // Sans cet état, une API en panne rend exactement la même page qu'une
    // bibliothèque vide.
    const onReessayer = vi.fn()
    liste({ projets: undefined, erreur: 'La base est verrouillée.', onReessayer })

    expect(screen.getByRole('alert').textContent).toContain('La base est verrouillée.')
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(onReessayer).toHaveBeenCalledTimes(1)
  })
})

describe('ListeProjets, ce qui se dit à voix haute', () => {
  it('annonce l’étape, jamais le pourcentage', () => {
    // Un sondage toutes les deux secondes sur une analyse de neuf minutes ferait
    // deux cent soixante-dix annonces. `aria-valuenow` se met à jour en silence.
    const { rerender } = liste({
      projets: [{ ...CQLP, running: { step: 'transcript', progress: 0.1 } }],
    })

    const region = screen.getByRole('status')
    expect(region.textContent).toContain('Transcription')
    expect(region.textContent).not.toContain('%')

    // Le même texte après un tour de sondage : rien ne change dans le DOM, donc
    // rien n'est annoncé.
    const avant = region.textContent
    rerender(
      <ListeProjets
        projets={[{ ...CQLP, running: { step: 'transcript', progress: 0.9 } }]}
        chargement={false}
        erreur={null}
        onReessayer={vi.fn()}
      />,
    )
    expect(screen.getByRole('status').textContent).toBe(avant)

    // Un changement d'étape, lui, se dit.
    rerender(
      <ListeProjets
        projets={[{ ...CQLP, running: { step: 'candidates', progress: 0 } }]}
        chargement={false}
        erreur={null}
        onReessayer={vi.fn()}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('Repérage')
  })

  it('annonce la fin, qui est ce qu’on attend pour revenir', () => {
    const { rerender } = liste({
      projets: [{ ...CQLP, running: { step: 'proxy', progress: 0.9 } }],
    })

    rerender(
      <ListeProjets projets={[CQLP]} chargement={false} erreur={null} onReessayer={vi.fn()} />,
    )
    expect(screen.getByRole('status').textContent).toContain('analyse terminée')
  })

  it('annonce un échec comme un échec, pas comme une fin', () => {
    const { rerender } = liste({
      projets: [{ ...CQLP, running: { step: 'proxy', progress: 0.9 } }],
    })

    rerender(
      <ListeProjets
        projets={[{ ...CQLP, error: 'ffmpeg a rendu 1.' }]}
        chargement={false}
        erreur={null}
        onReessayer={vi.fn()}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('analyse en échec')
  })
})
