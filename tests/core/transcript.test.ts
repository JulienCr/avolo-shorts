import { describe, it, expect } from 'vitest'
// `Word` est un type, et il sert plus bas à typer les fixtures de `snapToWords` :
// sans cet import, `pnpm type-check` échoue sur « Cannot find name 'Word' ».
import {
  anchor,
  buildWindows,
  clipCountTargets,
  shortlistSize,
  snapToWords,
  windowTextWithAnchors,
  type Transcript,
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
    const marker = parseFloat(windowTextWithAnchors(w, tx).slice(1, 7))
    const words = [word('last', 28.0, 29.0), word('next', 30.56, 31.2)]

    const [, tronque] = snapToWords(10.0, marker, words, 100)
    expect(tronque).toBeLessThan(30.56)

    // Le contrôle négatif : 30,56 arrondi au dixième donne 30,6, qui tombe
    // APRÈS le début du mot. La borne se lit alors comme de la parole et le clip
    // garde le mot qu'il voulait exclure.
    const [, arrondi] = snapToWords(10.0, 30.6, words, 100)
    expect(arrondi).toBeGreaterThan(31.2)
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
    const bornes = new Set([0, 40, 80, 100, 150])
    for (const w of buildWindows(tx4, 150)) {
      expect(bornes.has(w.start)).toBe(true)
      expect(bornes.has(w.end)).toBe(true)
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
      const attendu = tx.segments.slice(w.segFrom, w.segTo + 1).map((s) => s.text).join(' ')
      expect(w.text).toBe(attendu)
    }
    expect(ws[0].id).toBe('window_001')
  })
})

describe('shortlistSize', () => {
  it('30 % des fenêtres, plancher 10, plafond 24, minimum absolu 3', () => {
    expect(shortlistSize(2)).toBe(2)
    expect(shortlistSize(20)).toBe(10)
    expect(shortlistSize(100)).toBe(24)
  })

  it('ne retient jamais plus de fenêtres qu il n en existe', () => {
    for (let n = 1; n < 40; n++) expect(shortlistSize(n)).toBeLessThanOrEqual(n)
  })

  it('les vidéos courtes prennent le plancher plat de dix', () => {
    expect(shortlistSize(13)).toBe(10)
  })

  it('les longues suivent la matière, jusqu au plafond', () => {
    // ~79 fenêtres, c'est une source de deux heures : 30 % d'entre elles.
    expect(shortlistSize(79)).toBe(24)
    expect(shortlistSize(200)).toBe(24)
  })

  it('une entrée dégénérée ne casse rien', () => {
    expect(shortlistSize(0)).toBe(1)
    expect(shortlistSize(-5)).toBe(1)
    expect(shortlistSize(NaN)).toBe(1)
  })

  // La forme réduite doit valoir la formule complète du plan sur tout le
  // domaine, pas seulement sur les trois valeurs citées.
  it('vaut la formule du plan sur tout le domaine', () => {
    const duPlan = (n: number) =>
      Math.min(n, Math.max(3, Math.min(Math.max(10, Math.min(24, Math.round(n * 0.3))), n)))
    for (let n = 1; n <= 300; n++) expect(shortlistSize(n)).toBe(duPlan(n))
  })

  // Le test ci-dessus emploie `Math.round` des deux côtés : il ne peut donc pas
  // voir l'écart avec le `round` de Python, qui arrondit les demis vers le pair.
  // Ces trois valeurs sont les seules où l'écart survit au plancher de 10 et au
  // plafond de 24. Il est délibéré ; on l'épingle pour qu'il reste une décision.
  it('arrondit les demis vers le haut, pas vers le pair comme Python', () => {
    // Python rendrait respectivement 10, 16 et 22.
    expect(shortlistSize(35)).toBe(11)
    expect(shortlistSize(55)).toBe(17)
    expect(shortlistSize(75)).toBe(23)

    // Et nulle part ailleurs : partout ailleurs les deux arrondis coïncident,
    // ou bien le plancher et le plafond effacent leur différence.
    const roundHalfToEven = (x: number) => {
      const arrondi = Math.round(x)
      return Math.abs(x % 1) === 0.5 && arrondi % 2 !== 0 ? arrondi - 1 : arrondi
    }
    const commePython = (n: number) =>
      Math.min(n, Math.max(10, Math.min(24, roundHalfToEven(n * 0.3))))
    const ecarts = []
    for (let n = 1; n <= 300; n++) {
      if (shortlistSize(n) !== commePython(n)) ecarts.push(n)
    }
    expect(ecarts).toEqual([35, 55, 75])
  })
})

