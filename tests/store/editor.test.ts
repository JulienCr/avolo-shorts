import { beforeEach, describe, expect, it } from 'vitest'

import { clipDuration, type Clip } from '@/core/edl'
import { indexTranscript, type TranscriptLine } from '@/lib/editing'
import { useEditeur } from '@/store/editor'

const lignes: TranscriptLine[] = [
  {
    id: 'l0',
    start: 10,
    end: 14.8,
    words: [
      { word: 'un', start: 10, end: 10.8 },
      { word: 'deux', start: 11, end: 11.8 },
      { word: 'trois', start: 12, end: 12.8 },
      { word: 'quatre', start: 13, end: 13.8 },
      { word: 'cinq', start: 14, end: 14.8 },
    ],
  },
]

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    projectId: 'p1',
    segments: [{ start: 10, end: 14.8 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'Un titre',
    description: '',
    status: 'candidate',
    pass: 1,
    ...overrides,
  }
}

/** Les mots, marqués selon les segments courants du store. */
function mots() {
  return indexTranscript(lignes, useEditeur.getState().historique.present).words
}

const initial = useEditeur.getState()

beforeEach(() => {
  useEditeur.setState(initial, true)
})

describe('charger', () => {
  it('installe les segments, le cadrage, et une pile vide', () => {
    useEditeur.getState().charger(clip())
    const etat = useEditeur.getState()
    expect(etat.historique.present).toEqual([{ start: 10, end: 14.8 }])
    expect(etat.historique.past).toEqual([])
    expect(etat.cropX).toBe(0.5)
  })

  it('ne recharge pas le clip déjà ouvert', () => {
    // Un refetch au retour d'onglet rejoue la requête. Recharger sans condition
    // écraserait le montage en cours par la version du serveur, et viderait la
    // pile d'annulation avec.
    const editeur = useEditeur.getState()
    editeur.charger(clip())
    editeur.commencerSelection(2, false)
    editeur.retirerSelection(mots())
    const monte = useEditeur.getState().historique.present

    useEditeur.getState().charger(clip())
    expect(useEditeur.getState().historique.present).toBe(monte)
  })

  it('recharge quand on ouvre un autre clip', () => {
    useEditeur.getState().charger(clip())
    useEditeur.getState().charger(clip({ id: 'c2', segments: [{ start: 0, end: 5 }], cropX: 0.2 }))
    expect(useEditeur.getState().historique.present).toEqual([{ start: 0, end: 5 }])
    expect(useEditeur.getState().cropX).toBe(0.2)
  })
})

describe('la sélection', () => {
  it('un clic sélectionne un mot, un shift-clic étend depuis l’ancre', () => {
    const editeur = useEditeur.getState()
    editeur.charger(clip())
    editeur.commencerSelection(1, false)
    editeur.commencerSelection(3, true)
    expect(useEditeur.getState().selection).toEqual({ ancre: 1, tete: 3 })
  })

  it('le survol n’étend que pendant un glissé', () => {
    const editeur = useEditeur.getState()
    editeur.charger(clip())
    editeur.commencerSelection(1, false)
    editeur.etendreSelection(3)
    expect(useEditeur.getState().selection).toEqual({ ancre: 1, tete: 3 })

    editeur.terminerSelection()
    useEditeur.getState().etendreSelection(4)
    expect(useEditeur.getState().selection).toEqual({ ancre: 1, tete: 3 })
  })

  it('s’étend aussi vers la gauche', () => {
    const editeur = useEditeur.getState()
    editeur.charger(clip())
    editeur.commencerSelection(3, false)
    editeur.etendreSelection(1)
    expect(useEditeur.getState().selection).toEqual({ ancre: 3, tete: 1 })
  })
})

describe('les trois gestes', () => {
  it('retirer une sélection raccourcit le clip et vide la sélection', () => {
    const editeur = useEditeur.getState()
    editeur.charger(clip())
    editeur.commencerSelection(2, false)
    editeur.retirerSelection(mots())

    const etat = useEditeur.getState()
    expect(etat.historique.present).toEqual([
      { start: 10, end: 12 },
      { start: 12.8, end: 14.8 },
    ])
    expect(clipDuration(etat.historique.present)).toBeCloseTo(4, 6)
    expect(etat.selection).toBeNull()
  })

  it('remonter un mot barré recolle le clip', () => {
    const editeur = useEditeur.getState()
    editeur.charger(clip())
    editeur.commencerSelection(2, false)
    editeur.retirerSelection(mots())
    useEditeur.getState().remonterMot(mots(), 2)
    expect(useEditeur.getState().historique.present).toEqual([{ start: 10, end: 14.8 }])
  })

  it('poser une borne au mot rétrécit le clip', () => {
    const editeur = useEditeur.getState()
    editeur.charger(clip())
    editeur.poserBorne(mots(), 2, 'start')
    expect(useEditeur.getState().historique.present).toEqual([{ start: 12, end: 14.8 }])
  })
})

describe('annuler', () => {
  it('dépile geste par geste', () => {
    const editeur = useEditeur.getState()
    editeur.charger(clip())
    editeur.commencerSelection(1, false)
    editeur.retirerSelection(mots())
    useEditeur.getState().poserBorne(mots(), 3, 'end')
    expect(useEditeur.getState().historique.present).toEqual([
      { start: 10, end: 11 },
      { start: 11.8, end: 13.8 },
    ])

    useEditeur.getState().annuler()
    expect(useEditeur.getState().historique.present).toEqual([
      { start: 10, end: 11 },
      { start: 11.8, end: 14.8 },
    ])

    useEditeur.getState().annuler()
    expect(useEditeur.getState().historique.present).toEqual([{ start: 10, end: 14.8 }])
  })

  it('un Ctrl+Z de trop ne fait rien', () => {
    const editeur = useEditeur.getState()
    editeur.charger(clip())
    editeur.annuler()
    editeur.annuler()
    expect(useEditeur.getState().historique.present).toEqual([{ start: 10, end: 14.8 }])
  })

  it('un geste sans effet n’ajoute pas de pas à annuler', () => {
    const editeur = useEditeur.getState()
    editeur.charger(clip())
    editeur.commencerSelection(2, false)
    editeur.retirerSelection(mots())
    const apres = useEditeur.getState().historique.past.length

    useEditeur.getState().commencerSelection(2, false)
    useEditeur.getState().retirerSelection(mots())
    expect(useEditeur.getState().historique.past.length).toBe(apres)
  })
})
