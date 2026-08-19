import { describe, it, expect } from 'vitest'
import { analyzeProbe } from '@/server/ffprobe'

/**
 * La fragilité d'un sondage tient dans la lecture de sa sortie, pas dans
 * l'appel : ffprobe rend `"N/A"` là où on attend un nombre, une fraction là où
 * on attend une cadence, et parfois rien du tout.
 */

// Relevé sur `2025-06-15-cqlp.mp4` le 18 août 2026.
const REAL = JSON.stringify({
  programs: [],
  stream_groups: [],
  streams: [{ width: 1920, height: 1080, r_frame_rate: '30/1' }],
  format: { duration: '5936.995333' },
})

describe('analyserSondage', () => {
  it('lit une sortie réelle', () => {
    expect(analyzeProbe(REAL)).toEqual({
      durationSec: 5936.995333,
      width: 1920,
      height: 1080,
      fps: 30,
    })
  })

  it('réduit la fraction de cadence : 60000/1001 vaut du 59,94', () => {
    const s = analyzeProbe(
      JSON.stringify({ streams: [{ r_frame_rate: '60000/1001' }], format: {} }),
    )
    expect(s.fps).toBeCloseTo(59.94, 2)
  })

  it('rend null sur une cadence inconnue (0/0), que ffprobe sort sur une pochette', () => {
    expect(analyzeProbe(JSON.stringify({ streams: [{ r_frame_rate: '0/0' }] })).fps).toBeNull()
  })

  it("rend null sur N/A, que ffprobe écrit là où on attend un nombre", () => {
    const s = analyzeProbe(JSON.stringify({ format: { duration: 'N/A' }, streams: [] }))
    expect(s.durationSec).toBeNull()
    expect(s.width).toBeNull()
  })

  it('rend un sondage vide sur un JSON illisible plutôt que de lever', () => {
    // Un fichier qu'on n'arrive pas à sonder reste un fichier qu'on peut copier
    // et transcrire : la durée n'est qu'une commodité.
    expect(analyzeProbe('pas du JSON')).toEqual({
      durationSec: null,
      width: null,
      height: null,
      fps: null,
    })
    expect(analyzeProbe('null').fps).toBeNull()
    expect(analyzeProbe('').durationSec).toBeNull()
  })

  it('rend un sondage vide sur une sortie sans flux ni format', () => {
    expect(analyzeProbe('{}')).toEqual({
      durationSec: null,
      width: null,
      height: null,
      fps: null,
    })
  })

  it('ne prend que le premier flux', () => {
    const s = analyzeProbe(
      JSON.stringify({ streams: [{ width: 1920 }, { width: 320 }], format: {} }),
    )
    expect(s.width).toBe(1920)
  })
})
