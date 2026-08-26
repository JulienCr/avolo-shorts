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
            ratio: 'auto',
            cropMode: 'auto',
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
