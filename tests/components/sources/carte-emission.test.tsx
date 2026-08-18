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
  CarteÉmission,
  HAUTEUR_CARTE,
  type Creation,
  type Entrée,
} from '@/components/sources/carte-emission'
import { bibliothèque } from '@/core/bibliotheque'
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

const PROJET: ProjectListItem = {
  id: '2025-06-15-cqlp',
  title: '2025-06-15-cqlp',
  durationSec: 5_940,
  createdAt: '2025-06-15T19:04:00.000Z',
  running: null,
  error: null,
}

function creation(partiel: Partial<Creation> = {}): Creation {
  return { enCours: null, erreur: null, lancer: vi.fn(), ...partiel }
}

/** Une entrée fabriquée par la vraie jointure, jamais à la main. */
function entrée(
  source: Partial<Source> | null,
  projet: Partial<ProjectListItem> | null = null,
): Entrée {
  const s = source === null ? null : { ...SOURCE, ...source }
  const p = projet === null ? null : { ...PROJET, ...projet }
  const entrées = bibliothèque(s === null ? [] : [s], p === null ? [] : [p])
  return entrées[0]
}

function poser(e: Entrée, c: Creation = creation()) {
  return render(<CarteÉmission entrée={e} creation={c} />)
}

/** L'élément cliquable de la carte : un lien, ou un bouton sur une émission neuve. */
function carte(): HTMLElement {
  return screen.queryByRole('link') ?? screen.getByRole('button')
}

describe('les cinq états', () => {
  it('propose de lancer l’analyse sur une émission jamais analysée', () => {
    poser(entrée({}))
    expect(screen.getByRole('button').getAttribute('data-etat')).toBe('neuve')
    expect(screen.getByText('Lancer l’analyse')).toBeTruthy()
  })

  it('montre l’étape et son avancement pendant l’analyse', () => {
    poser(
      entrée(
        { projectId: PROJET.id },
        { running: { step: 'transcript', progress: 0.42 } },
      ),
    )
    expect(carte().getAttribute('data-etat')).toBe('analyse')
    expect(screen.getByText('Transcription')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42')
  })

  it('dit « en cours » sur une source dont le projet n’est pas encore dans la liste', () => {
    // Les deux requêtes ne se rafraîchissent pas ensemble : `marquerSourceAnalysée`
    // inscrit le `projectId` dès la réponse de création, la liste des projets
    // arrive au tour suivant. Reproposer « Lancer l'analyse » pendant cette
    // fenêtre vaudrait un 409 au second clic.
    poser(entrée({ projectId: PROJET.id }, null))
    const lien = screen.getByRole('link')
    expect(lien.getAttribute('data-etat')).toBe('analyse')
    // Et elle mène déjà au projet : l'identifiant vient de la source, pas de la
    // liste des projets. Un bouton de création ici aurait relancé la même
    // analyse, pour un 409.
    expect(lien).toHaveProperty('pathname', '/projects/2025-06-15-cqlp')
    expect(screen.getByText('Analyse en cours')).toBeTruthy()
  })

  it('dit qu’une analyse est interrompue et propose de la reprendre', () => {
    // `progression()` lit une `Map` du processus Next : un redémarrage la vide
    // sans laisser d'erreur. `durationSec` à zéro est la trace qu'il reste.
    poser(entrée({ projectId: PROJET.id }, { durationSec: 0 }))
    expect(carte().getAttribute('data-etat')).toBe('interrompue')
    expect(screen.getByText('Analyse interrompue')).toBeTruthy()
    expect(screen.getByText('Reprendre')).toBeTruthy()
  })

  it('dit qu’une analyse a échoué, sans recopier le message du serveur', () => {
    // Le message entier vit sur la vue Émission, avec le bouton qui le répare.
    // Le tronquer ici aurait promis une cause en la cachant, et l'afficher en
    // entier aurait fait grandir la carte.
    poser(entrée({ projectId: PROJET.id }, { error: 'ffmpeg est tombé sur le segment 12.' }))
    expect(carte().getAttribute('data-etat')).toBe('echec')
    expect(screen.getByText('Analyse en erreur')).toBeTruthy()
    expect(screen.queryByText(/ffmpeg/)).toBeNull()
  })

  it('marque une émission analysée et mène à sa vue', () => {
    poser(entrée({ projectId: PROJET.id }, {}))
    const lien = screen.getByRole('link')
    expect(lien.getAttribute('data-etat')).toBe('analysée')
    expect(lien).toHaveProperty('pathname', '/projects/2025-06-15-cqlp')
    expect(screen.getByText('Analysée')).toBeTruthy()
  })
})

describe('la hauteur', () => {
  it('est la même dans les cinq états', () => {
    // C'est ce qui ferme le point 2 de l'issue #56 : plus rien ne grandit après
    // coup, donc la position de défilement reste juste au retour d'un clip.
    const cas: Entrée[] = [
      entrée({}),
      entrée({ projectId: PROJET.id }, { running: { step: 'proxy', progress: 0.1 } }),
      entrée({ projectId: PROJET.id }, { durationSec: 0 }),
      entrée({ projectId: PROJET.id }, { error: 'tombé' }),
      entrée({ projectId: PROJET.id }, {}),
    ]

    for (const cas1 of cas) {
      const { unmount } = poser(cas1)
      expect(carte().className).toContain(HAUTEUR_CARTE)
      unmount()
    }
  })
})

describe('le projet orphelin', () => {
  it('garde une carte quand son replay a disparu du Drive', () => {
    // Sans elle, les clips gardés, les montages et les rendus déjà sur le
    // disque deviendraient inatteignables, sans qu'aucun écran ne le signale.
    poser(entrée(null, { id: 'perdu', title: 'perdu' }))
    const lien = screen.getByRole('link')
    expect(lien).toHaveProperty('pathname', '/projects/perdu')
    expect(screen.getByText(/Replay introuvable/)).toBeTruthy()
    expect(screen.getByText('Orpheline')).toBeTruthy()
  })

  it('affiche la durée sondée à l’ingestion, qui survit au fichier', () => {
    poser(entrée(null, { id: 'perdu', durationSec: 5_940 }))
    expect(screen.getByText(/1:39:00/)).toBeTruthy()
  })
})

describe('la création', () => {
  it('lance l’analyse au clic sur une émission neuve', async () => {
    const lancer = vi.fn()
    poser(entrée({}), creation({ lancer }))
    await userEvent.click(screen.getByRole('button'))
    expect(lancer).toHaveBeenCalledWith(expect.objectContaining({ name: SOURCE.name }))
  })

  it('affiche l’attente sur la carte cliquée, sans la sortir du clavier', async () => {
    // `disabled` prendrait le focus à qui vient d'appuyer sur Entrée, et il
    // faudrait retraverser la page pour revenir à la carte en cas d'échec.
    poser(entrée({}), creation({ enCours: SOURCE.name }))
    const bouton = screen.getByRole('button')
    expect(bouton.getAttribute('aria-disabled')).toBe('true')
    expect(bouton.hasAttribute('disabled')).toBe(false)
    expect(screen.getByText('Lancement de l’analyse…')).toBeTruthy()
  })

  it('sort les autres cartes du clavier pendant qu’une création est en vol', async () => {
    // Deux créations en vol se disputeraient la redirection : on atterrirait
    // sur celle qui a répondu la dernière, sans que rien ne dise laquelle.
    const lancer = vi.fn()
    poser(entrée({ name: 'autre.mp4' }), creation({ enCours: SOURCE.name, lancer }))
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
    expect(lancer).not.toHaveBeenCalled()
  })
})
