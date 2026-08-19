import { describe, expect, it } from 'vitest'

import { clipDuration, type Segment } from '@/core/edl'
import type { Word } from '@/core/transcript'
import {
  applyWordCorrection,
  clipBounds,
  indexTranscript,
  isWordKept,
  ligneInitiale,
  moveBoundaryToWord,
  playbackAction,
  redistributeTiming,
  removeSelection,
  restoreBounds,
  restoreWord,
  segmentAt,
  selectionBounds,
  wordsToText,
  type TranscriptLine,
} from '@/lib/editing'

/** Cinq mots réguliers : un par seconde, chacun long de 0,8 s. */
const mots: Word[] = [
  { word: 'un', start: 10, end: 10.8 },
  { word: 'deux', start: 11, end: 11.8 },
  { word: 'trois', start: 12, end: 12.8 },
  { word: 'quatre', start: 13, end: 13.8 },
  { word: 'cinq', start: 14, end: 14.8 },
]

describe('isWordKept', () => {
  it('un mot dans un segment est monté', () => {
    expect(isWordKept(mots[1], [{ start: 10, end: 15 }])).toBe(true)
  })

  it('un mot hors de tout segment est barré', () => {
    expect(isWordKept(mots[1], [{ start: 12, end: 15 }])).toBe(false)
  })

  it('un mot à cheval sur une borne est monté : on l’entendra', () => {
    // La borne tombe au milieu de « deux ». L'inclusion le rendrait barré alors
    // qu'il s'entend dans le clip — c'est l'affichage qui ment.
    expect(isWordKept(mots[1], [{ start: 11.4, end: 15 }])).toBe(true)
  })

  it('sans segment, plus rien n’est monté', () => {
    expect(isWordKept(mots[0], [])).toBe(false)
  })
})

describe('indexTranscript', () => {
  const lignes: TranscriptLine[] = [
    { id: 'a', start: 10, end: 11.8, words: mots.slice(0, 2) },
    { id: 'b', start: 12, end: 14.8, words: mots.slice(2) },
  ]

  it('numérote les mots à plat, phrases confondues', () => {
    const { words } = indexTranscript(lignes, [])
    expect(words.map((w) => w.index)).toEqual([0, 1, 2, 3, 4])
    expect(words.map((w) => w.word)).toEqual(['un', 'deux', 'trois', 'quatre', 'cinq'])
  })

  it('chaque phrase pointe la tranche de mots qui lui appartient', () => {
    const { words, lines } = indexTranscript(lignes, [])
    expect(lines).toEqual([
      { id: 'a', start: 10, end: 11.8, from: 0, to: 2 },
      { id: 'b', start: 12, end: 14.8, from: 2, to: 5 },
    ])
    expect(words.slice(lines[1].from, lines[1].to).map((w) => w.word)).toEqual([
      'trois',
      'quatre',
      'cinq',
    ])
  })

  it('marque les mots retirés', () => {
    const { words } = indexTranscript(lignes, [{ start: 10, end: 12.9 }])
    expect(words.map((w) => w.kept)).toEqual([true, true, true, false, false])
  })
})

describe('selectionBounds', () => {
  it('va du début du premier mot à la fin du dernier', () => {
    expect(selectionBounds(mots, 1, 3)).toEqual({ from: 11, to: 13.8 })
  })

  it('accepte une sélection faite à l’envers', () => {
    // On sélectionne aussi souvent de la fin vers le début. Une soustraction
    // naïve rendrait un intervalle inversé, que `removeRange` traiterait comme
    // vide : la phrase resterait, sans erreur et sans trace.
    expect(selectionBounds(mots, 3, 1)).toEqual(selectionBounds(mots, 1, 3))
  })

  it('un seul mot se sélectionne', () => {
    expect(selectionBounds(mots, 2, 2)).toEqual({ from: 12, to: 12.8 })
  })

  it('rend null hors bornes plutôt que de lever', () => {
    expect(selectionBounds(mots, -1, 2)).toBeNull()
    expect(selectionBounds(mots, 2, 99)).toBeNull()
    expect(selectionBounds([], 0, 0)).toBeNull()
  })
})

describe('removeSelection', () => {
  const segments: Segment[] = [{ start: 10, end: 15 }]

  it('coupe le clip en deux quand on retire son milieu', () => {
    expect(removeSelection(segments, mots, 2, 2)).toEqual([
      { start: 10, end: 12 },
      { start: 12.8, end: 15 },
    ])
  })

  it('la durée baisse d’exactement la sélection retirée', () => {
    const apres = removeSelection(segments, mots, 1, 3)
    expect(clipDuration(segments) - clipDuration(apres)).toBeCloseTo(2.8, 6)
  })

  it('une sélection impossible ne change rien', () => {
    expect(removeSelection(segments, mots, 0, 99)).toEqual(segments)
  })

  it('retirer deux fois de suite est idempotent', () => {
    const une = removeSelection(segments, mots, 2, 2)
    expect(removeSelection(une, mots, 2, 2)).toEqual(une)
  })
})

