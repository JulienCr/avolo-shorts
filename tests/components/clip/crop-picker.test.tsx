// @vitest-environment jsdom

/**
 * Le sélecteur de ratio.
 *
 * Le curseur de cadrage se fige en 16:9 — le cadre occupe alors toute la
 * largeur, il n'y a rien à déplacer — et **rien ne le disait**. Un contrôle
 * inerte sans raison écrite passe pour cassé, et la raison ne peut pas vivre
 * dans une bulle d'aide : elle serait invisible au clavier.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CropOverlay, RatioPicker, frozenCropReason } from '@/components/clip/crop-picker'
import { framing, manualFraming, shot, splitCells, dubbingCells } from '../../fixtures/framing'

afterEach(cleanup)

/**
 * Le sélecteur ne montre plus que « auto » : les quatre ratios forçables
 * vivent derrière « Forcer un cadrage ». La raison d'un curseur figé et le
 * repli du calcul restent visibles en permanence, hors de la modale.
 */
function openForceDialog() {
  fireEvent.click(screen.getByRole('button', { name: /forcer un cadrage/i }))
}

describe('RatioPicker', () => {
  it('ne garde que « auto », le forçage derrière un déclencheur discret', () => {
    render(<RatioPicker framing={framing()} ratio="auto" onRatio={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'auto' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '4:5' })).toBeNull()
    expect(screen.getByRole('button', { name: /forcer un cadrage/i })).toBeTruthy()

    openForceDialog()
    expect(screen.getByRole('button', { name: '4:5' })).toBeTruthy()
  })

  it('forcer un ratio le transmet et referme la modale', () => {
    const onRatio = vi.fn()
    render(<RatioPicker framing={framing()} ratio="auto" onRatio={onRatio} />)

    openForceDialog()
    fireEvent.click(screen.getByRole('button', { name: '4:5' }))

    expect(onRatio).toHaveBeenCalledWith('4:5')
    expect(screen.queryByRole('button', { name: '4:5' })).toBeNull()
  })

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
   * **Le repli se dit, il ne se subit pas.** `renders` ne dépend pas
   * d'`analysis` dans le graphe : rien ne garantit qu'un clip en « auto » ait des
   * plans sous la main, et un 9:16 centré posé sans un mot ne se verrait qu'à
   * l'image, trois minutes d'export plus tard. Un fait sur ce clip, donc visible
   * en permanence, jamais derrière la modale de forçage.
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

  it('ne promet pas de variante quand le natif est déjà vertical', () => {
    // Un clip dont le natif est 9:16 n'a qu'une sortie (spec §11) : la ligne
    // qui nomme les deux fichiers le dit « aucune » plutôt que d'en taire une.
    render(
      <RatioPicker
        framing={framing({ ratio: '9:16', shots: [shot(0, 100, '9:16', 0.5)] })}
        ratio="auto"
        onRatio={vi.fn()}
      />,
    )
    const line = screen.getByText(/Fichier natif/).closest('p')!
    expect(line.textContent).toContain('aucune')
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

describe('doublage — porté par le ratio épinglé, comme le split', () => {
  // Régression Copilot : le natif ignore `dubbing` (`render.ts`), donc épingler
  // 9:16 doit faire taire la raison « doublage » comme `activeSplit` le fait
  // déjà pour le split — jamais `shot.dubbing` seul.
  it('ne cite plus le doublage quand le ratio épinglé supprime la variante', () => {
    const withDubbing = framing({
      ratio: '16:9',
      origin: 'no-analysis',
      shots: [shot(0, 100, '16:9', 0.5, 'manual', undefined, dubbingCells())],
    })
    render(<RatioPicker framing={withDubbing} ratio="9:16" onRatio={vi.fn()} />)
    expect(screen.queryByText(/doublage improvisé/)).toBeNull()
  })

  it('cite le doublage quand la variante 9:16 existe bien', () => {
    const withDubbing = framing({
      ratio: '16:9',
      origin: 'no-analysis',
      shots: [shot(0, 100, '16:9', 0.5, 'manual', undefined, dubbingCells())],
    })
    render(<RatioPicker framing={withDubbing} ratio="16:9" onRatio={vi.fn()} />)
    expect(screen.getByText(/doublage improvisé/)).toBeTruthy()
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

  it('rend les trois pavés plutôt qu’un slider, sur un plan de doublage', () => {
    // Pas de crop unique à situer, comme pour le split : un `slider` mentirait
    // sur les trois pavés (`aria-valuenow` d'une position qui n'existe pas).
    render(
      <CropOverlay
        framing={framing({
          origin: 'no-analysis',
          shots: [shot(0, 100, '16:9', 0.5, 'manual', undefined, dubbingCells())],
        })}
        ratio="16:9"
        cropX={0.5}
        onCropX={vi.fn()}
        describedBy="raison-cadrage"
      />,
    )
    expect(screen.queryByRole('slider')).toBeNull()
    const group = screen.getByRole('group')
    expect(group.getAttribute('aria-label')).toContain('doublage')
    expect(group.getAttribute('aria-describedby')).toBe('raison-cadrage')
    expect(group.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3)
  })

  it('ne rend pas les pavés quand le ratio épinglé supprime le doublage', () => {
    // Épingler 9:16 supprime la variante et le doublage avec elle, même
    // raisonnement qu'`activeSplit` (régression Copilot citée dans le contrat).
    render(
      <CropOverlay
        framing={framing({
          origin: 'no-analysis',
          shots: [shot(0, 100, '16:9', 0.5, 'manual', undefined, dubbingCells())],
        })}
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
