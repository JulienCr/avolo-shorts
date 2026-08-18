// @vitest-environment jsdom

/**
 * La boucle de tri : les trois comportements dont une régression serait
 * silencieuse (spec §5.5).
 *
 * `G` avance, `U` revient sur la carte précédente, et une carte décidée ne bouge
 * pas. Aucun des trois ne se voit dans un test pur — ce sont des faits de focus
 * et d'ordre à l'écran —, et les trois se paient trente fois par émission.
 */

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ClipStatus } from '@/core/edl'
import { FilDeTri } from '@/components/tri/fil'
import type { BilanRepérage, CandidateClip } from '@/lib/api'
import type { Vue } from '@/components/tri/modele'
import { écrireSessionTri } from '@/components/tri/session'

afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
  vi.restoreAllMocks()
})

function candidat(n: number, status: ClipStatus = 'candidate'): CandidateClip {
  return {
    id: `c${n}`,
    projectId: 'p1',
    segments: [{ start: n * 100, end: n * 100 + 30 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: `Extrait ${n}`,
    description: '',
    status,
    pass: 1,
    preview: `Ce qui se dit dans l’extrait ${n}.`,
    thumbnailUrl: null,
  }
}

/**
 * Le harnais tient les statuts, comme la page le fait par écriture optimiste :
 * sans lui, une décision ne reviendrait jamais à l'écran et les tests
 * regarderaient un composant figé.
 */
function Harnais({
  depart,
  vueInitiale = 'atrier',
  proxyPret = true,
  bilan = null,
}: {
  depart: CandidateClip[]
  vueInitiale?: Vue
  proxyPret?: boolean
  bilan?: BilanRepérage | null
}) {
  const [clips, setClips] = useState(depart)
  const [vue, setVue] = useState<Vue>(vueInitiale)
  return (
    <FilDeTri
      projectId="p1"
      clips={clips}
      vue={vue}
      onVue={setVue}
      proxyPret={proxyPret}
      bilan={bilan}
      onStatut={(clipId, status) =>
        setClips((liste) => liste.map((c) => (c.id === clipId ? { ...c, status } : c)))
      }
    />
  )
}

function carte(titre: string): HTMLElement {
  return screen.getByRole('article', { name: titre })
}

async function focaliser(titre: string) {
  const utilisateur = userEvent.setup()
  await utilisateur.click(carte(titre))
  return utilisateur
}

/** Les titres des cartes, dans l'ordre où elles sont à l'écran. */
function ordreAffiché(): string[] {
  return screen
    .getAllByRole('article')
    .map((c) => c.getAttribute('aria-label') ?? '')
}

describe('la boucle de tri, au clavier', () => {
  it('« G » garde la carte et avance sur la suivante', async () => {
    // Décider sans avancer oblige à un geste sur deux. C'est ce qui fait passer
    // le tri de dix minutes à trois.
    render(<Harnais depart={[candidat(1), candidat(2), candidat(3)]} />)
    const utilisateur = await focaliser('Extrait 1')

    await utilisateur.keyboard('g')

    expect(
      within(carte('Extrait 1')).getByRole('button', { name: /gardé/i }).getAttribute('aria-pressed'),
    ).toBe('true')
    expect(document.activeElement).toBe(carte('Extrait 2'))
  })

  it('« E » écarte et avance de même', async () => {
    render(<Harnais depart={[candidat(1), candidat(2), candidat(3)]} />)
    const utilisateur = await focaliser('Extrait 1')

    await utilisateur.keyboard('e')

    expect(within(carte('Extrait 1')).getByRole('button', { name: /remettre/i })).toBeTruthy()
    expect(document.activeElement).toBe(carte('Extrait 2'))
  })

  it('« U » défait la dernière décision et revient sur sa carte', async () => {
    // Sans le retour sur la carte, on corrige à l'aveugle : la décision qu'on
    // vient de reprendre n'est plus sous l'œil.
    render(<Harnais depart={[candidat(1), candidat(2), candidat(3)]} />)
    const utilisateur = await focaliser('Extrait 1')

    await utilisateur.keyboard('gg')
    expect(document.activeElement).toBe(carte('Extrait 3'))

    await utilisateur.keyboard('u')

    expect(within(carte('Extrait 2')).getByRole('button', { name: /^garder$/i })).toBeTruthy()
    expect(document.activeElement).toBe(carte('Extrait 2'))
  })

  it('défait deux décisions dans l’ordre inverse', async () => {
    render(<Harnais depart={[candidat(1), candidat(2), candidat(3)]} />)
    const utilisateur = await focaliser('Extrait 1')

    await utilisateur.keyboard('geu')
    expect(within(carte('Extrait 2')).getByRole('button', { name: /^écarter$/i })).toBeTruthy()

    await utilisateur.keyboard('u')
    expect(within(carte('Extrait 1')).getByRole('button', { name: /^garder$/i })).toBeTruthy()
    expect(document.activeElement).toBe(carte('Extrait 1'))
  })

  it('ne fait rien sur une pile vide', async () => {
    render(<Harnais depart={[candidat(1), candidat(2)]} />)
    const utilisateur = await focaliser('Extrait 1')

    await utilisateur.keyboard('uuu')

    expect(within(carte('Extrait 1')).getByRole('button', { name: /^garder$/i })).toBeTruthy()
    expect(document.activeElement).toBe(carte('Extrait 1'))
  })

  it('ne reboucle pas aux deux bouts', async () => {
    // Reboucler ferait repasser indéfiniment sur des cartes déjà vues sans que
    // rien ne dise qu'on a fait le tour.
    render(<Harnais depart={[candidat(1), candidat(2)]} />)
    const utilisateur = await focaliser('Extrait 1')

    await utilisateur.keyboard('k')
    expect(document.activeElement).toBe(carte('Extrait 1'))

    await utilisateur.keyboard('jj')
    expect(document.activeElement).toBe(carte('Extrait 2'))
  })

  it('tient la dernière carte quand « G » n’a plus où avancer', async () => {
    render(<Harnais depart={[candidat(1), candidat(2)]} />)
    const utilisateur = await focaliser('Extrait 2')

    await utilisateur.keyboard('g')

    expect(document.activeElement).toBe(carte('Extrait 2'))
  })

  it('marche sur une liste d’une seule carte', async () => {
    render(<Harnais depart={[candidat(1)]} />)
    const utilisateur = await focaliser('Extrait 1')

    await utilisateur.keyboard('g')

    // La dernière décision fait tomber le compteur à zéro : la fin de boucle
    // s'ajoute, mais la carte reste en place — sinon `U` n'aurait plus de carte
    // où revenir.
    expect(
      within(carte('Extrait 1')).getByRole('button', { name: /gardé/i }).getAttribute('aria-pressed'),
    ).toBe('true')
    expect(screen.getByText(/tout est trié/i)).toBeTruthy()
  })
})

describe('rien ne bouge sous la main', () => {
  it('laisse une carte écartée à sa place, marquée', async () => {
    // Aujourd'hui, écarter fait disparaître la carte et refluer toute la
    // grille : la suivante n'est plus sous l'œil ni sous le curseur. C'est le
    // défaut qui coûte le plus cher sur une boucle, parce qu'il se paie à
    // chaque itération.
    render(<Harnais depart={[candidat(1), candidat(2), candidat(3)]} />)
    const utilisateur = await focaliser('Extrait 1')

    await utilisateur.keyboard('e')

    expect(ordreAffiché()).toEqual(['Extrait 1', 'Extrait 2', 'Extrait 3'])
  })

  it('compacte au changement de vue, pas au moment du clic', async () => {
    render(<Harnais depart={[candidat(1), candidat(2), candidat(3)]} />)
    const utilisateur = await focaliser('Extrait 1')
    await utilisateur.keyboard('e')

    await utilisateur.click(screen.getByRole('tab', { name: /écartés/i }))
    expect(ordreAffiché()).toEqual(['Extrait 1'])

    await utilisateur.click(screen.getByRole('tab', { name: /à trier/i }))
    expect(ordreAffiché()).toEqual(['Extrait 2', 'Extrait 3'])
  })

  it('accueille un candidat qui arrive d’une nouvelle passe', async () => {
    // La liste figée l'est pour les décisions, pas pour les données : une passe
    // de repérage qui se termine pendant qu'on trie ajoute des cartes, et les
    // cacher jusqu'au prochain changement de vue serait un vide inexplicable.
    function Nu({ liste }: { liste: CandidateClip[] }) {
      return (
        <FilDeTri
          projectId="p1"
          clips={liste}
          vue="atrier"
          onVue={() => {}}
          proxyPret
          bilan={null}
          onStatut={() => {}}
        />
      )
    }
    const { rerender } = render(<Nu liste={[candidat(1)]} />)
    rerender(<Nu liste={[candidat(1), candidat(2)]} />)

    expect(ordreAffiché()).toEqual(['Extrait 1', 'Extrait 2'])
  })
})

describe('le retour depuis un clip', () => {
  it('rend le focus à la carte d’où l’on est parti', () => {
    // Sans cela le clavier repart du haut de la page à chaque aller-retour, soit
    // quatre fois par émission. C'est l'écran de tri qui le porte : celui de
    // clip ne fait que naviguer par un lien.
    écrireSessionTri('p1', { carte: 'c2' })
    render(<Harnais depart={[candidat(1), candidat(2), candidat(3)]} />)

    expect(document.activeElement).toBe(carte('Extrait 2'))
  })

  it('ne vole pas le focus quand on arrive pour la première fois', () => {
    // Une arrivée n'est pas un retour : déplacer le focus ferait sauter la page
    // sur une carte que personne n'a demandée.
    render(<Harnais depart={[candidat(1), candidat(2)]} />)
    expect(document.activeElement).toBe(document.body)
  })

  it('retrouve la position de défilement quand aucune carte n’est à reprendre', () => {
    const defiler = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    écrireSessionTri('p1', { defilement: 940 })
    render(<Harnais depart={[candidat(1), candidat(2)]} />)

    expect(defiler).toHaveBeenCalledWith(0, 940)
  })
})

describe('les comptes', () => {
  it('reste juste après un changement d’avis', async () => {
    render(<Harnais depart={[candidat(1), candidat(2), candidat(3)]} />)
    const utilisateur = await focaliser('Extrait 1')

    await utilisateur.keyboard('g')
    expect(screen.getByTestId('comptes').textContent).toContain('1 clip gardé')

    await utilisateur.keyboard('u')
    expect(screen.getByTestId('comptes').textContent).toContain('0 clip gardé')
    expect(screen.getByTestId('comptes').textContent).toContain('3 à trier')
  })

  it('compte un clip exporté comme gardé', () => {
    render(<Harnais depart={[candidat(1, 'exported'), candidat(2, 'kept')]} />)
    expect(screen.getByTestId('comptes').textContent).toContain('2 clips gardés')
  })

  it('accorde le singulier des écartés', async () => {
    render(<Harnais depart={[candidat(1), candidat(2)]} />)
    const utilisateur = await focaliser('Extrait 1')

    await utilisateur.keyboard('e')
    expect(screen.getByRole('tab', { name: /écartés/i }).textContent).toContain('1')
  })
})

describe('la fin de la boucle', () => {
  it('le dit et propose les clips gardés', async () => {
    // C'est le seul endroit du parcours où une progression linéaire est
    // honnête : on connaît enfin le dénominateur.
    render(<Harnais depart={[candidat(1, 'kept'), candidat(2, 'discarded')]} />)

    expect(screen.getByText(/tout est trié/i)).toBeTruthy()
    expect(screen.getByRole('progressbar')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Extrait 1/ })).toBeTruthy()
  })

  it('distingue « tout a été écarté » de « des gardés restent à monter »', () => {
    // `suite` ne sépare pas les deux : les deux tombent sur `travail: 'trie'`.
    // C'est l'écran qui tient la liste, donc c'est à lui de le dire.
    render(<Harnais depart={[candidat(1, 'discarded'), candidat(2, 'discarded')]} />)

    expect(screen.getByText(/tout a été écarté/i)).toBeTruthy()
    expect(screen.queryByText(/tout est trié/i)).toBeNull()
  })

  it('ne parle pas de fin sur une liste vide', () => {
    // Zéro candidat n'est pas une boucle terminée : c'est un repérage qui n'a
    // rien rendu, ou qui n'a pas encore tourné.
    render(<Harnais depart={[]} />)

    expect(screen.queryByText(/tout est trié/i)).toBeNull()
    expect(screen.getByText(/aucune proposition/i)).toBeTruthy()
  })
})

