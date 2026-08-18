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

describe('le cadrage', () => {
  it('accepte une valeur', () => {
    useEditeur.getState().deplacerCrop(0.3)
    expect(useEditeur.getState().cropX).toBeCloseTo(0.3, 6)
  })

  it('accepte une fonction de la précédente, pour les flèches répétées', () => {
    // Six frappes dans le même tour de boucle : lues depuis la fermeture du
    // rendu, elles calculeraient six fois le même résultat et le cadre
    // n'avancerait que d'un cran.
    const editeur = useEditeur.getState()
    editeur.deplacerCrop(0.5)
    for (let i = 0; i < 6; i++) editeur.deplacerCrop((p) => p - 0.01)
    expect(useEditeur.getState().cropX).toBeCloseTo(0.44, 6)
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

describe('réconcilier après un PATCH refusé', () => {
  // `applied: false` veut dire « une écriture plus récente a gagné ». Le cache
  // adopte le clip rendu ; le store, lui, resterait sur l'intention refusée et
  // la renverrait avec un jeton neuf — donc gagnant. Voir `@/lib/enregistrement`
  // pour la forme retenue et pourquoi c'est celle-là.
  it('adopte les valeurs du gagnant', () => {
    useEditeur.getState().charger(clip())
    useEditeur.getState().reconcilier('c1', {
      segments: [{ start: 10, end: 12 }],
      ratio: '1:1',
      cropX: 0.2,
    })

    const etat = useEditeur.getState()
    expect(etat.historique.present).toEqual([{ start: 10, end: 12 }])
    expect(etat.ratio).toBe('1:1')
    expect(etat.cropX).toBe(0.2)
  })

  it('ne vide pas la pile d’annulation', () => {
    // C'est ce qui distingue cette réconciliation d'un rechargement forcé : le
    // montage de la séance reste défaisable, y compris jusqu'avant le geste que
    // le serveur vient d'écarter.
    const editeur = useEditeur.getState()
    editeur.charger(clip())
    editeur.commencerSelection(2, false)
    editeur.retirerSelection(mots())
    const pile = useEditeur.getState().historique.past

    useEditeur.getState().reconcilier('c1', { segments: [{ start: 10, end: 14.8 }] })
    expect(useEditeur.getState().historique.past).toEqual(pile)
  })

  it('n’empile pas de pas à annuler', () => {
    // Une réconciliation n'est pas un geste de l'utilisateur : l'empiler ferait
    // d'un Ctrl+Z le moyen de remettre l'intention que le serveur a refusée.
    const editeur = useEditeur.getState()
    editeur.charger(clip())
    editeur.reconcilier('c1', { segments: [{ start: 10, end: 12 }] })
    expect(useEditeur.getState().historique.past).toEqual([])
  })

  it('ne touche pas un autre clip que celui qui est ouvert', () => {
    // Une écriture part en `keepalive` et lui survit à la navigation : sa
    // réponse peut arriver alors que l'écran montre déjà le clip suivant.
    const editeur = useEditeur.getState()
    editeur.charger(clip({ id: 'c2', segments: [{ start: 0, end: 5 }] }))
    editeur.reconcilier('c1', { segments: [{ start: 10, end: 12 }], cropX: 0.9 })

    const etat = useEditeur.getState()
    expect(etat.historique.present).toEqual([{ start: 0, end: 5 }])
    expect(etat.cropX).toBe(0.5)
  })
})
