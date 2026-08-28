import { beforeEach, describe, expect, it } from 'vitest'
import { stillArgs, type StillRequest } from '../../scripts/framing/board/still'
import type { BoardInput } from '../../scripts/framing/board/input'
import type { ResolvedFraming } from '@/server/clip-framing'
import type { Ratio } from '@/core/edl'
import type { ShotFraming } from '@/core/framing'
import { cropRect, outputSize, splitCellRect } from '@/core/framing'
import { blurredVariantArgs, type FramedSegment } from '@/core/ffmpeg/args'

/**
 * `stillArgs` ne lance jamais ffmpeg : c'est tout l'intérêt de l'avoir
 * isolée. `encoderName()` sonde NVENC par un vrai `ffmpeg -c:v h264_nvenc` à
 * moins que `FFMPEG_ENCODER` ne tranche d'avance — donc fixé ici, sur tous
 * les tests du fichier.
 */
beforeEach(() => {
  process.env.FFMPEG_ENCODER = 'x264'
})

function decodedInput(o: Partial<BoardInput['decoded']> = {}): BoardInput {
  return {
    projectId: 'test-project',
    // Seul `decoded` est lu par `stillArgs` — le reste de `BoardInput` sert
    // `input.ts`/`framing.ts`, hors de portée de ce fichier.
    analysis: {} as BoardInput['analysis'],
    decoded: { file: '/tmp/source.mp4', w: 1920, h: 1080, videoFps: 30, fromProxy: false, durationSec: null, ...o },
    hasAudio: true,
    globals: {} as BoardInput['globals'],
  }
}

function shotFraming(o: Partial<ShotFraming> & Pick<ShotFraming, 'shot'>): ShotFraming {
  return {
    key: 0,
    ratio: '9:16',
    cropX: 0.5,
    cropXNative: 0.5,
    source: 'auto',
    ...o,
  }
}

function framing(shots: ShotFraming[], ratio: Ratio = '16:9'): ResolvedFraming {
  return { ratio, shots, rejectedOverrides: [], origin: 'computed' }
}

/** Les seuls champs de l'argv que l'invariant 1 protège : timing et nombre d'entrées. */
function timingOf(args: string[]): { ss: string[]; t: string[]; iCount: number } {
  const ss: string[] = []
  const t: string[] = []
  let iCount = 0
  args.forEach((a, i) => {
    if (a === '-ss') ss.push(args[i + 1])
    if (a === '-t') t.push(args[i + 1])
    if (a === '-i') iCount += 1
  })
  return { ss, t, iCount }
}

const SHOT = { start: 0, end: 100 }