describe('restoreBounds', () => {
  it('remonte du mot précédent au mot suivant, pas seulement le mot', () => {
    // C'est ce qui fait que l'intervalle *touche* le voisin monté : sans ça,
    // chaque mot rendu ajoutait un segment séparé par un silence de quelques
    // centièmes — un décodeur ffmpeg de plus pour un trou que personne n'a
    // demandé.
    expect(restoreBounds(mots, 2)).toEqual({ from: 11.8, to: 13 })
  })

  it('s’arrête au mot lui-même aux extrémités de la liste', () => {
    expect(restoreBounds(mots, 0)).toEqual({ from: 10, to: 11 })
    expect(restoreBounds(mots, 4)).toEqual({ from: 13.8, to: 14.8 })
  })

  it('supporte des mots qui se chevauchent, comme en parole rapide', () => {
    const rapides: Word[] = [
      { word: 'a', start: 0, end: 1.2 },
      { word: 'b', start: 1, end: 2.2 },
      { word: 'c', start: 2, end: 3 },
    ]
    expect(restoreBounds(rapides, 1)).toEqual({ from: 1, to: 2.2 })
  })

  it('ne rejoint pas un voisin séparé par un long silence', () => {
    // Le défaut trouvé en review : sans plafond, le premier mot d'après une
    // coupure de scène se rejoignait au dernier mot d'avant. Sur un transcript
    // où deux catégories sont séparées de sept minutes, un seul clic ajoutait
    // sept minutes de silence au clip.
    const separes: Word[] = [
      { word: 'avant', start: 10, end: 10.5 },
      { word: 'après', start: 430, end: 430.6 },
      { word: 'suite', start: 431, end: 431.5 },
    ]
    expect(restoreBounds(separes, 1)).toEqual({ from: 430, to: 431 })
  })

  it('ne rejoint pas non plus vers l’avant par-dessus un long silence', () => {
    const separes: Word[] = [
      { word: 'un', start: 10, end: 10.5 },
      { word: 'deux', start: 10.7, end: 11.2 },
      { word: 'plus tard', start: 400, end: 400.8 },
    ]
    expect(restoreBounds(separes, 1)).toEqual({ from: 10.5, to: 11.2 })
  })

  it('rejoint encore par-dessus une respiration entre deux phrases', () => {
    const respiration: Word[] = [
      { word: 'fin.', start: 10, end: 10.5 },
      { word: 'Suite', start: 11.2, end: 11.8 },
      { word: 'immédiate', start: 11.9, end: 12.6 },
    ]
    expect(restoreBounds(respiration, 1)).toEqual({ from: 10.5, to: 11.9 })
  })

  it('rend null hors bornes', () => {
    expect(restoreBounds(mots, 5)).toBeNull()
    expect(restoreBounds([], 0)).toBeNull()
  })
})

describe('restoreWord', () => {
  it('rend un mot barré et le recolle au segment voisin, sans trou', () => {
    const segments: Segment[] = [
      { start: 10, end: 12 },
      { start: 12.8, end: 15 },
    ]
    expect(restoreWord(segments, mots, 2)).toEqual([{ start: 10, end: 15 }])
  })

  it('deux mots rendus l’un après l’autre finissent par fusionner', () => {
    const segments: Segment[] = [
      { start: 10, end: 11 },
      { start: 13, end: 15 },
    ]
    const apresUn = restoreWord(segments, mots, 1)
    const apresDeux = restoreWord(apresUn, mots, 2)
    expect(apresDeux).toEqual([{ start: 10, end: 15 }])
  })

  it('un index impossible ne change rien', () => {
    const segments: Segment[] = [{ start: 10, end: 11 }]
    expect(restoreWord(segments, mots, 42)).toEqual(segments)
  })
})

describe('moveBoundaryToWord', () => {
  const segments: Segment[] = [{ start: 11, end: 13 }]

  it('pose la borne de début au début du mot', () => {
    expect(moveBoundaryToWord(segments, mots, 0, 'start')).toEqual([{ start: 10, end: 13 }])
  })

  it('pose la borne de fin à la fin du mot', () => {
    expect(moveBoundaryToWord(segments, mots, 4, 'end')).toEqual([{ start: 11, end: 14.8 }])
  })

  it('rétrécir traverse les segments qu’il faut', () => {
    const deux: Segment[] = [
      { start: 10, end: 11.8 },
      { start: 13, end: 14.8 },
    ]
    expect(moveBoundaryToWord(deux, mots, 3, 'start')).toEqual([{ start: 13, end: 14.8 }])
  })
})

