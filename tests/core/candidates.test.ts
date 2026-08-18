import { describe, it, expect } from 'vitest'
import { mergeCandidates } from '@/core/candidates'
import type { Clip, ClipStatus } from '@/core/edl'

/**
 * Spec §5, « une nouvelle passe n'écrase jamais un travail humain ». Relancer le
 * repérage ne balaie pas les clips déjà montés — sans quoi le tri de 25
 * candidats se referait à chaque passe, et personne ne relancerait le repérage.
 */

const c = (id: string, status: ClipStatus, pass = 1) =>
  ({ id, status, pass, segments: [{ start: 0, end: 1 }] }) as Clip

describe('mergeCandidates', () => {
  it('un clip qui n’est plus candidate survit toujours', () => {
    const out = mergeCandidates([c('a', 'kept'), c('b', 'exported')], [c('z', 'candidate', 2)], 2)
    expect(out.map((x) => x.id).sort()).toEqual(['a', 'b', 'z'])
  })

  it('les propositions non traitées sont remplacées', () => {
    const out = mergeCandidates([c('old', 'candidate')], [c('new', 'candidate', 2)], 2)
    expect(out.map((x) => x.id)).toEqual(['new'])
  })

  it('un clip écarté à la main ne revient pas', () => {
    const out = mergeCandidates([c('no', 'discarded')], [c('no', 'candidate', 2)], 2)
    expect(out.filter((x) => x.id === 'no')[0].status).toBe('discarded')
  })

  it('chaque lot porte son numéro de passe', () => {
    const out = mergeCandidates([], [c('x', 'candidate', 0)], 3)
    expect(out[0].pass).toBe(3)
  })
})
