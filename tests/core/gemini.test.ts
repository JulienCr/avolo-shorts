import { describe, it, expect } from 'vitest'
import { clipDuration } from '@/core/edl'
import {
  detailPrompt,
  detailWindowsJson,
  HOOK_PATTERNS,
  hookPrompt,
  scorePrompt,
  scoreWindowsJson,
} from '@/core/gemini/prompts'
import {
  parseDetailResponse,
  parseJsonResponse,
  parseScoreResponse,
  shortlistFromScores,
} from '@/core/gemini/parse'
import { buildWindows, type Transcript, type Window, type Word } from '@/core/transcript'
import notation from '../fixtures/gemini-score.json'
import detail from '../fixtures/gemini-detail.json'
import detailOutsideMedia from '../fixtures/gemini-detail-outside-media.json'

/**
 * Le pourvoyeur Gemini, testé **sans jamais appeler Gemini** : les réponses
 * vivent dans `tests/fixtures/`. Ce qui se vérifie ici est ce qui est pur —
 * la construction des prompts, l'analyse des réponses, la réconciliation des
 * fenêtres omises, le rejet d'un clip hors média, et le fait qu'aucun clip ne
 * soit plafonné à 60 secondes.
 *
 * **La qualité du choix de Gemini n'est pas testable** (spec §14, « non testé et
 * assumé ») : elle se juge à l'œil, sur un vrai transcript.
 */

const PROJECT = '2025-06-15-cqlp'

/** Les phrases du transcript de test, huit mots chacune. */
const SENTENCES = [
  'alors moi je dis que ce pingouin ment',
  'attends tu viens de dire quoi là exactement',
  'non mais regarde le il a un cartable',
  'un pingouin avec un cartable ça se discute',
  'monsieur le juge je demande une suspension immédiate',
]

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}

/**
 * Un segment dont les mots sont posés sur une grille régulière : un mot toutes
 * les 0,45 s, long de 0,35 s. Les trous entre les mots et entre les phrases sont
 * ce sur quoi `snapToWords` a le droit de poser une coupe, donc les fixtures de
 * bornes plus bas tombent tantôt dans un mot, tantôt dans un silence.
 */
function seg(start: number, text: string) {
  const words: Word[] = text.split(' ').map((word, i) => ({
    word: word,
    start: round3(start + i * 0.45),
    end: round3(start + i * 0.45 + 0.35),
  }))
  return { start, end: words[words.length - 1].end, text: text, words }
}

/** Soixante phrases espacées de 6 s : le transcript couvre 0 à ~357,5 s. */
const TRANSCRIPT: Transcript = {
  segments: Array.from({ length: 60 }, (_, i) => seg(i * 6, SENTENCES[i % SENTENCES.length])),
}

const WORDS: Word[] = TRANSCRIPT.segments.flatMap((s) => s.words)

/**
 * Les mêmes mots sur une vidéo de 100 secondes. Les tests de rejet hors média
 * tronquent la liste plutôt que de baisser la seule durée : **les mots ne
 * survivent jamais à la vidéo**, ils en sont extraits. Garder 357 secondes de
 * parole sur une vidéo de 100 fabriquerait un monde impossible, et
 * `snapToWords` y ramène une fin trop lointaine sur la fin du média au lieu de
 * la laisser dehors — ce qui ferait passer le test pour la mauvaise raison.
 */
const WORDS_SHORT: Word[] = WORDS.filter((m) => m.end <= 100)

/** Une fenêtre nue, pour les tests qui ne regardent que les identifiants. */
function fen(id: string, start = 0, end = 90): Window {
  return { id, start, end, text: '', segFrom: 0, segTo: -1 }
}

/**
 * Un bloc qui couvre tout le transcript de test. Les clips des fixtures en
 * viennent tous : le contrôle de provenance ne doit pas les écarter.
 */
const BLOCKS_WIDE = [fen('window_001', 0, 300)]

