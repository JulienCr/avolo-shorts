import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import type { ShotFraming } from '@/core/framing'
import type { PersonBox } from '@/core/shots'
import type { ProjectId } from '../../scripts/framing/cases'
import type { PersonFrame, ShotSample } from '../../scripts/framing/corpus'
import { METRICS, type ShotMetric } from '../../scripts/framing/metrics'
import { sieve, type Family } from '../../scripts/framing/sieve'

/**
 * `sieve()` est pure : ces fixtures ne touchent jamais le disque, elles
 * fabriquent leur `ShotSample[]` à la main. C'est ce qui rend ce fichier
 * exécutable sans `projects/` ni ffmpeg (contrat #191 lot 5).
 */

function fixtureShot(startMs: number): ShotFraming {
  const start = startMs / 1000
  return {
    shot: { start, end: start + 5 },
    key: startMs,
    ratio: '9:16',
    cropX: 0.5,
    cropXNative: 0.5,
    source: 'auto',
  }
}

function fixtureSample(
  project: string,
  startMs: number,
  frames: readonly PersonFrame[] = [],
): ShotSample {
  return {
    project: project as ProjectId,
    shot: fixtureShot(startMs),
    frames,
    analysisFps: 2,
    srcW: 1920,
    srcH: 1080,
  }
}

/** Un métrique de test, dont la valeur est fixée à la main par échantillon. */
function metricFromValues(values: ReadonlyMap<ShotSample, number | null>): ShotMetric {
  return {
    name: 'test-metric',
    what: 'valeur de test',
    unit: 'u',
    of: (s) => values.get(s) ?? null,
    perFrame: () => null,
  }
}

