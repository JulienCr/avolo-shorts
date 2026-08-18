// @vitest-environment jsdom

/**
 * La grille de la bibliothèque : les filtres, la recherche et les cinq états
 * d'écran.
 *
 * **Aucune émission n'y apparaît deux fois**, c'est le défaut que cette grille
 * remplace. Et les deux vides ne se confondent pas : « aucune émission en
 * erreur » est une bonne nouvelle, « ce montage n'a pas eu lieu » en est une
 * mauvaise, et les deux rendaient la même page grise dans OpenShorts.
 */

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LibraryGrid } from '@/components/sources/library'
import type { Creation } from '@/components/sources/show-card'
import { buildLibrary } from '@/core/library'
import type { CauseIndisponible, ProjectListItem, Source, SourcesListing } from '@/lib/api'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

const MONTÉ: SourcesListing['montage'] = {
  disponible: true,
  cause: null,
  fstype: '9p',
  entrées: 3,
}

function source(name: string, projectId: string | null = null): Source {
  return {
    name,
    sizeBytes: 4_300_000_000,
    modifiedAt: '2025-06-15T19:04:00.000Z',
    projectId,
    thumbnailUrl: `/api/sources/thumb?file=${name}`,
  }
}

function project(id: string, partial: Partial<ProjectListItem> = {}): ProjectListItem {
  return {
    id,
    title: id,
    durationSec: 5_940,
    createdAt: '2025-06-15T19:04:00.000Z',
    running: null,
    error: null,
    ...partial,
  }
}

function creation(partial: Partial<Creation> = {}): Creation {
  return { pending: null, error: null, start: vi.fn(), ...partial }
}

/** Les cinq états, une émission chacun. */
const SOURCES = [
  source('a-neuve.mp4'),
  source('b-encours.mp4', 'b'),
  source('c-interrompue.mp4', 'c'),
  source('d-echec.mp4', 'd'),
  source('e-analysee.mp4', 'e'),
]
const PROJETS = [
  project('b', { running: { step: 'proxy', progress: 0.3 } }),
  project('c', { durationSec: 0 }),
  project('d', { error: 'ffmpeg est tombé.' }),
  project('e'),
]

function grille(props: Partial<Parameters<typeof LibraryGrid>[0]> = {}) {
  return render(
    <LibraryGrid
      entries={buildLibrary(SOURCES, PROJETS)}
      projects={PROJETS}
      mount={MONTÉ}
      loading={false}
      error={null}
      projectsError={null}
      onRetry={vi.fn()}
      creation={creation()}
      {...props}
    />,
  )
}

/** Les titres visibles, dans l'ordre de la grille. */
function titres(): string[] {
  return screen
    .getAllByRole('listitem')
    .map((li) => li.querySelector('[data-title]')?.textContent ?? '')
}

describe('la grille unifiée', () => {
  it('montre chaque émission une fois et une seule', () => {
    grille()
    for (const s of SOURCES) {
      expect(screen.getAllByText(s.name)).toHaveLength(1)
    }
  })

  it('résume le nombre d’émissions et celles qui sont analysées', () => {
    grille()
    expect(screen.getByText('5 émissions · 1 analysée')).toBeTruthy()
  })
})

describe('les filtres', () => {
  it('portent le compte de ce qu’ils retiennent', () => {
    grille()
    const onglets = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(onglets).toEqual(['Tous5', 'À analyser1', 'En cours1', 'Analysés1', 'Erreurs2'])
  })

  it('range l’interrompue et l’échouée sous « Erreurs »', async () => {
    // C'est le regroupement du retour d'usage, et les deux appellent le même
    // geste : reprendre l'analyse.
    grille()
    await userEvent.click(screen.getByRole('tab', { name: /Erreurs/ }))
    expect(titres()).toEqual(['c-interrompue.mp4', 'd-echec.mp4'])
  })

  it('ne retient que les neuves sous « À analyser »', async () => {
    grille()
    await userEvent.click(screen.getByRole('tab', { name: /À analyser/ }))
    expect(titres()).toEqual(['a-neuve.mp4'])
  })

  it('dit pourquoi un filtre ne rend rien, sans le confondre avec un dossier vide', async () => {
    grille({ entries: buildLibrary([source('a.mp4')], []) })
    await userEvent.click(screen.getByRole('tab', { name: /Analysés/ }))
    expect(screen.getByText('Aucune émission n’est encore analysée.')).toBeTruthy()
  })
})

describe('la recherche', () => {
  it('filtre par titre, sans tenir compte de la casse', async () => {
    grille()
    await userEvent.type(screen.getByRole('searchbox'), 'ECHEC')
    expect(titres()).toEqual(['d-echec.mp4'])
  })

  it('se compose avec le filtre actif', async () => {
    grille()
    await userEvent.click(screen.getByRole('tab', { name: /Erreurs/ }))
    await userEvent.type(screen.getByRole('searchbox'), 'interrompue')
    expect(titres()).toEqual(['c-interrompue.mp4'])
  })

  it('laisse les comptes des filtres intacts pendant la frappe', async () => {
    // Ces comptes servent à choisir un filtre : les faire fondre au fil de la
    // frappe ferait dire « Erreurs 0 » là où quelque chose a échoué.
    grille()
    await userEvent.type(screen.getByRole('searchbox'), 'zzz')
    expect(screen.getByRole('tab', { name: /Erreurs/ }).textContent).toBe('Erreurs2')
  })

  it('propose d’effacer une recherche qui ne rend rien', async () => {
    grille()
    await userEvent.type(screen.getByRole('searchbox'), 'zzz')
    expect(screen.getByText(/Aucune émission ne porte/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Effacer la recherche' }))
    expect(titres()).toHaveLength(5)
  })
})

describe('les états d’écran', () => {
  it('pose des squelettes tant qu’une des deux listes n’a pas répondu', () => {
    const { container } = grille({ loading: true })
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('affiche le message du serveur quand les émissions ne se listent pas', () => {
    grille({ error: 'REPLAY_DIR est absent.' })
    expect(screen.getByText('REPLAY_DIR est absent.')).toBeTruthy()
  })

  it('avertit quand l’état des analyses n’a pas pu être lu', () => {
    // Sans ce mot, une API de projets en panne rendait la même page qu'une
    // bibliothèque où rien n'est analysé : dix-huit cartes « À analyser » sur
    // des émissions déjà traitées, ce qui invite à relancer pour rien.
    grille({ projectsError: 'La base ne répond pas.' })
    expect(screen.getByText(/annoncer « À analyser » à tort/)).toBeTruthy()
    expect(screen.getByText('La base ne répond pas.')).toBeTruthy()
  })

  it('distingue un dossier vide d’un montage qui n’a pas eu lieu', () => {
    const cause: CauseIndisponible = 'absent'
    grille({
      entries: [],
      projects: [],
      mount: { disponible: false, cause, fstype: null, entrées: 0 },
    })
    expect(screen.getByText('Le dossier des replays n’existe pas à ce chemin.')).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('affiche l’échec d’une création au-dessus de la grille, pas dans la carte', () => {
    // La carte peut avoir disparu sous un filtre au rendu suivant, et le
    // message serait parti avec elle.
    grille({ creation: creation({ error: 'Le dossier des replays ne répond pas.' }) })
    const alerte = screen.getByRole('alert')
    expect(within(alerte).getByText('Le dossier des replays ne répond pas.')).toBeTruthy()
  })
})