function proposed(
  raw: unknown,
  options: { words?: Word[]; videoDuration?: number; projectId?: string; blocks?: Window[] } = {},
) {
  return parseDetailResponse(raw, {
    words: options.words ?? WORDS,
    videoDuration: options.videoDuration ?? 3600,
    projectId: options.projectId ?? PROJECT,
    blocks: options.blocks ?? BLOCKS_WIDE,
  })
}

/**
 * Les seuls clips, sans les notes : ce que la plupart de ces tests regardent.
 * La note se juge dans son propre bloc, plus bas.
 */
function detailed(
  raw: unknown,
  options: { words?: Word[]; videoDuration?: number; projectId?: string; blocks?: Window[] } = {},
) {
  return proposed(raw, options).map((p) => p.clip)
}

const ENTRIES_DETAIL = {
  language: 'fr',
  videoDuration: 3600,
  windowsJson: '[]',
  minClips: 4,
  maxClips: 9,
}

describe('scorePrompt', () => {
  it('porte le barème ancré, qui est ce qui rend deux lots comparables', () => {
    const p = scorePrompt({ language: 'fr', videoDuration: 3600, windowsJson: '[]' })
    for (const tier of ['80-100', '50-79', '20-49', '0-19']) {
      expect(p).toContain(tier)
    }
  })

  it('porte la règle des 2 secondes', () => {
    const p = scorePrompt({ language: 'fr', videoDuration: 3600, windowsJson: '[]' })
    expect(p).toContain('THE 2-SECOND TEST')
  })

  it('demande de noter toutes les fenêtres du lot', () => {
    const p = scorePrompt({ language: 'fr', videoDuration: 3600, windowsJson: '[]' })
    expect(p).toContain('Score EVERY window in this batch')
  })

  it('interpole la langue, la durée et les fenêtres', () => {
    const p = scorePrompt({
      language: 'français',
      videoDuration: 10234.5,
      windowsJson: '[{"id":"window_001"}]',
    })
    expect(p).toContain('TRANSCRIPT_LANGUAGE: français')
    expect(p).toContain('VIDEO_DURATION_SECONDS: 10234.5')
    expect(p).toContain('[{"id":"window_001"}]')
    // Aucun trou de gabarit laissé derrière. Le motif cherche `${`, la syntaxe
    // que ces gabarits utilisent réellement : la version précédente cherchait
    // des noms en `snake_case` que le TypeScript ne produit jamais, donc elle
    // passait quoi qu'il arrive. (relevé par Aristarque)
    expect(p).not.toContain('${')
  })
})

describe('detailPrompt', () => {
  it('porte les cibles de nombre de clips', () => {
    expect(detailPrompt(ENTRIES_DETAIL)).toContain('return 4 to 9 clips')
  })

  it('ne contient plus de plafond de durée', () => {
    const p = detailPrompt(ENTRIES_DETAIL)
    expect(p).not.toMatch(/15 to 60 seconds/)
    // La ligne d'openshorts a disparu, et aucune autre ne la remplace : la durée
    // est un résultat, jamais une contrainte d'entrée (spec §5). C'est ce
    // plafond qui gardait 25 secondes de préambule et coupait la chute.
    expect(p).not.toMatch(/\d+\s+(to|-)\s+\d+\s+seconds long/)
    expect(p).not.toMatch(/seconds long/)
  })

  it('explique comment lire les marqueurs [SECONDS]', () => {
    const p = detailPrompt(ENTRIES_DETAIL)
    expect(p).toContain('[123.400]')
    expect(p).toContain('do not round a marker to a whole number')
  })

  it('interpole la langue aux deux endroits où elle apparaît', () => {
    const p = detailPrompt({ ...ENTRIES_DETAIL, language: 'français' })
    expect(p.match(/français/g) ?? []).toHaveLength(2)
    expect(p).not.toContain('${')
  })
})

