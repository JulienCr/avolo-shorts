import { describe, it, expect } from 'vitest'
// `Word` est un type, et il sert plus bas à typer les fixtures de `snapToWords` :
// sans cet import, `pnpm type-check` échoue sur « Cannot find name 'Word' ».
import {
  anchor,
  buildWindows,
  clipCountTargets,
  DEFAULT_SELECTION_DIMENSIONS,
  mergeOverlappingWindows,
  speechSeconds,
  shortlistSize,
  snapToWords,
  usableSegments,
  windowTextWithAnchors,
  wholeTranscriptWithAnchors,
  type Transcript,
  type Window,
  type Word,
} from '@/core/transcript'

/** Un segment de transcript, sans les mots quand le test ne les regarde pas. */
function seg(start: number, end: number, text: string, words: Word[] = []) {
  return { start, end, text, words }
}

/** Un mot, dans l'ordre `(texte, début, fin)` du fichier source d'openshorts. */
function word(w: string, s: number, e: number): Word {
  return { word: w, start: s, end: e }
}

describe('anchor', () => {
  it('tronque, jamais n arrondit', () => {
    expect(anchor(30.5678)).toBe('[30.567]')
    expect(anchor(30.5699)).toBe('[30.569]')
  })

  it("l'ancre ne tombe jamais après le vrai début", () => {
    for (const t of [0.0009, 1.9999, 123.4567, 3599.9999]) {
      const parsed = parseFloat(anchor(t).slice(1, -1))
      expect(parsed).toBeLessThanOrEqual(t)
    }
  })

  // La propriété, pas l'exemple. Une ancre en retard de 0,4 ms déclenche le même
  // défaut qu'une ancre en retard de 40 ms : seul le signe compte. On la vérifie
  // donc sur un balayage large, y compris sur les valeurs qui tombent pile sur
  // une frontière de milliseconde — celles où un arrondi et une troncature
  // divergent.
  it('la propriété tient sur un balayage, pas seulement sur deux exemples', () => {
    for (let i = 0; i < 4000; i++) {
      const t = i * 0.7913 // pas irrationnel-ish : balaie toutes les décimales
      expect(parseFloat(anchor(t).slice(1, -1))).toBeLessThanOrEqual(t)
    }
    for (const t of [0.0005, 0.9995, 1.5, 30.56, 30.5, 99.9999, 1234.5675]) {
      expect(parseFloat(anchor(t).slice(1, -1))).toBeLessThanOrEqual(t)
    }
  })

  it('émet toujours le nombre de décimales demandé', () => {
    expect(anchor(12.34)).toBe('[12.340]')
    expect(anchor(0)).toBe('[0.000]')
    expect(anchor(15)).toBe('[15.000]')
    expect(anchor(30.5678, 1)).toBe('[30.5]')
  })
})