describe('le montage sans proxy', () => {
  it('désactive « monter » en le laissant atteignable, avec sa raison à côté', async () => {
    // `disabled` sort du parcours de tabulation : au clavier, on ne découvre ni
    // le bouton ni sa raison. Et une bulle d'aide au survol est invisible au
    // clavier.
    render(<Harnais depart={[candidat(1, 'kept')]} proxyPret={false} vueInitiale="gardes" />)

    const monter = screen.getByRole('button', { name: /monter/i })
    expect(monter.getAttribute('aria-disabled')).toBe('true')
    expect(monter.hasAttribute('disabled')).toBe(false)
    expect(within(carte('Extrait 1')).getByTestId('raison-monter').textContent).toMatch(/proxy/i)
  })

  it('rend « monter » cliquable dès que le proxy est là', () => {
    render(<Harnais depart={[candidat(1, 'kept')]} proxyPret vueInitiale="gardes" />)
    expect(screen.getByRole('link', { name: /monter/i })).toHaveProperty(
      'pathname',
      '/clips/c1',
    )
  })
})

describe('la couverture du repérage', () => {
  const perdu: BilanRepérage = {
    fenêtres: 83,
    notées: 57,
    lotsRefusés: 4,
    lotsRépondus: 7,
    couverture: 0.684,
    partiel: false,
  }

  it('vit à côté du compte, et ne se referme pas', () => {
    // Ni notification, ni bandeau qu'on referme : c'est une propriété permanente
    // de cette liste, au même titre que son nombre d'éléments.
    render(<Harnais depart={[candidat(1)]} bilan={perdu} />)

    const mot = screen.getByTestId('reperage')
    expect(mot.textContent).toContain('68 %')
    expect(within(mot).queryByRole('button')).toBeNull()
  })

  it('ne dit rien quand le serveur n’a rien mesuré', () => {
    render(<Harnais depart={[candidat(1)]} bilan={null} />)
    expect(screen.queryByTestId('reperage')).toBeNull()
  })

  it('annonce un décompte provisoire sans le déduire lui-même', () => {
    render(<Harnais depart={[candidat(1)]} bilan={{ ...perdu, partiel: true }} />)
    expect(screen.getByTestId('reperage').textContent).toMatch(/provisoire/i)
  })
})