describe('hookPrompt', () => {
  const ENTRIES_HOOK = {
    language: 'fr',
    title: 'Le pingouin au tribunal',
    description: 'Un procès improbable',
    lines: ['alors moi je dis que ce pingouin ment', 'un pingouin avec un cartable ça se discute'],
    maxWords: 10,
  }

  it('porte le même HOOK PLAYBOOK que detailPrompt, mot pour mot', () => {
    const p = hookPrompt(ENTRIES_HOOK)
    expect(p).toContain(HOOK_PATTERNS)
    expect(detailPrompt(ENTRIES_DETAIL)).toContain(HOOK_PATTERNS)
  })

  it('interpole la langue, le titre, la description et le texte du clip', () => {
    const p = hookPrompt(ENTRIES_HOOK)
    expect(p).toContain('TRANSCRIPT_LANGUAGE: fr')
    expect(p).toContain('TITLE: Le pingouin au tribunal')
    expect(p).toContain('DESCRIPTION: Un procès improbable')
    expect(p).toContain('alors moi je dis que ce pingouin ment')
    expect(p).toContain('un pingouin avec un cartable ça se discute')
    // Aucun trou de gabarit laissé derrière.
    expect(p).not.toContain('${')
  })

  it('porte le plafond de mots demandé, pas une valeur fixe', () => {
    const p = hookPrompt({ ...ENTRIES_HOOK, maxWords: 6 })
    expect(p).toContain('at most 6 words')
    expect(p).toContain('max 6 words')
  })

  it("ne demande qu'un seul champ en sortie", () => {
    const p = hookPrompt(ENTRIES_HOOK)
    const returnBlock = p.slice(p.indexOf('Return only:'))
    expect(returnBlock).toContain('"hook":')
    expect(returnBlock).not.toContain('viral_hook_text')
    expect(returnBlock).not.toContain('shorts')
  })
})

describe('scoreWindowsJson', () => {
  it("n'envoie que ce que le modèle doit lire", () => {
    const w: Window = { id: 'window_001', start: 0, end: 90, text: 'bonjour', segFrom: 0, segTo: 2 }
    const payload = JSON.parse(scoreWindowsJson([w])) as unknown[]
    // Les index de segments sont de la plomberie interne : les envoyer invite le
    // modèle à s'en servir comme d'une position.
    expect(payload[0]).toEqual({ id: 'window_001', start: 0, end: 90, text: 'bonjour' })
  })

  it('ne fuit pas les accents en séquences d’échappement', () => {
    const w: Window = { id: 'window_001', start: 0, end: 90, text: 'à côté', segFrom: 0, segTo: 0 }
    expect(scoreWindowsJson([w])).toContain('à côté')
  })
})

describe('detailWindowsJson', () => {
  it('rend le texte ancré, pas la prose nue', () => {
    const windows = buildWindows(TRANSCRIPT, 3600)
    const payload = JSON.parse(detailWindowsJson(windows.slice(0, 1), TRANSCRIPT)) as {
      text: string
    }[]
    expect(payload[0].text).toMatch(/^\[0\.000\] alors moi je dis/)
    expect(payload[0].text).toContain('[6.000]')
  })
})

describe('parseScoreResponse', () => {
  const windows = [fen('window_001'), fen('window_002'), fen('window_003'), fen('window_004')]

  it('réconcilie les fenêtres que le modèle a omises', () => {
    const { scored, missing } = parseScoreResponse(notation, windows)
    expect(missing).toContain('window_002')
    expect(scored.every((s) => s.score >= 0 && s.score <= 100)).toBe(true)
    // Omise ne veut pas dire perdue : elle est classée dernière, pas écartée.
    // C'est `shortlistSize` qui retire de la matière, et rien d'autre.
    expect(scored.map((s) => s.id).sort()).toEqual([
      'window_001',
      'window_002',
      'window_003',
      'window_004',
    ])
    expect(scored.find((s) => s.id === 'window_002')?.score).toBe(0)
  })

  it('ignore un identifiant que le lot ne contenait pas', () => {
    const { scored } = parseScoreResponse(notation, windows)
    expect(scored.map((s) => s.id)).not.toContain('window_999')
  })

  it('garde le premier avis sur une fenêtre notée deux fois', () => {
    const { scored } = parseScoreResponse(notation, windows)
    const w1 = scored.filter((s) => s.id === 'window_001')
    expect(w1).toHaveLength(1)
    expect(w1[0].score).toBe(82)
  })

  it('ramène une note hors barème dans le barème', () => {
    const { scored } = parseScoreResponse(notation, windows)
    expect(scored.find((s) => s.id === 'window_004')?.score).toBe(100)
  })

  it('une réponse illisible laisse toutes les fenêtres non notées', () => {
    for (const raw of [null, undefined, 'du texte', {}, { windows: 'non' }]) {
      const { scored, missing } = parseScoreResponse(raw, windows)
      expect(missing).toHaveLength(4)
      expect(scored).toHaveLength(4)
      expect(scored.every((s) => s.score === 0)).toBe(true)
    }
  })

  it('ne modifie pas les fenêtres reçues', () => {
    const copy = structuredClone(windows)
    parseScoreResponse(notation, windows)
    expect(windows).toEqual(copy)
  })
})

