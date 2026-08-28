import { beforeEach, describe, expect, it } from 'vitest'

import { clipDuration, type Clip } from '@/core/edl'
import { indexTranscript, type TranscriptLine } from '@/lib/editing'
import { useEditor } from '@/store/editor'

const lines: TranscriptLine[] = [
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
    footer: true,
    title: 'Un titre',
    description: '',
    status: 'candidate',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
    ...overrides,
  }
}

/** Les mots, marqués selon les segments courants du store. */
function words() {
  return indexTranscript(lines, useEditor.getState().history.present).words
}

const initial = useEditor.getState()

beforeEach(() => {
  useEditor.setState(initial, true)
})

describe('charger', () => {
  it('installe les segments, le cadrage, et une pile vide', () => {
    useEditor.getState().charger(clip())
    const state = useEditor.getState()
    expect(state.history.present).toEqual([{ start: 10, end: 14.8 }])
    expect(state.history.past).toEqual([])
    expect(state.cropX).toBe(0.5)
  })

  it('ne recharge pas le clip déjà ouvert', () => {
    // Un refetch au retour d'onglet rejoue la requête. Recharger sans condition
    // écraserait le montage en cours par la version du serveur, et viderait la
    // pile d'annulation avec.
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.commencerSelection(2, false)
    editor.removeSelection(words())
    const mount = useEditor.getState().history.present

    useEditor.getState().charger(clip())
    expect(useEditor.getState().history.present).toBe(mount)
  })

  it('recharge quand on ouvre un autre clip', () => {
    useEditor.getState().charger(clip())
    useEditor.getState().charger(clip({ id: 'c2', segments: [{ start: 0, end: 5 }], cropX: 0.2 }))
    expect(useEditor.getState().history.present).toEqual([{ start: 0, end: 5 }])
    expect(useEditor.getState().cropX).toBe(0.2)
  })
})

describe('la sélection', () => {
  it('un clic sélectionne un mot, un shift-clic étend depuis l’ancre', () => {
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.commencerSelection(1, false)
    editor.commencerSelection(3, true)
    expect(useEditor.getState().selection).toEqual({ anchor: 1, head: 3 })
  })

  it('le survol n’étend que pendant un glissé', () => {
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.commencerSelection(1, false)
    editor.extendSelection(3)
    expect(useEditor.getState().selection).toEqual({ anchor: 1, head: 3 })

    editor.finishSelection()
    useEditor.getState().extendSelection(4)
    expect(useEditor.getState().selection).toEqual({ anchor: 1, head: 3 })
  })

  it('s’étend aussi vers la gauche', () => {
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.commencerSelection(3, false)
    editor.extendSelection(1)
    expect(useEditor.getState().selection).toEqual({ anchor: 3, head: 1 })
  })
})

describe('les trois gestes', () => {
  it('retirer une sélection raccourcit le clip et vide la sélection', () => {
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.commencerSelection(2, false)
    editor.removeSelection(words())

    const state = useEditor.getState()
    expect(state.history.present).toEqual([
      { start: 10, end: 12 },
      { start: 12.8, end: 14.8 },
    ])
    expect(clipDuration(state.history.present)).toBeCloseTo(4, 6)
    expect(state.selection).toBeNull()
  })

  it('remonter un mot barré recolle le clip', () => {
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.commencerSelection(2, false)
    editor.removeSelection(words())
    useEditor.getState().surfaceWord(words(), 2)
    expect(useEditor.getState().history.present).toEqual([{ start: 10, end: 14.8 }])
  })

  it('poser une borne au mot rétrécit le clip', () => {
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.poserBound(words(), 2, 'start')
    expect(useEditor.getState().history.present).toEqual([{ start: 12, end: 14.8 }])
  })
})

describe('le cadrage', () => {
  it('accepte une valeur', () => {
    useEditor.getState().moveCrop(0.3)
    expect(useEditor.getState().cropX).toBeCloseTo(0.3, 6)
  })

  it('accepte une fonction de la précédente, pour les flèches répétées', () => {
    // Six frappes dans le même tour de boucle : lues depuis la fermeture du
    // rendu, elles calculeraient six fois le même résultat et le cadre
    // n'avancerait que d'un cran.
    const editor = useEditor.getState()
    editor.moveCrop(0.5)
    for (let i = 0; i < 6; i++) editor.moveCrop((p) => p - 0.01)
    expect(useEditor.getState().cropX).toBeCloseTo(0.44, 6)
  })
})

describe('annuler', () => {
  it('dépile geste par geste', () => {
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.commencerSelection(1, false)
    editor.removeSelection(words())
    useEditor.getState().poserBound(words(), 3, 'end')
    expect(useEditor.getState().history.present).toEqual([
      { start: 10, end: 11 },
      { start: 11.8, end: 13.8 },
    ])

    useEditor.getState().cancel()
    expect(useEditor.getState().history.present).toEqual([
      { start: 10, end: 11 },
      { start: 11.8, end: 14.8 },
    ])

    useEditor.getState().cancel()
    expect(useEditor.getState().history.present).toEqual([{ start: 10, end: 14.8 }])
  })

  it('un Ctrl+Z de trop ne fait rien', () => {
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.cancel()
    editor.cancel()
    expect(useEditor.getState().history.present).toEqual([{ start: 10, end: 14.8 }])
  })

  it('un geste sans effet n’ajoute pas de pas à annuler', () => {
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.commencerSelection(2, false)
    editor.removeSelection(words())
    const after = useEditor.getState().history.past.length

    useEditor.getState().commencerSelection(2, false)
    useEditor.getState().removeSelection(words())
    expect(useEditor.getState().history.past.length).toBe(after)
  })
})