describe('windowTextWithAnchors', () => {
  it('pose un marqueur par segment, devant sa prose', () => {
    const tx: Transcript = { segments: [seg(12.34, 15, 'hello'), seg(15, 20, 'world')] }
    const w = { id: 'window_001', start: 12.34, end: 20, text: 'hello world', segFrom: 0, segTo: 1 }
    expect(windowTextWithAnchors(w, tx)).toBe('[12.340] hello [15.000] world')
  })

  it('les marqueurs ne tombent jamais après le vrai début du segment', () => {
    const starts = [30.56, 99.9999]
    const tx: Transcript = { segments: [seg(30.56, 31.2, 'next'), seg(99.9999, 100.5, 'later')] }
    const w = { id: 'window_001', start: 30.56, end: 100.5, text: '', segFrom: 0, segTo: 1 }
    const markers = [...windowTextWithAnchors(w, tx).matchAll(/\[([\d.]+)\]/g)]
    expect(markers).toHaveLength(2)
    markers.forEach((m, i) => expect(parseFloat(m[1])).toBeLessThanOrEqual(starts[i]))
  })

  // Le test qui compte : de bout en bout, le marqueur émis ici puis rendu tel
  // quel par le modèle ne doit pas étendre le clip jusque dans le mot qu'il
  // désigne. C'est tout le raisonnement de la troncature, vérifié contre son
  // contraire.
  it('un marqueur tronqué se lit comme un trou ; arrondi, il avale le mot suivant', () => {
    const tx: Transcript = { segments: [seg(30.56, 31.2, 'next')] }
    const w = { id: 'window_001', start: 30.56, end: 31.2, text: 'next', segFrom: 0, segTo: 0 }
    // Le marqueur se lit par motif, jamais par découpe à position fixe : un
    // `slice(1, 7)` code en dur une ancre de sept caractères et rendrait
    // `123.45` pour un début de segment à trois chiffres.
    const marker = parseFloat(windowTextWithAnchors(w, tx).match(/\[([\d.]+)\]/)![1])
    const words = [word('last', 28.0, 29.0), word('next', 30.56, 31.2)]

    const [, truncated] = snapToWords(10.0, marker, words, 100)
    expect(truncated).toBeLessThan(30.56)

    // Le contrôle négatif : 30,56 arrondi au dixième donne 30,6, qui tombe
    // APRÈS le début du mot. La borne se lit alors comme de la parole et le clip
    // garde le mot qu'il voulait exclure.
    const [, rounded] = snapToWords(10.0, 30.6, words, 100)
    expect(rounded).toBeGreaterThan(31.2)
  })

  it("la fenêtre de repli, sans segments, reçoit quand même un marqueur légal", () => {
    // Le prompt interdit un horodatage qui ne vient pas d'un marqueur : lui en
    // livrer zéro serait pire qu'une ancre grossière.
    const w = { id: 'window_001', start: 0, end: 120, text: 'tout le transcript', segFrom: 0, segTo: -1 }
    expect(windowTextWithAnchors(w, { segments: [] })).toBe('[0.000] tout le transcript')
  })

  // `segFrom`/`segTo` indexent les segments *utilisables* — ceux dont le texte
  // n'est pas vide. `buildWindows` et cette fonction doivent en dériver la même
  // liste, sinon les index désignent deux choses différentes et la prose
  // ressort décalée d'un cran.
  it('les index survivent à un segment vide dans le transcript', () => {
    const tx: Transcript = {
      segments: [seg(0, 5, 'un'), seg(5, 6, '   '), seg(6, 10, 'deux'), seg(10, 15, 'trois')],
    }
    const windows = buildWindows(tx, 15)
    expect(windowTextWithAnchors(windows[0], tx)).toBe('[0.000] un [6.000] deux [10.000] trois')
  })
})

describe('wholeTranscriptWithAnchors', () => {
  const tx: Transcript = {
    segments: [seg(0, 5, 'un'), seg(5, 10, 'deux'), seg(10, 15, 'trois'), seg(15, 20, 'quatre')],
  }

  it('sans rien de pris, anchore chaque segment comme windowTextWithAnchors', () => {
    const text = wholeTranscriptWithAnchors(usableSegments(tx), [])
    expect(text).toBe('[0.000] un [5.000] deux [10.000] trois [15.000] quatre')
  })

  it('entoure un segment pris de [PRIS] … [/PRIS]', () => {
    const text = wholeTranscriptWithAnchors(usableSegments(tx), [{ start: 5, end: 10 }])
    expect(text).toBe('[0.000] un [PRIS] [5.000] deux [/PRIS] [10.000] trois [15.000] quatre')
  })

  // The contract's rule: two consecutive taken segments form ONE block,
  // never one [PRIS] per segment — a wall of alternating tags would bury
  // the prose they annotate.
  it('fusionne deux segments pris adjacents en un seul bloc', () => {
    const text = wholeTranscriptWithAnchors(usableSegments(tx), [{ start: 5, end: 15 }])
    expect(text).toBe('[0.000] un [PRIS] [5.000] deux [10.000] trois [/PRIS] [15.000] quatre')
    expect(text.match(/\[PRIS\]/g)).toHaveLength(1)
  })

  // Marking addresses a whole segment, never a word in the middle: the
  // anchor names a segment, and a mid-segment cut would point the model at
  // a time that addresses nothing.
  it("un chevauchement partiel prend le segment en entier, jamais la moitié", () => {
    const text = wholeTranscriptWithAnchors(usableSegments(tx), [{ start: 7, end: 8 }])
    expect(text).toBe('[0.000] un [PRIS] [5.000] deux [/PRIS] [10.000] trois [15.000] quatre')
  })

  it('un transcript entièrement pris ne rend qu’un seul bloc', () => {
    const text = wholeTranscriptWithAnchors(usableSegments(tx), [{ start: 0, end: 20 }])
    expect(text).toBe('[PRIS] [0.000] un [5.000] deux [10.000] trois [15.000] quatre [/PRIS]')
  })

  it('accepte une tranche partielle, pour la descente sur refus de contenu', () => {
    const all = usableSegments(tx)
    const text = wholeTranscriptWithAnchors(all.slice(0, 2), [])
    expect(text).toBe('[0.000] un [5.000] deux')
  })
})