describe('shortlistFromScores', () => {
  // Douze fenêtres pour une cible de 10 : il reste de quoi voir un tri. La cible
  // est passée en clair — `shortlistFromScores` trie et coupe, elle ne
  // dimensionne plus.
  const twelve = Array.from({ length: 12 }, (_, i) => fen(`window_${String(i + 1).padStart(3, '0')}`))

  it('retient le haut du panier', () => {
    const notes = twelve.map((w, i) => ({ id: w.id, score: i * 5, reason: '', noted: true }))
    const kept = shortlistFromScores(notes, twelve, 10)
    expect(kept).toHaveLength(10)
    expect(kept[0].id).toBe('window_012')
    expect(kept.map((w) => w.id)).not.toContain('window_001')
  })

  it('se rabat sur les premières fenêtres quand la notation n’a rien rendu', () => {
    const kept = shortlistFromScores([], twelve, 10)
    expect(kept.map((w) => w.id)).toEqual(twelve.slice(0, 10).map((w) => w.id))
  })

  it('ne retient jamais une fenêtre qui n’a pas été soumise', () => {
    const kept = shortlistFromScores([{ id: 'window_999', score: 100, reason: '', noted: true }], twelve, 10)
    expect(kept.map((w) => w.id)).not.toContain('window_999')
    // La note fantôme ne mange pas non plus une place : dix fenêtres réelles
    // atteignent la présélection, pas neuf.
    expect(kept).toHaveLength(10)
  })

  it('départage deux notes égales par l’ordre chronologique', () => {
    const notes = twelve.map((w) => ({ id: w.id, score: 50, reason: '', noted: true }))
    const kept = shortlistFromScores(notes, twelve, 10)
    expect(kept.map((w) => w.id)).toEqual(twelve.slice(0, 10).map((w) => w.id))
  })

  it('départage même quand le modèle a répondu dans le désordre', () => {
    // Le tri stable ne suffit pas : il préserve l'ordre de la RÉPONSE, que
    // Gemini choisit. Une égalité qui tombe pile sur la coupure admettait alors
    // une fenêtre tardive en écartant une fenêtre antérieure, au hasard.
    // (relevé par Codex et Copilot)
    const notes = [...twelve].reverse().map((w) => ({ id: w.id, score: 50, reason: '', noted: true }))
    const kept = shortlistFromScores(notes, twelve, 10)
    expect(kept.map((w) => w.id)).toEqual(twelve.slice(0, 10).map((w) => w.id))
  })

  it('une fenêtre notée 0 passe devant une fenêtre jamais notée', () => {
    // Le zéro de réconciliation et un vrai zéro portaient la même valeur, donc
    // le départage chronologique les mêlait : une fenêtre antérieure jamais
    // évaluée pouvait prendre, à la coupure, la place d'une fenêtre évaluée.
    // (relevé par Copilot)
    const fifteen = Array.from({ length: 15 }, (_, i) =>
      fen(`window_${String(i + 1).padStart(3, '0')}`),
    )
    const { scored } = parseScoreResponse(
      { windows: [{ id: 'window_015', start: 0, end: 90, score: 0, reason: 'nul mais jugé' }] },
      fifteen,
    )
    const kept = shortlistFromScores(scored, fifteen, 10)
    expect(kept[0].id).toBe('window_015')
  })

  it('une note plus haute passe toujours devant, désordre ou pas', () => {
    const notes = [
      { id: 'window_003', score: 10, reason: '', noted: true },
      { id: 'window_011', score: 99, reason: '', noted: true },
      { id: 'window_001', score: 50, reason: '', noted: true },
    ]
    const kept = shortlistFromScores(notes, twelve, 10)
    expect(kept.slice(0, 3).map((w) => w.id)).toEqual([
      'window_011',
      'window_001',
      'window_003',
    ])
  })
})

