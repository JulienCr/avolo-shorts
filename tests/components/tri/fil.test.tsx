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
import type { StepName } from '@/core/graph'
import { phaseProjet } from '@/core/parcours'
import { suite } from '@/lib/parcours'
import { FilDeTri } from '@/components/tri/fil'
import type { BilanRepérage, CandidateClip } from '@/lib/api'
import type { Vue } from '@/components/tri/modele'
import { lireSessionTri, écrireSessionTri } from '@/components/tri/session'

// **`PointerEvent` n'existe pas sous `jsdom`.** La case de sélection en masse
// (Base UI `Checkbox`) dispatche elle-même un `PointerEvent` synthétique à la
// validation, quel que soit le mécanisme qui a déclenché le clic. Voir le même
// repli, plus longuement commenté, dans
// `tests/components/publication/publish-dialog.test.tsx`.
if (typeof window !== 'undefined' && typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {}
  // @ts-expect-error -- un repli minimal, pas la classe complète du DOM.
  window.PointerEvent = PointerEventPolyfill
}

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
  // La vraie `suite`, calculée sur la vraie phase : c'est elle qui garantit
  // qu'aucun état n'est une impasse, et la lui donner en dur ferait passer le
  // test à côté de la garantie.
  const étapes = { candidates: true, proxy: proxyPret } as Record<StepName, boolean>
  const issue = suite(phaseProjet(étapes, null, null, clips), { id: 'p1' })
  return (
    <FilDeTri
      projectId="p1"
      clips={clips}
      vue={vue}
      onVue={setVue}
      proxyPret={proxyPret}
      bilan={bilan}
      suite={issue}
      onStatut={(clipId, status) =>
        setClips((liste) => liste.map((c) => (c.id === clipId ? { ...c, status } : c)))
      }
    />
  )
}

/**
 * Le même harnais, mais dont la **liste** vient des propriétés et les **statuts**
 * de l'état : c'est ce qui permet de rejouer l'arrivée de nouveaux candidats
 * après une décision, sans perdre celle-ci.
 */