describe('stillArgs : invariant 1 — même instant, argv de timing identiques', () => {
  it("quatre variantes qui ne diffèrent que par le cadre produisent le même -ss/-t/-i", () => {
    // Les quatre replis du split rejeté (#190) : split activé, désactivé, un
    // ratio épinglé plus large, et un crop manuel — ce dernier avec `source:
    // 'manual'` et sans `split`, comme `applyExceptions` le pose réellement
    // (`src/core/framing.ts`).
    const splitOn = framing([shotFraming({ shot: SHOT, split: [{ x0: 0, y0: 0, x1: 1, y1: 0.5 }, { x0: 0, y0: 0.5, x1: 1, y1: 1 }] })])
    const splitOff = framing([shotFraming({ shot: SHOT })])
    const pinnedRatio = framing([shotFraming({ shot: SHOT, ratio: '1:1' })], '1:1')
    const manualCrop = framing([shotFraming({ shot: SHOT, ratio: '9:16', cropX: 0.7, cropXNative: 0.7, source: 'manual' })])

    const base = { input: decodedInput(), instant: 10, shotEnd: SHOT.end, output: 'vertical' as const, dst: 'a.mp4' }
    const variants = [splitOn, splitOff, pinnedRatio, manualCrop].map((f) => stillArgs({ ...base, framing: f }))

    const [reference, ...rest] = variants.map((v) => timingOf(v.args))
    for (const timing of rest) {
      expect(timing).toEqual(reference)
    }
    for (const v of variants) {
      expect(v.window).toEqual(variants[0].window)
    }
  })

  it("une variante qui redécoupe le plan (#190) ne bouge ni -ss ni -t : la frontière tombe hors de la fenêtre", () => {
    const single = framing([shotFraming({ shot: SHOT })])
    const subdivided = framing([
      shotFraming({ shot: { start: 0, end: 50 } }),
      shotFraming({ shot: { start: 50, end: 100 } }),
    ])

    const base = { input: decodedInput(), instant: 10, shotEnd: SHOT.end, output: 'vertical' as const, dst: 'a.mp4' }
    const a = stillArgs({ ...base, framing: single })
    const b = stillArgs({ ...base, framing: subdivided })

    expect(timingOf(a.args)).toEqual(timingOf(b.args))
    expect(a.pieces.length).toBe(1)
    expect(b.pieces.length).toBe(1)
  })

  it('contrôle négatif : un plan à une seule personne rend deux argv identiques caractère pour caractère', () => {
    const same = framing([shotFraming({ shot: SHOT, ratio: '1:1', cropX: 0.4, cropXNative: 0.4 })])
    const base = { input: decodedInput(), instant: 10, shotEnd: SHOT.end, output: 'vertical' as const, dst: 'a.mp4' }
    const a = stillArgs({ ...base, framing: same })
    const b = stillArgs({ ...base, framing: same })
    expect(a.args).toEqual(b.args)
    expect(a.args.join('\0')).toBe(b.args.join('\0'))
  })
})

describe('stillArgs : géométrie sur les dimensions sondées du fichier décodé', () => {
  it("un fichier décodé à 960x540 (proxy) calcule crop.w sur 960x540, pas sur 1920x1080 rééchelonné", () => {
    const input = decodedInput({ w: 960, h: 540, fromProxy: true })
    const f = framing([shotFraming({ shot: SHOT, ratio: '9:16', cropX: 0.5 })])
    const { args } = stillArgs({ input, instant: 10, shotEnd: SHOT.end, framing: f, output: 'vertical', dst: 'a.mp4' })

    const expected = cropRect('9:16', 0.5, 960, 540)
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(filter).toContain(`crop=${expected.w}:${expected.h}:${expected.x}:${expected.y}`)
  })
})