describe('parseDetailResponse', () => {
  it('cale les bornes rendues sur les frontières de mots', () => {
    const clips = detailed(detail)
    expect(clips.length).toBeGreaterThan(0)
    for (const c of clips) {
      expect(c.segments).toHaveLength(1)
      // Une borne calée tombe dans un silence, jamais au milieu d'un mot.
      for (const bound of [c.segments[0].start, c.segments[0].end]) {
        expect(WORDS.some((m) => m.start < bound && bound < m.end)).toBe(false)
      }
    }
  })

  it('ne rend aucun clip plafonné à 60 secondes', () => {
    const clips = detailed(detail)
    expect(clips.some((c) => clipDuration(c.segments) > 60)).toBe(true)
  })

  it('rejette un clip dont les bornes sortent de la vidéo', () => {
    expect(detailed(detailOutsideMedia, { words: WORDS_SHORT, videoDuration: 100 })).toEqual([])
  })

  it('rejette un clip qui ne recoupe aucun bloc présélectionné', () => {
    // Le modèle n'a lu que le texte des blocs : des bornes sans le moindre
    // recouvrement ne viennent pas d'une lecture mais d'une invention, et elles
    // contourneraient les deux passes. (relevé par Copilot)
    const clips = detailed(detail, { blocks: [fen('window_001', 0, 50)] })
    expect(clips).toHaveLength(1)
    expect(clips[0].segments[0].start).toBeLessThan(50)
  })

  it('garde un clip qui dépasse le bord de son bloc de peu', () => {
    // Le prompt demande `end` au marqueur de la phrase SUIVANTE, et le calage
    // ajoute du silence : un débordement de quelques secondes est le cas normal,
    // pas une invention. Exiger le confinement écarterait de vrais clips.
    const clips = detailed(detail, { blocks: [fen('window_001', 0, 30)] })
    expect(clips).toHaveLength(1)
    expect(clips[0].segments[0].end).toBeGreaterThan(30)
  })

  it('sans aucun bloc, rien ne peut venir de nulle part', () => {
    expect(detailed(detail, { blocks: [] })).toEqual([])
  })

  it('ne jette que le clip hors média, pas le lot', () => {
    const clips = detailed(detail, { words: WORDS_SHORT, videoDuration: 100 })
    expect(clips).toHaveLength(1)
    expect(clips[0].segments[0].end).toBeLessThanOrEqual(100)
  })

  it('ignore une entrée illisible sans perdre les autres', () => {
    const clips = detailed(detail)
    // La fixture porte quatre entrées, dont une avec un `start` textuel.
    expect(clips).toHaveLength(3)
  })

  it('une enveloppe illisible lève, au lieu de passer pour une passe réussie', () => {
    // « Le modèle n'a rien trouvé » et « la réponse est cassée » se ressemblent
    // et ne veulent pas dire la même chose. Confondues, une réponse cassée
    // effaçait les propositions non traitées et écrivait `candidates.json`, que
    // le graphe lit ensuite comme une étape à jour. (relevé par Copilot)
    for (const raw of [null, undefined, 'du texte', {}, { shorts: 'non' }]) {
      expect(() => detailed(raw)).toThrow(/did not contain a "shorts" array/)
    }
  })

  it('un tableau vide reste une réponse, pas une panne', () => {
    expect(detailed({ shorts: [] })).toEqual([])
  })

  it('un lot non vide dont rien n’est lisible lève, lui aussi', () => {
    // Six propositions toutes illisibles ne veulent pas dire « aucun moment
    // trouvé », elles veulent dire que la réponse est cassée — et elles
    // ressortaient en liste vide comme un `shorts: []` légitime.
    // (relevé par Copilot)
    expect(() => detailed({ shorts: [{ start: 'plus tard' }, { fin: 3 }] })).toThrow(
      /any readable entry/,
    )
  })

  it('un lot mixte garde ce qui est lisible', () => {
    const clips = detailed({
      shorts: [{ start: 'plus tard' }, { start: 12.0, end: 41.4 }],
    })
    expect(clips).toHaveLength(1)
  })

  it('un lot lisible dont tout est écarté reste une réponse', () => {
    // Écarté pour être hors bloc n'est pas « illisible » : l'entrée a bien été
    // lue, et la refuser est un jugement, pas une panne.
    expect(detailed({ shorts: [{ start: 12.0, end: 41.4 }] }, { blocks: [fen('w', 200, 300)] })).toEqual(
      [],
    )
  })

  it('rend des candidats prêts pour la fusion des passes', () => {
    const clips = detailed(detail)
    for (const c of clips) {
      expect(c.status).toBe('candidate')
      expect(c.projectId).toBe(PROJECT)
      expect(c.ratio).toBe('auto')
      expect(c.cropX).toBe(0.5)
    }
    expect(clips[0].title).toBe('Il ne lâche jamais le pingouin')
    expect(clips[0].description).toContain('#impro')
  })

  it("l'identifiant dérive du projet et des bornes, jamais d’un compteur", () => {
    const clips = detailed(detail)
    for (const c of clips) {
      expect(c.id.startsWith(`${PROJECT}_`)).toBe(true)
      // Un compteur reparti de 1 rendrait la garantie « un clip écarté ne
      // revient pas » inopérante : la même proposition reviendrait sous un
      // nouvel identifiant, et une proposition sans rapport hériterait du refus
      // prononcé sur le `clip_01` de la passe précédente.
      expect(c.id).not.toMatch(/clip_0*\d+$/)
      const bounds = c.id.slice(PROJECT.length + 1)
      expect(bounds).toMatch(/^\d+-\d+$/)
    }
    expect(new Set(clips.map((c) => c.id)).size).toBe(clips.length)
  })

  it('les mêmes bornes redonnent le même identifiant, passe après passe', () => {
    const a = detailed(detail)
    const b = detailed(detail)
    expect(b.map((c) => c.id)).toEqual(a.map((c) => c.id))
  })

  it('deux projets aux mêmes bornes ne se partagent pas un identifiant', () => {
    const a = detailed(detail)
    const b = detailed(detail, { projectId: '2026-03-08-caro-mdlm' })
    expect(a.map((c) => c.id)).not.toEqual(b.map((c) => c.id))
    // `clips.id` est unique pour toute la base (`src/server/db.ts`) : deux
    // projets qui produiraient le même identifiant se voleraient leurs clips.
    for (const id of b.map((c) => c.id)) {
      expect(a.map((c) => c.id)).not.toContain(id)
    }
  })

  it('des bornes distinctes à la milliseconde près donnent des identifiants distincts', () => {
    const raw = {
      shorts: [
        { start: 12.0, end: 41.4 },
        { start: 12.001, end: 41.4 },
      ],
    }
    // Sans mots, `snapToWords` rend les bornes telles quelles : c'est le cas où
    // l'identifiant doit encore séparer deux propositions voisines.
    const clips = detailed(raw, { words: [] })
    expect(new Set(clips.map((c) => c.id)).size).toBe(2)
  })
})

