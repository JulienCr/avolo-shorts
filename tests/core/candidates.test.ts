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
    // Et il n'y en a qu'un : un doublon passerait l'assertion précédente sans
    // que la proposition ait été écartée. (relevé par Aristarque)
    expect(out.filter((x) => x.id === 'no')).toHaveLength(1)
  })

  // La survie ne dépend pas du statut humain, seulement du fait qu'il ne soit
  // plus `candidate`. Seul `discarded` était couvert. (relevé par Aristarque)
  it.each(['kept', 'exported', 'discarded'] as const)(
    'une proposition ne recouvre pas un clip « %s » du même id',
    (status) => {
      const out = mergeCandidates([c('x', status)], [c('x', 'candidate', 2)], 2)
      expect(out).toHaveLength(1)
      expect(out[0].status).toBe(status)
      expect(out[0].pass).toBe(1)
    },
  )

  // La non-mutation est un contrat écrit ; une régression qui trierait ou
  // pousserait dans les tableaux d'entrée passerait toute la suite ci-dessus.
  // (relevé par Aristarque)
  it('ne modifie ni existing ni incoming', () => {
    const existing = [c('gardé', 'kept'), c('périmé', 'candidate')]
    const incoming = [c('neuf', 'candidate', 0)]
    const copyExisting = structuredClone(existing)
    const copyIncoming = structuredClone(incoming)

    mergeCandidates(existing, incoming, 7)

    expect(existing).toEqual(copyExisting)
    expect(incoming).toEqual(copyIncoming)
  })

  it('chaque lot porte son numéro de passe', () => {
    const out = mergeCandidates([], [c('x', 'candidate', 0)], 3)
    expect(out[0].pass).toBe(3)
  })

  it('ne garde qu’un exemplaire d’un id répété dans le même lot', () => {
    const out = mergeCandidates([], [c('x', 'candidate', 2), c('x', 'candidate', 2)], 2)
    expect(out).toHaveLength(1)
  })

  // Un lot de repérage ne propose que des candidats. Laisser entrer un statut
  // humain fabriquerait une décision que personne n'a prise, et le clip serait
  // ensuite conservé pour toujours. (relevé par Aristarque)
  // Le helper `c()` ne renseigne que quatre champs : une régression qui
  // recopierait le clip champ par champ au lieu de l'épandre perdrait tout le
  // reste en production sans faire échouer un seul test ci-dessus. (relevé par
  // Aristarque)
  it('ne perd aucun champ de la proposition, seul le numéro de passe change', () => {
    const incoming: Clip = {
      id: 'clip_2841',
      projectId: '2026-03-08-caro-mdlm',
      segments: [{ start: 2841.2, end: 2856.9 }],
      ratio: '1:1',
      cropX: 0.42,
      captions: true,
      branding: false,
      title: 'La vanne du chapeau',
      description: 'ça part en vrille',
      status: 'candidate',
      pass: 0,
      hookText: '',
      hookStyle: {},
    }
    expect(mergeCandidates([], [incoming], 4)).toEqual([{ ...incoming, pass: 4 }])
  })

  it.each(['kept', 'discarded', 'exported'] as const)(
    'refuse une proposition qui entre déjà en « %s »',
    (status) => {
      expect(() => mergeCandidates([], [c('x', status)], 2)).toThrow()
    },
  )
})