describe('clipBounds', () => {
  it('relit les bornes dans la liste rendue, jamais la valeur demandée', () => {
    // Le piège documenté sur `moveBoundary` : la borne demandée tombe dans le
    // trou entre les deux segments, et la borne obtenue est celle du voisin.
    const deux: Segment[] = [
      { start: 10, end: 11.8 },
      { start: 13, end: 14.8 },
    ]
    const apres = moveBoundaryToWord(deux, mots, 2, 'start')
    expect(clipBounds(apres)).toEqual({ start: 13, end: 14.8 })
    expect(clipBounds(apres)?.start).not.toBe(mots[2].start)
  })

  it('rend null sur un clip vide', () => {
    expect(clipBounds([])).toBeNull()
  })

  it('ignore l’ordre d’arrivée des segments', () => {
    expect(
      clipBounds([
        { start: 30, end: 40 },
        { start: 10, end: 20 },
      ]),
    ).toEqual({ start: 10, end: 40 })
  })
})

describe('segmentAt', () => {
  const segments: Segment[] = [
    { start: 10, end: 20 },
    { start: 30, end: 40 },
  ]

  it('rend le segment qui contient la position', () => {
    expect(segmentAt(segments, 15)).toEqual({ start: 10, end: 20 })
  })

  it('rend le suivant quand la position tombe dans un trou', () => {
    expect(segmentAt(segments, 25)).toEqual({ start: 30, end: 40 })
  })

  it('rend null après le dernier segment', () => {
    expect(segmentAt(segments, 41)).toBeNull()
  })
})

describe('playbackAction', () => {
  const segments: Segment[] = [
    { start: 10, end: 20 },
    { start: 30, end: 40 },
  ]

  it('laisse lire à l’intérieur d’un segment', () => {
    expect(playbackAction(segments, 15)).toEqual({ kind: 'play' })
  })

  it('saute au segment suivant depuis un passage retiré', () => {
    expect(playbackAction(segments, 21)).toEqual({ kind: 'seek', to: 30 })
  })

  it('ne resaute pas quand le navigateur retombe un peu avant la borne', () => {
    // `currentTime` après un saut n'est jamais exactement la valeur demandée :
    // le navigateur se cale sur une image clé. Sans marge, chaque saut en
    // déclencherait un autre au même endroit.
    expect(playbackAction(segments, 29.9)).toEqual({ kind: 'play' })
  })

  it('annonce la fin après le dernier segment', () => {
    expect(playbackAction(segments, 41)).toEqual({ kind: 'end' })
  })

  it('un clip vide est fini d’emblée', () => {
    expect(playbackAction([], 0)).toEqual({ kind: 'end' })
  })
})

describe('ligneInitiale', () => {
  const lignes: TranscriptLine[] = [
    { id: 'l0', start: 0, end: 5, words: [] },
    { id: 'l1', start: 5, end: 10, words: [] },
    { id: 'l2', start: 10, end: 15, words: [] },
  ]

  it('ouvre sur la phrase où le clip commence, pas sur le contexte d’avant', () => {
    expect(ligneInitiale(lignes, [{ start: 11, end: 14 }])).toBe(2)
  })

  it('prend la phrase qui contient le début, même s’il tombe en son milieu', () => {
    expect(ligneInitiale(lignes, [{ start: 7.5, end: 9 }])).toBe(1)
  })

  it('ouvre en haut quand le clip n’a plus de segment', () => {
    // Un clip dont tous les mots ont été retirés : la fenêtre de transcript
    // existe toujours, et c'est précisément là qu'il faut la relire.
    expect(ligneInitiale(lignes, [])).toBe(0)
  })

  it('ouvre en haut quand aucune phrase ne va jusque-là', () => {
    expect(ligneInitiale(lignes, [{ start: 99, end: 100 }])).toBe(0)
  })
})

