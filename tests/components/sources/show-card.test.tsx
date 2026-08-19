// @vitest-environment jsdom

/**
 * La carte d'une émission, et ses cinq états.
 *
 * Deux propriétés portent ce fichier. **Les cinq états se distinguent**, sans
 * quoi la bibliothèque unifiée ne vaudrait pas mieux que les deux sections
 * qu'elle remplace. Et **la hauteur ne bouge pas d'un état à l'autre** : une
 * carte qui grandit en gagnant sa barre d'avancement au tour de sondage suivant
 * déplace tout ce qui la suit, sous les yeux et sous le curseur.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CARD_HEIGHT,
  ShowCard,
  type Creation,
  type Entry,
} from '@/components/sources/show-card'
import { buildLibrary } from '@/core/library'
import type { ProjectListItem, Source } from '@/lib/api'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SOURCE: Source = {
  name: '2025-06-15-cqlp.mp4',
  sizeBytes: 4_300_000_000,
  modifiedAt: '2025-06-15T19:04:00.000Z',
  projectId: null,
  thumbnailUrl: '/api/sources/thumb?file=2025-06-15-cqlp.mp4',
}

const PROJECT: ProjectListItem = {
  id: '2025-06-15-cqlp',
  title: '2025-06-15-cqlp',
  durationSec: 5_940,
  createdAt: '2025-06-15T19:04:00.000Z',
  running: null,
  error: null,
  stopped: false,
}

function creation(partial: Partial<Creation> = {}): Creation {
  return { pending: null, error: null, start: vi.fn(), ...partial }
}

/** Une entrée fabriquée par la vraie jointure, jamais à la main. */
function entry(
  source: Partial<Source> | null,
  project: Partial<ProjectListItem> | null = null,
): Entry {
  const s = source === null ? null : { ...SOURCE, ...source }
  const p = project === null ? null : { ...PROJECT, ...project }
  return buildLibrary(s === null ? [] : [s], p === null ? [] : [p])[0]
}

function renderCard(e: Entry, c: Creation = creation()) {
  return render(<ShowCard entry={e} creation={c} />)
}

/** L'élément cliquable de la carte : un link, ou un bouton sur une émission neuve. */
function card(): HTMLElement {
  return screen.queryByRole('link') ?? screen.getByRole('button')
}