/**
 * La note que le modèle donne à chacun de ses clips.
 *
 * Le prompt la demande depuis toujours ; elle était lue et jetée. Elle ressort
 * parce que l'ordre du tableau `shorts` n'est un classement qu'à l'intérieur
 * d'une réponse : deux sous-requêtes concaténées ne se comparent plus, et c'est
 * la note qui les reclasse avant le plafond. (relevé par Codex)
 */
describe('la note prédite d’un clip', () => {
  it('ressort avec le clip, sans entrer dedans', () => {
    const proposals = proposed(detail)
    expect(proposals.map((p) => p.predictedScore)).toEqual([88, 74, 61])
    expect(proposals.every((p) => p.scored)).toBe(true)
    // `Clip` est ce que la base porte et ce que l'interface édite : une
    // estimation de viralité n'y a pas sa place, et elle ressortirait dans
    // `candidates.json` comme si elle décrivait le clip monté.
    for (const { clip } of proposals) {
      expect(clip).not.toHaveProperty('predictedScore')
      expect(clip).not.toHaveProperty('predicted_score')
    }
  })

  it('ramène une note hors barème dans le barème, au lieu de la jeter', () => {
    // Un 130 dit que le modèle tient ce clip pour excellent : le jeter perdrait
    // précisément le clip qu'il classait premier.
    const proposals = proposed({
      shorts: [
        { start: 12.0, end: 41.4, predicted_score: 130 },
        { start: 96.0, end: 187.2, predicted_score: -5 },
        { start: 240.0, end: 268.2, predicted_score: 61.6 },
      ],
    })
    expect(proposals.map((p) => p.predictedScore)).toEqual([100, 0, 62])
  })

  it('une note illisible ne coûte pas la proposition', () => {
    // La réponse est une entrée hostile, et une note en chaîne y est plausible.
    // Le champ vit dans le schéma du clip : sans repli, il faisait échouer
    // l'entrée entière, et un clip aux bornes valides était jeté — et compté
    // comme illisible — pour une note accessoire. Avant cette PR, le champ
    // n'était pas lu du tout. (relevé par Copilot et Aristarque)
    const proposals = proposed({
      shorts: [
        { start: 12.0, end: 41.4, predicted_score: 'très bon' },
        { start: 96.0, end: 187.2, predicted_score: null },
        { start: 240.0, end: 268.2, predicted_score: 61 },
      ],
    })
    expect(proposals).toHaveLength(3)
    expect(proposals.map((p) => p.scored)).toEqual([false, false, true])
    expect(proposals.map((p) => p.predictedScore)).toEqual([0, 0, 61])
  })

  it('une note absente n’est pas une note nulle', () => {
    // `predicted_score` est facultatif dans la réponse. Sans ce drapeau, un clip
    // non noté partagerait le zéro d'un clip que le modèle a jugé sans intérêt,
    // et le classement mêlerait les deux — c'est la leçon déjà tirée sur les
    // fenêtres avec `notée`.
    const [withoutScore] = proposed({ shorts: [{ start: 12.0, end: 41.4 }] })
    expect(withoutScore.scored).toBe(false)
    expect(withoutScore.predictedScore).toBe(0)
    const [withScore] = proposed({ shorts: [{ start: 12.0, end: 41.4, predicted_score: 0 }] })
    expect(withScore.scored).toBe(true)
    expect(withScore.predictedScore).toBe(0)
  })
})

