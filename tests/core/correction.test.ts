import { describe, expect, it } from 'vitest'

import {
  flattenTranscript,
  parseCorrectionResponse,
  phoneticKey,
  toProposedCorrection,
  validateCorrections,
  type CorrectionCandidate,
} from '@/core/correction'
import type { Transcript, Word } from '@/core/transcript'

/**
 * Le noyau pur de la correction du transcript (spec §9, §14) : la clé
 * phonétique, la validation d'une réponse de modèle contre l'empan qui l'a
 * produite, et la traduction vers l'index de phrase.
 *
 * **Aucun appel à Ollama.** Les réponses de modèle sont des littéraux
 * `CorrectionCandidate[]`, comme la spec §14 le réclame nommément.
 */

function word(text: string, start: number, end: number): Word {
  return { word: text, start, end }
}

describe('phoneticKey', () => {
  it.each([
    ['et', 'est'],
    ['a', 'à'],
    ['ces', 'ses'],
    ['ces', "c'est"],
    ['ces', "s'est"],
    ["c'est", "s'est"],
  ])('fait collider %s et %s', (a, b) => {
    expect(phoneticKey(a)).toBe(phoneticKey(b))
  })

  it('ne fait pas collider deux mots qui ne se ressemblent pas', () => {
    expect(phoneticKey('chat')).not.toBe(phoneticKey('chien'))
  })

  it('ignore la ponctuation collée au mot', () => {
    expect(phoneticKey("c'est.")).toBe(phoneticKey('ces'))
  })

  it('est stable sur un mot déjà réduit à une seule lettre', () => {
    expect(phoneticKey('a')).toBe('a')
  })
})

describe('validateCorrections', () => {
  const span: Word[] = [
    word('Bonjour', 0, 1),
    word('cest', 1, 2),
    word('a', 2, 3),
    word('tous', 3, 4),
    word('chat', 4, 5),
  ]

  it('accepte une substitution simple qui sonne comme l’original', () => {
    const { accepted, rejected } = validateCorrections(span, [{ i: 1, w: "c'est" }])
    expect(rejected).toEqual([])
    expect(accepted).toEqual([{ from: 1, to: 1, original: ['cest'], replacement: "c'est" }])
  })

  it('accepte une fusion (merge) et rend l’empan original entier', () => {
    const { accepted, rejected } = validateCorrections(span, [
      { i: 1, merge: 2, w: "c'est-à" },
    ])
    expect(rejected).toEqual([])
    expect(accepted).toEqual([
      { from: 1, to: 2, original: ['cest', 'a'], replacement: "c'est-à" },
    ])
  })

  // « Une réponse du modèle qui insère des mots est rejetée » (spec §14) :
  // l'insertion n'a pas de forme dans ce contrat — le plus proche est un `i`
  // au-delà du dernier mot, ou un `merge` qui déborde l'empan.
  it('rejette un index au-delà du dernier mot de l’empan (insertion déguisée)', () => {
    const { accepted, rejected } = validateCorrections(span, [{ i: 5, w: 'en' }])
    expect(accepted).toEqual([])
    expect(rejected).toEqual([{ candidate: { i: 5, w: 'en' }, reason: 'out-of-range' }])
  })

  it('rejette un merge qui déborde l’empan', () => {
    const { accepted, rejected } = validateCorrections(span, [{ i: 4, merge: 3, w: 'chats' }])
    expect(accepted).toEqual([])
    expect(rejected[0]?.reason).toBe('out-of-range')
  })

  // « Une réponse qui supprime des mots est rejetée » : la suppression n'a
  // pas de forme non plus — `w` vide est le plus proche, et il est refusé.
  it('rejette un remplacement vide (suppression déguisée)', () => {
    const { accepted, rejected } = validateCorrections(span, [{ i: 3, w: '' }])
    expect(accepted).toEqual([])
    expect(rejected).toEqual([{ candidate: { i: 3, w: '' }, reason: 'empty-word' }])
  })

  it('rejette un remplacement à plusieurs mots', () => {
    const { accepted, rejected } = validateCorrections(span, [{ i: 0, w: 'bien le bonjour' }])
    expect(accepted).toEqual([])
    expect(rejected[0]?.reason).toBe('word-has-space')
  })

  // « Une réponse qui réordonne des mots est rejetée » : un échange de deux
  // mots se déguise en deux substitutions ordinaires — c'est la garde
  // phonétique qui les arrête, faute d'un champ « expected » dans le contrat
  // du modèle (voir la doc de `validateCorrections`).
  it('rejette un réordonnancement déguisé en deux substitutions', () => {
    const { accepted, rejected } = validateCorrections(span, [
      { i: 0, w: 'chat' },
      { i: 4, w: 'Bonjour' },
    ])
    expect(accepted).toEqual([])
    expect(rejected.map((r) => r.reason)).toEqual(['phonetic-mismatch', 'phonetic-mismatch'])
  })

  it('rejette une substitution qui ne sonne pas comme l’original', () => {
    const { accepted, rejected } = validateCorrections(span, [{ i: 4, w: 'chien' }])
    expect(accepted).toEqual([])
    expect(rejected).toEqual([{ candidate: { i: 4, w: 'chien' }, reason: 'phonetic-mismatch' }])
  })

  it('rejette un recouvrement, le candidat le plus tôt dans l’empan l’emporte', () => {
    // Deux candidats dont les empans se chevauchent sur l'index 2 ("a") :
    // les remplacements reprennent le texte d'origine pour n'exercer que le
    // recouvrement, sans passer par la garde phonétique.
    const { accepted, rejected } = validateCorrections(span, [
      { i: 2, w: 'a' },
      { i: 1, merge: 2, w: 'cesta' },
    ])
    expect(accepted).toEqual([{ from: 1, to: 2, original: ['cest', 'a'], replacement: 'cesta' }])
    expect(rejected).toEqual([{ candidate: { i: 2, w: 'a' }, reason: 'overlap' }])
  })
})

