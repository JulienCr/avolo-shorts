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
import type { CauseUnavailable, ProjectListItem, Source, SourcesListing } from '@/lib/api'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

const MOUNTED: SourcesListing['editing'] = {
  available: true,
  cause: null,
  fstype: '9p',
  entries: 3,
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
    warning: null,
    stopped: false,
    everRan: true,
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
const PROJECTS = [
  project('b', { running: { step: 'proxy', progress: 0.3, waiting: null } }),
  project('c', { stopped: true }),
  project('d', { error: 'ffmpeg est tombé.' }),
  project('e'),
]

function renderGrid(props: Partial<Parameters<typeof LibraryGrid>[0]> = {}) {
  return render(
    <LibraryGrid
      entries={buildLibrary(SOURCES, PROJECTS)}
      projects={PROJECTS}
      mount={MOUNTED}
      loading={false}
      error={null}
      projectsError={null}
      onRetry={vi.fn()}
      creation={creation()}
      {...props}
    />,
  )
}

/**
 * Les noms de fichiers visibles, dans l'ordre de la grille.
 *
 * Le nom de fichier plutôt que le titre : c'est l'identité stable d'une carte —
 * le titre, lui, est dérivé par `titleProject` et c'est ce qu'un test dédié
 * vérifie plus bas.
 */
function files(): string[] {
  return screen
    .getAllByRole('listitem')
    .map((li) => li.querySelector('[data-file]')?.textContent ?? '')
}

describe('la grille unifiée', () => {
  it('montre chaque émission une fois et une seule', () => {
    renderGrid()
    for (const s of SOURCES) {
      expect(screen.getAllByText(s.name)).toHaveLength(1)
    }
  })

  it('titre les cartes par l’émission, et garde le fichier en métadonnée', () => {
    // Dans une bibliothèque d'émissions, `2025-06-15-cqlp.mp4` n'est pas un
    // titre : c'est un nom de fichier. Il reste affiché, parce que c'est par lui
    // qu'on fait le lien avec ce qui est posé sur le Drive.
    renderGrid({ entries: buildLibrary([source('2025-06-15-cqlp.mp4')], []) })
    const card = screen.getByRole('listitem')
    expect(card.querySelector('[data-title]')?.textContent).toBe('cqlp — 15 juin 2025')
    expect(card.querySelector('[data-file]')?.textContent).toBe('2025-06-15-cqlp.mp4')
  })

  it('résume le nombre d’émissions et celles qui sont analysées', () => {
    renderGrid()
    expect(screen.getByText('5 émissions · 1 analysée')).toBeTruthy()
  })
})

describe('les filtres', () => {
  it('portent le compte de ce qu’ils retiennent', () => {
    renderGrid()
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(tabs).toEqual(['Tous5', 'À analyser1', 'En cours1', 'Analysés1', 'Erreurs2'])
  })

  it('range l’interrompue et l’échouée sous « Erreurs »', async () => {
    // C'est le regroupement du retour d'usage, et les deux appellent le même
    // geste : reprendre l'analyse.
    renderGrid()
    await userEvent.click(screen.getByRole('tab', { name: /Erreurs/ }))
    expect(files()).toEqual(['c-interrompue.mp4', 'd-echec.mp4'])
  })

  it('ne retient que les neuves sous « À analyser »', async () => {
    renderGrid()
    await userEvent.click(screen.getByRole('tab', { name: /À analyser/ }))
    expect(files()).toEqual(['a-neuve.mp4'])
  })

  it('dit pourquoi un filtre ne rend rien, sans le confondre avec un dossier vide', async () => {
    renderGrid({ entries: buildLibrary([source('a.mp4')], []) })
    await userEvent.click(screen.getByRole('tab', { name: /Analysés/ }))
    expect(screen.getByText('Aucune émission n’est encore analysée.')).toBeTruthy()
  })
})

describe('la recherche', () => {
  it('filtre par titre, sans tenir compte de la casse', async () => {
    renderGrid()
    await userEvent.type(screen.getByRole('searchbox'), 'ECHEC')
    expect(files()).toEqual(['d-echec.mp4'])
  })

  it('trouve une émission par le nom de fichier qu’elle affiche', async () => {
    // Le titre d'une émission datée ne contient pas la date au format du
    // fichier : sans ce chemin, le nom qu'on a sous les yeux dans un
    // explorateur ne se taperait pas.
    renderGrid({ entries: buildLibrary([source('2025-06-15-cqlp.mp4'), source('autre.mp4')], []) })
    await userEvent.type(screen.getByRole('searchbox'), '2025-06')
    expect(files()).toEqual(['2025-06-15-cqlp.mp4'])
  })

  it('se compose avec le filtre actif', async () => {
    renderGrid()
    await userEvent.click(screen.getByRole('tab', { name: /Erreurs/ }))
    await userEvent.type(screen.getByRole('searchbox'), 'interrompue')
    expect(files()).toEqual(['c-interrompue.mp4'])
  })

  it('laisse les comptes des filtres intacts pendant la frappe', async () => {
    // Ces comptes servent à choisir un filtre : les faire fondre au fil de la
    // frappe ferait dire « Erreurs 0 » là où quelque chose a échoué.
    renderGrid()
    await userEvent.type(screen.getByRole('searchbox'), 'zzz')
    expect(screen.getByRole('tab', { name: /Erreurs/ }).textContent).toBe('Erreurs2')
  })

  it('propose d’effacer une recherche qui ne rend rien', async () => {
    renderGrid()
    await userEvent.type(screen.getByRole('searchbox'), 'zzz')
    expect(screen.getByText(/Aucune émission ne porte/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Effacer la recherche' }))
    expect(files()).toHaveLength(5)
  })
})

describe('ce qui se dit à voix haute', () => {
  /** Deux relevés successifs, comme le sondage les rend. */
  function announce(before: ProjectListItem[], after: ProjectListItem[]): string {
    const { rerender } = renderGrid({ entries: buildLibrary([], before), projects: before })
    rerender(
      <LibraryGrid
        entries={buildLibrary([], after)}
        projects={after}
        mount={MOUNTED}
        loading={false}
        error={null}
        projectsError={null}
        onRetry={vi.fn()}
        creation={creation()}
      />,
    )
    return screen.getByRole('status').textContent ?? ''
  }

  it('dit « arrêtée » et non « terminée » après un arrêt', () => {
    // **Un arrêt demandé laisse `error` à `null`** — ce n'est pas une panne —,
    // si bien que la région live annonçait « analyse terminée » au moment précis
    // où la carte affichait « Analyse interrompue ». Deux surfaces qui décrivent
    // le même projet ne peuvent pas se contredire, et c'est celle qu'on n'entend
    // qu'une fois qui aurait menti. (relevé par Copilot)
    const inCurrent = project('a', { running: { step: 'proxy', progress: 0.3, waiting: null } })
    expect(announce([inCurrent], [project('a', { stopped: true })])).toContain('arrêtée')
  })

  it('dit « terminée » sur une fin ordinaire', () => {
    const inCurrent = project('a', { running: { step: 'proxy', progress: 0.3, waiting: null } })
    expect(announce([inCurrent], [project('a')])).toContain('terminée')
  })

  it('dit « en échec » sur un échec', () => {
    const inCurrent = project('a', { running: { step: 'proxy', progress: 0.3, waiting: null } })
    expect(announce([inCurrent], [project('a', { error: 'tombé' })])).toContain('échec')
  })
})

describe('les états d’écran', () => {
  it('pose des squelettes tant qu’une des deux listes n’a pas répondu', () => {
    const { container } = renderGrid({ loading: true })
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('affiche le message du serveur sans emporter les émissions', () => {
    // **La panne des replays ne remplace plus la grille.** Elle la remplaçait,
    // et les émissions déjà analysées devenaient inatteignables — leurs clips,
    // leurs rendus — sur une panne qui ne les concerne pas.
    // (relevé par Copilot)
    renderGrid({
      error: 'REPLAY_DIR est absent.',
      entries: buildLibrary([], [project('a')], false),
      mount: undefined,
    })
    expect(screen.getByText('REPLAY_DIR est absent.')).toBeTruthy()
    expect(screen.getByText(/Replay inconnu/)).toBeTruthy()
  })

  it('dit l’incident de montage même quand des émissions restent affichées', () => {
    // Il dépendait du nombre d'entrées, donc ne s'affichait jamais dès qu'un
    // seul projet existait : le partage pouvait être tombé, la bibliothèque
    // montrait des cartes et se taisait sur la cause. (relevé par Copilot)
    renderGrid({
      entries: buildLibrary([], [project('a')], false),
      mount: { available: false, cause: 'silent', fstype: '9p', entries: 0 },
    })
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText(/Replay inconnu/)).toBeTruthy()
  })

  it('avertit quand l’état des analyses n’a pas pu être lu', () => {
    // Sans ce mot, une API de projets en panne rendait la même page qu'une
    // bibliothèque où rien n'est analysé. L'écran ne fabrique plus d'entrée dans
    // ce cas — c'est l'affaire de `library-screen` — et le bandeau dit ce qui
    // manque plutôt que de le deviner.
    renderGrid({ projectsError: 'La base ne répond pas.' })
    expect(screen.getByText(/L’état des analyses n’a pas pu être lu/)).toBeTruthy()
    expect(screen.getByText('La base ne répond pas.')).toBeTruthy()
  })

  it('distingue un dossier vide d’un montage qui n’a pas eu lieu', () => {
    const cause: CauseUnavailable = 'absent'
    renderGrid({
      entries: [],
      projects: [],
      mount: { available: false, cause, fstype: null, entries: 0 },
    })
    expect(screen.getByText('Le dossier des replays n’existe pas à ce chemin.')).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('affiche l’échec d’une création au-dessus de la grille, pas dans la carte', () => {
    // La carte peut avoir disparu sous un filtre au rendu suivant, et le
    // message serait parti avec elle.
    renderGrid({ creation: creation({ error: 'Le dossier des replays ne répond pas.' }) })
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('Le dossier des replays ne répond pas.')).toBeTruthy()
  })
})
