// @vitest-environment jsdom

/**
 * La grille des sources et ses cinq états.
 *
 * Deux d'entre eux portent l'essentiel de ce lot. **Les deux vides ne se
 * confondent pas** : « ce dossier est vide » et « ce montage n'a pas eu lieu »
 * rendaient la même page dans OpenShorts, et c'est l'incident que
 * `SourcesListing.montage` existe pour fermer. **Et l'erreur affiche le message
 * du serveur**, jamais une phrase composée ici.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CLE_DEFILEMENT, GrilleSources } from '@/components/sources/grille-sources'
import type { Creation } from '@/components/sources/source-card'
import type { Source, SourcesListing } from '@/lib/api'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

const CQLP: Source = {
  name: '2025-06-15-cqlp.mp4',
  sizeBytes: 4_300_000_000,
  modifiedAt: '2025-06-15T19:04:00.000Z',
  projectId: null,
}

const MONTÉ = { disponible: true, fstype: '9p', entrées: 21 }

function listing(partiel: Partial<SourcesListing> = {}): SourcesListing {
  return { sources: [CQLP], montage: MONTÉ, ...partiel }
}

function creation(partiel: Partial<Creation> = {}): Creation {
  return { enCours: null, erreur: null, lancer: vi.fn(), ...partiel }
}

function grille(props: Partial<Parameters<typeof GrilleSources>[0]> = {}) {
  return render(
    <GrilleSources
      listing={listing()}
      chargement={false}
      erreur={null}
      onReessayer={vi.fn()}
      creation={creation()}
      {...props}
    />,
  )
}

describe('GrilleSources, au chargement', () => {
  it('pose des squelettes plutôt que de laisser la place vide', () => {
    // Aux dimensions finales : une grille qui se remplit de cartes plus hautes
    // que ses squelettes saute au moment où l'œil s'y pose.
    const { container } = grille({ listing: undefined, chargement: true })

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    // Et surtout, pas d'état vide : « rien n'est encore arrivé » n'est pas
    // « il n'y a rien ».
    expect(screen.queryByText(/vide|n’est pas monté/)).toBeNull()
  })
})

describe('GrilleSources, quand il y a des replays', () => {
  it('en fait une liste de liens et de boutons, tabulable telle quelle', () => {
    grille({
      listing: listing({
        sources: [CQLP, { ...CQLP, name: 'autre.mp4', projectId: 'autre' }],
      }),
    })

    expect(screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ })).toBeTruthy()
    expect(screen.getByRole('link', { name: /autre\.mp4/ })).toBeTruthy()
  })

  it('compte au singulier quand il n’y en a qu’un', () => {
    grille()
    expect(screen.getByText('1 replay')).toBeTruthy()
  })

  it('dit combien sont déjà analysés, puisqu’il le sait', () => {
    grille({
      listing: listing({
        sources: [CQLP, { ...CQLP, name: 'a.mp4', projectId: 'a' }, { ...CQLP, name: 'b.mp4' }],
      }),
    })
    expect(screen.getByText(/3 replays/)).toBeTruthy()
    expect(screen.getByText(/1 déjà analysé$/)).toBeTruthy()
  })
})

describe('GrilleSources, les deux vides', () => {
  it('distingue un dossier vraiment vide', () => {
    grille({ listing: { sources: [], montage: { disponible: true, fstype: '9p', entrées: 0 } } })

    expect(screen.getByText('Le dossier des replays est vide.')).toBeTruthy()
    // Le type de système de fichiers est la preuve que le montage a bien eu
    // lieu : sans lui, « vide » et « absent » se lisent pareil.
    expect(screen.getByText(/9p/)).toBeTruthy()
  })

  it('distingue un dossier plein d’autre chose', () => {
    // `entrées` compte tout, vidéos ou non. Trois fichiers dont aucune vidéo est
    // un diagnostic, pas un vide.
    grille({ listing: { sources: [], montage: { disponible: true, fstype: '9p', entrées: 3 } } })

    expect(screen.getByText(/3 entrées/)).toBeTruthy()
    expect(screen.queryByText('Le dossier des replays est vide.')).toBeNull()
  })

  it('nomme le montage absent, et le geste qui le répare', async () => {
    // Le pire cas du parcours : montage absent et aucun projet. Une seule
    // phrase, et l'action qui la lève — prise de `CLAUDE.md`.
    const onReessayer = vi.fn()
    grille({
      listing: { sources: [], montage: { disponible: false, fstype: null, entrées: 0 } },
      onReessayer,
    })

    expect(screen.getByText('Le dossier des replays n’est pas monté.')).toBeTruthy()
    expect(screen.getByText(/lecteur côté Windows/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(onReessayer).toHaveBeenCalledTimes(1)
  })
})

describe('GrilleSources, les erreurs', () => {
  it('affiche le message du serveur, et propose de réessayer', async () => {
    const onReessayer = vi.fn()
    grille({
      listing: undefined,
      erreur: 'REPLAY_DIR est absent de l’environnement.',
      onReessayer,
    })

    const alerte = screen.getByRole('alert')
    expect(alerte.textContent).toContain('REPLAY_DIR est absent de l’environnement.')

    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(onReessayer).toHaveBeenCalledTimes(1)
  })

  it('reprend tel quel le 503 d’une création sur un Drive muet', () => {
    // Ce texte est déjà écrit côté serveur, et déjà épuré de ses chemins
    // absolus. Le réécrire ici en produirait une seconde version, qui
    // vieillirait séparément.
    const duServeur =
      'Le dossier des replays ne répond pas. REPLAY_DIR est monté en 9p : il peut être absent, ' +
      'ou monté avec son transport mort dessous. Rouvrir le lecteur côté Windows, ou remonter le partage.'
    grille({ creation: creation({ erreur: duServeur }) })

    expect(screen.getByRole('alert').textContent).toContain(duServeur)
  })

  it('dit aussi la source disparue entre l’affichage et le clic', () => {
    // Un 404 du serveur, mot pour mot. Rien à composer : la grille se
    // rafraîchit et la carte s'en va.
    grille({ creation: creation({ erreur: 'Aucun replay nommé "vieux.mp4" dans REPLAY_DIR.' }) })
    expect(screen.getByRole('alert').textContent).toContain('Aucun replay nommé "vieux.mp4"')
  })
})

describe('GrilleSources, le retour', () => {
  it('rend la grille où on l’avait laissée', () => {
    // Vingt et une cartes : revenir en haut à chaque retour d'un projet ferait
    // redemander ce qui a déjà été vu.
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    sessionStorage.setItem(CLE_DEFILEMENT, '420')

    grille()

    expect(scrollTo).toHaveBeenCalledWith(0, 420)
  })

  it('ne restaure rien tant que les cartes ne sont pas là', () => {
    // Rendre le défilement sur une page de squelettes le poserait sur une
    // hauteur qui n'est pas encore la bonne.
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    sessionStorage.setItem(CLE_DEFILEMENT, '420')

    grille({ listing: undefined, chargement: true })

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('retient la position pendant qu’on descend', () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    grille()

    Object.defineProperty(window, 'scrollY', { value: 300, configurable: true })
    window.dispatchEvent(new Event('scroll'))

    expect(sessionStorage.getItem(CLE_DEFILEMENT)).toBe('300')
  })
})

describe('GrilleSources et la création', () => {
  it('confie le clic à la page, qui seule sait rediriger', async () => {
    const c = creation()
    grille({ creation: c })

    await userEvent.click(screen.getByRole('button', { name: /2025-06-15-cqlp\.mp4/ }))
    expect(c.lancer).toHaveBeenCalledWith(CQLP)
  })
})