describe('sieve — famille extremes', () => {
  it('rend les rangs documentés aux deux bouts, et jamais deux fois le même plan', () => {
    const values = new Map<ShotSample, number>()
    const samples = Array.from({ length: 20 }, (_, i) => {
      const s = fixtureSample(`projet-${i % 3}`, i * 1000)
      values.set(s, i)
      return s
    })
    const metric = metricFromValues(values)
    const family: Family = { kind: 'extremes', n: 4, spread: true }
    const result = sieve(samples, metric, family, 'avolo')

    expect(result.picks).toHaveLength(4)
    const low = result.picks.filter((p) => p.side === 'low').map((p) => p.value).sort((a, b) => a - b)
    const high = result.picks.filter((p) => p.side === 'high').map((p) => p.value).sort((a, b) => a - b)
    // Décile de 20 = 2 éléments : [0, 1] en bas, [18, 19] en haut, tous deux
    // repris intégralement puisqu'il y a une tranche par élément.
    expect(low).toEqual([0, 1])
    expect(high).toEqual([18, 19])
    const ids = result.picks.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('--brut rend les extrêmes littéraux, sans passer par la décile', () => {
    const values = new Map<ShotSample, number>()
    const samples = Array.from({ length: 20 }, (_, i) => {
      const s = fixtureSample(`projet-${i % 3}`, i * 1000)
      values.set(s, i)
      return s
    })
    const metric = metricFromValues(values)
    const family: Family = { kind: 'extremes', n: 2, spread: false }
    const result = sieve(samples, metric, family, 'avolo')
    expect(result.picks.map((p) => p.value)).toEqual([0, 19])
  })
})

describe('sieve — famille autour', () => {
  it('rend exactement les plans de [V-W, V+W], bornes incluses', () => {
    const values = new Map<ShotSample, number>()
    const raw = [0.1, 0.14, 0.15, 0.19, 0.2, 0.21, 0.25]
    const samples = raw.map((v, i) => {
      const s = fixtureSample('projet-a', i * 1000)
      values.set(s, v)
      return s
    })
    const metric = metricFromValues(values)
    // Bande [0.15 - 0.05, 0.15 + 0.05] = [0.10, 0.20] inclus : 0.1, 0.14,
    // 0.15, 0.19, 0.2 tombent dedans ; 0.21 et 0.25 tombent dehors.
    const family: Family = { kind: 'around', threshold: 0.15, width: 0.05, n: 10 }
    const result = sieve(samples, metric, family, 'avolo')
    const picked = result.picks.map((p) => p.value).sort((a, b) => a - b)
    expect(picked).toEqual([0.1, 0.14, 0.15, 0.19, 0.2])
  })

  it('équilibre entre below et above', () => {
    const values = new Map<ShotSample, number>()
    const raw = [0.1, 0.11, 0.12, 0.13, 0.19, 0.2]
    const samples = raw.map((v, i) => {
      const s = fixtureSample('projet-a', i * 1000)
      values.set(s, v)
      return s
    })
    const metric = metricFromValues(values)
    const family: Family = { kind: 'around', threshold: 0.15, width: 0.1, n: 2 }
    const result = sieve(samples, metric, family, 'avolo')
    expect(result.picks.filter((p) => p.side === 'below')).toHaveLength(1)
    expect(result.picks.filter((p) => p.side === 'above')).toHaveLength(1)
  })
})

describe('sieve — null et valeurs refusées', () => {
  it('les valeurs null sont exclues de la distribution, pas traitées comme 0, et comptées dans l’en-tête', () => {
    const values = new Map<ShotSample, number | null>()
    const samples: ShotSample[] = []
    for (let i = 0; i < 5; i += 1) {
      const s = fixtureSample('projet-a', i * 1000)
      values.set(s, i)
      samples.push(s)
    }
    for (let i = 5; i < 8; i += 1) {
      const s = fixtureSample('projet-a', i * 1000)
      values.set(s, null)
      samples.push(s)
    }
    const metric = metricFromValues(values)
    const family: Family = { kind: 'extremes', n: 10, spread: false }
    const result = sieve(samples, metric, family, 'avolo')
    expect(result.total).toBe(8)
    expect(result.defined).toBe(5)
    expect(result.undefinedCount).toBe(3)
    expect(result.picks.every((p) => Number.isFinite(p.value))).toBe(true)
  })

  it('NaN et Infinity sont refusés, pas triés', () => {
    const values = new Map<ShotSample, number>()
    const samples: ShotSample[] = []
    for (let i = 0; i < 5; i += 1) {
      const s = fixtureSample('projet-a', i * 1000)
      values.set(s, i)
      samples.push(s)
    }
    const nan = fixtureSample('projet-a', 5000)
    values.set(nan, Number.NaN)
    samples.push(nan)
    const inf = fixtureSample('projet-a', 6000)
    values.set(inf, Number.POSITIVE_INFINITY)
    samples.push(inf)

    const metric = metricFromValues(values)
    const family: Family = { kind: 'extremes', n: 10, spread: false }
    const result = sieve(samples, metric, family, 'avolo')
    expect(result.defined).toBe(5)
    expect(result.undefinedCount).toBe(2)
    expect(result.picks.some((p) => Number.isNaN(p.value) || !Number.isFinite(p.value))).toBe(false)
  })
})

describe('sieve — déterminisme', () => {
  const raw = [0.1, 0.14, 0.15, 0.19, 0.2, 0.21, 0.25, 0.05, 0.3, 0.16]

  function build(): { samples: ShotSample[]; metric: ShotMetric } {
    const values = new Map<ShotSample, number>()
    const samples = raw.map((v, i) => {
      const s = fixtureSample(`projet-${i % 2}`, i * 1000)
      values.set(s, v)
      return s
    })
    return { samples, metric: metricFromValues(values) }
  }

  it('même entrée + même graine ⇒ mêmes sélections', () => {
    const { samples, metric } = build()
    const family: Family = { kind: 'around', threshold: 0.15, width: 0.06, n: 4 }
    const a = sieve(samples, metric, family, 'avolo')
    const b = sieve(samples, metric, family, 'avolo')
    expect(a.picks).toEqual(b.picks)
  })

  it('une entrée mélangée ⇒ les mêmes sélections (indépendance de readdirSync)', () => {
    const { samples, metric } = build()
    const shuffled = [...samples].reverse()
    const family: Family = { kind: 'around', threshold: 0.15, width: 0.06, n: 4 }
    const a = sieve(samples, metric, family, 'avolo')
    const b = sieve(shuffled, metric, family, 'avolo')
    expect(a.picks).toEqual(b.picks)
  })

  it('une graine différente peut changer la sélection au sein d’une bande', () => {
    const { samples, metric } = build()
    const family: Family = { kind: 'around', threshold: 0.15, width: 0.2, n: 2 }
    const a = sieve(samples, metric, family, 'avolo')
    const b = sieve(samples, metric, family, 'une-autre-graine')
    // Pas une garantie de différence à coup sûr, mais les deux tirages
    // restent chacun déterministes et valides sur la même bande.
    expect(a.picks.every((p) => p.value >= 0.15 - 0.2 && p.value <= 0.15 + 0.2)).toBe(true)
    expect(b.picks.every((p) => p.value >= 0.15 - 0.2 && p.value <= 0.15 + 0.2)).toBe(true)
  })

  it('stabilité sous croissance : ajouter des échantillons hors bande ne change pas les sélections antérieures', () => {
    const { samples, metric: baseMetric } = build()
    const family: Family = { kind: 'around', threshold: 0.15, width: 0.06, n: 3 }
    const before = sieve(samples, baseMetric, family, 'avolo')

    // Un cinquième spectacle, dont aucun plan ne tombe dans la bande : un PRNG
    // seedé qui marche la liste aurait rebattu les tirages précédents ici.
    const values = new Map<ShotSample, number>()
    for (const s of samples) values.set(s, baseMetric.of(s) as number)
    const grown = [...samples]
    for (let i = 0; i < 4; i += 1) {
      const s = fixtureSample('projet-hors-bande', 100000 + i * 1000)
      values.set(s, i % 2 === 0 ? 0.9 : -0.9)
      grown.push(s)
    }
    const grownMetric = metricFromValues(values)
    const after = sieve(grown, grownMetric, family, 'avolo')
    expect(after.picks).toEqual(before.picks)
  })
})

describe('sieve — bornage aux deux extrémités', () => {
  const K_LEN = 51
  function personBoxWithWildKeypoints(): PersonBox {
    const k = new Array(K_LEN).fill(0)
    // NOSE, hors cadre à gauche.
    k[0] = -0.3
    k[1] = 0.4
    k[2] = 0.9
    // LEFT_EYE, hors cadre à droite.
    k[3] = 1.4
    k[4] = 0.38
    k[5] = 0.9
    // Les deux épaules, à l'intérieur du cadre — pour que `torsoBounds` ait
    // de quoi calculer un tronc, pas seulement la tête.
    k[15] = 0.3
    k[16] = 0.5
    k[17] = 0.9
    k[18] = 0.7
    k[19] = 0.5
    k[20] = 0.9
    return { t: 0, x0: 0.3, x1: 0.7, y0: 0.2, y1: 0.9, score: 0.9, k }
  }

  it('head-height et required-width rendent une largeur non négative sur un keypoint à -0.3 et un à 1.4', () => {
    const box = personBoxWithWildKeypoints()
    const frame: PersonFrame = { t: 0, boxes: [box] }
    const sample = fixtureSample('projet-a', 0, [frame])

    const requiredWidth = METRICS['required-width'].of(sample)
    expect(requiredWidth).not.toBeNull()
    expect(Number.isFinite(requiredWidth as number)).toBe(true)
    expect(requiredWidth as number).toBeGreaterThanOrEqual(0)

    const perFrameWidth = METRICS['required-width'].perFrame(frame)
    expect(perFrameWidth).not.toBeNull()
    expect(perFrameWidth as number).toBeGreaterThanOrEqual(0)

    const headHeight = METRICS['head-height'].of(sample)
    expect(headHeight).not.toBeNull()
    expect(Number.isFinite(headHeight as number)).toBe(true)
    expect(headHeight as number).toBeGreaterThanOrEqual(0)
  })
})

describe('sieve — head-absence-worst et head-containment-worst (#190)', () => {
  const K_LEN = 51

  // Chaque boîte ne porte qu'**un seul** point hors de [0, 1] : deux points
  // évadés aux deux extrémités opposées de l'image élargiraient `torsoBounds`
  // (qui inclut les points de tête dans son propre empan) au point de refuser
  // le split sur `tooNarrowForSource` — ce que ce test n'éprouve pas. Le
  // clampage aux deux bouts est déjà éprouvé isolément par `headContainment`
  // dans `tests/core/framing.test.ts`.
  function wildLeftBox(t: number): PersonBox {
    const k = new Array(K_LEN).fill(0)
    k[0] = -0.05
    k[1] = 0.2
    k[2] = 0.9 // NOSE, juste sous 0
    k[3] = 0.1
    k[4] = 0.19
    k[5] = 0.9 // LEFT_EYE, valide
    k[15] = 0.05
    k[16] = 0.4
    k[17] = 0.9 // LEFT_SHOULDER
    k[18] = 0.15
    k[19] = 0.4
    k[20] = 0.9 // RIGHT_SHOULDER
    return { t, x0: 0, x1: 0.2, y0: 0.1, y1: 0.9, score: 0.9, k }
  }

  function wildRightBox(t: number): PersonBox {
    const k = new Array(K_LEN).fill(0)
    k[0] = 0.9
    k[1] = 0.2
    k[2] = 0.9 // NOSE, valide
    k[3] = 1.05
    k[4] = 0.19
    k[5] = 0.9 // LEFT_EYE, juste au-dessus de 1
    k[15] = 0.85
    k[16] = 0.4
    k[17] = 0.9 // LEFT_SHOULDER
    k[18] = 0.95
    k[19] = 0.4
    k[20] = 0.9 // RIGHT_SHOULDER
    return { t, x0: 0.8, x1: 1, y0: 0.1, y1: 0.9, score: 0.9, k }
  }

  const SPLITTING_FRAMES: PersonFrame[] = Array.from({ length: 16 }, (_, i) => {
    const t = i * 0.5
    return { t, boxes: [wildLeftBox(t), wildRightBox(t)] }
  })

  const SPLITTING_SAMPLE: ShotSample = {
    project: 'projet-a' as ProjectId,
    shot: { shot: { start: 0, end: 8 }, key: 0, ratio: '1:1', cropX: 0.5, cropXNative: 0.5, source: 'auto' },
    frames: SPLITTING_FRAMES,
    analysisFps: 2,
    srcW: 1920,
    srcH: 1080,
  }

  it('restent bornés à [0, 1] sur un keypoint à -0,3 et un à 1,4', () => {
    const absence = METRICS['head-absence-worst'].of(SPLITTING_SAMPLE)
    expect(absence).not.toBeNull()
    expect(Number.isFinite(absence as number)).toBe(true)
    expect(absence as number).toBeGreaterThanOrEqual(0)
    expect(absence as number).toBeLessThanOrEqual(1)

    const containment = METRICS['head-containment-worst'].of(SPLITTING_SAMPLE)
    expect(containment).not.toBeNull()
    expect(Number.isFinite(containment as number)).toBe(true)
    expect(containment as number).toBeGreaterThanOrEqual(0)
    expect(containment as number).toBeLessThanOrEqual(1)

    const perFrameAbsence = METRICS['head-absence-worst'].perFrame(SPLITTING_FRAMES[0], SPLITTING_SAMPLE)
    expect(perFrameAbsence === null || (perFrameAbsence >= 0 && perFrameAbsence <= 1)).toBe(true)
  })

  it("un plan qui ne split pas sort de la distribution, jamais compté pour 0", () => {
    // Trop court pour le déclencheur du split (`splitMinShot` = 4 s) : les deux
    // métriques doivent rendre `null`, comme `computeShotHeadInstrument`.
    const tooShort: ShotSample = {
      ...SPLITTING_SAMPLE,
      shot: { ...SPLITTING_SAMPLE.shot, shot: { start: 0, end: 3 } },
      frames: SPLITTING_FRAMES.filter((f) => f.t < 3),
    }
    expect(METRICS['head-absence-worst'].of(tooShort)).toBeNull()
    expect(METRICS['head-containment-worst'].of(tooShort)).toBeNull()

    const family: Family = { kind: 'extremes', n: 10, spread: false }
    const result = sieve([SPLITTING_SAMPLE, tooShort], METRICS['head-absence-worst'], family, 'avolo')
    expect(result.total).toBe(2)
    expect(result.defined).toBe(1)
    expect(result.undefinedCount).toBe(1)
  })
})

describe('sieve — Math.random inatteignable depuis scripts/framing/**', () => {
  const eslint = new ESLint()

  it('refuse Math.random() dans un fichier de scripts/framing', async () => {
    const [result] = await eslint.lintText('export const x = Math.random()\n', {
      filePath: 'scripts/framing/sonde.ts',
    })
    const rules = result.messages.filter((m) => m.severity === 2).map((m) => m.ruleId)
    expect(rules).toContain('no-restricted-properties')
  })

  it('laisse passer Math.random() ailleurs dans le dépôt', async () => {
    const [result] = await eslint.lintText('export const x = Math.random()\n', {
      filePath: 'scripts/dev-common.ts',
    })
    const rules = result.messages.filter((m) => m.severity === 2).map((m) => m.ruleId)
    expect(rules).not.toContain('no-restricted-properties')
  })
})
