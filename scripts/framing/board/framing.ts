/**
 * Convertit une variante de planche en cadrage réel — issue #191, lot 3.
 *
 * Une variante `kind: 'settings'` traverse toujours `framingWith`
 * (`src/server/clip-framing.ts`), **la seule conversion** `FramingSettings` →
 * `FramingOptions` du dépôt. `kind: 'options'` échappe volontairement à cette
 * conversion (voir `spec.ts`) et appelle `computeFraming` en direct — c'est
 * l'escape hatch pour `margin`/`sideTrim`/`torso`, que `FramingSettings` ne
 * persiste pas.
 */

import type { Clip } from '@/core/edl'
import { computeFraming, FRAMING_DEFAULTS } from '@/core/framing'
import { shotStartMs, type Shot } from '@/core/shots'
import { getClips, getDb } from '@/server/db'
import { framingWith, type ResolvedFraming } from '@/server/clip-framing'
import { shotAt } from '../case-registry'
import type { BoardInput } from './input'
import type { BoardCase, FramingVariant } from './spec'

/** Un clip qui n'existe que pour porter des segments à `computeFraming` — aucun champ hors `segments`/`ratio`/`framingStyle` n'est lu. */
function syntheticClip(projectId: string, end: number): Clip {
  return {
    id: `synthetic:${projectId}`,
    projectId,
    segments: [{ start: 0, end }],
    ratio: 'auto',
    cropX: 0.5,
    captions: false,
    branding: false,
    footer: false,
    title: '',
    description: '',
    status: 'candidate',
    pass: 0,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
  }
}

/**
 * Le plan de l'analyse qui couvre `at` — la même règle que `build.ts` : le
 * plan de référence est toujours celui de l'analyse, jamais celui qu'une
 * variante subdivise.
 */
function shotCovering(input: BoardInput, at: number): Shot {
  const shot = input.analysis.shots.find((s) => s.start <= at && at < s.end)
  if (shot === undefined) {
    throw new Error(`resolveVariant : aucun plan de l'analyse ne couvre l'instant ${at}.`)
  }
  return shot
}

/**
 * Le `cropX` d'une variante pour un cas donné : un nombre s'applique tel
 * quel, une table par `BoardCase.id` s'y indexe — jamais par `shotStartMs`.
 */
function cropXFor(cropX: number | Readonly<Record<string, number>> | undefined, caseId: string): number | undefined {
  return typeof cropX === 'number' ? cropX : cropX?.[caseId]
}

/**
 * Le clip que le cas désigne : le vrai via `clipId`, ou un synthétique qui
 * couvre toute la source quand le cas n'en cite aucun.
 */
function clipFor(input: BoardInput, boardCase: BoardCase): Clip {
  if (boardCase.clipId !== null) {
    const clip = getClips(getDb(), boardCase.projectId).find((c) => c.id === boardCase.clipId)
    if (clip === undefined) {
      throw new Error(`resolveVariant : clip introuvable "${boardCase.clipId}" sur ${boardCase.projectId}.`)
    }
    return clip
  }
  const end = Math.max(...input.analysis.shots.map((s) => s.end), 0)
  return syntheticClip(boardCase.projectId, end)
}

export function resolveVariant(o: {
  input: BoardInput
  case: BoardCase
  variant: FramingVariant
}): ResolvedFraming {
  const { input, case: boardCase, variant } = o
  const clip = clipFor(input, boardCase)
  const cropX = variant.kind === 'options' ? cropXFor(variant.cropX, boardCase.id) : undefined

  const framing: ResolvedFraming =
    variant.kind === 'settings'
      ? framingWith(
          clip,
          { analysis: input.analysis, origin: 'computed' },
          { ...input.globals, ...variant.settings },
        )
      : {
          ...computeFraming({
            ...FRAMING_DEFAULTS,
            ...variant.options,
            segments: clip.segments,
            shots: input.analysis.shots,
            people: input.analysis.boxes,
            srcW: input.analysis.source.w,
            srcH: input.analysis.source.h,
            ratio: variant.ratio ?? 'auto',
            cropMode: variant.cropMode ?? 'auto',
            // Un `cropX` de variante porte sur le plan du cas, jamais sur
            // `shotStartMs` — c'est ici, et nulle part dans la spec, qu'il se
            // résout en dérogation `FramingRequest.crops`.
            crops:
              variant.cropMode === 'manual' && cropX !== undefined
                ? { [shotStartMs(shotCovering(input, boardCase.at))]: cropX }
                : undefined,
            fps: input.analysis.fps,
          }),
          origin: 'computed' as const,
        }

  if (shotAt(framing, boardCase.at) === undefined) {
    throw new Error(
      `resolveVariant : aucun plan ne couvre l'instant ${boardCase.at} — cas "${boardCase.id}", ` +
        `variante "${variant.id}".`,
    )
  }
  return framing
}