describe('réconcilier après un PATCH refusé', () => {
  // `applied: false` veut dire « une écriture plus récente a gagné ». Le cache
  // adopte le clip rendu ; le store, lui, resterait sur l'intention refusée et
  // la renverrait avec un jeton neuf — donc gagnant. Voir `@/lib/autosave`
  // pour la forme retenue et pourquoi c'est celle-là.
  it('adopte les valeurs du gagnant', () => {
    useEditor.getState().charger(clip())
    useEditor.getState().reconcile('c1', {
      segments: [{ start: 10, end: 12 }],
      ratio: '1:1',
      cropX: 0.2,
    })

    const state = useEditor.getState()
    expect(state.history.present).toEqual([{ start: 10, end: 12 }])
    expect(state.ratio).toBe('1:1')
    expect(state.cropX).toBe(0.2)
  })

  it('ne vide pas la pile d’annulation', () => {
    // C'est ce qui distingue cette réconciliation d'un rechargement forcé : le
    // montage de la séance reste défaisable, y compris jusqu'avant le geste que
    // le serveur vient d'écarter.
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.commencerSelection(2, false)
    editor.removeSelection(words())
    const stack = useEditor.getState().history.past

    useEditor.getState().reconcile('c1', { segments: [{ start: 10, end: 14.8 }] })
    expect(useEditor.getState().history.past).toEqual(stack)
  })

  it('n’empile pas de pas à annuler', () => {
    // Une réconciliation n'est pas un geste de l'utilisateur : l'empiler ferait
    // d'un Ctrl+Z le moyen de remettre l'intention que le serveur a refusée.
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.reconcile('c1', { segments: [{ start: 10, end: 12 }] })
    expect(useEditor.getState().history.past).toEqual([])
  })

  it('efface ce qu’il y avait à refaire', () => {
    // La branche annulée n'a plus de sens une fois le montage remis d'accord
    // avec le serveur : un `Ctrl+Shift+Z` y remettrait un état antérieur au
    // gagnant, et l'enregistrement différé le renverrait avec un jeton neuf —
    // donc gagnant. Exactement le défaut que la réconciliation ferme.
    // (relevé par Copilot)
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.commencerSelection(2, false)
    editor.removeSelection(words())
    useEditor.getState().cancel()
    expect(useEditor.getState().history.future).toHaveLength(1)

    useEditor.getState().reconcile('c1', { segments: [{ start: 10, end: 12 }] })
    expect(useEditor.getState().history.future).toEqual([])
  })

  it('garde ce qu’il y avait à refaire quand le montage n’a pas bougé', () => {
    // Un refus qui ne porte que sur le cadrage ne change pas de branche : la
    // pile de rétablissement décrit toujours le même montage.
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.commencerSelection(2, false)
    editor.removeSelection(words())
    useEditor.getState().cancel()
    const aRedo = useEditor.getState().history.future

    useEditor.getState().reconcile('c1', { cropX: 0.2 })
    expect(useEditor.getState().history.future).toEqual(aRedo)
  })

  it('ne touche pas un autre clip que celui qui est ouvert', () => {
    // Une écriture part en `keepalive` et lui survit à la navigation : sa
    // réponse peut arriver alors que l'écran montre déjà le clip suivant.
    const editor = useEditor.getState()
    editor.charger(clip({ id: 'c2', segments: [{ start: 0, end: 5 }] }))
    editor.reconcile('c1', { segments: [{ start: 10, end: 12 }], cropX: 0.9 })

    const state = useEditor.getState()
    expect(state.history.present).toEqual([{ start: 0, end: 5 }])
    expect(state.cropX).toBe(0.5)
  })
})

describe('rétablir', () => {
  it('refait le geste qu’on vient d’annuler', () => {
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.commencerSelection(2, false)
    editor.removeSelection(words())
    const mount = useEditor.getState().history.present

    useEditor.getState().cancel()
    expect(useEditor.getState().history.present).toEqual([{ start: 10, end: 14.8 }])

    useEditor.getState().restore()
    expect(useEditor.getState().history.present).toEqual(mount)
  })

  it('un Ctrl+Shift+Z de trop ne fait rien', () => {
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.restore()
    expect(useEditor.getState().history.present).toEqual([{ start: 10, end: 14.8 }])
  })

  it('un nouveau geste efface ce qu’il y avait à refaire', () => {
    const editor = useEditor.getState()
    editor.charger(clip())
    editor.commencerSelection(2, false)
    editor.removeSelection(words())
    useEditor.getState().cancel()

    useEditor.getState().commencerSelection(4, false)
    useEditor.getState().removeSelection(words())
    expect(useEditor.getState().history.future).toEqual([])
  })

  it('n’a rien à refaire sur un clip qu’on vient d’ouvrir', () => {
    useEditor.getState().charger(clip())
    expect(useEditor.getState().history.future).toEqual([])
  })
})