describe('buildWindows', () => {
  const tx: Transcript = {
    segments: Array.from({ length: 40 }, (_, i) => seg(i * 10, i * 10 + 9, `phrase ${i}`)),
  }

  it('cale les fenêtres sur les frontières de segments, autour de 90 s', () => {
    const ws = buildWindows(tx, 400)
    expect(ws.length).toBeGreaterThan(1)
    for (const w of ws) expect(w.end - w.start).toBeLessThanOrEqual(90 * 1.25)
    for (const w of ws) expect(tx.segments.some((s) => s.start === w.start)).toBe(true)
  })

  it('avance toujours, même sur des segments plus longs que la fenêtre', () => {
    const long: Transcript = { segments: [seg(0, 200, 'a'), seg(200, 400, 'b')] }
    expect(buildWindows(long, 400).length).toBe(2)
  })

  it('les deux bornes tombent sur une frontière de segment', () => {
    const tx4: Transcript = {
      segments: [seg(0, 40, 'a'), seg(40, 80, 'b'), seg(80, 100, 'c'), seg(100, 150, 'd')],
    }
    const bounds = new Set([0, 40, 80, 100, 150])
    for (const w of buildWindows(tx4, 150)) {
      expect(bounds.has(w.start)).toBe(true)
      expect(bounds.has(w.end)).toBe(true)
    }
  })

  it('les fenêtres se chevauchent et couvrent le transcript jusqu au bout', () => {
    const dense: Transcript = {
      segments: Array.from({ length: 30 }, (_, i) => seg(i * 10, (i + 1) * 10, `s${i}`)),
    }
    const ws = buildWindows(dense, 300)
    expect(ws.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < ws.length; i++) expect(ws[i].start).toBeLessThan(ws[i - 1].end)
    expect(ws[ws.length - 1].end).toBe(300)
  })

  it('un segment unique plus long que la fenêtre ne boucle pas à l infini', () => {
    expect(buildWindows({ segments: [seg(0, 500, 'monologue')] }, 500)).toHaveLength(1)
  })

  it('un transcript vide se replie sur la vidéo entière', () => {
    const ws = buildWindows({ segments: [] }, 120)
    expect(ws).toHaveLength(1)
    expect(ws[0].start).toBe(0)
    expect(ws[0].end).toBe(120)
    // Une étendue vide, et non un index qui pointerait sur un segment absent.
    expect(ws[0].segTo).toBeLessThan(ws[0].segFrom)
  })

  it("porte le texte des segments qu'elle couvre, et son étendue", () => {
    const ws = buildWindows(tx, 400)
    for (const w of ws) {
      const expected = tx.segments.slice(w.segFrom, w.segTo + 1).map((s) => s.text).join(' ')
      expect(w.text).toBe(expected)
    }
    expect(ws[0].id).toBe('window_001')
  })
})