/**
 * `viral_hook_text` — le prompt le demande depuis toujours (`HOOK PLAYBOOK`,
 * `prompts.ts`) et le schéma de repérage le requiert (`candidates.ts`) ; ce
 * fichier le lisait et le jetait. Il verse désormais dans `Clip.hookText`,
 * comme `video_title_for_youtube_short` verse dans `Clip.title` deux lignes
 * plus loin dans `parseDetailResponse`.
 */
describe('viral_hook_text', () => {
  it('récolte l’accroche rendue par le modèle, normalisée', () => {
    const clips = detailed(detail)
    // La fixture porte l'accroche entre guillemets pour aucun des trois clips
    // lisibles ; `normalizeHookText` ne fait ici qu'un passage sans effet visible
    // sur des phrases déjà propres, donc l'égalité directe suffit à prouver la
    // récolte.
    expect(clips.map((c) => c.hookText)).toEqual([
      "Personne n'a osé l'arrêter",
      "Il n'avait rien vu venir",
      'Et là, plus personne ne parle',
    ])
  })

  it('rend une chaîne vide quand le modèle n’a pas fourni d’accroche', () => {
    const [clip] = proposed({ shorts: [{ start: 12.0, end: 41.4 }] }).map((p) => p.clip)
    expect(clip.hookText).toBe('')
  })

  it('une accroche illisible ne coûte pas la proposition', () => {
    // Même garde que `predicted_score` : une entrée hostile sur ce champ ne
    // doit pas faire échouer le `safeParse` de la proposition entière.
    const clips = detailed({
      shorts: [{ start: 12.0, end: 41.4, viral_hook_text: null }],
    })
    expect(clips).toHaveLength(1)
    expect(clips[0].hookText).toBe('')
  })

  it('n’a pas de surcharge à la sortie du repérage', () => {
    const [clip] = detailed(detail)
    expect(clip.hookStyle).toEqual({})
  })
})

