/**
 * Le registre des cas de cadrage : ce qui vivait en prose dans la skill
 * `cadrage` § « Mesurer » et dans le corps de l'issue #190, rendu exécutable
 * (issue #191, lot 1).
 *
 * **Données pures, aucun accès disque.** `projects/` est gitignoré : un clone
 * frais n'a aucune analyse sur le disque. Un test qui importerait ce fichier et
 * réussirait quand même ne prouverait donc **jamais rien** sur ce
 * clone-là — c'est la résolution contre `analysis.json`
 * (`scripts/framing/case-registry.ts`) qui touche le disque, jamais ce fichier.
 *
 * Un cas n'est **jamais supprimé, seulement retiré** (`retired`), qui garde
 * `why` et l'ancien `probes`. Un cas supprimé est un test de régression perdu
 * en silence : le risque s'est déjà réalisé une fois, le 25 août 2026, quand le
 * résultat attendu de `cqlp` 2120 s a changé (un 1:1 partagé n'est plus visé).
 */

import type { Ratio } from '@/core/edl'
import type { SplitRejection } from '@/core/framing'

export const REGISTRY_REVISION = 1

export const PROJECTS = {
  cqlp: '2025-06-15-cqlp',
  handicap: '2025-12-14-handicap',
  'caro-mdlm': '2026-03-08-caro-mdlm',
  fmr: '2026-04-24-fmr',
  nabla: '2026-05-31-nabla',
  'entre-nous': '2026-22-02-entre-nous',
} as const satisfies Record<string, string>

export type ShowName = keyof typeof PROJECTS
export type ProjectId = (typeof PROJECTS)[ShowName]

export type IsoDay = `${number}-${number}-${number}`
export type Call = 'keep' | 'drop' | 'unsure'

/**
 * Ce que le code produisait sur ce cas à cette date — un TÉMOIN, pas une
 * attente. Un écart dit « le comportement a changé, va voir », jamais « c'est
 * une régression » : trois des cas portent aujourd'hui un split que le
 * propriétaire a rejeté, et #190 le corrigera.
 */
export type CaseBaseline = {
  ratio: Ratio
  split: boolean
  rejection: SplitRejection | null
  on: IsoDay
}

/** Un verdict posé par un humain. Ne partage aucun champ avec `HeuristicTag`. */
export type HumanLabel = {
  call: Call
  /** Un identifiant GitHub, jamais une adresse email. */
  by: string
  on: IsoDay
  /** Ses mots à lui ; vide s'il n'en a laissé aucun, jamais rempli à sa place. */
  note: string
  /** `'issue #190'`, `'skill cadrage'`, `'planche 2026-08-27'`. */
  from: string
}

/**
 * Ce qu'une règle a trouvé, à distinguer structurellement d'un `HumanLabel` :
 * un outil qui découvre un cas écrit un `tag`, jamais un `label`.
 */
export type HeuristicTag = {
  rule: string
  outcome: string
  /** Le commit auquel la règle a été évaluée. */
  at: string
  on: IsoDay
}

/**
 * Ce que le cas porte : toute la source, un plan entier, ou un clip précis.
 *
 * **Un cas ne peut pas se clé sur un clip** : mesuré, 6 des 13 instants ne
 * tombent dans aucun clip de `projects/avolo.db`, et `cqlp` 2138 s tombe dans
 * deux clips qui se recouvrent.
 */
export type CaseScope = { over: 'source' } | { over: 'shot' } | { over: 'clip'; clipId: string }

/**
 * Où le cas s'ancre : un plan entier avec ses instants d'intérêt, ou un
 * instant seul.
 *
 * **Une union, pas `shot: Shot | null`** : avec l'union, lire `c.anchor.shot`
 * sans avoir d'abord discriminé `at` est une erreur de compilation, donc on ne
 * peut pas lire un intervalle qui n'a jamais été observé. Les cinq cas de la
 * skill n'ont jamais eu qu'un instant relevé.
 */
export type CaseAnchor =
  | { at: 'shot'; shot: { start: number; end: number }; instants: readonly [number, ...number[]] }
  | { at: 'instant'; instants: readonly [number, ...number[]] }