describe('clipCountTargets', () => {
  // Le plancher est tout l'intérêt : en production, le mode était UN clip, et
  // les utilisateurs qui en recevaient 1 à 3 revenaient 0,4 % du temps contre
  // 16 % pour ceux qui en recevaient 4 à 9.
  it('le plancher sort de la zone morte dès qu il y a de la matière', () => {
    for (const n of [4, 5, 6, 8, 10]) {
      const [low, high] = clipCountTargets(n)
      expect(low).toBeGreaterThanOrEqual(4)
      expect(high).toBeGreaterThanOrEqual(low)
    }
  })

  it('les toutes petites présélections restent modestes', () => {
    expect(clipCountTargets(1)[0]).toBeLessThanOrEqual(2)
    expect(clipCountTargets(2)[0]).toBeLessThanOrEqual(3)
  })

  it('le plafond est borné, pour que les longues vidéos n explosent pas', () => {
    expect(clipCountTargets(40)).toEqual(clipCountTargets(12))
    expect(clipCountTargets(40)[1]).toBeLessThanOrEqual(12)
  })

  it('le plancher ne dépasse jamais le plafond', () => {
    for (let n = 1; n < 40; n++) {
      const [low, high] = clipCountTargets(n)
      expect(low).toBeLessThanOrEqual(high)
    }
  })

  it('une entrée dégénérée ne casse rien', () => {
    expect(clipCountTargets(0)[0]).toBeGreaterThanOrEqual(1)
    expect(clipCountTargets(NaN)[0]).toBeGreaterThanOrEqual(1)
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
    const contigus = Array.from({ length: 40 }, (_, i) => word(`w${i}`, i, i + 1))
    const [s, e] = snapToWords(0, 5, contigus, 100)
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

  const chaque2s = () => Array.from({ length: 40 }, (_, i) => word(`w${i}`, i * 2, i * 2 + 1.6))

  it('recule dans le silence qui précède le mot, de la moitié du trou', () => {
    // Trou de 0,4 s avant le mot à 10,0 : le rembourrage vaut 0,2, pas 0,35.
    const [s, e] = snapToWords(10.3, 30.1, chaque2s(), 80)
    expect(s).toBe(9.8)
    expect(e).toBe(29.8)
  })

  const avecTrou = (from: number, to: number, until = 80) =>
    Array.from({ length: until }, (_, i) => i)
      .filter((i) => !(from <= i && i < to))
      .map((i) => word(`w${i}`, i, i + 0.8))

  it('une borne de début tombée dans un silence avance vers la parole', () => {
    // Le trou est plus large que 2 × maxLead : le rembourrage prend son plafond.
    const [s, e] = snapToWords(15, 45, avecTrou(10, 20, 60), 80)
    expect(s).toBe(19.65)
    expect(e).toBe(44.9)
  })

  it('une borne de fin tombée dans un silence recule vers la parole', () => {
    const [s, e] = snapToWords(10, 35, avecTrou(30, 40), 80)
    expect(s).toBe(9.9)
    expect(e).toBe(30.25)
  })

  it('au-delà du saut de silence maximal, la borne brute est conservée', () => {
    // 45 s de silence : l'horodatage n'est pas « un peu dans une pause », il est
    // faux, et déplacer la borne jusque-là changerait ce que contient le clip.
    expect(snapToWords(15, 35, avecTrou(10, 60), 80)).toEqual([15, 35])
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
  const imbriques = () => [word('looong', 10, 20), word('in', 15, 16), word('after', 40, 41)]

  it('une borne masquée par un mot court reste de la parole', () => {
    const [, e] = snapToWords(0.5, 19, imbriques(), 100)
    expect(e).toBeGreaterThan(20)
  })

  it('la fin ne tombe jamais sur une frontière enterrée dans un autre mot', () => {
    const [, e] = snapToWords(0.5, 17, imbriques(), 100)
    expect(e).toBeGreaterThan(20)
  })

  it('le début non plus', () => {
    const [s] = snapToWords(17, 40.5, imbriques(), 100)
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
    const duree = 99.9995
    const w = [word('fin', 98, duree)]
    const [, e] = snapToWords(90, duree, w, duree)
    expect(e).toBeLessThanOrEqual(duree)
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