describe('redistributeTiming', () => {
  it('un seul mot de remplacement prend tout l’empan', () => {
    expect(redistributeTiming({ start: 10, end: 12 }, ['fusionné'])).toEqual([
      { word: 'fusionné', start: 10, end: 12 },
    ])
  })

  it('aucun mot rend une liste vide — c’est la suppression', () => {
    expect(redistributeTiming({ start: 10, end: 12 }, [])).toEqual([])
  })

  it('plusieurs mots se partagent l’empan au prorata de leur longueur', () => {
    // « a » (1) et « bcd » (3) : un quart / trois quarts de la seconde.
    const mots = redistributeTiming({ start: 10, end: 11 }, ['a', 'bcd'])
    expect(mots[0]).toEqual({ word: 'a', start: 10, end: 10.25 })
    expect(mots[1]).toEqual({ word: 'bcd', start: 10.25, end: 11 })
  })

  it('le premier mot commence à span.start, le dernier finit à span.end', () => {
    const mots = redistributeTiming({ start: 5, end: 5.7 }, ['un', 'deux', 'trois'])
    expect(mots[0].start).toBe(5)
    expect(mots[mots.length - 1].end).toBe(5.7)
  })

  it('reste stable sur un empan de durée nulle', () => {
    const mots = redistributeTiming({ start: 5, end: 5 }, ['un', 'deux'])
    expect(mots.every((m) => m.start === 5 && m.end === 5)).toBe(true)
  })
})

describe('applyWordCorrection', () => {
  it('remplace un mot par un autre, sans toucher aux voisins', () => {
    const résultat = applyWordCorrection(mots, {
      from: 2,
      to: 2,
      expected: ['trois'],
      replacement: ['3'],
    })
    expect(résultat).toEqual({
      ok: true,
      words: [mots[0], mots[1], { word: '3', start: 12, end: 12.8 }, mots[3], mots[4]],
    })
  })

  it('fusionne deux mots en un, qui prend leur empan réuni', () => {
    const résultat = applyWordCorrection(mots, {
      from: 0,
      to: 1,
      expected: ['un', 'deux'],
      replacement: ['un-deux'],
    })
    expect(résultat.ok).toBe(true)
    if (!résultat.ok) throw new Error('inattendu')
    expect(résultat.words[0]).toEqual({ word: 'un-deux', start: 10, end: 11.8 })
    expect(résultat.words.slice(1)).toEqual([mots[2], mots[3], mots[4]])
  })

  it('scinde un mot en deux, qui se partagent son empan', () => {
    const résultat = applyWordCorrection(mots, {
      from: 3,
      to: 3,
      expected: ['quatre'],
      replacement: ['quat', 're'],
    })
    expect(résultat.ok).toBe(true)
    if (!résultat.ok) throw new Error('inattendu')
    expect(résultat.words[3].start).toBe(13)
    expect(résultat.words[4].end).toBe(13.8)
    expect(résultat.words.map((w) => w.word)).toEqual(['un', 'deux', 'trois', 'quat', 're', 'cinq'])
  })

  it('supprime un mot — un remplacement vide', () => {
    const résultat = applyWordCorrection(mots, {
      from: 1,
      to: 1,
      expected: ['deux'],
      replacement: [],
    })
    expect(résultat).toEqual({ ok: true, words: [mots[0], mots[2], mots[3], mots[4]] })
  })

  it('refuse une ancre qui ne correspond plus — le transcript a changé sous les yeux', () => {
    const résultat = applyWordCorrection(mots, {
      from: 1,
      to: 1,
      expected: ['pas-le-bon-mot'],
      replacement: ['x'],
    })
    expect(résultat).toEqual({ ok: false, reason: 'anchor-mismatch' })
  })

  it('refuse un empan qui déborde de la phrase', () => {
    expect(
      applyWordCorrection(mots, { from: 0, to: 10, expected: [], replacement: ['x'] }),
    ).toEqual({ ok: false, reason: 'out-of-range' })
  })

  it('refuse des bornes inversées', () => {
    expect(
      applyWordCorrection(mots, { from: 3, to: 1, expected: [], replacement: ['x'] }),
    ).toEqual({ ok: false, reason: 'out-of-range' })
  })

  it('ne modifie pas le tableau reçu', () => {
    const copie = mots.map((m) => ({ ...m }))
    applyWordCorrection(mots, { from: 0, to: 0, expected: ['un'], replacement: ['1'] })
    expect(mots).toEqual(copie)
  })
})

describe('wordsToText', () => {
  it('joint les mots par un espace, comme WhisperX', () => {
    // Vérifié sur un transcript réel (2025-06-15-cqlp) : la ponctuation reste
    // collée au mot, aucun espace n'est inséré avant elle.
    expect(wordsToText([{ word: 'Je', start: 0, end: 1 }, { word: 'ne', start: 1, end: 2 }, { word: 'savais', start: 2, end: 3 }, { word: 'pas.', start: 3, end: 4 }])).toBe('Je ne savais pas.')
  })

  it('rend une chaîne vide pour une phrase sans mot', () => {
    expect(wordsToText([])).toBe('')
  })
})