function Vivant({ liste }: { liste: CandidateClip[] }) {
  const [statuts, setStatuts] = useState<Record<string, ClipStatus>>({})
  const clips = liste.map((c) => ({ ...c, status: statuts[c.id] ?? c.status }))
  const étapes = { candidates: true, proxy: true } as Record<StepName, boolean>
  return (
    <FilDeTri
      projectId="p1"
      clips={clips}
      vue="atrier"
      onVue={() => {}}
      proxyPret
      bilan={null}
      suite={suite(phaseProjet(étapes, null, null, clips), { id: 'p1' })}
      onStatut={(clipId, status) => setStatuts((s) => ({ ...s, [clipId]: status }))}
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

    expect(within(carte('Extrait 1')).getByRole('button', { name: /^écarté$/i })).toBeTruthy()
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

  it('« Entrée » ouvre le clip de la carte sélectionnée', async () => {
    const ouverts: string[] = []
    // En capture, et avec `preventDefault` : sans lui, jsdom tenterait la
    // navigation et la noierait dans une erreur « Not implemented ».
    const espion = (événement: Event) => {
      const lien = (événement.target as HTMLElement).closest('a[data-ouvrir]')
      if (lien !== null) {
        événement.preventDefault()
        ouverts.push(lien.getAttribute('href') ?? '')
      }
    }
    document.addEventListener('click', espion, true)
    try {
      render(<Harnais depart={[candidat(1), candidat(2)]} />)
      const utilisateur = await focaliser('Extrait 1')
      await utilisateur.keyboard('j{Enter}')
      expect(ouverts).toEqual(['/clips/c2'])
    } finally {
      document.removeEventListener('click', espion, true)
    }
  })

  it('ne rend jamais son statut d’exporté à un clip défait', async () => {
    // `PATCH` refuse `exported` : un clip devient exporté parce qu'un MP4 a été
    // produit, jamais parce que quelqu'un l'a écrit — et la décision qu'on
    // défait a de toute façon fait écarter le rendu. `kept` est le maximum
    // honnête.
    render(<Harnais depart={[candidat(1, 'exported')]} vueInitiale="gardes" />)
    const utilisateur = await focaliser('Extrait 1')

    await utilisateur.keyboard('e')
    expect(within(carte('Extrait 1')).getByRole('button', { name: /^écarté$/i })).toBeTruthy()

    await utilisateur.keyboard('u')
    const gardé = within(carte('Extrait 1')).getByRole('button', { name: /gardé/i })
    expect(gardé.getAttribute('aria-pressed')).toBe('true')
    expect(gardé.textContent).not.toMatch(/exporté/i)
  })

  it('ne fait rien sur une pile vide', async () => {
    render(<Harnais depart={[candidat(1), candidat(2)]} />)
    const utilisateur = await focaliser('Extrait 1')

    await utilisateur.keyboard('uuu')

    expect(within(carte('Extrait 1')).getByRole('button', { name: /^garder$/i })).toBeTruthy()
    expect(document.activeElement).toBe(carte('Extrait 1'))
  })

  it('ne défait rien hors de vue', async () => {
    // Une décision reprise sur une carte que la vue courante n'affiche pas
    // changerait l'état sans que rien ne bouge à l'écran : c'est la pire des
    // corrections, celle qu'on ne voit pas. Elle redevient possible en revenant
    // là où la carte est.
    render(<Harnais depart={[candidat(1), candidat(2)]} />)
    const utilisateur = await focaliser('Extrait 1')
    await utilisateur.keyboard('e')

    await utilisateur.click(screen.getByRole('tab', { name: /gardés/i }))
    // **Le focus quitte l'onglet**, sinon la garde des raccourcis avale la
    // touche et le test passerait sans rien prouver.
    await utilisateur.click(document.body)
    expect(document.activeElement).toBe(document.body)
    await utilisateur.keyboard('u')

    await utilisateur.click(screen.getByRole('tab', { name: /écartés/i }))
    expect(ordreAffiché()).toEqual(['Extrait 1'])

    // De retour là où la carte est, la correction redevient possible — et se
    // voit.
    await utilisateur.click(carte('Extrait 1'))
    await utilisateur.keyboard('u')
    expect(within(carte('Extrait 1')).getByRole('button', { name: /^écarter$/i })).toBeTruthy()
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

describe('la souris et le clavier se relaient', () => {
  it('rend le clavier après une décision prise au bouton', async () => {
    // Cliquer « Garder » laisse le focus sur le bouton, et la garde des
    // raccourcis écarte tout `button` : plus une seule touche ne répondait,
    // sans message et sans retour visible — la carte gardait son anneau de
    // sélection, donc l'écran affirmait le contraire. On en sortait en cliquant
    // le corps d'une carte, ce que personne ne devine.
    render(<Harnais depart={[candidat(1), candidat(2), candidat(3)]} />)
    const utilisateur = userEvent.setup()

    await utilisateur.click(within(carte('Extrait 1')).getByRole('button', { name: /^garder$/i }))
    await utilisateur.keyboard('j')

    expect(document.activeElement).toBe(carte('Extrait 2'))
  })

  it('rend le clavier après un écart pris au bouton', async () => {
    render(<Harnais depart={[candidat(1), candidat(2)]} />)
    const utilisateur = userEvent.setup()

    await utilisateur.click(within(carte('Extrait 1')).getByRole('button', { name: /^écarter$/i }))
    await utilisateur.keyboard('u')

    expect(within(carte('Extrait 1')).getByRole('button', { name: /^écarter$/i })).toBeTruthy()
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
    const { rerender } = render(<Vivant liste={[candidat(1)]} />)
    rerender(<Vivant liste={[candidat(1), candidat(2)]} />)

    expect(ordreAffiché()).toEqual(['Extrait 1', 'Extrait 2'])
  })

  it('ne compacte pas les cartes décidées quand de nouveaux candidats arrivent', async () => {
    // Le bouton de relance est posé dans l'en-tête juste au-dessus : un repérage
    // forcé conserve les décisions humaines **et** ajoute des candidats. Le jeu
    // d'identifiants change donc, et refiger depuis zéro escamotait les cartes
    // qu'on venait de décider — sous la main, et hors de portée de `U`.
    const { rerender } = render(<Vivant liste={[candidat(1), candidat(2)]} />)
    const utilisateur = await focaliser('Extrait 1')
    await utilisateur.keyboard('e')

    rerender(<Vivant liste={[candidat(1), candidat(2), candidat(3)]} />)

    expect(ordreAffiché()).toEqual(['Extrait 1', 'Extrait 2', 'Extrait 3'])
  })
})

describe('le parcours de tabulation', () => {
  it('ne laisse tabulables que les contrôles de la carte sélectionnée', () => {
    // Le `tabindex` glissant ne portait que sur l'article : le titre, les deux
    // boutons et le montage restaient tabulables sur **chaque** carte, soit une
    // centaine d'arrêts sur trente cartes — l'inverse de ce que le commentaire
    // promettait. (relevé par Copilot)
    render(<Harnais depart={[candidat(1, 'kept'), candidat(2, 'kept')]} vueInitiale="gardes" />)

    const tabulables = (titre: string) =>
      Array.from(carte(titre).querySelectorAll('a, button')).filter(
        (n) => n.getAttribute('tabindex') !== '-1',
      ).length

    // La première est la sélection par défaut.
    expect(tabulables('Extrait 1')).toBeGreaterThan(0)
    expect(tabulables('Extrait 2')).toBe(0)
  })

  it('déplace les arrêts avec la sélection', async () => {
    render(<Harnais depart={[candidat(1, 'kept'), candidat(2, 'kept')]} vueInitiale="gardes" />)
    const utilisateur = await focaliser('Extrait 1')

    await utilisateur.keyboard('j')

    const arrêts = Array.from(carte('Extrait 2').querySelectorAll('a, button')).filter(
      (n) => n.getAttribute('tabindex') !== '-1',
    )
    expect(arrêts.length).toBeGreaterThan(0)
  })
})

describe('le retour, et lui seul', () => {
  /** Un fil dont la vue est pilotée de l'extérieur, comme l'écran le fait. */
  function Piloté({ vue, liste }: { vue: Vue; liste: CandidateClip[] }) {
    const étapes = { candidates: true, proxy: true } as Record<StepName, boolean>
    return (
      <FilDeTri
        projectId="p1"
        clips={liste}
        vue={vue}
        onVue={() => {}}
        proxyPret
        bilan={null}
        suite={suite(phaseProjet(étapes, null, null, liste), { id: 'p1' })}
        onStatut={() => {}}
      />
    )
  }

  it('repose le focus une fois la vue mémorisée arrivée', async () => {
    // Le retour par URL nue monte d'abord « à trier », et la vue mémorisée
    // n'arrive qu'après, par un remplacement d'URL. Une restauration jouée une
    // seule fois au montage cherchait donc une carte qui n'existait pas encore,
    // et ne réessayait jamais : la vue revenait, le focus non. (relevé par Codex
    // et Copilot)
    const liste = [candidat(1), candidat(2, 'kept')]
    écrireSessionTri('p1', { retour: true, carte: 'c2', vue: 'gardes' })

    const { rerender } = render(<Piloté vue="atrier" liste={liste} />)
    expect(document.activeElement).toBe(document.body)

    rerender(<Piloté vue="gardes" liste={liste} />)
    expect(document.activeElement).toBe(carte('Extrait 2'))
  })

  it('ne touche à rien sur une visite ordinaire', async () => {
    // Venir de la bibliothèque n'est pas revenir d'un clip. Sans marque de
    // retour, la session ne doit ni déplacer le focus ni faire défiler.
    const defiler = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    écrireSessionTri('p1', { carte: 'c1', defilement: 940, vue: 'gardes' })

    render(<Piloté vue="atrier" liste={[candidat(1)]} />)

    expect(document.activeElement).toBe(document.body)
    expect(defiler).not.toHaveBeenCalled()
  })

  it('n’honore pas une marque orpheline — départ vers un clip sans retour au projet', async () => {
    // Issue #56, point 1 : quitter le clip vers la bibliothèque au lieu de
    // revenir au projet laisse la marque posée. La visite suivante, ordinaire
    // celle-là, ne doit pas hériter du focus et de la vue de l'aller-retour
    // qu'elle n'a jamais fait.
    const maintenant = vi.spyOn(Date, 'now')
    maintenant.mockReturnValue(1_000_000)
    écrireSessionTri('p1', { retour: true, carte: 'c2', vue: 'gardes' })

    maintenant.mockReturnValue(1_000_000 + 31 * 60 * 1000)
    const liste = [candidat(1), candidat(2, 'kept')]
    render(<Piloté vue="gardes" liste={liste} />)

    expect(document.activeElement).toBe(document.body)
  })

  it('marque le retour quand on part vers un clip', async () => {
    // C'est ce départ-là qui autorise la restauration au retour : sans lui, la
    // marque n'existerait jamais.
    render(<Harnais depart={[candidat(1)]} />)
    const utilisateur = await focaliser('Extrait 1')

    const espion = (événement: Event) => événement.preventDefault()
    document.addEventListener('click', espion, true)
    try {
      await utilisateur.keyboard('{Enter}')
    } finally {
      document.removeEventListener('click', espion, true)
    }

    expect(lireSessionTri('p1').retour).toBe(true)
  })
})

describe('le défilement mémorisé', () => {
  it('vide l’écriture différée avant de se démonter', async () => {
    // On fait défiler puis on ouvre un clip dans la foulée : le composant se
    // démontait, le minuteur était annulé sans avoir écrit, et le retour
    // restaurait l'ancienne position. (relevé par Copilot)
    Object.defineProperty(window, 'scrollY', { value: 640, configurable: true })
    const { unmount } = render(<Harnais depart={[candidat(1)]} />)

    window.dispatchEvent(new Event('scroll'))
    unmount()

    expect(lireSessionTri('p1').defilement).toBe(640)
  })
})

describe('ce que la carte annonce', () => {
  it('ne dit pas « Remettre, activé »', async () => {
    // Un bouton bascule dont le nom **est** l'état se lit tout seul : « Gardé,
    // activé ». Un nom qui décrit l'action inverse — « Remettre » — associé au
    // même `aria-pressed` s'annonce comme sa propre contradiction. Les deux
    // boutons portent donc leur statut, et le geste reste le même : rappuyer le
    // relâche.
    render(<Harnais depart={[candidat(1)]} />)
    const utilisateur = await focaliser('Extrait 1')

    await utilisateur.keyboard('e')

    const bouton = within(carte('Extrait 1')).getByRole('button', { name: /^écarté$/i })
    expect(bouton.getAttribute('aria-pressed')).toBe('true')
  })

  it('associe la raison du montage bloqué au contrôle qu’elle explique', () => {
    // La raison est à côté à l'œil ; sans `aria-describedby` elle n'est nulle
    // part pour qui n'a que le clavier et la voix — on entend « Monter », et
    // rien.
    render(<Harnais depart={[candidat(1, 'kept')]} proxyPret={false} vueInitiale="gardes" />)

    const monter = screen.getByRole('button', { name: /monter/i })
    const raison = within(carte('Extrait 1')).getByTestId('raison-monter')
    expect(monter.getAttribute('aria-describedby')).toBe(raison.id)
    expect(raison.id).not.toBe('')
  })
})

describe('la liste des raccourcis', () => {
  it('s’ouvre à « ? »', async () => {
    // Sept raccourcis qui ne se découvrent que dans un attribut `title` sont
    // sept raccourcis que personne n'utilise.
    render(<Harnais depart={[candidat(1)]} />)
    const utilisateur = await focaliser('Extrait 1')

    await utilisateur.keyboard('?')

    expect(within(screen.getByRole('dialog')).getByText(/défaire la dernière décision/i)).toBeTruthy()
  })

  it('s’ouvre aussi au bouton, pour qui n’a pas encore lu la liste', async () => {
    render(<Harnais depart={[candidat(1)]} />)

    await userEvent.setup().click(screen.getByRole('button', { name: /raccourcis/i }))

    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('ce que la carte expose', () => {
  it('ne cache pas la durée ni l’état derrière le lien de la vignette', () => {
    // Le lien de la vignette double celui du titre : il est retiré de l'arbre
    // d'accessibilité pour ne pas annoncer deux fois la même destination. Ce qui
    // est **information** — la position dans le replay, la durée, la marque de
    // décision — doit rester dehors, sinon on la perd avec lui.
    render(<Harnais depart={[candidat(1, 'kept')]} vueInitiale="gardes" />)
    const carte1 = carte('Extrait 1')

    for (const texte of ['0:30', '0:01:40']) {
      const noeud = within(carte1).getByText(texte)
      expect(noeud.closest('[aria-hidden="true"]')).toBeNull()
    }
  })
})

describe('le retour depuis un clip', () => {
  it('rend le focus à la carte d’où l’on est parti', () => {
    // Sans cela le clavier repart du haut de la page à chaque aller-retour, soit
    // quatre fois par émission. C'est l'écran de tri qui le porte : celui de
    // clip ne fait que naviguer par un lien.
    écrireSessionTri('p1', { retour: true, carte: 'c2' })
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
    écrireSessionTri('p1', { retour: true, defilement: 940 })
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

  it('dit l’avancement du montage en français, aux trois bornes', () => {
    // « 0 est monté » se lit mal, et c'est la phrase la plus regardée du
    // parcours : c'est celle qui dit ce qu'il reste à faire une fois le tri
    // fini.
    // Trois montages distincts : `cleanup` démonte tout, donc un `rerender`
    // derrière lui ne rendrait plus rien.
    render(<Harnais depart={[candidat(1, 'kept'), candidat(2, 'kept')]} />)
    expect(screen.getByText(/aucun n’est encore monté/i)).toBeTruthy()

    cleanup()
    render(<Harnais depart={[candidat(1, 'exported'), candidat(2, 'kept')]} />)
    expect(screen.getByText(/1 sur 2 est monté/i)).toBeTruthy()

    cleanup()
    render(<Harnais depart={[candidat(1, 'exported'), candidat(2, 'exported')]} />)
    expect(screen.getByText(/tous sont montés/i)).toBeTruthy()
  })

  it('distingue « tout a été écarté » de « des gardés restent à monter »', () => {
    // `suite` ne sépare pas les deux : les deux tombent sur `travail: 'trie'`.
    // C'est l'écran qui tient la liste, donc c'est à lui de le dire.
    render(<Harnais depart={[candidat(1, 'discarded'), candidat(2, 'discarded')]} />)

    expect(screen.getByText(/tout a été écarté/i)).toBeTruthy()
    expect(screen.queryByText(/tout est trié/i)).toBeNull()
  })

  it('offre la sortie du parcours quand tout est monté', () => {
    // `suite` rend alors une action dont la cible n'est pas cet écran : c'est le
    // succès du parcours, et il était jusqu'ici inexprimable.
    render(<Harnais depart={[candidat(1, 'exported'), candidat(2, 'discarded')]} />)

    const sortie = screen.getByRole('link', { name: /autre émission/i })
    expect(sortie).toHaveProperty('pathname', '/')
  })

  it('ne propose pas un lien vers l’écran où l’on est déjà', () => {
    // Sur `{ complet, trie }`, `suite` vise cet écran-ci : la grille **est**
    // l'action, et un lien vers soi-même volerait un arrêt de tabulation.
    render(<Harnais depart={[candidat(1, 'kept'), candidat(2, 'discarded')]} />)

    expect(screen.queryByRole('link', { name: /passer au montage/i })).toBeNull()
    expect(screen.getByText(/tout est trié/i)).toBeTruthy()
  })

  it('nomme ce qui débloque le montage quand le proxy manque', () => {
    // `{ triable, trie }` : Julien a fini de trier avant la fin de l'encodage. Il
    // n'a aucune action qui fasse avancer le montage, et l'attente est un
    // résultat de plein droit — avec sa raison, et ce qui la lèvera.
    render(<Harnais depart={[candidat(1, 'kept')]} proxyPret={false} />)

    expect(screen.getByTestId('issue').textContent).toMatch(/proxy/i)
    expect(screen.getByTestId('issue').textContent).toMatch(/titres|descriptions/i)
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

describe('la sélection en masse pour la publication (retour d’usage §2.4)', () => {
  it('n’affiche la barre d’outils que dès qu’un clip est coché', async () => {
    render(<Harnais depart={[candidat(1, 'kept'), candidat(2, 'kept')]} vueInitiale="gardes" />)
    const utilisateur = userEvent.setup()

    expect(screen.queryByRole('button', { name: /^Publier/ })).toBeNull()

    await utilisateur.click(screen.getByRole('checkbox', { name: /Extrait 1/ }))
    expect(screen.getByRole('button', { name: 'Publier 1 clip' })).toBeTruthy()

    await utilisateur.click(screen.getByRole('checkbox', { name: /Extrait 2/ }))
    expect(screen.getByRole('button', { name: 'Publier 2 clips' })).toBeTruthy()
  })

  it('ouvre la même modale que celle du clip seul, sur les clips cochés', async () => {
    render(<Harnais depart={[candidat(1, 'kept'), candidat(2, 'exported')]} vueInitiale="gardes" />)
    const utilisateur = userEvent.setup()

    await utilisateur.click(screen.getByRole('checkbox', { name: /Extrait 2/ }))
    await utilisateur.click(screen.getByRole('button', { name: 'Publier 1 clip' }))

    expect(screen.getByRole('heading', { name: 'Publier « Extrait 2 »' })).toBeTruthy()
  })

  it('ne vole pas le clavier du tri après un clic sur une case', async () => {
    // Le motif du contrat : le focus ne doit pas rester sur la case après le
    // clic, avec l'anneau de sélection resté sur la carte pendant que plus
    // rien ne répond au clavier.
    render(<Harnais depart={[candidat(1), candidat(2)]} />)
    const utilisateur = await focaliser('Extrait 1')
    await utilisateur.click(screen.getByRole('checkbox', { name: /Extrait 1/ }))
    await utilisateur.keyboard('g')

    expect(within(carte('Extrait 1')).getByRole('button', { name: /gardé/i })).toHaveProperty(
      'ariaPressed',
      'true',
    )
  })
})
