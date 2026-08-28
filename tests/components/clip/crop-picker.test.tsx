// @vitest-environment jsdom

/**
 * Le sélecteur de ratio.
 *
 * Le curseur de cadrage se fige en 16:9 — le cadre occupe alors toute la
 * largeur, il n'y a rien à déplacer — et **rien ne le disait**. Un contrôle
 * inerte sans raison écrite passe pour cassé, et la raison ne peut pas vivre
 * dans une bulle d'aide : elle serait invisible au clavier.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CropOverlay, RatioPicker, frozenCropReason } from '@/components/clip/crop-picker'
import { framing, manualFraming, shot, splitCells } from '../../fixtures/framing'

afterEach(cleanup)

describe('RatioPicker', () => {
  it('dit pourquoi le cadre ne se déplace pas en 16:9', () => {
    render(
      <RatioPicker
        framing={framing({ ratio: '16:9', shots: [shot(0, 100, '16:9', 0.5)] })}
        ratio="16:9"
        onRatio={vi.fn()}
      />,
    )
    expect(screen.getByText(/toute la largeur/i)).toBeTruthy()
  })

  it('ne dit rien de tel sur un ratio où le cadre se déplace', () => {
    render(<RatioPicker framing={framing()} ratio="1:1" onRatio={vi.fn()} />)
    expect(screen.queryByText(/toute la largeur/i)).toBeNull()
  })

  /**
   * **Le message de l'itération 0 disait « auto vaut 9:16 », et c'était faux dès
   * que le calcul est entré en service.** §3.5 demande un mot au même endroit
   * dans les deux cas : ce que « auto » a choisi, ou que le ratio est épinglé.
   */
  it('dit ce que « auto » a choisi pour le plan qu’on regarde', () => {
    render(
      <RatioPicker
        framing={framing({ ratio: '4:5', shots: [shot(0, 100, '4:5', 0.5)] })}
        ratio="auto"
        onRatio={vi.fn()}
      />,
    )
    expect(screen.getByText(/auto → 4:5/)).toBeTruthy()
    expect(screen.queryByText(/itération 0/i)).toBeNull()
  })

  it('marque un ratio épinglé au lieu de le laisser passer pour un calcul', () => {
    render(<RatioPicker framing={framing()} ratio="1:1" onRatio={vi.fn()} />)
    expect(screen.getByText(/1:1 · épinglé/)).toBeTruthy()
  })

  /**
   * **Le ratio se choisit par plan, et un cadre qui change de taille en cours de
   * lecture passe pour un défaut de rendu si personne ne le dit.** C'est
   * pourtant le bénéfice qu'on cherche : un ratio unique écraserait chaque plan
   * serré sous le plus large.
   */
  it('annonce que le cadre change avec les plans', () => {
    render(
      <RatioPicker
        framing={framing({
          ratio: '16:9',
          shots: [shot(0, 50, '9:16', 0.5), shot(50, 100, '16:9', 0.5)],
        })}
        ratio="auto"
        onRatio={vi.fn()}
      />,
    )
    expect(screen.getByText(/change avec les plans/i)).toBeTruthy()
  })

  /**
   * **Le repli se dit, il ne se subit pas.** `renders` ne dépend pas
   * d'`analysis` dans le graphe : rien ne garantit qu'un clip en « auto » ait des
   * plans sous la main, et un 9:16 centré posé sans un mot ne se verrait qu'à
   * l'image, trois minutes d'export plus tard.
   */
  it.each([
    ['no-analysis', /n’a pas tourné/i],
    ['unreadable-analysis', /ne se lit pas/i],
    ['no-shots', /aucun plan/i],
  ] as const)('dit qu’aucun calcul n’a eu lieu — %s', (origin, pattern) => {
    render(
      <RatioPicker framing={manualFraming('9:16', 0.5, origin)} ratio="auto" onRatio={vi.fn()} />,
    )
    expect(screen.getByText(pattern)).toBeTruthy()
  })

  it('ne dit rien de tel quand le cadrage a été calculé', () => {
    render(<RatioPicker framing={framing()} ratio="auto" onRatio={vi.fn()} />)
    expect(screen.queryByText(/n’a pas tourné/i)).toBeNull()
    expect(screen.getByText(/calculé pour chaque plan/i)).toBeTruthy()
  })

  /**
   * **Une seule ligne par question, et elles ne sont pas la même.**
   *
   * Ce test disait l'inverse : quand les cadres variaient, la raison du curseur
   * figé disparaissait pour ne pas empiler deux paragraphes. La conséquence
   * était qu'un curseur inerte cessait de dire pourquoi précisément dans le cas
   * le plus fréquent — le cadrage calculé sur une émission à plusieurs plans.
   * L'arbitrage a changé : la variation des cadres et l'inertie du curseur sont
   * deux faits distincts, et chacun se dit dans **une** phrase. Ce qui reste
   * interdit, c'est de répéter l'un des deux.
   */
  it('dit la variation des cadres et l’inertie du curseur, chacune une fois', () => {
    render(
      <RatioPicker
        framing={framing({
          ratio: '16:9',
          shots: [shot(0, 50, '4:5', 0.5), shot(50, 100, '16:9', 0.5)],
        })}
        ratio="auto"
        onRatio={vi.fn()}
      />,
    )
    expect(screen.getAllByText(/change avec les plans/i)).toHaveLength(1)
    expect(screen.getAllByText(/calculé pour chaque plan/i)).toHaveLength(1)
  })

  /**
   * **Le sélecteur choisit le natif, pas la sortie verticale plan par plan**, et
   * rien dans la géométrie de l'écran ne l'empêche de faire croire le contraire :
   * les deux aperçus montrent le cadre de la *variante*, qui est celui qui bouge.
   * La ligne qui nomme les deux fichiers est donc la seule chose qui ferme le
   * piège — la raccourcir en supprimant l'un des deux noms le rouvre.
   */
  it('nomme les deux fichiers que le choix décide', () => {
    render(
      <RatioPicker
        framing={framing({
          ratio: '16:9',
          shots: [shot(0, 50, '4:5', 0.5), shot(50, 100, '16:9', 0.5)],
        })}
        ratio="auto"
        onRatio={vi.fn()}
      />,
    )
    const line = screen.getByText(/ne se règle pas ici/i)
    expect(line.textContent).toContain('fichier natif')
    expect(line.textContent).toContain('variante 9:16')
  })

  it('ne promet pas de variante quand le natif est déjà vertical', () => {
    // Un clip dont le natif est 9:16 n'a qu'une sortie (spec §11). Annoncer une
    // variante ici la ferait attendre sur le clip le mieux livré.
    render(
      <RatioPicker
        framing={framing({ ratio: '9:16', shots: [shot(0, 100, '9:16', 0.5)] })}
        ratio="auto"
        onRatio={vi.fn()}
      />,
    )
    expect(screen.getByText(/déjà vertical/i)).toBeTruthy()
    expect(screen.queryByText(/ne se règle pas ici/i)).toBeNull()
  })

  /**
   * Le split (spec du 25 août) n'existe que sur la variante : « auto → split »
   * dit ce que ce plan-là rend, pas un ratio de crop qui n'y correspond plus.
   */
  it('dit « split » sur un plan splitté plutôt qu’un ratio de crop', () => {
    render(
      <RatioPicker
        framing={framing({ shots: [shot(0, 100, '16:9', 0.5, 'auto', splitCells())] })}
        ratio="auto"
        onRatio={vi.fn()}
      />,
    )
    expect(screen.getByText(/auto → split/)).toBeTruthy()
  })

  it('dit « split · sur ce plan » quand le ratio est épinglé sur un plan splitté', () => {
    // Un ratio épinglé vaut « pour tous » (§ ci-dessus) — sauf sur un plan
    // splitté, où ce n'est justement plus un ratio de crop qui s'applique.
    render(
      <RatioPicker
        framing={framing({ shots: [shot(0, 100, '16:9', 0.5, 'auto', splitCells())] })}
        ratio="1:1"
        onRatio={vi.fn()}
      />,
    )
    expect(screen.getByText(/split · sur ce plan/)).toBeTruthy()
  })

  it('signale le split dans la ligne qui nomme les deux fichiers', () => {
    render(
      <RatioPicker
        framing={framing({
          shots: [shot(0, 50, '16:9', 0.5, 'auto', splitCells()), shot(50, 100, '1:1', 0.5)],
        })}
        ratio="auto"
        onRatio={vi.fn()}
      />,
    )
    expect(screen.getByText(/en split sur certains plans/)).toBeTruthy()
  })

  it('ne signale aucun split quand aucun plan n’en pose', () => {
    render(<RatioPicker framing={framing()} ratio="auto" onRatio={vi.fn()} />)
    expect(screen.queryByText(/en split sur certains plans/)).toBeNull()
  })

  it('détaille le split-screen dans le dépliant de comportement', () => {
    render(
      <RatioPicker
        framing={framing({ shots: [shot(0, 100, '16:9', 0.5, 'auto', splitCells())] })}
        ratio="auto"
        onRatio={vi.fn()}
      />,
    )
    expect(screen.getByText(/deux cellules empilées, sans fond/)).toBeTruthy()
  })

  it('nomme le cadre pris dans la source, pas « le ratio de sortie »', () => {
    // Il y a deux sorties, et ce sélecteur n'en règle qu'une directement :
    // « ratio de sortie » était le mot qui autorisait la confusion.
    render(<RatioPicker framing={framing()} ratio="auto" onRatio={vi.fn()} />)
    expect(screen.getByRole('group', { name: /cadre pris dans la source/i })).toBeTruthy()
  })
})

