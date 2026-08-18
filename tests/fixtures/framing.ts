import type { PublishedFraming, FramingOrigin, ShotFraming } from '@/lib/api'
import type { Ratio } from '@/core/edl'

/**
 * Le cadrage que le serveur publie, dans la forme minimale dont les composants
 * ont besoin.
 *
 * Il vit ici plutôt que dans chaque fichier de test parce que quatre composants
 * le consomment — le rectangle, l'aperçu, le sélecteur de ratio et le panneau
 * d'export — et qu'un champ ajouté au contrat doit casser un seul endroit.
 */
export function framing(surcharges: Partial<PublishedFraming> = {}): PublishedFraming {
  return {
    ratio: '1:1',
    shots: [shot(0, 100, '1:1', 0.5)],
    rejectedOverrides: [],
    origin: 'computed',
    ...surcharges,
  }
}

/** Un plan cadré, aux bornes de la **source** — celles que la lecture compare. */
export function shot(
  start: number,
  end: number,
  ratio: Ratio,
  cropX: number,
  source: ShotFraming['source'] = 'auto',
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
  }
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