describe('stillArgs : native contre verticale', () => {
  it('la variante native ne porte jamais `split`, même quand le plan en pose un', () => {
    const f = framing([shotFraming({ shot: SHOT, split: [{ x0: 0, y0: 0, x1: 1, y1: 0.5 }, { x0: 0, y0: 0.5, x1: 1, y1: 1 }] })])
    const native = stillArgs({ input: decodedInput(), instant: 10, shotEnd: SHOT.end, framing: f, output: 'native', dst: 'a.mp4' })
    const vertical = stillArgs({ input: decodedInput(), instant: 10, shotEnd: SHOT.end, framing: f, output: 'vertical', dst: 'a.mp4' })

    expect(native.args.join(' ')).not.toContain('vstack')
    expect(vertical.args.join(' ')).toContain('vstack=inputs=2')
  })

  it('la variante native prend `cropXNative`, la verticale prend `cropX`', () => {
    const input = decodedInput()
    const f = framing([shotFraming({ shot: SHOT, ratio: '9:16', cropX: 0.3, cropXNative: 0.7 })], '16:9')

    const native = stillArgs({ input, instant: 10, shotEnd: SHOT.end, framing: f, output: 'native', dst: 'a.mp4' })
    const vertical = stillArgs({ input, instant: 10, shotEnd: SHOT.end, framing: f, output: 'vertical', dst: 'a.mp4' })

    const expectedNative = cropRect('16:9', 0.7, input.decoded.w, input.decoded.h)
    const expectedVertical = cropRect('9:16', 0.3, input.decoded.w, input.decoded.h)

    const nativeFilter = native.args[native.args.indexOf('-filter_complex') + 1]
    const verticalFilter = vertical.args[vertical.args.indexOf('-filter_complex') + 1]

    expect(nativeFilter).toContain(`crop=${expectedNative.w}:${expectedNative.h}:${expectedNative.x}:${expectedNative.y}`)
    expect(verticalFilter).toContain(`crop=${expectedVertical.w}:${expectedVertical.h}:${expectedVertical.x}:${expectedVertical.y}`)
  })

  // Régression Copilot : `stillArgs` promet de construire les mêmes
  // `FramedSegment[]` que `render.ts` ; sans `dubbing` propagé, une planche sur
  // un plan de doublage montrerait le crop ordinaire au lieu de la composition.
  it('la variante verticale propage `dubbing`, comme `split`', () => {
    const cells = {
      film: { x0: 0, y0: 0, x1: 1, y1: 0.9 },
      pip: { x0: 0.773, y0: 0.022, x1: 0.988, y1: 0.222 },
      strip: { x0: 0, y0: 0.9, x1: 1, y1: 1 },
    }
    const f = framing([shotFraming({ shot: SHOT, ratio: '1:1', dubbing: cells })])
    const vertical = stillArgs({ input: decodedInput(), instant: 10, shotEnd: SHOT.end, framing: f, output: 'vertical', dst: 'a.mp4' })
    const native = stillArgs({ input: decodedInput(), instant: 10, shotEnd: SHOT.end, framing: f, output: 'native', dst: 'a.mp4' })

    const verticalFilter = vertical.args[vertical.args.indexOf('-filter_complex') + 1]
    const nativeFilter = native.args[native.args.indexOf('-filter_complex') + 1]

    expect(verticalFilter).toContain('geq=')
    // Le natif ignore toujours `dubbing`, comme il ignore déjà `split`.
    expect(nativeFilter).not.toContain('geq=')
  })
})

describe('stillArgs : la fenêtre', () => {
  it("une fenêtre qui ne tient pas une image est refusée", () => {
    const f = framing([shotFraming({ shot: SHOT })])
    const input = decodedInput({ videoFps: 30 })
    expect(() =>
      stillArgs({ input, instant: 10, shotEnd: 10.001, framing: f, output: 'vertical', dst: 'a.mp4' }),
    ).toThrow()
  })

  it('une fenêtre est bornée à la fin du plan', () => {
    const f = framing([shotFraming({ shot: { start: 0, end: 10.15 } })])
    const input = decodedInput({ videoFps: 60 })
    const { window } = stillArgs({ input, instant: 10, shotEnd: 10.15, framing: f, output: 'vertical', dst: 'a.mp4' })
    expect(window.end).toBe(10.15)
  })
})

describe("stillArgs : l'argv vertical est exactement celui de blurredVariantArgs", () => {
  it('appelé directement avec les mêmes segments, sur les mêmes pièces', () => {
    const input = decodedInput()
    const f = framing([shotFraming({ shot: SHOT, ratio: '4:5', cropX: 0.6, cropXNative: 0.5 })], '16:9')
    const request: StillRequest & { dst: string } = {
      input,
      instant: 10,
      shotEnd: SHOT.end,
      framing: f,
      output: 'vertical',
      dst: 'a.mp4',
    }
    const { pieces, args } = stillArgs(request)

    // Reproduit le geste de `still.ts`, pas son résultat : reconstruit les
    // mêmes `FramedSegment[]` depuis les `pieces` déjà rendues par
    // `stillArgs`, et vérifie que `blurredVariantArgs` appelé en direct rend
    // exactement le même argv — la preuve que rien n'a été réimplémenté.
    const { w, h } = input.decoded
    const segments: FramedSegment[] = pieces.map((p) => ({
      start: p.start,
      end: p.end,
      ratio: p.ratio,
      crop: cropRect(p.ratio, p.cropX, w, h),
      split: p.split !== undefined ? [splitCellRect(p.split[0], w, h), splitCellRect(p.split[1], w, h)] : undefined,
    }))
    const direct = blurredVariantArgs({
      src: input.decoded.file,
      dst: 'a.mp4',
      segments,
      out: outputSize('9:16'),
      encoder: 'x264',
    })

    expect(args).toEqual(direct)
  })
})