export type FramingCase = {
  id: string
  show: ShowName
  scope: CaseScope
  anchor: CaseAnchor
  /** En français : ce que le cas éprouve, pas le verdict qu'il a reçu. */
  probes: string
  label: HumanLabel | null
  tags: readonly HeuristicTag[]
  origin: string
  retired: { on: IsoDay; why: string; was: string } | null
  baseline: CaseBaseline | null
}

/**
 * `${show}-${round(instants[0] * 1000)}` — la même convention `round(t*1000)`
 * que `shotStartMs` (`src/core/shots.ts`), pour que l'identifiant se relise
 * comme une clé de plan.
 */
export function caseId(c: Pick<FramingCase, 'show' | 'anchor'>): string {
  return `${c.show}-${Math.round(c.anchor.instants[0] * 1000)}`
}

export function projectOf(c: FramingCase): ProjectId {
  return PROJECTS[c.show]
}

export function findCase(id: string): FramingCase | undefined {
  return FRAMING_CASES.find((c) => c.id === id)
}

const KEYWORDS = ['all', 'active', 'labelled', 'unlabelled', 'keep', 'drop', 'unsure'] as const
type Keyword = (typeof KEYWORDS)[number]

function isShowName(token: string): token is ShowName {
  // `in` remonte le prototype : `'hasOwnProperty'` s'y lirait comme un nom
  // d'émission valide (relevé par Aristarque sur la #192).
  return Object.hasOwn(PROJECTS, token)
}

function matchesToken(c: FramingCase, token: Keyword | ShowName | string): boolean {
  switch (token) {
    case 'all':
      return true
    case 'active':
      return c.retired === null
    case 'labelled':
      return c.label !== null
    case 'unlabelled':
      return c.label === null
    case 'keep':
    case 'drop':
    case 'unsure':
      return c.label?.call === token
    default:
      return isShowName(token) ? c.show === token : c.id === token
  }
}

/**
 * Résout un sélecteur : un mot-clé, un nom d'émission, un identifiant de cas,
 * ou une liste séparée par des virgules — union de ce que chaque terme
 * désigne.
 *
 * **Un terme inconnu lève, il ne rend jamais `[]`.** Une planche vide serait
 * lue comme « rien à montrer » plutôt que comme la faute de frappe qu'elle est.
 */
export function selectCases(
  selector: string,
  from: readonly FramingCase[] = FRAMING_CASES,
): FramingCase[] {
  const tokens = selector
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (tokens.length === 0) {
    throw new Error(`sélecteur vide.`)
  }
  const result: FramingCase[] = []
  for (const token of tokens) {
    const known =
      (KEYWORDS as readonly string[]).includes(token) ||
      isShowName(token) ||
      from.some((c) => c.id === token)
    if (!known) {
      throw new Error(
        `sélecteur inconnu : « ${token} ». Attendu : ${KEYWORDS.join(', ')}, un nom ` +
          `d'émission (${Object.keys(PROJECTS).join(', ')}), un identifiant de cas, ou une ` +
          'liste de ces termes séparée par des virgules.',
      )
    }
    for (const c of from) {
      if (matchesToken(c, token) && !result.includes(c)) result.push(c)
    }
  }
  return result
}

