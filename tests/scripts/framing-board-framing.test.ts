import { describe, expect, it } from 'vitest'
import { resolveVariant } from '../../scripts/framing/board/framing'
import type { BoardInput } from '../../scripts/framing/board/input'
import type { BoardCase, FramingVariant } from '../../scripts/framing/board/spec'
import { computeFraming, FRAMING_DEFAULTS, FRAMING_SETTINGS_DEFAULTS } from '@/core/framing'
import type { FramingSettings } from '@/core/framing'
import { POINT, POINT_COUNT } from '@/core/shots'
import type { PersonBox } from '@/core/shots'
import type { Analysis } from '@/server/steps/analysis'

/**
 * `resolveVariant` sans `clipId` ne touche jamais le disque ni la base — le
 * clip synthétique couvre toute la source. Ces tests restent donc purs, sur
 * une `Analysis` construite à la main plutôt que lue d'un `projects/`.
 */

function personKeypoints(centerX: number, eyeY: number, shoulderY: number, halfWidth: number): number[] {
  const k = Array.from({ length: POINT_COUNT * 3 }, () => 0)
  const put = (point: keyof typeof POINT, x: number, y: number, score: number): void => {
    k[POINT[point] * 3] = x
    k[POINT[point] * 3 + 1] = y
    k[POINT[point] * 3 + 2] = score
  }
  put('NOSE', centerX, eyeY, 0.9)
  put('LEFT_EYE', centerX - 0.01, eyeY, 0.9)
  put('RIGHT_EYE', centerX + 0.01, eyeY, 0.9)
  put('LEFT_EAR', centerX - halfWidth, eyeY, 0.9)
  put('RIGHT_EAR', centerX + halfWidth, eyeY, 0.9)
  put('LEFT_SHOULDER', centerX - halfWidth, shoulderY, 0.9)
  put('RIGHT_SHOULDER', centerX + halfWidth, shoulderY, 0.9)
  return k
}

function personBox(t: number, centerX: number, eyeY: number, shoulderY: number, halfWidth: number): PersonBox {
  return {
    t,
    x0: centerX - halfWidth * 2,
    x1: centerX + halfWidth * 2,
    y0: eyeY - 0.1,
    y1: shoulderY + 0.5,
    score: 0.9,
    k: personKeypoints(centerX, eyeY, shoulderY, halfWidth),
  }
}

function analysisFixture(boxes: PersonBox[], shots: { start: number; end: number }[]): Analysis {
  return {
    version: 2,
    keypoints: 'coco17',
    fps: 2,
    source: { w: 1920, h: 1080 },
    proxy: { w: 960, h: 540 },
    shots,
    boxes,
  } as Analysis
}

function boardInput(analysis: Analysis, globals: FramingSettings = FRAMING_SETTINGS_DEFAULTS): BoardInput {
  return {
    projectId: 'test-project',
    analysis,
    decoded: { file: '/tmp/source.mp4', w: 1920, h: 1080, videoFps: 30, fromProxy: false },
    hasAudio: true,
    globals,
  }
}

function boardCase(o: Partial<BoardCase> = {}): BoardCase {
  return { id: 'case-1', projectId: 'test-project', at: 1, clipId: null, stake: 'test', ...o }
}

describe("resolveVariant : kind 'settings' traverse `framingWith`, jamais une seconde conversion", () => {
  it('`splitMinShotMs: 1500` donne le même cadrage que `splitMinShot: 1.5` passé directement à `computeFraming`', () => {
    const boxes: PersonBox[] = []
    for (let t = 0; t < 2.5; t += 0.5) {
      boxes.push(personBox(t, 0.25, 0.3, 0.4, 0.05))
      boxes.push(personBox(t, 0.64, 0.35, 0.45, 0.04))
    }
    const shots = [{ start: 0, end: 2.5 }]
    const analysis = analysisFixture(boxes, shots)
    const input = boardInput(analysis)
    const c = boardCase({ at: 1 })
    const variant: FramingVariant = { id: 'v', label: 'v', kind: 'settings', settings: { splitMinShotMs: 1500 } }

    const resolved = resolveVariant({ input, case: c, variant })

    const direct = computeFraming({
      ...FRAMING_DEFAULTS,
      splitMinShot: 1.5,
      segments: [{ start: 0, end: 2.5 }],
      shots,
      people: boxes,
      srcW: analysis.source.w,
      srcH: analysis.source.h,
      ratio: 'auto',
      cropMode: 'auto',
      fps: analysis.fps,
    })

    expect(resolved.shots).toEqual(direct.shots)
    // Le réglage a un effet mesurable : sans lui (défaut 4 s pour un plan de
    // 2,5 s), aucun split ne se pose. Sans cet écart, l'égalité ci-dessus
    // serait vraie même si `resolveVariant` ignorait `variant.settings`.
    expect(resolved.shots[0].split).toBeDefined()
  })
})

describe("resolveVariant : kind 'options' échappe à la conversion et appelle `computeFraming` en direct", () => {
  it('les options passent telles quelles, sans traverser `framingWith`', () => {
    const boxes: PersonBox[] = [{ t: 1, x0: 0.1, x1: 0.3, y0: 0.2, y1: 0.9, score: 0.9 }]
    const shots = [{ start: 0, end: 5 }]
    const analysis = analysisFixture(boxes, shots)
    const input = boardInput(analysis)
    const c = boardCase({ at: 1 })
    const variant: FramingVariant = { id: 'v', label: 'v', kind: 'options', options: { margin: 0.2 }, why: 'test' }

    const resolved = resolveVariant({ input, case: c, variant })

    const direct = computeFraming({
      ...FRAMING_DEFAULTS,
      margin: 0.2,
      segments: [{ start: 0, end: 5 }],
      shots,
      people: boxes,
      srcW: analysis.source.w,
      srcH: analysis.source.h,
      ratio: 'auto',
      cropMode: 'auto',
      fps: analysis.fps,
    })

    expect(resolved.shots).toEqual(direct.shots)
  })
})

describe('resolveVariant : le cas', () => {
  it("sans `clipId` est cadré sur le plan entier — le clip synthétique couvre toute la source", () => {
    const boxes: PersonBox[] = [{ t: 1, x0: 0.1, x1: 0.3, y0: 0.2, y1: 0.9, score: 0.9 }]
    const shots = [{ start: 0, end: 5 }, { start: 10, end: 20 }]
    const analysis = analysisFixture(boxes, shots)
    const input = boardInput(analysis)
    const c = boardCase({ at: 1, clipId: null })
    const variant: FramingVariant = { id: 'v', label: 'v', kind: 'settings', settings: {} }

    const resolved = resolveVariant({ input, case: c, variant })

    expect(resolved.shots.map((s) => [s.shot.start, s.shot.end])).toEqual([
      [0, 5],
      [10, 20],
    ])
  })

  it("dont l'instant `at` ne tombe dans aucun plan est refusé", () => {
    const boxes: PersonBox[] = [{ t: 1, x0: 0.1, x1: 0.3, y0: 0.2, y1: 0.9, score: 0.9 }]
    const shots = [{ start: 0, end: 5 }]
    const analysis = analysisFixture(boxes, shots)
    const input = boardInput(analysis)
    const c = boardCase({ at: 50, clipId: null })
    const variant: FramingVariant = { id: 'v', label: 'v', kind: 'settings', settings: {} }

    expect(() => resolveVariant({ input, case: c, variant })).toThrow()
  })
})
