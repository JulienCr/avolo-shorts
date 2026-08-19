import { describe, it, expect } from 'vitest'
// Trois modules distincts, et non un `@/core/captions/…` qui ne se résout pas :
// Vitest échouerait sur l'import avant d'exécuter le moindre test.
import { retimeWords } from '@/core/captions/retime'
import { splitIntoCards } from '@/core/captions/cards'
import { renderAss, DEFAULT_CAPTION_STYLE } from '@/core/captions/ass'

/** Les lignes d'événement d'un fichier ASS, dans l'ordre. */
function dialogues(ass: string): string[] {
  return ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
}

/**
 * Le champ `Text` d'un événement : le dixième, et le seul qui puisse contenir
 * des virgules — les balises de l'effet `pop` en portent deux.
 */
function textOf(dialogue: string): string {
  return dialogue.split(',').slice(9).join(',')
}

/** La ligne `Style: Default,…` du bloc `[V4+ Styles]`. */
function styleLine(ass: string): string {
  const line = ass.split('\n').find((l) => l.startsWith('Style: '))
  if (line === undefined) throw new Error("le fichier ASS n'a pas de ligne Style")
  return line
}

describe('retimeWords', () => {
  const segments = [
    { start: 100, end: 110 },
    { start: 200, end: 210 },
  ]

  it('replace les mots du premier segment à partir de zéro', () => {
    expect(retimeWords([{ word: 'a', start: 100, end: 100.5 }], segments)).toEqual([
      { word: 'a', start: 0, end: 0.5 },
    ])
  })

  it('décale les mots du second segment de la durée du premier, pas de son écart', () => {
    expect(retimeWords([{ word: 'b', start: 200, end: 200.5 }], segments)).toEqual([
      { word: 'b', start: 10, end: 10.5 },
    ])
  })

  it('jette les mots tombés dans une coupe interne', () => {
    expect(retimeWords([{ word: 'coupé', start: 150, end: 150.4 }], segments)).toEqual([])
  })

  it('conserve la continuité : aucun mot ne recule dans le temps', () => {
    const words = [
      { word: 'a', start: 100, end: 101 },
      { word: 'b', start: 109, end: 110 },
      { word: 'c', start: 200, end: 201 },
      { word: 'd', start: 209, end: 210 },
    ]
    const out = retimeWords(words, segments)
    for (let i = 1; i < out.length; i++)
      expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].start)
    expect(out[out.length - 1].end).toBeLessThanOrEqual(20)
  })

  it('rogne un mot à cheval sur une borne de segment', () => {
    const out = retimeWords([{ word: 'x', start: 109.5, end: 111.5 }], segments)
    expect(out[0].end).toBeLessThanOrEqual(10)
  })

  // Le contrôle qui distingue vraiment la bonne implémentation de la mauvaise :
  // boucler sur les mots à l'extérieur rendrait ici `a, b, d, c`, un karaoké qui
  // recule d'une seconde en plein clip. Le défaut ne lève aucune erreur et ne se
  // voit qu'à l'œil, sur un rendu.
  it("range les mots dans l'ordre des segments, jamais dans celui de la source", () => {
    const outOfOrder = [
      { word: 'd', start: 209, end: 210 },
      { word: 'a', start: 100, end: 101 },
      { word: 'c', start: 200, end: 201 },
      { word: 'b', start: 109, end: 110 },
    ]
    expect(retimeWords(outOfOrder, segments).map((w) => w.word)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('trie les segments avant de cumuler leurs durées', () => {
    const out = retimeWords(
      [
        { word: 'a', start: 100, end: 101 },
        { word: 'c', start: 200, end: 201 },
      ],
      [
        { start: 200, end: 210 },
        { start: 100, end: 110 },
      ],
    )
    expect(out).toEqual([
      { word: 'a', start: 0, end: 1 },
      { word: 'c', start: 10, end: 11 },
    ])
  })

  it('rend un clip vide quand il ne reste aucun segment', () => {
    expect(retimeWords([{ word: 'a', start: 100, end: 101 }], [])).toEqual([])
  })

  // Un mot dont la coupe traverse le milieu s'entend en deux morceaux : il
  // s'affiche donc dans les deux, rogné de part et d'autre. C'est une
  // conséquence assumée du rognage, pas un oubli — un mot avalé serait pire.
  it('affiche des deux côtés un mot que la coupe traverse', () => {
    expect(retimeWords([{ word: 'long', start: 109.5, end: 200.5 }], segments)).toEqual([
      { word: 'long', start: 9.5, end: 10 },
      { word: 'long', start: 10, end: 10.5 },
    ])
  })

  it("ne modifie ni le tableau ni les mots qu'on lui passe", () => {
    const words = [
      { word: 'b', start: 200, end: 200.5 },
      { word: 'a', start: 100, end: 100.5 },
    ]
    retimeWords(words, segments)
    expect(words).toEqual([
      { word: 'b', start: 200, end: 200.5 },
      { word: 'a', start: 100, end: 100.5 },
    ])
  })
})

describe('splitIntoCards', () => {
  it('ferme un carton à 16 caractères, espaces compris', () => {
    const words = 'alpha bravo charlie delta'.split(' ').map((w, i) => ({
      word: w,
      start: i * 0.3,
      end: i * 0.3 + 0.25,
    }))
    for (const card of splitIntoCards(words)) {
      const len = card.reduce((n, w) => n + w.word.length + 1, 0)
      expect(len).toBeLessThanOrEqual(16 + card[card.length - 1].word.length)
    }
  })

  // Sans marge : le code garantit exactement le seuil, et une tolérance d'une
  // demi-seconde laisserait passer un dépassement de 0,1 à 0,4 s (Aristarque).
  it('ferme un carton à 1,4 seconde', () => {
    const words = Array.from({ length: 8 }, (_, i) => ({
      word: 'a',
      start: i * 0.5,
      end: i * 0.5 + 0.4,
    }))
    for (const card of splitIntoCards(words)) {
      expect(card[card.length - 1].end - card[0].start).toBeLessThanOrEqual(1.4)
    }
  })

  // La seule exception au seuil, et elle est structurelle : le premier mot ouvre
  // le carton sans condition. Un mot plus long que la limite tient donc seul,
  // au-delà d'elle — le jeter serait pire.
  it('laisse un mot plus long que le seuil tenir un carton à lui seul', () => {
    expect(splitIntoCards([{ word: 'euuuuh', start: 0, end: 3 }])).toEqual([
      [{ word: 'euuuuh', start: 0, end: 3 }],
    ])
  })

  it('ne perd aucun mot', () => {
    const words = Array.from({ length: 37 }, (_, i) => ({ word: `m${i}`, start: i, end: i + 0.5 }))
    expect(splitIntoCards(words).flat().length).toBe(37)
  })

  // La durée se mesure depuis le début du carton, pas depuis le mot précédent :
  // sinon un carton ne se refermerait jamais tant que les mots s'enchaînent, et
  // c'est le cas courant.
  it('mesure la durée depuis le début du carton', () => {
    const words = Array.from({ length: 6 }, (_, i) => ({
      word: 'a',
      start: i * 0.5,
      end: i * 0.5 + 0.4,
    }))
    expect(splitIntoCards(words).map((c) => c.length)).toEqual([3, 3])
  })

  it('rend un tableau vide sans mot', () => {
    expect(splitIntoCards([])).toEqual([])
  })

  // Le décompte de caractères et le rendu supposent un mot sans blanc autour :
  // certains transcripts portent l'espace de séparation dans le jeton lui-même.
  it('normalise les blancs et écarte un jeton sans texte', () => {
    const cards = splitIntoCards([
      { word: ' salut ', start: 0, end: 0.4 },
      { word: '  ', start: 0.5, end: 0.6 },
      { word: 'toi', start: 0.7, end: 1 },
    ])
    expect(cards.flat().map((w) => w.word)).toEqual(['salut', 'toi'])
  })

  it("n'écrit ni dans le tableau ni dans les mots qu'on lui passe", () => {
    const words = [{ word: ' salut ', start: 0, end: 0.4 }]
    splitIntoCards(words)
    expect(words).toEqual([{ word: ' salut ', start: 0, end: 0.4 }])
  })
})

describe('renderAss', () => {
  const cards = [
    [
      { word: 'salut', start: 0, end: 0.4 },
      { word: 'toi', start: 0.5, end: 0.9 },
    ],
  ]

  it('émet un événement Dialogue par mot, chaque carton entier à chaque fois', () => {
    const ass = renderAss(cards, DEFAULT_CAPTION_STYLE)
    const events = dialogues(ass)
    expect(events.length).toBe(2)
    for (const e of events) {
      expect(e).toContain('SALUT')
      expect(e).toContain('TOI')
    }
  })

  it('déclare Anton et la couleur de surlignage au format ASS &HBBGGRR', () => {
    const ass = renderAss(cards, DEFAULT_CAPTION_STYLE)
    expect(ass).toContain('Style: Default,Anton,')
    expect(ass).toContain('&H00E5FF&') // #FFE500 inversé en BGR
  })

  it('échappe les accolades, qui sont la syntaxe des balises ASS', () => {
    const ass = renderAss([[{ word: '{piégé}', start: 0, end: 1 }]], DEFAULT_CAPTION_STYLE)
    expect(ass).not.toMatch(/[^\\]\{piégé/)
  })

  // Le contrôle précédent passe sans rien neutraliser, puisque le preset force
  // les majuscules et que « piégé » n'y survit pas. Celui-ci coupe la casse et
  // regarde le texte réellement émis.
  it("neutralise accolades et antislash même quand la casse n'est pas forcée", () => {
    const ass = renderAss([[{ word: '{piégé}\\N', start: 0, end: 1 }]], {
      ...DEFAULT_CAPTION_STYLE,
      uppercase: false,
    })
    const text = textOf(dialogues(ass)[0])
    expect(text).toContain('(piégé)/N')
    expect(text).not.toContain('{piégé')
  })

  it('met la police à l’échelle de PlayResY 288 : 44 devient 37', () => {
    const ass = renderAss(cards, DEFAULT_CAPTION_STYLE)
    expect(ass).toContain('PlayResY: 288')
    expect(styleLine(ass).split(',')[2]).toBe('37')
  })

  // 43 unités de PlayResY, soit ~15 % de la hauteur. Les 25 d'avant passaient
  // sous l'interface de TikTok : c'est une mesure, pas un goût.
  it('pose la marge basse à 43 et cale les sous-titres en bas', () => {
    const fields = styleLine(renderAss(cards, DEFAULT_CAPTION_STYLE)).split(',')
    expect(fields[18]).toBe('2') // Alignment : bas centré
    expect(fields[21]).toBe('43') // MarginV
  })

  // Deux formats de couleur, et les confondre inverse les couleurs sans erreur.
  // #FFE500 n'est pas un palindrome : le contrôle mord.
  it('écrit les couleurs du bloc Style en &HAABBGGRR', () => {
    const ass = renderAss(cards, { ...DEFAULT_CAPTION_STYLE, fontColor: '#FFE500' })
    const fields = styleLine(ass).split(',')
    expect(fields[3]).toBe('&H0000E5FF') // opaque, BGR
    expect(fields[5]).toBe('&H00000000') // contour noir opaque
    expect(fields[6]).toBe('&HFF000000') // fond entièrement transparent
  })

  it('borne chaque événement sur le début du mot suivant, le dernier sur la fin du carton', () => {
    const events = dialogues(renderAss(cards, DEFAULT_CAPTION_STYLE))
    expect(events[0].startsWith('Dialogue: 0,0:00:00.00,0:00:00.50,Default,,0,0,0,,')).toBe(true)
    expect(events[1].startsWith('Dialogue: 0,0:00:00.50,0:00:00.90,Default,,0,0,0,,')).toBe(true)
  })

  it("n'enveloppe que le mot actif, et le mot actif avance d'un événement à l'autre", () => {
    const events = dialogues(renderAss(cards, DEFAULT_CAPTION_STYLE))
    const active = /\{\\c&H00E5FF&\\fscx90\\fscy90\\t\(0,110,\\fscx108\\fscy108\)\}(\w+)\{\\r\}/
    expect(events[0].match(active)?.[1]).toBe('SALUT')
    expect(events[1].match(active)?.[1]).toBe('TOI')
  })

  // Le fichier ne connaît que le centième : un événement dont les deux bornes
  // retombent sur le même centième s'écrirait `0:00:00.00 → 0:00:00.00`. Comparer
  // les temps bruts le laissait passer (Copilot). Un mot rogné par une coupe
  // interne en produit de quelques millisecondes.
  it("saute un événement que l'arrondi au centième réduit à rien", () => {
    const ass = renderAss(
      [
        [
          { word: 'a', start: 0, end: 0.5 },
          { word: 'b', start: 0.004, end: 0.5 },
        ],
      ],
      DEFAULT_CAPTION_STYLE,
    )
    expect(dialogues(ass).length).toBe(1)
  })

  // L'arrondi doit se propager, pas se faire écrêter : `59,999` vaut une minute
  // pleine, pas `0:00:59.99` (Copilot). Le portage avait hérité de l'écrêtage de
  // la version d'origine, qui perd jusqu'à 10 ms au passage de chaque seconde.
  it("propage la retenue de l'arrondi au lieu de l'écrêter", () => {
    const ass = renderAss([[{ word: 'a', start: 59.5, end: 59.999 }]], DEFAULT_CAPTION_STYLE)
    expect(dialogues(ass)[0]).toContain('0:00:59.50,0:01:00.00')
  })

  it('saute un événement dont la fin ne dépasse pas le début', () => {
    const ass = renderAss(
      [
        [
          { word: 'a', start: 0, end: 0.5 },
          { word: 'b', start: 0, end: 0.5 },
        ],
      ],
      DEFAULT_CAPTION_STYLE,
    )
    expect(dialogues(ass).length).toBe(1)
  })

  // Le fichier part chez ffmpeg tel quel : le BOM est la marque que les lecteurs
  // de sous-titres attendent pour reconnaître de l'Unicode.
  it('écrit le fichier en UTF-8 avec BOM', () => {
    // Par le point de code, pas par un littéral : un U+FEFF dans la source d'un
    // test est invisible, donc le contrôle passerait encore après l'avoir perdu.
    expect(renderAss(cards, DEFAULT_CAPTION_STYLE).codePointAt(0)).toBe(0xfeff)
  })

  it('rend un document valide, et sans événement, sans carton', () => {
    const ass = renderAss([], DEFAULT_CAPTION_STYLE)
    expect(ass).toContain('[Events]')
    expect(dialogues(ass)).toEqual([])
  })

  // Spec §9 : « ces valeurs deviennent un preset modifiable, pas des constantes
  // en dur ». Chaque champ doit donc atteindre la sortie.
  it('est un preset : chaque champ du style atteint la sortie', () => {
    const ass = renderAss(cards, {
      ...DEFAULT_CAPTION_STYLE,
      fontName: 'Impact',
      fontSize: 100,
      highlightColor: '#0000FF',
      borderColor: '#112233',
      borderWidth: 7,
      uppercase: false,
      marginV: 60,
    })
    const fields = styleLine(ass).split(',')
    expect(fields[1]).toBe('Impact')
    expect(fields[2]).toBe('85')
    expect(fields[5]).toBe('&H00332211')
    expect(fields[16]).toBe('7')
    expect(fields[21]).toBe('60')
    expect(ass).toContain('&HFF0000&')
    expect(dialogues(ass)[0]).toContain('salut')
  })

  // Une virgule dans le nom de la police ajouterait des champs à la ligne de
  // style, donc réécrirait la taille, les couleurs et la marge.
  it("ne laisse pas un nom de police injecter des champs dans la ligne de style", () => {
    const ass = renderAss(cards, { ...DEFAULT_CAPTION_STYLE, fontName: 'Anton,72,&HFF0000' })
    expect(styleLine(ass).slice('Style: '.length).split(',').length).toBe(23)
  })

  // Un saut de ligne littéral couperait la ligne `Dialogue:` en deux et
  // corromprait le fichier. `splitIntoCards` normalise déjà les blancs, mais
  // `renderAss` est exporté et sa documentation dit qu'il se suffit (Aristarque).
  it('aplatit un saut de ligne, qui couperait la ligne Dialogue en deux', () => {
    const ass = renderAss([[{ word: 'deux\nlignes\r', start: 0, end: 1 }]], DEFAULT_CAPTION_STYLE)
    expect(dialogues(ass).length).toBe(1)
    expect(textOf(dialogues(ass)[0])).toContain('DEUX LIGNES')
  })

  // `borner(…, 0, …)` puis `Math.max(1, …)` se contredisaient : un preset à 0
  // remontait à 1 sans rien dire (Aristarque). Une seule garde, qui l'énonce.
  it('remonte un contour nul au minimum lisible', () => {
    const ass = renderAss(cards, { ...DEFAULT_CAPTION_STYLE, borderWidth: 0 })
    expect(styleLine(ass).split(',')[16]).toBe('1')
  })

  it('retombe sur des couleurs valides plutôt que de rendre un fichier illisible', () => {
    const ass = renderAss(cards, {
      ...DEFAULT_CAPTION_STYLE,
      fontColor: 'rouge',
      highlightColor: '#GGGGGG',
      borderColor: '',
    })
    const fields = styleLine(ass).split(',')
    expect(fields[3]).toBe('&H00FFFFFF')
    expect(fields[5]).toBe('&H00000000')
    expect(ass).toContain('&H00D7FF&') // le jaune de repli, #FFD700
  })
})

// Les trois modules s'enchaînent dans cet ordre au rendu (tâche 5). Le contrôle
// vérifie la seule propriété qui compte au bout de la chaîne : les temps du
// fichier ASS sont ceux du clip, pas ceux de la source.
describe('la chaîne recalage → cartons → ASS', () => {
  it("horodate le fichier sur la timeline du clip et non sur celle de l'émission", () => {
    const segments = [
      { start: 2841.2, end: 2856.9 },
      { start: 2874.1, end: 2931.4 },
    ]
    const words = [
      { word: 'salut', start: 2841.2, end: 2841.6 },
      { word: 'toi', start: 2874.1, end: 2874.5 },
    ]
    const ass = renderAss(splitIntoCards(retimeWords(words, segments)), DEFAULT_CAPTION_STYLE)
    const events = dialogues(ass)
    expect(events.length).toBe(2)
    expect(events[0]).toContain('0:00:00.00')
    expect(events[1]).toContain('0:00:15.70')
    expect(ass).not.toContain('0:47:2')
  })
})