export const FRAMING_CASES: readonly FramingCase[] = [
  // Les cinq cas de la skill `cadrage` § « Mesurer ».
  {
    id: 'entre-nous-2973000',
    show: 'entre-nous',
    scope: { over: 'source' },
    anchor: { at: 'instant', instants: [2973] },
    probes: 'Le tronc contre la boîte — un comédien assis, jambes tendues.',
    label: null,
    tags: [],
    origin: 'skill cadrage § Mesurer',
    retired: null,
    baseline: { ratio: '4:5', split: false, rejection: 'tooShort', on: '2026-08-26' },
  },
  {
    id: 'caro-mdlm-7250000',
    show: 'caro-mdlm',
    scope: { over: 'source' },
    anchor: { at: 'instant', instants: [7250] },
    probes: "Qu'un rognage aveugle perd un visage — tête à l'extrémité de sa boîte.",
    label: null,
    tags: [],
    origin: 'skill cadrage § Mesurer',
    retired: null,
    baseline: { ratio: '16:9', split: false, rejection: 'bleedsIntoOther', on: '2026-08-26' },
  },
  {
    id: 'cqlp-2120000',
    show: 'cqlp',
    scope: { over: 'source' },
    anchor: { at: 'instant', instants: [2120] },
    probes:
      'Que le split-screen tienne les deux bustes, chacun dans sa cellule. Un 1:1 partagé ' +
      "n'est plus le résultat attendu depuis le 25 août 2026 " +
      '(`docs/superpowers/specs/2026-08-25-split-screen-design.md`).',
    label: null,
    tags: [],
    origin: 'skill cadrage § Mesurer',
    retired: null,
    baseline: { ratio: '1:1', split: false, rejection: 'bleedsIntoOther', on: '2026-08-26' },
  },
  {
    id: 'cqlp-2138000',
    show: 'cqlp',
    scope: { over: 'source' },
    // Intervalle enregistré exprès : l'instant tombe 33 ms après la frontière
    // 2137,967, sur une grille à 2 im/s. C'est le cas le plus susceptible de
    // basculer pour une raison étrangère au cadrage — sans l'intervalle,
    // personne ne saurait pourquoi.
    anchor: { at: 'shot', shot: { start: 2137.967, end: 2186.233 }, instants: [2138] },
    probes: "Ce qu'aucune largeur ne résout — gros plan à boîtes instables.",
    label: null,
    tags: [],
    origin: 'skill cadrage § Mesurer',
    retired: null,
    baseline: { ratio: '16:9', split: false, rejection: 'tooNarrowForSource', on: '2026-08-26' },
  },
  {
    id: 'caro-mdlm-652500',
    show: 'caro-mdlm',
    scope: { over: 'source' },
    anchor: { at: 'shot', shot: { start: 652.467, end: 722.133 }, instants: [652.5] },
    probes:
      "Qu'une frontière posée corresponde à une coupe — bascule acceptée sans coupe. Le seul " +
      "cas qui éprouve une frontière et non un cadre : il ne se voit qu'en regardant les deux " +
      "images qui l'encadrent.",
    label: null,
    tags: [],
    origin: 'skill cadrage § Mesurer',
    retired: null,
    baseline: { ratio: '16:9', split: false, rejection: 'bleedsIntoOther', on: '2026-08-26' },
  },
  // Les huit cas de l'issue #190, table « Les cas de référence, à garder
  // comme jeu d'épreuve ». `nabla` 1798,867 s et 1607,967 s sont deux plans
  // distincts d'une même ligne de la table : douze cas selon l'issue, treize
  // ici, parce qu'un verdict est par plan.
  {
    id: 'nabla-2056800',
    show: 'nabla',
    scope: { over: 'source' },
    anchor: { at: 'shot', shot: { start: 2056.8, end: 2065.833 }, instants: [2056.8] },
    probes: "Un vrai profil à deux visages lisibles — que la règle de frontalité ne l'écarte pas.",
    label: {
      call: 'keep',
      by: 'JulienCr',
      on: '2026-08-26',
      note: 'un vrai profil, deux visages lisibles',
      from: 'issue #190',
    },
    tags: [],
    origin: 'issue #190',
    retired: null,
    baseline: { ratio: '16:9', split: true, rejection: null, on: '2026-08-26' },
  },
  {
    id: 'nabla-1798867',
    show: 'nabla',
    scope: { over: 'source' },
    anchor: { at: 'shot', shot: { start: 1798.867, end: 1840.2 }, instants: [1798.867] },
    probes: 'Un profil qui a réfuté le seuil de frontalité — visage lisible malgré une frontalité basse.',
    label: {
      call: 'keep',
      by: 'JulienCr',
      on: '2026-08-26',
      note: 'deux autres vrais profils — ils ont réfuté le seuil de frontalité',
      from: 'issue #190',
    },
    tags: [],
    origin: 'issue #190',
    retired: null,
    baseline: { ratio: '16:9', split: true, rejection: null, on: '2026-08-26' },
  },
  {
    id: 'nabla-1607967',
    show: 'nabla',
    scope: { over: 'source' },
    anchor: { at: 'shot', shot: { start: 1607.967, end: 1618.433 }, instants: [1607.967] },
    probes: 'Un second profil qui réfute le même seuil, sur un plan distinct du précédent.',
    label: {
      call: 'keep',
      by: 'JulienCr',
      on: '2026-08-26',
      note: 'deux autres vrais profils — ils ont réfuté le seuil de frontalité',
      from: 'issue #190',
    },
    tags: [],
    origin: 'issue #190',
    retired: null,
    baseline: { ratio: '16:9', split: true, rejection: null, on: '2026-08-26' },
  },
  {
    id: 'nabla-2077400',
    show: 'nabla',
    scope: { over: 'source' },
    anchor: { at: 'shot', shot: { start: 2077.4, end: 2083.933 }, instants: [2077.4] },
    probes: 'Un trois-quarts dos stable — que la règle sache l\'écarter sans le confondre avec un profil.',
    label: {
      call: 'drop',
      by: 'JulienCr',
      on: '2026-08-26',
      note: 'trois-quarts dos, stable sur 13 images',
      from: 'issue #190',
    },
    tags: [],
    origin: 'issue #190',
    retired: null,
    baseline: { ratio: '1:1', split: true, rejection: null, on: '2026-08-26' },
  },
  {
    id: 'nabla-6418667',
    show: 'nabla',
    scope: { over: 'source' },
    anchor: { at: 'shot', shot: { start: 6418.667, end: 6427.367 }, instants: [6418.667] },
    probes: "Une nuque, `facing == 'unknown'` sur tout le plan — le cas binaire de tête absente.",
    label: {
      call: 'drop',
      by: 'JulienCr',
      on: '2026-08-26',
      note: "nuque, `facing == 'unknown'` sur 17 images",
      from: 'issue #190',
    },
    tags: [],
    origin: 'issue #190',
    retired: null,
    baseline: { ratio: '1:1', split: true, rejection: null, on: '2026-08-26' },
  },
  {
    id: 'cqlp-1366033',
    show: 'cqlp',
    scope: { over: 'source' },
    anchor: { at: 'shot', shot: { start: 1366.033, end: 1372.0 }, instants: [1366.033] },
    probes: "Des têtes tronquées par le cadre — que l'indicateur de troncature les attrape.",
    label: {
      call: 'drop',
      by: 'JulienCr',
      on: '2026-08-26',
      note: 'têtes tronquées',
      from: 'issue #190',
    },
    tags: [],
    origin: 'issue #190',
    retired: null,
    baseline: { ratio: '16:9', split: true, rejection: null, on: '2026-08-26' },
  },
  {
    id: 'entre-nous-3495867',
    show: 'entre-nous',
    scope: { over: 'source' },
    anchor: { at: 'shot', shot: { start: 3495.867, end: 3507.633 }, instants: [3495.867] },
    probes: 'Une tête tronquée, où un cadre plus large vaudrait mieux qu\'un resserrement.',
    label: {
      call: 'drop',
      by: 'JulienCr',
      on: '2026-08-26',
      note: 'tête tronquée ; un 1:1 ou 4:5 unique vaudrait mieux',
      from: 'issue #190',
    },
    tags: [],
    origin: 'issue #190',
    retired: null,
    baseline: { ratio: '16:9', split: true, rejection: null, on: '2026-08-26' },
  },
  {
    id: 'fmr-1115733',
    show: 'fmr',
    scope: { over: 'source' },
    anchor: { at: 'shot', shot: { start: 1115.733, end: 1120.767 }, instants: [1115.733] },
    probes: 'Une cellule sans aucune tête — le cas binaire de tête absente, sur une autre émission.',
    label: {
      call: 'drop',
      by: 'JulienCr',
      on: '2026-08-26',
      note: 'aucune tête dans la cellule du haut',
      from: 'issue #190',
    },
    tags: [],
    origin: 'issue #190',
    retired: null,
    baseline: { ratio: '16:9', split: true, rejection: null, on: '2026-08-26' },
  },
]