describe('parseCorrectionResponse', () => {
  it('lit un tableau de corrections valide', () => {
    expect(parseCorrectionResponse({ corrections: [{ i: 0, w: 'x' }] })).toEqual([
      { i: 0, w: 'x' },
    ])
  })

  it('écarte en silence un candidat individuel mal formé', () => {
    expect(
      parseCorrectionResponse({ corrections: [{ i: 0, w: 'x' }, { i: 'oops' }, { w: 'sans index' }] }),
    ).toEqual([{ i: 0, w: 'x' }])
  })

  it('lève quand l’enveloppe elle-même est cassée', () => {
    expect(() => parseCorrectionResponse({})).toThrow()
    expect(() => parseCorrectionResponse(null)).toThrow()
    expect(() => parseCorrectionResponse({ corrections: 'pas un tableau' })).toThrow()
  })
})

describe('flattenTranscript et toProposedCorrection', () => {
  const transcript: Transcript = {
    segments: [
      { start: 0, end: 2, text: 'Bonjour cest', words: [word('Bonjour', 0, 1), word('cest', 1, 2)] },
      { start: 2, end: 3, text: '', words: [] },
      { start: 3, end: 5, text: 'a tous', words: [word('a', 3, 4), word('tous', 4, 5)] },
    ],
  }

  it('numérote segmentIndex sur l’index brut, y compris un segment sans mot', () => {
    const flat = flattenTranscript(transcript)
    expect(flat.map((f) => f.segmentIndex)).toEqual([0, 0, 2, 2])
    expect(flat.map((f) => f.localIndex)).toEqual([0, 1, 0, 1])
  })

  it('convertit une substitution en ligne l0, avec le bon empan local', () => {
    const flat = flattenTranscript(transcript)
    const converted = toProposedCorrection(flat, 0, {
      from: 1,
      to: 1,
      original: ['cest'],
      replacement: "c'est",
    })
    expect(converted).toEqual({
      ok: true,
      proposal: {
        lineId: 'l0',
        timecode: 1,
        correction: { from: 1, to: 1, expected: ['cest'], replacement: ["c'est"] },
        original: 'cest',
        replacement: "c'est",
      },
    })
  })

  // « Les horodatages survivent à une fusion » (spec §14) : la substitution
  // convertie porte l'empan local entier des mots fusionnés — c'est cet
  // empan que `redistributeTiming` (`@/lib/editing`, déjà testé) reprend
  // ensuite pour donner au remplacement exactement le temps des mots retirés.
  it('une fusion convertie porte l’empan local entier des mots fusionnés', () => {
    const flat = flattenTranscript(transcript)
    const converted = toProposedCorrection(flat, 2, {
      from: 0,
      to: 1,
      original: ['a', 'tous'],
      replacement: 'atous',
    })
    expect(converted).toEqual({
      ok: true,
      proposal: {
        lineId: 'l2',
        timecode: 3,
        correction: { from: 0, to: 1, expected: ['a', 'tous'], replacement: ['atous'] },
        original: 'a tous',
        replacement: 'atous',
      },
    })
  })

  it('rejette en crosses-line une fusion qui couvrirait deux phrases', () => {
    const flat = flattenTranscript(transcript)
    // Le mot d'index local 1 de l'empan (offset 0) est "cest" (segment 0,
    // dernier mot), et l'empan continuerait sur "a" (segment 2, après le
    // segment vide) : les deux moitiés de la fusion appartiennent à des
    // phrases différentes.
    const converted = toProposedCorrection(flat, 0, {
      from: 1,
      to: 2,
      original: ['cest', 'a'],
      replacement: 'x',
    })
    expect(converted).toEqual({ ok: false, reason: 'crosses-line' })
  })
})

// Les cinq candidats types que la doc de `validateCorrections` énumère —
// gardé comme un test de non-régression sur les catégories elles-mêmes,
// indépendamment des cas ci-dessus qui les exercent une à une.
describe('les six catégories de refus sont toutes atteignables', () => {
  const span: Word[] = [word('un', 0, 1), word('deux', 1, 2)]
  const cases: [string, CorrectionCandidate, string][] = [
    ['out-of-range', { i: 9, w: 'x' }, 'out-of-range'],
    ['empty-word', { i: 0, w: '' }, 'empty-word'],
    ['word-has-space', { i: 0, w: 'a b' }, 'word-has-space'],
    ['phonetic-mismatch', { i: 0, w: 'chat' }, 'phonetic-mismatch'],
  ]

  it.each(cases)('%s', (_label, candidate, reason) => {
    const { rejected } = validateCorrections(span, [candidate])
    expect(rejected[0]?.reason).toBe(reason)
  })

  it('overlap', () => {
    // Le premier candidat de l'empan (`i: 0, merge: 2`) est accepté et
    // marque les deux index comme pris ; le second, sur le seul index 0,
    // recouvre et est rejeté — avant même que sa propre valeur soit jugée.
    const { accepted, rejected } = validateCorrections(span, [
      { i: 0, merge: 2, w: 'undeux' },
      { i: 0, w: 'un' },
    ])
    expect(accepted).toEqual([{ from: 0, to: 1, original: ['un', 'deux'], replacement: 'undeux' }])
    expect(rejected).toEqual([{ candidate: { i: 0, w: 'un' }, reason: 'overlap' }])
  })
})
