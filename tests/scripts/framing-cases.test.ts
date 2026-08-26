import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  caseId,
  FRAMING_CASES,
  PROJECTS,
  projectOf,
  selectCases,
  type FramingCase,
} from '../../scripts/framing/cases'
import { framingDrift, resolveCase } from '../../scripts/framing/case-registry'
import { hasDrift } from '../../scripts/framing-cases'

/**
 * Le registre est une donnée pure : ce fichier ne touche jamais le disque, et
 * doit passer sur un clone frais sans `projects/`. C'est la garantie que
 * `scripts/framing/cases.ts` promet dans son en-tête.
 */

describe('FRAMING_CASES', () => {
  it('a des identifiants tous distincts', () => {
    const ids = FRAMING_CASES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("chaque identifiant vaut caseId(c) — un id à la main qui dérive échoue ici", () => {
    for (const c of FRAMING_CASES) {
      expect(c.id).toBe(caseId(c))
    }
  })

  it("chaque date `on` est un YYYY-MM-DD réel, ni dans le futur, ni un artefact d'arrondi", () => {
    const today = new Date()
    for (const c of FRAMING_CASES) {
      if (c.label === null) continue
      expect(c.label.on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      const parsed = new Date(`${c.label.on}T00:00:00Z`)
      expect(parsed.toISOString().slice(0, 10)).toBe(c.label.on)
      expect(parsed.getTime()).toBeLessThanOrEqual(today.getTime())
    }
  })

  it('porte `by`, `from` et `probes` non vides — `note` peut être vide', () => {
    for (const c of FRAMING_CASES) {
      expect(c.probes.length).toBeGreaterThan(0)
      if (c.label !== null) {
        expect(c.label.by.length).toBeGreaterThan(0)
        expect(c.label.from.length).toBeGreaterThan(0)
      }
    }
  })

  it('un plan a start < end, et chaque instant tombe dedans par le prédicat semi-ouvert', () => {
    for (const c of FRAMING_CASES) {
      if (c.anchor.at !== 'shot') continue
      const { shot, instants } = c.anchor
      expect(shot.start).toBeLessThan(shot.end)
      for (const t of instants) {
        expect(t).toBeGreaterThanOrEqual(shot.start)
        expect(t).toBeLessThan(shot.end)
      }
    }
  })

  it('les instants de chaque cas sont strictement croissants, sans doublon', () => {
    for (const c of FRAMING_CASES) {
      const instants = c.anchor.instants
      for (let i = 1; i < instants.length; i += 1) {
        expect(instants[i]).toBeGreaterThan(instants[i - 1])
      }
    }
  })

  it('`label.call` est keep/drop/unsure, et aucun `tag` ne porte de champ en forme de verdict', () => {
    const calls = new Set(['keep', 'drop', 'unsure'])
    for (const c of FRAMING_CASES) {
      if (c.label !== null) expect(calls.has(c.label.call)).toBe(true)
      for (const tag of c.tags) {
        expect('call' in tag).toBe(false)
      }
    }
  })

  it('les treize identifiants attendus sont tous présents — retirer un cas ne le retire pas d\'ici', () => {
    const expected = [
      'entre-nous-2973000',
      'caro-mdlm-7250000',
      'cqlp-2120000',
      'cqlp-2138000',
      'caro-mdlm-652500',
      'nabla-2056800',
      'nabla-1798867',
      'nabla-1607967',
      'nabla-2077400',
      'nabla-6418667',
      'cqlp-1366033',
      'entre-nous-3495867',
      'fmr-1115733',
    ]
    const ids = new Set(FRAMING_CASES.map((c) => c.id))
    for (const id of expected) {
      expect(ids.has(id)).toBe(true)
    }
    expect(ids.size).toBe(expected.length)
  })

  it('selectCases lève sur un sélecteur inconnu, jamais un tableau vide', () => {
    expect(() => selectCases('ce-token-nexiste-pas')).toThrow()
  })

  it('selectCases connaît les mots-clés, les émissions et les identifiants', () => {
    expect(selectCases('all').length).toBe(FRAMING_CASES.length)
    expect(selectCases('keep').every((c: FramingCase) => c.label?.call === 'keep')).toBe(true)
    expect(selectCases('nabla').every((c: FramingCase) => c.show === 'nabla')).toBe(true)
    expect(selectCases('fmr-1115733').map((c: FramingCase) => c.id)).toEqual(['fmr-1115733'])
    expect(Object.keys(PROJECTS)).toContain('nabla')
  })
})

/**
 * `note` contre `drift` (issue #191 lot 2) : un instant pile sur `shot.start`
 * se résout de façon déterministe par le prédicat semi-ouvert, un instant à
 * quelques dizaines de ms d'une frontière ne le peut pas. Ce bloc-ci touche le
 * disque — un fixture temporaire, jamais `projects/` — contrairement au reste
 * du fichier.
 */
describe('note contre dérive (case-registry, framing-cases)', () => {
  let projectsDir: string
  let previousProjectsDir: string | undefined

  const FPS = 25

  function writeAnalysis(projectId: string): void {
    const dir = path.join(projectsDir, projectId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'analysis.json'),
      JSON.stringify({
        version: 2,
        fps: FPS,
        source: { w: 1920, h: 1080 },
        proxy: { w: 960, h: 540 },
        shots: [
          { start: 0, end: 5 },
          { start: 5, end: 10 },
        ],
        boxes: [],
      }),
    )
  }

  function caseAt(instant: number, baseline: FramingCase['baseline'] = null): FramingCase {
    return {
      id: `test-${instant}`,
      show: 'nabla',
      scope: { over: 'source' },
      anchor: { at: 'instant', instants: [instant] },
      probes: 'fixture de test',
      label: null,
      tags: [],
      origin: 'test',
      retired: null,
      baseline,
    }
  }

  beforeEach(() => {
    projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framing-cases-test-'))
    previousProjectsDir = process.env.PROJECTS_DIR
    process.env.PROJECTS_DIR = projectsDir
    writeAnalysis(projectOf(caseAt(0)))
  })

  afterEach(() => {
    fs.rmSync(projectsDir, { recursive: true, force: true })
    if (previousProjectsDir === undefined) delete process.env.PROJECTS_DIR
    else process.env.PROJECTS_DIR = previousProjectsDir
  })

  it('un instant pile sur la frontière du plan est une note, jamais une dérive', () => {
    const resolved = resolveCase(caseAt(5))
    expect(resolved.notes).toEqual([{ kind: 'anchoredOnStart', instant: 5, shot: { start: 5, end: 10 } }])
    expect(resolved.drift).toEqual([])
  })

  it('un instant à 33 ms après la frontière est une dérive (nearBoundary), jamais une note', () => {
    const resolved = resolveCase(caseAt(5.033))
    expect(resolved.notes).toEqual([])
    expect(resolved.drift).toHaveLength(1)
    const [d] = resolved.drift
    if (d?.kind !== 'nearBoundary') throw new Error('attendu nearBoundary')
    expect(d.instant).toBe(5.033)
    expect(d.distance).toBeCloseTo(0.033, 6)
    expect(d.frame).toBe(Math.round(5.033 * FPS))
  })

  it("`hasDrift` — le prédicat de `--strict` — est faux avec une note seule, sans dérive", () => {
    const resolved = resolveCase(caseAt(5))
    expect(hasDrift([resolved])).toBe(false)
  })

  it('`hasDrift` est vrai dès qu’un cas a une dérive, note ou pas ailleurs', () => {
    const noted = resolveCase(caseAt(5))
    const drifted = resolveCase(caseAt(5.033))
    expect(hasDrift([noted, drifted])).toBe(true)
  })

  /**
   * Ce que le code produit aujourd'hui sur `caseAt(2)` : plan [0; 5[, aucune
   * boîte, ratio `16:9`, aucun split (`notTwoPeople`). Fixé une fois ici pour
   * que les témoins ci-dessous s'écrivent contre une valeur connue plutôt que
   * recalculée à chaque test.
   */
  const TODAY = { ratio: '16:9', split: false, rejection: 'notTwoPeople' } as const

  it('un témoin absent (`baseline: null`) ne remonte rien — pas une dérive', () => {
    const resolved = resolveCase(caseAt(2, null))
    expect(resolved.drift.filter((d) => d.kind === 'framingChanged')).toEqual([])
    expect(hasDrift([resolved])).toBe(false)
  })

  it('un témoin conforme ne remonte rien', () => {
    const resolved = resolveCase(caseAt(2, { ...TODAY, on: '2026-08-26' }))
    expect(resolved.drift.filter((d) => d.kind === 'framingChanged')).toEqual([])
    expect(hasDrift([resolved])).toBe(false)
  })

  it('un cas dont le split diffère du témoin remonte un `framingChanged` nommant le champ, et `--strict` échoue dessus', () => {
    const resolved = resolveCase(caseAt(2, { ratio: '16:9', split: true, rejection: null, on: '2026-08-26' }))
    expect(resolved.drift).toEqual([
      { kind: 'framingChanged', field: 'split', baseline: true, today: false },
    ])
    expect(hasDrift([resolved])).toBe(true)
  })

  it('`--strict` continue de ne pas échouer sur une simple note, même à côté d\'un cas conforme', () => {
    const noted = resolveCase(caseAt(5))
    const conforme = resolveCase(caseAt(2, { ...TODAY, on: '2026-08-26' }))
    expect(hasDrift([noted, conforme])).toBe(false)
  })

  it("le compte de dérive (celui de la ligne de résumé) est juste sur un mélange de cas", () => {
    const sansTemoin = resolveCase(caseAt(2, null))
    const conforme = resolveCase(caseAt(2, { ...TODAY, on: '2026-08-26' }))
    const change = resolveCase(caseAt(2, { ratio: '9:16', split: false, rejection: 'notTwoPeople', on: '2026-08-26' }))
    const resolved = [sansTemoin, conforme, change]
    const driftCount = resolved.filter((r) => r.drift.length > 0).length
    expect(driftCount).toBe(1)
  })
})

describe('framingDrift — comparaison pure au témoin, sans disque', () => {
  const TODAY_SNAPSHOT = { ratio: '16:9', split: false, rejection: 'notTwoPeople' } as const

  it('rend [] sans témoin', () => {
    expect(framingDrift(null, TODAY_SNAPSHOT)).toEqual([])
  })

  it('rend [] quand le témoin est conforme à aujourd\'hui', () => {
    const baseline = { ...TODAY_SNAPSHOT, on: '2026-08-26' as const }
    expect(framingDrift(baseline, TODAY_SNAPSHOT)).toEqual([])
  })

  it('nomme `ratio` quand seul le ratio diffère', () => {
    const baseline = { ratio: '9:16' as const, split: false, rejection: 'notTwoPeople' as const, on: '2026-08-26' as const }
    expect(framingDrift(baseline, TODAY_SNAPSHOT)).toEqual([
      { kind: 'framingChanged', field: 'ratio', baseline: '9:16', today: '16:9' },
    ])
  })

  it('nomme `split` quand seul le split diffère', () => {
    const baseline = { ratio: '16:9' as const, split: true, rejection: null, on: '2026-08-26' as const }
    expect(framingDrift(baseline, TODAY_SNAPSHOT)).toEqual([
      { kind: 'framingChanged', field: 'split', baseline: true, today: false },
    ])
  })

  it('nomme `rejection` quand le split est identique mais sa raison de refus a changé', () => {
    const baseline = { ratio: '16:9' as const, split: false, rejection: 'ratioNotWide' as const, on: '2026-08-26' as const }
    expect(framingDrift(baseline, TODAY_SNAPSHOT)).toEqual([
      { kind: 'framingChanged', field: 'rejection', baseline: 'ratioNotWide', today: 'notTwoPeople' },
    ])
  })
})