describe('mergeOverlappingWindows', () => {
  const tx: Transcript = {
    segments: [seg(0, 5, 'A'), seg(10, 15, 'B'), seg(20, 25, 'C'), seg(30, 35, 'D')],
  }
  const w = (id: string, start: number, end: number, segFrom: number, segTo: number): Window => ({
    id,
    start,
    end,
    text: tx.segments.slice(segFrom, segTo + 1).map((s) => s.text).join(' '),
    segFrom,
    segTo,
  })

  it('fusionne deux fenêtres qui se chevauchent, et la prose commune ne sort qu’une fois', () => {
    const out = mergeOverlappingWindows([w('window_001', 0, 15, 0, 1), w('window_002', 10, 25, 1, 2)], tx)
    expect(out).toHaveLength(1)
    expect(out[0].start).toBe(0)
    expect(out[0].end).toBe(25)
    expect(out[0].segFrom).toBe(0)
    expect(out[0].segTo).toBe(2)
    // « B » est dans les deux fenêtres. Recoller les deux `text` le donnerait
    // deux fois au modèle, sous une consigne qui lui demande de travailler
    // chaque fenêtre : deux clips sur le même moment en sont le résultat.
    expect(out[0].text).toBe('A B C')
  })

  it('le bloc survivant garde l’identifiant de la première fenêtre', () => {
    const out = mergeOverlappingWindows([w('window_002', 10, 25, 1, 2), w('window_001', 0, 15, 0, 1)], tx)
    expect(out[0].id).toBe('window_001')
  })

  it('trie chronologiquement avant de fusionner', () => {
    const out = mergeOverlappingWindows(
      [w('window_003', 30, 35, 3, 3), w('window_001', 0, 5, 0, 0)],
      tx,
    )
    expect(out.map((x) => x.start)).toEqual([0, 30])
  })

  it('laisse intactes deux fenêtres disjointes', () => {
    const out = mergeOverlappingWindows([w('a', 0, 5, 0, 0), w('b', 20, 25, 2, 2)], tx)
    expect(out).toHaveLength(2)
    expect(out.map((x) => x.text)).toEqual(['A', 'C'])
  })

  it('deux fenêtres qui se touchent exactement fusionnent', () => {
    const out = mergeOverlappingWindows([w('a', 0, 15, 0, 1), w('b', 15, 25, 2, 2)], tx)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('A B C')
  })

  it('une fenêtre entièrement contenue ne raccourcit pas la précédente', () => {
    const out = mergeOverlappingWindows([w('a', 0, 25, 0, 2), w('b', 10, 15, 1, 1)], tx)
    expect(out).toHaveLength(1)
    expect(out[0].end).toBe(25)
    expect(out[0].segTo).toBe(2)
  })

  it('ne modifie ni les fenêtres reçues ni leur tableau', () => {
    const entry = [w('window_001', 0, 15, 0, 1), w('window_002', 10, 25, 1, 2)]
    const copy = structuredClone(entry)
    mergeOverlappingWindows(entry, tx)
    expect(entry).toEqual(copy)
  })

  it('une entrée vide rend une liste vide', () => {
    expect(mergeOverlappingWindows([], tx)).toEqual([])
  })

  it('la fenêtre de repli du transcript vide traverse sans casser', () => {
    const fallback = buildWindows({ segments: [] }, 120)
    const out = mergeOverlappingWindows(fallback, { segments: [] })
    expect(out).toHaveLength(1)
    expect(out[0].segTo).toBeLessThan(out[0].segFrom)
    expect(out[0].end).toBe(120)
  })

  it('une fenêtre sans étendue ne fait pas perdre la prose de sa voisine', () => {
    const withoutExtent: Window = { id: 'vide', start: 5, end: 20, text: '', segFrom: 0, segTo: -1 }
    const out = mergeOverlappingWindows([w('a', 0, 15, 0, 1), withoutExtent], tx)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('A B')
    expect(out[0].end).toBe(20)
  })
})

// Les deux émissions du dépôt, mesurées le 18 août 2026 : union des segments qui
// portent de la prose, et nombre de fenêtres réellement construites. Ce sont
// elles qui ancrent les attentes ci-dessous — pas des durées rondes.
//
// Ces durées ne sont **pas** l'écart du premier mot au dernier, qui vaut 5755,5 s
// et 6642,3 s : voir `speechSeconds`, l'écart surestime de 21 %.
const CQLP = { parole: 4635.3, fenêtres: 83 }
const BETWEEN_US = { parole: 5244.5, fenêtres: 95 }
const min = (m: number) => m * 60

describe('speechSeconds', () => {
  // La raison d'être de cette fonction : l'écart du premier au dernier mot
  // compte le silence du milieu, et sur les deux émissions du dépôt cela
  // surestime de 21 %. (relevé par Codex)
  it('ne compte pas le silence entre deux prises de parole', () => {
    const tx = {
      segments: [seg(0, 30, 'avant'), seg(3630, 3660, 'après')],
    }
    expect(speechSeconds(tx)).toBe(60)
    // L'écart, lui, en compterait 3660.
  })

  it('fusionne deux segments qui se chevauchent au lieu de les additionner', () => {
    const tx = { segments: [seg(0, 40, 'un'), seg(30, 60, 'deux')] }
    expect(speechSeconds(tx)).toBe(60)
  })

  // `buildWindows` écarte déjà les segments sans prose — WhisperX en émet sur
  // les silences —, et cette fonction doit voir la même matière que lui.
  it('ignore les segments sans prose, comme le fenêtrage', () => {
    const tx = { segments: [seg(0, 30, 'un'), seg(30, 90, '   '), seg(90, 120, 'deux')] }
    expect(speechSeconds(tx)).toBe(60)
  })

  it('rend zéro sur un transcript vide', () => {
    expect(speechSeconds({ segments: [] })).toBe(0)
  })
})