describe('frozenCropReason', () => {
  /**
   * **Le curseur est inerte depuis la mise en service du cadrage automatique, et
   * c'est délibéré** : la table de dérogation par plan dans laquelle il écrira
   * n'existe pas encore. Un curseur muet qui ne bouge rien fait douter de
   * l'outil, d'où la raison écrite à côté — la forme que le bouton « Monter »
   * d'une carte de candidat a déjà.
   */
  it('dit pourquoi le curseur ne déplace rien quand le cadrage est calculé', () => {
    expect(frozenCropReason(framing(), '1:1')).toContain('dérogation par plan')
  })

  it('dit qu’il n’y a rien à déplacer en 16:9', () => {
    expect(frozenCropReason(framing({ ratio: '16:9' }), '16:9')).toContain('toute la largeur')
  })

  it('ne dit rien quand le curseur sert vraiment', () => {
    // L'analyse n'a pas tourné : le réglage à la main reprend la main
    // entièrement, et c'est le cadrage de l'itération 0 — il n'a jamais été
    // jetable.
    expect(frozenCropReason(manualFraming('1:1'), '1:1')).toBeNull()
  })

  it('dit qu’un plan splitté n’a pas un seul crop à déplacer', () => {
    // Prime sur les deux autres causes : même en 16:9 ou en réglage manuel, un
    // plan à deux cellules n'a rien qu'un curseur horizontal puisse désigner.
    expect(frozenCropReason(manualFraming('1:1'), '1:1', true)).toContain('cellules empilées')
  })

  // PR3 rend cette phrase vraie : `render.ts` compose désormais le pavé
  // comédiens depuis `shot.dubbing`, ce qui n'était pas le cas quand PR4 avait
  // fait retirer cette même cause (revue Copilot, PR #254).
  it('dit qu’un plan de doublage n’a pas un seul crop à déplacer', () => {
    expect(frozenCropReason(manualFraming('1:1'), '1:1', false, true)).toContain(
      'doublage improvisé',
    )
  })
})