describe('stillArgs : la fenêtre déborde du plan, pas du fichier — issue #194', () => {
  const SHOT_END = 10.15

  it("un instant à la dernière image d'un plan produit une fenêtre valide, et -ss vaut toujours cet instant", () => {
    const f = framing([shotFraming({ shot: { start: 0, end: SHOT_END } })])
    const input = decodedInput({ videoFps: 60, durationSec: 120 })
    const instant = SHOT_END - 1 / 60

    const { window, args } = stillArgs({ input, instant, shotEnd: SHOT_END, framing: f, output: 'vertical', dst: 'a.mp4' })

    expect(window.start).toBe(instant)
    const ss = args[args.indexOf('-ss') + 1]
    expect(Number(ss)).toBeCloseTo(instant, 5)
  })

  it('la fenêtre déborde du plan mais reste dans le fichier', () => {
    const f = framing([shotFraming({ shot: { start: 0, end: SHOT_END } })])
    const input = decodedInput({ videoFps: 60, durationSec: 120 })
    const instant = SHOT_END - 1 / 60

    const { window } = stillArgs({ input, instant, shotEnd: SHOT_END, framing: f, output: 'vertical', dst: 'a.mp4' })

    expect(window.end).toBeGreaterThan(SHOT_END)
    expect(window.end).toBeLessThanOrEqual(120)
  })

  it('un instant au-delà de la fin du fichier est refusé', () => {
    const f = framing([shotFraming({ shot: { start: 0, end: SHOT_END } })])
    const input = decodedInput({ videoFps: 60, durationSec: 120 })

    expect(() =>
      stillArgs({ input, instant: 120, shotEnd: SHOT_END, framing: f, output: 'vertical', dst: 'a.mp4' }),
    ).toThrow()
  })

  it("sans durée sondée, repli sur la fin du plan — la fenêtre reste refusée comme avant #194", () => {
    const f = framing([shotFraming({ shot: { start: 0, end: SHOT_END } })])
    const input = decodedInput({ videoFps: 60, durationSec: null })
    const instant = SHOT_END - 1 / 60

    expect(() =>
      stillArgs({ input, instant, shotEnd: SHOT_END, framing: f, output: 'vertical', dst: 'a.mp4' }),
    ).toThrow()
  })

  it("l'invariante tient : window.start === instant dans tous les cas acceptés", () => {
    const f = framing([shotFraming({ shot: { start: 0, end: SHOT_END } })])
    const cases = [
      { videoFps: 30, durationSec: 60 },
      { videoFps: 60, durationSec: 120 },
    ]
    for (const c of cases) {
      const input = decodedInput(c)
      const instant = SHOT_END - 1 / c.videoFps
      const { window } = stillArgs({ input, instant, shotEnd: SHOT_END, framing: f, output: 'vertical', dst: 'a.mp4' })
      expect(window.start).toBe(instant)
    }
  })

  it("le cas limite nommé par l'issue #194 — un plan finissant sur une image isolée, comme fmr-1115733 — passe", () => {
    const shot = { start: 1115.733, end: 1120.767 }
    const f = framing([shotFraming({ shot })])
    const input = decodedInput({ videoFps: 60, durationSec: 1200 })
    const instant = shot.end - 1 / 60

    const { window } = stillArgs({ input, instant, shotEnd: shot.end, framing: f, output: 'vertical', dst: 'a.mp4' })

    expect(window.start).toBe(instant)
    expect(window.end - window.start).toBeGreaterThanOrEqual(1.5 / 60)
  })
})