describe('clipCountTargets', () => {
  // Le plancher est tout l'intérêt : mesuré en production, le modèle rend le
  // minimum qu'on lui donne. Les utilisateurs qui recevaient 1 à 3 clips
  // revenaient 0,4 % du temps contre 16 % pour ceux qui en recevaient 4 à 9.
  it('suit la durée de parole, un clip toutes les six minutes par défaut', () => {
    expect(clipCountTargets(CQLP.parole, DEFAULT_SELECTION_DIMENSIONS)[0]).toBe(13)
    expect(clipCountTargets(BETWEEN_US.parole, DEFAULT_SELECTION_DIMENSIONS)[0]).toBe(15)
    expect(clipCountTargets(min(180), DEFAULT_SELECTION_DIMENSIONS)[0]).toBe(30)
  })

  // Le défaut qui a motivé tout ce changement : la cible était `[6, 12]` pour
  // toute source de plus de dix minutes, capsule comme live de deux heures.
  it('ne sature plus : deux durées différentes donnent deux cibles différentes', () => {
    const court = clipCountTargets(min(30), DEFAULT_SELECTION_DIMENSIONS)
    const long = clipCountTargets(min(120), DEFAULT_SELECTION_DIMENSIONS)
    expect(long[0]).toBeGreaterThan(court[0])
    expect(long[1]).toBeGreaterThan(court[1])
  })

  it('le plancher absolu tient les sources courtes hors de la zone morte', () => {
    // Un quart d'heure de parole ne vaut que trois clips au prorata, une
    // demi-heure cinq : `minimumClips` prend le relais, et c'est la mesure de
    // rétention qui le justifie.
    expect(clipCountTargets(min(15), DEFAULT_SELECTION_DIMENSIONS)[0]).toBe(6)
    expect(clipCountTargets(min(30), DEFAULT_SELECTION_DIMENSIONS)[0]).toBe(6)
    // Au-delà, le prorata reprend la main.
    expect(clipCountTargets(min(45), DEFAULT_SELECTION_DIMENSIONS)[0]).toBe(8)
  })

  it('les créneaux tiennent les sources trop courtes pour ce plancher', () => {
    // 90 secondes ne portent qu'un créneau : six clips n'auraient aucun support.
    expect(clipCountTargets(90, DEFAULT_SELECTION_DIMENSIONS)[0]).toBe(1)
    expect(clipCountTargets(min(5), DEFAULT_SELECTION_DIMENSIONS)[0]).toBe(3)
  })

  // Ne plafonner que le plancher laissait le plafond repartir au-dessus : un
  // maximum de 10 rendait `[10, 15]`, et le prompt autorisait toujours quinze
  // clips. Le tuple entier est vérifié, pas seulement sa première borne.
  // (relevé par Codex et Copilot)
  it('maximumClips borne les deux bornes, et zéro veut dire aucune', () => {
    const bound = { ...DEFAULT_SELECTION_DIMENSIONS, maximumClips: 10 }
    expect(clipCountTargets(BETWEEN_US.parole, bound)).toEqual([10, 10])
    expect(clipCountTargets(BETWEEN_US.parole, DEFAULT_SELECTION_DIMENSIONS)).toEqual([15, 23])
    // Le plafond ne descend jamais sous le plancher, quel que soit le maximum.
    for (let max = 1; max <= 40; max++) {
      const [bottom, top] = clipCountTargets(BETWEEN_US.parole, {
        ...DEFAULT_SELECTION_DIMENSIONS,
        maximumClips: max,
      })
      expect(bottom).toBeLessThanOrEqual(top)
      expect(top).toBeLessThanOrEqual(max)
    }
  })

  it('le rendement se règle', () => {
    const dense = { ...DEFAULT_SELECTION_DIMENSIONS, minutesPerClip: 4 }
    const sober = { ...DEFAULT_SELECTION_DIMENSIONS, minutesPerClip: 12 }
    expect(clipCountTargets(BETWEEN_US.parole, dense)[0]).toBe(22)
    expect(clipCountTargets(BETWEEN_US.parole, sober)[0]).toBe(7)
  })

  it('le plancher ne dépasse jamais le plafond', () => {
    for (let m = 0; m <= 240; m += 3) {
      const [bottom, top] = clipCountTargets(min(m), DEFAULT_SELECTION_DIMENSIONS)
      expect(bottom).toBeLessThanOrEqual(top)
    }
  })

  it('une entrée dégénérée ne casse rien', () => {
    for (const speech of [0, -5, NaN, Infinity]) {
      const [bottom, top] = clipCountTargets(speech, DEFAULT_SELECTION_DIMENSIONS)
      expect(bottom).toBeGreaterThanOrEqual(1)
      expect(top).toBeGreaterThanOrEqual(bottom)
    }
  })

  it('un réglage absurde ne divise pas par zéro', () => {
    const broken = { ...DEFAULT_SELECTION_DIMENSIONS, minutesPerClip: 0 }
    const [bottom, top] = clipCountTargets(BETWEEN_US.parole, broken)
    expect(Number.isFinite(bottom)).toBe(true)
    expect(top).toBeGreaterThanOrEqual(bottom)
  })
})

