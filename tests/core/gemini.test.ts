import { describe, it, expect } from 'vitest'
import { clipDuration } from '@/core/edl'
import {
  detailPrompt,
  detailWindowsJson,
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
import détail from '../fixtures/gemini-detail.json'
import détailHorsMédia from '../fixtures/gemini-detail-hors-media.json'

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

const PROJET = '2025-06-15-cqlp'

/** Les phrases du transcript de test, huit mots chacune. */
const PHRASES = [
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
function seg(start: number, texte: string) {
  const words: Word[] = texte.split(' ').map((mot, i) => ({
    word: mot,
    start: round3(start + i * 0.45),
    end: round3(start + i * 0.45 + 0.35),
  }))
  return { start, end: words[words.length - 1].end, text: texte, words }
}

/** Soixante phrases espacées de 6 s : le transcript couvre 0 à ~357,5 s. */
const TRANSCRIPT: Transcript = {
  segments: Array.from({ length: 60 }, (_, i) => seg(i * 6, PHRASES[i % PHRASES.length])),
}

const MOTS: Word[] = TRANSCRIPT.segments.flatMap((s) => s.words)

/**
 * Les mêmes mots sur une vidéo de 100 secondes. Les tests de rejet hors média
 * tronquent la liste plutôt que de baisser la seule durée : **les mots ne
 * survivent jamais à la vidéo**, ils en sont extraits. Garder 357 secondes de
 * parole sur une vidéo de 100 fabriquerait un monde impossible, et
 * `snapToWords` y ramène une fin trop lointaine sur la fin du média au lieu de
 * la laisser dehors — ce qui ferait passer le test pour la mauvaise raison.
 */
const MOTS_COURTS: Word[] = MOTS.filter((m) => m.end <= 100)

/** Une fenêtre nue, pour les tests qui ne regardent que les identifiants. */
function fen(id: string, start = 0, end = 90): Window {
  return { id, start, end, text: '', segFrom: 0, segTo: -1 }
}

/**
 * Un bloc qui couvre tout le transcript de test. Les clips des fixtures en
 * viennent tous : le contrôle de provenance ne doit pas les écarter.
 */
const BLOCS_LARGES = [fen('window_001', 0, 300)]

function détaille(
  brut: unknown,
  options: { words?: Word[]; videoDuration?: number; projectId?: string; blocks?: Window[] } = {},
) {
  return parseDetailResponse(brut, {
    words: options.words ?? MOTS,
    videoDuration: options.videoDuration ?? 3600,
    projectId: options.projectId ?? PROJET,
    blocks: options.blocks ?? BLOCS_LARGES,
  })
}

const ENTRÉES_DÉTAIL = {
  language: 'fr',
  videoDuration: 3600,
  windowsJson: '[]',
  minClips: 4,
  maxClips: 9,
}

describe('scorePrompt', () => {
  it('porte le barème ancré, qui est ce qui rend deux lots comparables', () => {
    const p = scorePrompt({ language: 'fr', videoDuration: 3600, windowsJson: '[]' })
    for (const palier of ['80-100', '50-79', '20-49', '0-19']) {
      expect(p).toContain(palier)
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
    // Aucun trou de gabarit laissé derrière : un `{language}` non remplacé se lit
    // par le modèle comme une consigne, pas comme une valeur manquante.
    expect(p).not.toMatch(/\{(language|video_duration|windows_json)\}/)
  })
})

describe('detailPrompt', () => {
  it('porte les cibles de nombre de clips', () => {
    expect(detailPrompt(ENTRÉES_DÉTAIL)).toContain('return 4 to 9 clips')
  })

  it('ne contient plus de plafond de durée', () => {
    const p = detailPrompt(ENTRÉES_DÉTAIL)
    expect(p).not.toMatch(/15 to 60 seconds/)
    // La ligne d'openshorts a disparu, et aucune autre ne la remplace : la durée
    // est un résultat, jamais une contrainte d'entrée (spec §5). C'est ce
    // plafond qui gardait 25 secondes de préambule et coupait la chute.
    expect(p).not.toMatch(/\d+\s+(to|-)\s+\d+\s+seconds long/)
    expect(p).not.toMatch(/seconds long/)
  })

  it('explique comment lire les marqueurs [SECONDS]', () => {
    const p = detailPrompt(ENTRÉES_DÉTAIL)
    expect(p).toContain('[123.400]')
    expect(p).toContain('do not round a marker to a whole number')
  })

  it('interpole la langue aux deux endroits où elle apparaît', () => {
    const p = detailPrompt({ ...ENTRÉES_DÉTAIL, language: 'français' })
    expect(p.match(/français/g) ?? []).toHaveLength(2)
    expect(p).not.toMatch(/\{(language|video_duration|windows_json|min_clips|max_clips)\}/)
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
    const fenêtres = buildWindows(TRANSCRIPT, 3600)
    const payload = JSON.parse(detailWindowsJson(fenêtres.slice(0, 1), TRANSCRIPT)) as {
      text: string
    }[]
    expect(payload[0].text).toMatch(/^\[0\.000\] alors moi je dis/)
    expect(payload[0].text).toContain('[6.000]')
  })
})

describe('parseScoreResponse', () => {
  const fenêtres = [fen('window_001'), fen('window_002'), fen('window_003'), fen('window_004')]

  it('réconcilie les fenêtres que le modèle a omises', () => {
    const { scored, missing } = parseScoreResponse(notation, fenêtres)
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
    const { scored } = parseScoreResponse(notation, fenêtres)
    expect(scored.map((s) => s.id)).not.toContain('window_999')
  })

  it('garde le premier avis sur une fenêtre notée deux fois', () => {
    const { scored } = parseScoreResponse(notation, fenêtres)
    const w1 = scored.filter((s) => s.id === 'window_001')
    expect(w1).toHaveLength(1)
    expect(w1[0].score).toBe(82)
  })

  it('ramène une note hors barème dans le barème', () => {
    const { scored } = parseScoreResponse(notation, fenêtres)
    expect(scored.find((s) => s.id === 'window_004')?.score).toBe(100)
  })

  it('une réponse illisible laisse toutes les fenêtres non notées', () => {
    for (const brut of [null, undefined, 'du texte', {}, { windows: 'non' }]) {
      const { scored, missing } = parseScoreResponse(brut, fenêtres)
      expect(missing).toHaveLength(4)
      expect(scored).toHaveLength(4)
      expect(scored.every((s) => s.score === 0)).toBe(true)
    }
  })

  it('ne modifie pas les fenêtres reçues', () => {
    const copie = structuredClone(fenêtres)
    parseScoreResponse(notation, fenêtres)
    expect(fenêtres).toEqual(copie)
  })
})

describe('shortlistFromScores', () => {
  // Douze fenêtres : `shortlistSize(12)` vaut 10, ce qui laisse voir un tri.
  const douze = Array.from({ length: 12 }, (_, i) => fen(`window_${String(i + 1).padStart(3, '0')}`))

  it('retient le haut du panier', () => {
    const notes = douze.map((w, i) => ({ id: w.id, score: i * 5, reason: '' }))
    const retenues = shortlistFromScores(notes, douze)
    expect(retenues).toHaveLength(10)
    expect(retenues[0].id).toBe('window_012')
    expect(retenues.map((w) => w.id)).not.toContain('window_001')
  })

  it('se rabat sur les premières fenêtres quand la notation n’a rien rendu', () => {
    const retenues = shortlistFromScores([], douze)
    expect(retenues.map((w) => w.id)).toEqual(douze.slice(0, 10).map((w) => w.id))
  })

  it('ne retient jamais une fenêtre qui n’a pas été soumise', () => {
    const retenues = shortlistFromScores([{ id: 'window_999', score: 100, reason: '' }], douze)
    expect(retenues.map((w) => w.id)).not.toContain('window_999')
    // La note fantôme ne mange pas non plus une place : dix fenêtres réelles
    // atteignent la présélection, pas neuf.
    expect(retenues).toHaveLength(10)
  })

  it('départage deux notes égales par l’ordre chronologique', () => {
    const notes = douze.map((w) => ({ id: w.id, score: 50, reason: '' }))
    const retenues = shortlistFromScores(notes, douze)
    expect(retenues.map((w) => w.id)).toEqual(douze.slice(0, 10).map((w) => w.id))
  })

  it('départage même quand le modèle a répondu dans le désordre', () => {
    // Le tri stable ne suffit pas : il préserve l'ordre de la RÉPONSE, que
    // Gemini choisit. Une égalité qui tombe pile sur la coupure admettait alors
    // une fenêtre tardive en écartant une fenêtre antérieure, au hasard.
    // (relevé par Codex et Copilot)
    const notes = [...douze].reverse().map((w) => ({ id: w.id, score: 50, reason: '' }))
    const retenues = shortlistFromScores(notes, douze)
    expect(retenues.map((w) => w.id)).toEqual(douze.slice(0, 10).map((w) => w.id))
  })

  it('une note plus haute passe toujours devant, désordre ou pas', () => {
    const notes = [
      { id: 'window_003', score: 10, reason: '' },
      { id: 'window_011', score: 99, reason: '' },
      { id: 'window_001', score: 50, reason: '' },
    ]
    const retenues = shortlistFromScores(notes, douze)
    expect(retenues.slice(0, 3).map((w) => w.id)).toEqual([
      'window_011',
      'window_001',
      'window_003',
    ])
  })
})

describe('parseDetailResponse', () => {
  it('cale les bornes rendues sur les frontières de mots', () => {
    const clips = détaille(détail)
    expect(clips.length).toBeGreaterThan(0)
    for (const c of clips) {
      expect(c.segments).toHaveLength(1)
      // Une borne calée tombe dans un silence, jamais au milieu d'un mot.
      for (const borne of [c.segments[0].start, c.segments[0].end]) {
        expect(MOTS.some((m) => m.start < borne && borne < m.end)).toBe(false)
      }
    }
  })

  it('ne rend aucun clip plafonné à 60 secondes', () => {
    const clips = détaille(détail)
    expect(clips.some((c) => clipDuration(c.segments) > 60)).toBe(true)
  })

  it('rejette un clip dont les bornes sortent de la vidéo', () => {
    expect(détaille(détailHorsMédia, { words: MOTS_COURTS, videoDuration: 100 })).toEqual([])
  })

  it('rejette un clip qui ne recoupe aucun bloc présélectionné', () => {
    // Le modèle n'a lu que le texte des blocs : des bornes sans le moindre
    // recouvrement ne viennent pas d'une lecture mais d'une invention, et elles
    // contourneraient les deux passes. (relevé par Copilot)
    const clips = détaille(détail, { blocks: [fen('window_001', 0, 50)] })
    expect(clips).toHaveLength(1)
    expect(clips[0].segments[0].start).toBeLessThan(50)
  })

  it('garde un clip qui dépasse le bord de son bloc de peu', () => {
    // Le prompt demande `end` au marqueur de la phrase SUIVANTE, et le calage
    // ajoute du silence : un débordement de quelques secondes est le cas normal,
    // pas une invention. Exiger le confinement écarterait de vrais clips.
    const clips = détaille(détail, { blocks: [fen('window_001', 0, 30)] })
    expect(clips).toHaveLength(1)
    expect(clips[0].segments[0].end).toBeGreaterThan(30)
  })

  it('sans aucun bloc, rien ne peut venir de nulle part', () => {
    expect(détaille(détail, { blocks: [] })).toEqual([])
  })

  it('ne jette que le clip hors média, pas le lot', () => {
    const clips = détaille(détail, { words: MOTS_COURTS, videoDuration: 100 })
    expect(clips).toHaveLength(1)
    expect(clips[0].segments[0].end).toBeLessThanOrEqual(100)
  })

  it('ignore une entrée illisible sans perdre les autres', () => {
    const clips = détaille(détail)
    // La fixture porte quatre entrées, dont une avec un `start` textuel.
    expect(clips).toHaveLength(3)
  })

  it('une réponse illisible ne rend rien plutôt que de lever', () => {
    for (const brut of [null, undefined, 'du texte', {}, { shorts: 'non' }]) {
      expect(détaille(brut)).toEqual([])
    }
  })

  it('rend des candidats prêts pour la fusion des passes', () => {
    const clips = détaille(détail)
    for (const c of clips) {
      expect(c.status).toBe('candidate')
      expect(c.projectId).toBe(PROJET)
      expect(c.ratio).toBe('auto')
      expect(c.cropX).toBe(0.5)
    }
    expect(clips[0].title).toBe('Il ne lâche jamais le pingouin')
    expect(clips[0].description).toContain('#impro')
  })

  it("l'identifiant dérive du projet et des bornes, jamais d’un compteur", () => {
    const clips = détaille(détail)
    for (const c of clips) {
      expect(c.id.startsWith(`${PROJET}_`)).toBe(true)
      // Un compteur reparti de 1 rendrait la garantie « un clip écarté ne
      // revient pas » inopérante : la même proposition reviendrait sous un
      // nouvel identifiant, et une proposition sans rapport hériterait du refus
      // prononcé sur le `clip_01` de la passe précédente.
      expect(c.id).not.toMatch(/clip_0*\d+$/)
      const bornes = c.id.slice(PROJET.length + 1)
      expect(bornes).toMatch(/^\d+-\d+$/)
    }
    expect(new Set(clips.map((c) => c.id)).size).toBe(clips.length)
  })

  it('les mêmes bornes redonnent le même identifiant, passe après passe', () => {
    const a = détaille(détail)
    const b = détaille(détail)
    expect(b.map((c) => c.id)).toEqual(a.map((c) => c.id))
  })

  it('deux projets aux mêmes bornes ne se partagent pas un identifiant', () => {
    const a = détaille(détail)
    const b = détaille(détail, { projectId: '2026-03-08-caro-mdlm' })
    expect(a.map((c) => c.id)).not.toEqual(b.map((c) => c.id))
    // `clips.id` est unique pour toute la base (`src/server/db.ts`) : deux
    // projets qui produiraient le même identifiant se voleraient leurs clips.
    for (const id of b.map((c) => c.id)) {
      expect(a.map((c) => c.id)).not.toContain(id)
    }
  })

  it('des bornes distinctes à la milliseconde près donnent des identifiants distincts', () => {
    const brut = {
      shorts: [
        { start: 12.0, end: 41.4 },
        { start: 12.001, end: 41.4 },
      ],
    }
    // Sans mots, `snapToWords` rend les bornes telles quelles : c'est le cas où
    // l'identifiant doit encore séparer deux propositions voisines.
    const clips = détaille(brut, { words: [] })
    expect(new Set(clips.map((c) => c.id)).size).toBe(2)
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
