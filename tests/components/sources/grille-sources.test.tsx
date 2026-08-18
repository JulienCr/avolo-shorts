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

  it('n’annonce pas un dossier vide comme une erreur', () => {
    // La primitive `Alert` pose `role="alert"` en dur, donc assertif : un dossier
    // vide interromprait la lecture en cours comme le ferait une panne. La
    // conception §4.3 n'admet que trois régions live, et les erreurs sont la
    // seule assertive. (relevé par Copilot)
    grille({ listing: { sources: [], montage: { disponible: true, fstype: '9p', entrées: 0 } } })

    expect(screen.queryByRole('alert')).toBeNull()
    // Ni région live du tout : la conception §4.3 en admet trois — l'avancement,
    // les erreurs, le résultat d'un export — et « pas une de plus ». Un dossier
    // vide n'est aucune des trois, et il se lit en arrivant sur la page.
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('Le dossier des replays est vide.')).toBeTruthy()
  })

  it('annonce le montage absent comme une erreur, lui', () => {
    grille({ listing: { sources: [], montage: { disponible: false, fstype: null, entrées: 0 } } })
    expect(screen.getByRole('alert').textContent).toContain('n’est pas monté')
  })

  it('n’affirme pas « monté » quand le relevé n’est pas le partage attendu', () => {
    // Un point de montage resté vide sur la racine locale se **liste** très
    // bien : `readdir` réussit, `disponible` vaut vrai, et le dossier passait
    // pour sain alors que le partage n'est nulle part. Le `fstype` est le seul
    // signal qui le dise, et l'écran l'affichait comme une confirmation.
    // (relevé par Codex)
    grille({ listing: { sources: [], montage: { disponible: true, fstype: 'ext4', entrées: 0 } } })

    expect(screen.getByText('Le dossier des replays est vide.')).toBeTruthy()
    expect(screen.getByText(/ext4/)).toBeTruthy()
    expect(screen.getByText(/n’est pas là/)).toBeTruthy()
    expect(screen.queryByText(/bien monté/)).toBeNull()
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

  it('ne conclut pas au transport mort quand le partage, lui, répond', () => {
    // **`disponible: false` recouvre quatre causes**, et `releverAvecGarde` le
    // dit lui-même : « absence, droits, transport mort, délai dépassé : du point
    // de vue de l'écran, c'est le même fait ». Un `REPLAY_DIR` mal orthographié
    // sous un partage 9p parfaitement sain tombe exactement ici — et envoyer
    // remonter le partage ferait perdre le geste utile, qui est de relire le
    // chemin. (relevé par Codex)
    grille({
      listing: { sources: [], montage: { disponible: false, fstype: '9p', entrées: 0 } },
    })

    expect(screen.getByText('Le dossier des replays n’a pas pu être lu.')).toBeTruthy()
    // Le relevé dit ce qu'il sait : le partage attendu, lui, est là.
    expect(screen.getByText(/9p/)).toBeTruthy()
    // Et le premier geste est de vérifier le chemin, pas de remonter le partage.
    expect(screen.getByText(/REPLAY_DIR/)).toBeTruthy()
  })

  it('nomme le système de fichiers relevé quand ce n’est pas le partage attendu', () => {
    // Un `ext4` là où on attend un `9p` dit « ce montage n'a pas eu lieu » : le
    // chemin retombe sur la racine locale, et le partage n'est nulle part.
    grille({
      listing: { sources: [], montage: { disponible: false, fstype: 'ext4', entrées: 0 } },
    })

    expect(screen.getByText('Le dossier des replays n’est pas monté.')).toBeTruthy()
    expect(screen.getByText(/ext4/)).toBeTruthy()
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
  /**
   * Le haut de la grille dans le document, simulé.
   *
   * jsdom ne calcule aucune mise en page : `getBoundingClientRect` y rend des
   * zéros. On rejoue donc la seule chose dont le hook dépend — la position de la
   * grille **relative au défilement courant**, ce qu'un vrai navigateur rend.
   */
  const HAUT_GRILLE = 200
  function poserLaMiseEnPage() {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ top: HAUT_GRILLE - window.scrollY }) as DOMRect,
    )
  }

  it('rend la grille où on l’avait laissée', () => {
    // Vingt et une cartes : revenir en haut à chaque retour d'un projet ferait
    // redemander ce qui a déjà été vu.
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
    poserLaMiseEnPage()
    sessionStorage.setItem(CLE_DEFILEMENT, '100')

    grille()

    // 100 **sous le haut de la grille**, pas 100 dans la page.
    expect(scrollTo).toHaveBeenCalledWith(0, HAUT_GRILLE + 100)
  })

  it('ne restaure rien tant que les cartes ne sont pas là', () => {
    // Rendre le défilement sur une page de squelettes le poserait sur une
    // hauteur qui n'est pas encore la bonne.
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    sessionStorage.setItem(CLE_DEFILEMENT, '420')

    grille({ listing: undefined, chargement: true })

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('ne réécrit pas la position tant que la grille n’est pas là', () => {
    // La restauration du navigateur tente l'ancienne position sur une page qui
    // n'a alors que la hauteur de ses squelettes : elle est ramenée vers le
    // haut, et l'événement de défilement qu'elle émet écrasait la position
    // gardée. Les cartes arrivaient ensuite sur une valeur rabotée.
    // (relevé par Codex)
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    sessionStorage.setItem(CLE_DEFILEMENT, '420')

    grille({ listing: undefined, chargement: true })
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
    window.dispatchEvent(new Event('scroll'))

    expect(sessionStorage.getItem(CLE_DEFILEMENT)).toBe('420')
  })

  it('retient la position relativement à la grille, pas à la page', () => {
    // **La section des projets grandit entre le départ et le retour** : une
    // création y ajoute une rangée, et une analyse qui démarre en fait pousser
    // une autre d'une barre de progression. Une position absolue retomberait
    // alors une rangée trop haut, sur une autre carte que celle qu'on avait
    // sous les yeux. (relevé par Codex)
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    poserLaMiseEnPage()
    grille()

    Object.defineProperty(window, 'scrollY', { value: 300, configurable: true })
    window.dispatchEvent(new Event('scroll'))

    expect(sessionStorage.getItem(CLE_DEFILEMENT)).toBe('100')
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