describe('shortlistSize', () => {
  it('suit le plancher de clips, à raison de deux fenêtres par clip', () => {
    expect(shortlistSize(CQLP.parole, CQLP.fenêtres, DEFAULT_SELECTION_DIMENSIONS)).toBe(26)
    expect(shortlistSize(BETWEEN_US.parole, BETWEEN_US.fenêtres, DEFAULT_SELECTION_DIMENSIONS)).toBe(30)
  })

  // Le plafond plat de 24 est retiré : c'est lui qui faisait examiner un quart
  // de la matière d'un 1 h 51 et la même chose d'un trois heures.
  it('ne sature plus au-delà de deux heures', () => {
    const threeHours = shortlistSize(min(180), 154, DEFAULT_SELECTION_DIMENSIONS)
    expect(threeHours).toBe(60)
    expect(threeHours).toBeGreaterThan(
      shortlistSize(BETWEEN_US.parole, BETWEEN_US.fenêtres, DEFAULT_SELECTION_DIMENSIONS),
    )
  })

  it('ne retient jamais plus de fenêtres qu il n en existe', () => {
    for (let m = 0; m <= 240; m += 3) {
      // Une fenêtre tous les ~70 s, mesuré sur les deux émissions.
      const windows = Math.max(1, Math.round(min(m) / 70))
      expect(shortlistSize(min(m), windows, DEFAULT_SELECTION_DIMENSIONS)).toBeLessThanOrEqual(windows)
    }
  })

  // Le plancher de dix ne mord que sous le produit `minimumClips ×
  // windowsPerClip`, qui vaut douze : le nommer « plancher de dix » figerait
  // une règle que la fonction n'applique pas. (relevé par Copilot)
  it('les sources courtes suivent le plancher de clips, pas minimumWindows', () => {
    expect(shortlistSize(min(15), 13, DEFAULT_SELECTION_DIMENSIONS)).toBe(12)
    // Moins de fenêtres que le plancher : c'est le réel qui gagne.
    expect(shortlistSize(min(15), 4, DEFAULT_SELECTION_DIMENSIONS)).toBe(4)
  })

  it('minimumWindows reprend la main quand le produit descend sous lui', () => {
    const narrow = { ...DEFAULT_SELECTION_DIMENSIONS, windowsPerClip: 1 }
    // Six clips à une fenêtre chacun ne feraient que six fenêtres examinées.
    expect(shortlistSize(min(15), 13, narrow)).toBe(10)
  })

  it('windowsPerClip règle la largeur de l examen', () => {
    const wide = { ...DEFAULT_SELECTION_DIMENSIONS, windowsPerClip: 4 }
    expect(shortlistSize(BETWEEN_US.parole, BETWEEN_US.fenêtres, wide)).toBe(60)
  })

  it('une entrée dégénérée ne casse rien', () => {
    expect(shortlistSize(0, 0, DEFAULT_SELECTION_DIMENSIONS)).toBe(1)
    expect(shortlistSize(NaN, -5, DEFAULT_SELECTION_DIMENSIONS)).toBe(1)
    expect(shortlistSize(min(120), NaN, DEFAULT_SELECTION_DIMENSIONS)).toBe(1)
  })

  // L'invariant qui compte pour la suite : la présélection doit toujours offrir
  // au modèle au moins autant de fenêtres qu'on lui demande de clips, sans quoi
  // la cible serait irréalisable par construction.
  it('offre toujours au moins autant de fenêtres que de clips demandés', () => {
    for (let m = 3; m <= 240; m += 3) {
      const windows = Math.max(1, Math.round(min(m) / 70))
      const kept = shortlistSize(min(m), windows, DEFAULT_SELECTION_DIMENSIONS)
      const [floor] = clipCountTargets(min(m), DEFAULT_SELECTION_DIMENSIONS)
      expect(kept).toBeGreaterThanOrEqual(Math.min(floor, windows))
    }
  })
})