describe('les cinq états', () => {
  it('propose de lancer l’analyse sur une émission jamais analysée', () => {
    renderCard(entry({}))
    expect(screen.getByRole('button').getAttribute('data-state')).toBe('new')
    expect(screen.getByText('Lancer l’analyse')).toBeTruthy()
  })

  it('montre l’étape et son avancement pendant l’analyse', () => {
    renderCard(
      entry(
        { projectId: PROJECT.id },
        { running: { step: 'transcript', progress: 0.42 } },
      ),
    )
    expect(card().getAttribute('data-state')).toBe('analyzing')
    expect(screen.getByText('Transcription')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42')
  })

  it('dit « en cours » sur une source dont le projet n’est pas encore dans la liste', () => {
    // Les deux requêtes ne se rafraîchissent pas ensemble : `markSourceAnalyzed`
    // inscrit le `projectId` dès la réponse de création, la liste des projets
    // arrive au tour suivant. Reproposer « Lancer l'analyse » pendant cette
    // fenêtre vaudrait un 409 au second clic.
    renderCard(entry({ projectId: PROJECT.id }, null))
    const link = screen.getByRole('link')
    expect(link.getAttribute('data-state')).toBe('analyzing')
    // Et elle mène déjà au projet : l'identifiant vient de la source, pas de la
    // liste des projets. Un bouton de création ici aurait relancé la même
    // analyse, pour un 409.
    expect(link).toHaveProperty('pathname', '/projects/2025-06-15-cqlp')
    expect(screen.getByText('Analyse en cours')).toBeTruthy()
  })

  it('dit qu’une analyse est interrompue et propose de la reprendre', () => {
    // Un arrêt demandé ne laisse ni `running` ni `error` — ce n'est pas une
    // panne —, et `stopped` est le seul chemin par lequel il se voit.
    renderCard(entry({ projectId: PROJECT.id }, { stopped: true }))
    expect(card().getAttribute('data-state')).toBe('interrupted')
    expect(screen.getByText('Analyse interrompue')).toBeTruthy()
    expect(screen.getByText('Reprendre')).toBeTruthy()
  })

  it('dit qu’une analyse a échoué, sans recopier le message du serveur', () => {
    // Le message entier vit sur la vue Émission, avec le bouton qui le répare.
    // Le tronquer ici aurait promis une cause en la cachant, et l'afficher en
    // entier aurait fait grandir la carte.
    renderCard(entry({ projectId: PROJECT.id }, { error: 'ffmpeg est tombé sur le segment 12.' }))
    expect(card().getAttribute('data-state')).toBe('failed')
    expect(screen.getByText('Analyse en erreur')).toBeTruthy()
    expect(screen.queryByText(/ffmpeg/)).toBeNull()
  })

  it('marque une émission analysée et mène à sa vue', () => {
    renderCard(entry({ projectId: PROJECT.id }, {}))
    const link = screen.getByRole('link')
    expect(link.getAttribute('data-state')).toBe('analyzed')
    expect(link).toHaveProperty('pathname', '/projects/2025-06-15-cqlp')
    expect(screen.getByText('Analysée')).toBeTruthy()
  })
})

describe('le titre', () => {
  it('nomme l’émission, et garde le fichier en métadonnée', () => {
    renderCard(entry({}))
    expect(screen.getByText('cqlp — 15 juin 2025')).toBeTruthy()
    expect(screen.getByText(/2025-06-15-cqlp\.mp4/)).toBeTruthy()
  })

  it('ne bouge pas quand l’analyse démarre', () => {
    // `titleProject` est une fonction pure de l'identifiant, et l'identifiant est
    // le nom de fichier sans son extension : le titre est le même avant et après.
    renderCard(entry({}))
    const before = screen.getByRole('button').querySelector('[data-title]')?.textContent
    cleanup()

    renderCard(entry({ projectId: PROJECT.id }, {}))
    expect(screen.getByRole('link').querySelector('[data-title]')?.textContent).toBe(before)
  })
})

describe('la hauteur', () => {
  it('est la même dans les cinq états', () => {
    // C'est ce qui ferme le point 2 de l'issue #56 : plus rien ne grandit après
    // coup, donc la position de défilement reste juste au retour d'un clip.
    const cells: Entry[] = [
      entry({}),
      entry({ projectId: PROJECT.id }, { running: { step: 'proxy', progress: 0.1 } }),
      entry({ projectId: PROJECT.id }, { stopped: true }),
      entry({ projectId: PROJECT.id }, { error: 'tombé' }),
      entry({ projectId: PROJECT.id }, {}),
    ]

    for (const item of cells) {
      const { unmount } = renderCard(item)
      expect(card().className).toContain(CARD_HEIGHT)
      unmount()
    }
  })
})

describe('le projet orphelin', () => {
  it('garde une carte quand son replay a disparu du Drive', () => {
    // Sans elle, les clips gardés, les montages et les rendus déjà sur le
    // disque deviendraient inatteignables, sans qu'aucun écran ne le signale.
    renderCard(entry(null, { id: 'perdu', title: 'perdu' }))
    const link = screen.getByRole('link')
    expect(link).toHaveProperty('pathname', '/projects/perdu')
    expect(screen.getByText(/Replay introuvable/)).toBeTruthy()
    expect(screen.getByText('Orpheline')).toBeTruthy()
  })

  it('dit « inconnu » et non « introuvable » quand le dossier n’a pas été lu', () => {
    // Déclarer orphelin un projet dont on n'a pas pu chercher le fichier
    // accuserait le Drive d'une perte qui n'a pas eu lieu. (relevé par Copilot)
    const [entry] = buildLibrary([], [{ ...PROJECT, id: 'perdu', title: 'perdu' }], false)
    renderCard(entry)
    expect(screen.getByText(/Replay inconnu/)).toBeTruthy()
    expect(screen.queryByText('Orpheline')).toBeNull()
  })

  it('affiche la durée sondée à l’ingestion, qui survit au fichier', () => {
    renderCard(entry(null, { id: 'perdu', durationSec: 5_940 }))
    expect(screen.getByText(/1:39:00/)).toBeTruthy()
  })
})

describe('la création', () => {
  it('lance l’analyse au clic sur une émission neuve', async () => {
    const start = vi.fn()
    renderCard(entry({}), creation({ start }))
    await userEvent.click(screen.getByRole('button'))
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ name: SOURCE.name }))
  })

  it('affiche l’attente sur la carte cliquée, sans la sortir du clavier', async () => {
    // `disabled` prendrait le focus à qui vient d'appuyer sur Entrée, et il
    // faudrait retraverser la page pour revenir à la carte en cas d'échec.
    renderCard(entry({}), creation({ pending: SOURCE.name }))
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(screen.getByText('Lancement de l’analyse…')).toBeTruthy()
  })

  it('sort les autres cartes du clavier pendant qu’une création est en vol', async () => {
    // Deux créations en vol se disputeraient la redirection : on atterrirait
    // sur celle qui a répondu la dernière, sans que rien ne dise laquelle.
    const start = vi.fn()
    renderCard(entry({ name: 'autre.mp4' }), creation({ pending: SOURCE.name, start }))
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
    expect(start).not.toHaveBeenCalled()
  })
})
