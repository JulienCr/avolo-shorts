import { describe, it, expect, afterEach } from 'vitest'
import { encodeurProxy } from '@/server/steps/proxy'

/**
 * Le proxy est le seul étage où le GPU **fait perdre du temps**, et c'est
 * mesuré : 13,8x en x264 contre 12,8x en NVENC. Le réflexe — « on a une 4090,
 * on encode dessus » — est faux ici, donc il vaut un test.
 */

const envDépart = { ...process.env }
afterEach(() => {
  process.env = { ...envDépart }
})

describe('encodeurProxy', () => {
  it("vaut x264 sur auto, contre le réflexe", () => {
    process.env.FFMPEG_ENCODER = 'auto'
    expect(encodeurProxy()).toBe('x264')
  })

  it('vaut x264 quand la variable est absente', () => {
    delete process.env.FFMPEG_ENCODER
    expect(encodeurProxy()).toBe('x264')
  })

  it('respecte un choix explicite, même celui qui coûte une minute sur douze', () => {
    process.env.FFMPEG_ENCODER = 'nvenc'
    expect(encodeurProxy()).toBe('nvenc')
    process.env.FFMPEG_ENCODER = 'x264'
    expect(encodeurProxy()).toBe('x264')
  })

  it('refuse une valeur inconnue', () => {
    process.env.FFMPEG_ENCODER = 'cuda'
    expect(() => encodeurProxy()).toThrow(/FFMPEG_ENCODER/)
  })
})