describe('snapToWords', () => {
  const words: Word[] = [
    { word: 'un', start: 10.0, end: 10.4 },
    { word: 'deux', start: 10.5, end: 11.0 },
    { word: 'trois', start: 90.0, end: 90.6 },
  ]

  it('cale les bornes sur des frontières de mots', () => {
    const [s, e] = snapToWords(10.2, 90.3, words, 200)
    expect(s).toBeLessThanOrEqual(10.0)
    expect(e).toBeGreaterThanOrEqual(90.6)
  })

  it("ne plafonne plus à 60 secondes — c'est le bug qu'on répare", () => {
    const [s, e] = snapToWords(10.0, 90.6, words, 200)
    expect(e - s).toBeGreaterThan(60)
  })

  // Le pendant du précédent : aucun plancher non plus. La durée est un
  // résultat ; openshorts étirait cette paire jusqu'à 15 s en allant chercher
  // une fin de mot dix secondes plus loin.
  it('ne rallonge plus jusqu à 15 secondes non plus', () => {
    const contiguous = Array.from({ length: 40 }, (_, i) => word(`w${i}`, i, i + 1))
    const [s, e] = snapToWords(0, 5, contiguous, 100)
    expect(e - s).toBeCloseTo(5, 3)
    // Et le rembourrage ne mord pas sur la parole contiguë : aucune place.
    expect(e).toBe(5)
  })

  it('sans mot, la borne d origine est rendue telle quelle', () => {
    expect(snapToWords(5, 25, [], 100)).toEqual([5, 25])
  })

  it('sans mot à portée, la borne d origine est rendue telle quelle', () => {
    expect(snapToWords(10, 40, [word('loin', 200, 201)], 300)).toEqual([10, 40])
  })

  const each2S = () => Array.from({ length: 40 }, (_, i) => word(`w${i}`, i * 2, i * 2 + 1.6))

  it('recule dans le silence qui précède le mot, de la moitié du trou', () => {
    // Trou de 0,4 s avant le mot à 10,0 : le rembourrage vaut 0,2, pas 0,35.
    const [s, e] = snapToWords(10.3, 30.1, each2S(), 80)
    expect(s).toBe(9.8)
    expect(e).toBe(29.8)
  })

  const withGap = (from: number, to: number, until = 80) =>
    Array.from({ length: until }, (_, i) => i)
      .filter((i) => !(from <= i && i < to))
      .map((i) => word(`w${i}`, i, i + 0.8))

  it('une borne de début tombée dans un silence avance vers la parole', () => {
    // Le trou est plus large que 2 × maxLead : le rembourrage prend son plafond.
    const [s, e] = snapToWords(15, 45, withGap(10, 20, 60), 80)
    expect(s).toBe(19.65)
    expect(e).toBe(44.9)
  })

  it('une borne de fin tombée dans un silence recule vers la parole', () => {
    const [s, e] = snapToWords(10, 35, withGap(30, 40), 80)
    expect(s).toBe(9.9)
    expect(e).toBe(30.25)
  })

  it('au-delà du saut de silence maximal, la borne brute est conservée', () => {
    // 45 s de silence : l'horodatage n'est pas « un peu dans une pause », il est
    // faux, et déplacer la borne jusque-là changerait ce que contient le clip.
    expect(snapToWords(15, 35, withGap(10, 60), 80)).toEqual([15, 35])
  })

  it('une borne de début dans une courte pause ne recule pas sur la phrase d avant', () => {
    const w = [word('a', 10, 10.8), word('b', 12, 12.8), word('c', 30, 30.8), word('d', 32, 32.8)]
    const [s] = snapToWords(10.9, 32.5, w, 100)
    expect(s).toBe(11.65) // avancé jusqu'à 12,0, pas reculé sur 10,0
  })

  it('une fin posée sur un marqueur de phrase n avale pas le mot suivant', () => {
    // Le prompt de détail demande `end` au marqueur de la phrase APRÈS la
    // dernière voulue : la fin de mot la plus proche est donc souvent le premier
    // mot d'une phrase que le clip ne doit pas contenir.
    const w = [word('last', 28, 29), word('next', 30.5, 31.2)]
    const [, e] = snapToWords(10, 30.5, w, 100)
    expect(e).toBe(29.45)
  })

  // Les trois cas des mots imbriqués. Consulter le seul dernier mot commençant
  // avant la borne appelle « silence » un instant où l'on parle encore.
  const nested = () => [word('looong', 10, 20), word('in', 15, 16), word('after', 40, 41)]

  it('une borne masquée par un mot court reste de la parole', () => {
    const [, e] = snapToWords(0.5, 19, nested(), 100)
    expect(e).toBeGreaterThan(20)
  })

  it('la fin ne tombe jamais sur une frontière enterrée dans un autre mot', () => {
    const [, e] = snapToWords(0.5, 17, nested(), 100)
    expect(e).toBeGreaterThan(20)
  })

  it('le début non plus', () => {
    const [s] = snapToWords(17, 40.5, nested(), 100)
    expect(s).toBeLessThanOrEqual(10)
  })

  it('une borne qui cale garde son calage même si l autre échoue', () => {
    // openshorts rendait les deux bornes brutes dès que la réparation de durée
    // échouait, jetant un début pourtant correctement calé.
    const w = [...Array.from({ length: 20 }, (_, i) => i), ...Array.from({ length: 60 }, (_, i) => 100 + i)]
      .map((i) => word(`w${i}`, i, i + 0.8))
    const [s, e] = snapToWords(8, 25, w, 200)
    expect(s).toBe(7.9)
    // Sans plancher de durée, la fin recule jusqu'à la vraie parole (19,8 + la
    // moitié du trou, plafonnée à 0,45) au lieu de rester sur les 25,0 bruts que
    // rendait openshorts pour atteindre ses 15 secondes.
    expect(e).toBe(20.25)
  })

  it('ne dépasse jamais la durée de la vidéo', () => {
    const w = [word('fin', 98, 99.9)]
    const [, e] = snapToWords(90, 99.9, w, 100)
    expect(e).toBeLessThanOrEqual(100)
  })

  // La validation porte sur la paire ARRONDIE, celle qu'on rend, et non sur la
  // paire brute : contrôler l'une puis rendre l'autre laissait sortir une borne
  // hors média sur une durée fractionnaire. ffprobe rend six décimales, donc la
  // durée fractionnaire n'a rien d'un cas de laboratoire.
  it('une durée fractionnaire ne sort pas du média par l arrondi', () => {
    const duration = 99.9995
    const w = [word('fin', 98, duration)]
    const [, e] = snapToWords(90, duration, w, duration)
    expect(e).toBeLessThanOrEqual(duration)
  })

  // Le pendant dégénéré : deux bornes distantes de moins d'une demi-milliseconde
  // s'arrondissent sur la même valeur, ce qui rendrait une durée nulle après un
  // contrôle `fin > début` pourtant réussi.
  it('ne rend jamais une paire que l arrondi a écrasée sur un point', () => {
    // Les mots sont hors de portée : les deux bornes restent brutes et
    // atteignent la validation telles quelles. Arrondies, elles tombent toutes
    // deux sur 10,000 — la paire est donc refusée, et c'est l'entrée brute qui
    // ressort, plutôt qu'un clip de durée nulle.
    const [s, e] = snapToWords(9.9995, 10.0004, [word('loin', 200, 201)], 500)
    expect(e).toBeGreaterThan(s)
  })

  it("l'entrée brute ressort sans arrondi, donc sans erreur ajoutée", () => {
    expect(snapToWords(90, 99.9996, [], 99.9996)).toEqual([90, 99.9996])
  })
})