/**
 * Le badge voyage dans la même réponse que l'accroche, et **facultativement** :
 * `SCHEMA_DETAIL` ne le met pas dans `required`, parce que toutes les
 * émissions ne portent pas de rubrique numérotée et qu'exiger le champ
 * pousserait le modèle à en inventer une par clip.
 */
describe('viral_hook_badge', () => {
  it('récolte le badge rendu par le modèle, normalisé', () => {
    const clips = detailed({
      shorts: [{ start: 12.0, end: 41.4, viral_hook_badge: '  «\u00a0DÉFI 10\u00a0»  ' }],
    })
    expect(clips[0].hookBadge).toBe('DÉFI 10')
  })

  it('rend une chaîne vide quand le modèle n’en propose pas — le cas courant', () => {
    const [clip] = proposed({ shorts: [{ start: 12.0, end: 41.4 }] }).map((p) => p.clip)
    expect(clip.hookBadge).toBe('')
  })

  it('un badge illisible ne coûte pas la proposition', () => {
    const clips = detailed({
      shorts: [{ start: 12.0, end: 41.4, viral_hook_badge: null }],
    })
    expect(clips).toHaveLength(1)
    expect(clips[0].hookBadge).toBe('')
  })

  it('un badge bavard est ramené à trois mots', () => {
    const clips = detailed({
      shorts: [{ start: 12.0, end: 41.4, viral_hook_badge: 'un badge beaucoup trop long' }],
    })
    expect(clips[0].hookBadge).toBe('un badge beaucoup')
  })
})

describe('parseJsonResponse', () => {
  it('lit un objet nu', () => {
    expect(parseJsonResponse('{"shorts": []}')).toEqual({ shorts: [] })
  })

  it('retire les clôtures de code que le modèle ajoute malgré le mime type', () => {
    expect(parseJsonResponse('```json\n{"shorts": []}\n```')).toEqual({ shorts: [] })
  })

  it('extrait l’objet noyé dans du bavardage', () => {
    expect(parseJsonResponse('Voici le résultat :\n{"shorts": []}\nBonne journée.')).toEqual({
      shorts: [],
    })
  })

  it('lève sur un corps vide', () => {
    // Le message compte : c'est lui que la relance reconnaît comme passager.
    // Gemini rend un 200 au corps vide, et la même charge passe à l'essai
    // suivant.
    expect(() => parseJsonResponse('')).toThrow(/empty response body/)
    expect(() => parseJsonResponse('   ')).toThrow(/empty response body/)
  })

  it('lève quand rien ne ressemble à un objet JSON', () => {
    expect(() => parseJsonResponse('je ne peux pas répondre')).toThrow(
      /did not contain a JSON object/,
    )
  })

  it('lève sur un objet mal formé', () => {
    expect(() => parseJsonResponse('{"shorts": [,]}')).toThrow(/Failed to parse Gemini JSON/)
  })
})