describe('CropOverlay', () => {
  it('reste atteignable au clavier tant qu’il a une raison à donner', () => {
    // `disabled` — ou un `tabIndex` à -1 — sort du parcours de tabulation : au
    // clavier on ne découvre ni le contrôle ni la raison pour laquelle il ne
    // répond pas (§4.4).
    render(
      <CropOverlay
        framing={framing()}
        ratio="1:1"
        cropX={0.5}
        onCropX={vi.fn()}
        describedBy="raison-cadrage"
      />,
    )
    const slider = screen.getByRole('slider')
    expect(slider.getAttribute('tabindex')).toBe('0')
    expect(slider.getAttribute('aria-disabled')).toBe('true')
    expect(slider.getAttribute('aria-describedby')).toBe('raison-cadrage')
  })

  it('ne décrit rien quand il déplace pour de bon', () => {
    // Un `aria-describedby` qui pointe vers une phrase que `RatioPicker` ne rend
    // pas dans ce cas-là désignerait un identifiant absent.
    render(
      <CropOverlay
        framing={manualFraming('1:1')}
        ratio="1:1"
        cropX={0.5}
        onCropX={vi.fn()}
        describedBy="raison-cadrage"
      />,
    )
    const slider = screen.getByRole('slider')
    expect(slider.getAttribute('aria-describedby')).toBeNull()
    expect(slider.getAttribute('aria-disabled')).toBeNull()
  })

  it('rend les deux cellules plutôt qu’un slider, sur un plan splitté', () => {
    // Pas de crop unique à situer : un `slider` mentirait sur les deux
    // (`aria-valuenow` d'une position qui n'existe pas).
    render(
      <CropOverlay
        framing={framing({ shots: [shot(0, 100, '16:9', 0.5, 'auto', splitCells())] })}
        ratio="auto"
        cropX={0.5}
        onCropX={vi.fn()}
        describedBy="raison-cadrage"
      />,
    )
    expect(screen.queryByRole('slider')).toBeNull()
    const group = screen.getByRole('group')
    expect(group.getAttribute('aria-describedby')).toBe('raison-cadrage')
    expect(group.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2)
  })

  it('ne rend pas les cellules quand le ratio épinglé supprime le split', () => {
    // Épingler 9:16 supprime la variante et le split avec elle, avant même le
    // retour du `PATCH` (`activeSplit`, addendum #178).
    render(
      <CropOverlay
        framing={framing({ shots: [shot(0, 100, '16:9', 0.5, 'auto', splitCells())] })}
        ratio="9:16"
        cropX={0.5}
        onCropX={vi.fn()}
        describedBy="raison-cadrage"
      />,
    )
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByRole('slider')).toBeTruthy()
  })
})
