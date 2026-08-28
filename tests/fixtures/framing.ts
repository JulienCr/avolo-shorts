import type { PublishedFraming, FramingOrigin, ShotFraming } from '@/lib/api'
import type { Cell } from '@/core/framing'
import type { DubbingCells } from '@/core/dubbing'
import type { Ratio } from '@/core/edl'

/**
 * Le cadrage que le serveur publie, dans la forme minimale dont les composants
 * ont besoin.
 *
 * Il vit ici plutôt que dans chaque fichier de test parce que quatre composants
 * le consomment — le rectangle, l'aperçu, le sélecteur de ratio et le panneau
 * d'export — et qu'un champ ajouté au contrat doit casser un seul endroit.
 */
export function framing(overrides: Partial<PublishedFraming> = {}): PublishedFraming {
  return {
    ratio: '1:1',
    shots: [shot(0, 100, '1:1', 0.5)],
    rejectedOverrides: [],
    origin: 'computed',
    ...overrides,
  }
}

/** Un plan cadré, aux bornes de la **source** — celles que la lecture compare. */
export function shot(
  start: number,
  end: number,
  ratio: Ratio,
  cropX: number,
  source: ShotFraming['source'] = 'auto',
  split?: [Cell, Cell],
  dubbing?: DubbingCells,
): ShotFraming {
  return {
    shot: { start, end },
    key: Math.round(start * 1000),
    ratio,
    cropX,
    // Les deux positions coïncident par défaut : c'est le cas d'un plan déjà au
    // ratio natif, et ces tests-ci ne mesurent pas la différence.
    cropXNative: cropX,
    source,
    split,
    dubbing,
  }
}

/** Un trio de cellules de doublage, comme `dubbingCellsFor` en poserait. */
export function dubbingCells(): DubbingCells {
  return {
    film: { x0: 0, y0: 0, x1: 1, y1: 0.7 },
    pip: { x0: 0.6, y0: 0.7, x1: 1, y1: 1 },
    strip: { x0: 0, y0: 0.7, x1: 0.6, y1: 1 },
  }
}

/** Une paire de cellules de test, comme `computeShotSplit` en poserait. */
export function splitCells(): [Cell, Cell] {
  return [
    { x0: 0, y0: 0, x1: 0.5, y1: 1 },
    { x0: 0.5, y0: 0, x1: 1, y1: 1 },
  ]
}

/**
 * Le cadrage d'un projet dont l'analyse n'a pas tourné : un plan unique, au
 * réglage manuel du clip. C'est le seul cas où le curseur de cadrage reste
 * utile, donc celui qu'un test d'interaction doit prendre.
 */
export function manualFraming(
  ratio: Ratio = '1:1',
  cropX = 0.5,
  origin: Exclude<FramingOrigin, 'computed'> = 'no-analysis',
): PublishedFraming {
  return {
    ratio,
    shots: [shot(0, 100, ratio, cropX, 'manual')],
    rejectedOverrides: [],
    origin,
  }
}
