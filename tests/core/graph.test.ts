import { describe, it, expect } from 'vitest'
import { dependenciesOf, planSteps, readySteps, type StepName } from '@/core/graph'

/**
 * Le graphe de l'itération 0 : la **présence d'un fichier**, pas encore une clé
 * de validité (spec §4). Les clés — version d'outil, paramètres, empreinte des
 * entrées — viennent en itération 4 ; ici, un artefact présent est un artefact
 * bon.
 */

const none: Record<StepName, boolean> = {
  proxy: false,
  audio: false,
  transcript: false,
  correction: false,
  analysis: false,
  candidates: false,
  renders: false,
}

const all: Record<StepName, boolean> = {
  proxy: true,
  audio: true,
  transcript: true,
  correction: true,
  analysis: true,
  candidates: true,
  renders: true,
}

describe('planSteps', () => {
  it('remonte les dépendances manquantes, dans l’ordre', () => {
    expect(planSteps('candidates', none)).toEqual([
      'audio',
      'transcript',
      'correction',
      'candidates',
    ])
  })

  // `correction` s'intercale entre `transcript` et `candidates` (spec §5, §9,
  // correction du 23 août 2026) : `candidates` ne dépend plus directement du
  // transcript, donc son absence seule ne suffit plus à limiter le plan au
  // seul repérage.
  it('refait la correction avant le repérage si le transcript existe déjà mais pas la correction', () => {
    expect(planSteps('candidates', { ...none, audio: true, transcript: true })).toEqual([
      'correction',
      'candidates',
    ])
  })

  it('ne relance que le repérage si transcript et correction existent déjà', () => {
    expect(
      planSteps('candidates', { ...none, audio: true, transcript: true, correction: true }),
    ).toEqual(['candidates'])
  })

  it('ne calcule rien si la cible est là', () => {
    expect(planSteps('transcript', { ...none, audio: true, transcript: true })).toEqual([])
  })

  it('ne construit pas le proxy pour atteindre le transcript', () => {
    expect(planSteps('transcript', none)).not.toContain('proxy')
  })

  it('force recalcule l’étape visée et tout ce qui en dépend', () => {
    expect(planSteps('renders', all, ['transcript'])).toEqual([
      'transcript',
      'correction',
      'candidates',
      'renders',
    ])
  })

  // Le cas courant, et pas un cas limite : le transcript vit dans un sidecar à
  // côté de la vidéo et survit à la suppression du projet, `audio.wav` non.
  // Recréer le projet donne exactement cet état. Remonter la présence rendrait
  // le WAV puis retranscrirait deux heures cinquante pour réécrire à
  // l'identique ce qui était déjà là. (relevé par Copilot)
  it('ne refait pas l’audio disparu sous un transcript toujours là', () => {
    expect(planSteps('candidates', { ...none, transcript: true })).toEqual([
      'correction',
      'candidates',
    ])
  })

  it('refait quand même l’audio si le transcript manque aussi', () => {
    expect(planSteps('candidates', none)).toEqual([
      'audio',
      'transcript',
      'correction',
      'candidates',
    ])
  })

  it('force la cible elle-même, artefact présent ou non', () => {
    expect(planSteps('transcript', all, ['transcript'])).toEqual(['transcript'])
  })

  // Le cas « changer de logo » de la spec §5 : le style n'entre que dans le
  // rendu, donc reforcer les rendus ne doit pas retranscrire deux heures
  // d'audio. C'est la propriété du graphe qui rend ce changement bon marché,
  // et elle mérite d'être prouvée plutôt que supposée. (relevé par Aristarque)
  it('ne remonte pas au-dessus de l’étape forcée', () => {
    expect(planSteps('renders', all, ['renders'])).toEqual(['renders'])
    expect(planSteps('candidates', all, ['candidates'])).toEqual(['candidates'])
  })

  // `force` dit *comment* atteindre la cible, il n'ajoute pas de cible.
  it('ignore une étape forcée qui ne mène pas à la cible', () => {
    expect(planSteps('transcript', all, ['proxy'])).toEqual([])
  })

  it('remonte jusqu’à l’étape forcée, sans dépasser', () => {
    expect(planSteps('candidates', all, ['audio'])).toEqual([
      'audio',
      'transcript',
      'correction',
      'candidates',
    ])
  })
})

/**
 * `correction` (spec §5, §9 — correction du 23 août 2026) : le repérage doit
 * lire le texte corrigé, jamais le brut, et une retranscription doit refaire
 * la correction avec lui — c'est tout l'objet de cette PR, et c'est la
 * propriété qui casse le plus cher si elle se rompt (« une erreur
 * d'invalidation se paie sur toutes les émissions »).
 */
describe('planSteps — correction', () => {
  it('s’intercale entre transcript et candidates', () => {
    expect(planSteps('correction', none)).toEqual(['audio', 'transcript', 'correction'])
  })

  it('ne dépend que du transcript, pas du proxy ni de l’audio directement', () => {
    const plan = planSteps('correction', { ...none, transcript: true })
    expect(plan).toEqual(['correction'])
  })

  // La propriété centrale du basculement : forcer une retranscription doit
  // refaire la correction **et** le repérage, sans qu'il faille le nommer
  // nulle part d'autre que `transcript` — c'est `forced` qui descend dans
  // l'aval (`src/core/graph.ts`).
  it('une retranscription forcée refait la correction et le repérage', () => {
    expect(planSteps('candidates', all, ['transcript'])).toEqual([
      'transcript',
      'correction',
      'candidates',
    ])
  })

  it('forcer la correction seule refait aussi le repérage qui en dépend', () => {
    expect(planSteps('candidates', all, ['correction'])).toEqual(['correction', 'candidates'])
  })

  // La réciproque de la propriété ci-dessus : un `correction.json` présent
  // sous un transcript présent ne relance pas l'étape — la présence ne remonte
  // pas, et c'est exactement ce qui distingue ce graphe d'un `make`.
  it('un correction.json présent sous un transcript présent ne relance rien', () => {
    expect(planSteps('candidates', { ...none, transcript: true, correction: true })).toEqual([
      'candidates',
    ])
  })

  // Le cas qui compte le plus des trois : c'est exactement l'état dans lequel
  // une panne du modèle laisse un projet (candidats calculés sur du texte non
  // corrigé) — la présence de `candidates` ne remonte pas non plus, et le
  // rattrapage passe par `force: ['correction']`, jamais par ce test.
  it('un correction.json absent sous un candidates.json présent ne relance rien non plus', () => {
    expect(planSteps('candidates', { ...none, candidates: true })).toEqual([])
  })
})

/**
 * `TARGETS_INITIAL` (`src/server/run.ts`) vise `candidates`, `proxy` et
 * `analysis` — jamais `correction` directement. La propriété qui rend ça
 * suffisant : viser `candidates` sur un projet neuf construit `correction`
 * avec lui, par la seule dépendance du graphe, sans qu'`initial_prompt` ait
 * besoin de la nommer. Prouvé ici plutôt que supposé (demandé par la revue du
 * plan de cette PR).
 */
describe('planSteps — TARGETS_INITIAL', () => {
  it('candidates entraîne correction avec lui sur un projet neuf', () => {
    const plan = planSteps('candidates', none)
    expect(plan.indexOf('correction')).toBeGreaterThanOrEqual(0)
    expect(plan.indexOf('correction')).toBeLessThan(plan.indexOf('candidates'))
  })
})

/**
 * L'analyse d'image (spec §6) : YOLO et le score de scène tournent sur le proxy,
 * et sur rien d'autre. Ces quatre cas figent la symétrie avec `transcript` — une
 * étape qui lit le son, une étape qui lit l'image, et aucune qui attende
 * l'autre.
 */
describe('planSteps — analysis', () => {
  it('construit le proxy, et lui seul, pour atteindre l’analyse', () => {
    expect(planSteps('analysis', none)).toEqual(['proxy', 'analysis'])
  })

  it('ne touche ni à l’audio ni au transcript', () => {
    const plan = planSteps('analysis', none)
    expect(plan).not.toContain('audio')
    expect(plan).not.toContain('transcript')
  })

  it('ne refait rien quand le proxy et l’analyse sont là', () => {
    expect(planSteps('analysis', { ...none, proxy: true, analysis: true })).toEqual([])
  })

  // Un proxy refait est un proxy dont les images ont pu changer — cadence,
  // dimensions, encodeur. Les boîtes qui en viennent ne valent plus rien.
  it('reprend l’analyse quand le proxy est forcé', () => {
    expect(planSteps('analysis', all, ['proxy'])).toEqual(['proxy', 'analysis'])
  })

  // La réciproque n'est pas vraie : l'analyse ne porte rien en aval du graphe,
  // et le rendu se lance par clip, jamais par le graphe.
  it('ne fait pas repartir le repérage des candidats', () => {
    expect(planSteps('candidates', all, ['analysis'])).toEqual([])
  })
})

describe('dependenciesOf', () => {
  it('renvoie les dépendances directes de chaque étape', () => {
    expect(dependenciesOf('candidates')).toEqual(['correction'])
    expect(dependenciesOf('proxy')).toEqual([])
  })
})

/**
 * `readySteps` knows nothing about resources or priority — the executor
 * applies those — its only job is which steps have no pending dependency
 * **within this plan**.
 */
describe('readySteps', () => {
  const none = new Set<StepName>()

  // A dependency absent from the plan is already on disk (`planSteps`'
  // contract): without this rule, `['correction', 'candidates']` on a
  // transcript already there would block forever.
  it('ne bloque pas sur une dépendance absente du plan', () => {
    expect(readySteps(['correction', 'candidates'], none, none)).toEqual(['correction'])
  })

  it('bloque sur une dépendance du plan qui n’est ni faite ni en cours', () => {
    expect(readySteps(['audio', 'transcript'], none, none)).toEqual(['audio'])
    expect(readySteps(['audio', 'transcript'], new Set(['audio']), none)).toEqual(['transcript'])
  })

  it('n’admet pas deux fois une étape déjà en cours', () => {
    expect(readySteps(['proxy', 'analysis'], none, new Set(['proxy']))).toEqual([])
  })

  it('n’admet pas une étape déjà faite', () => {
    expect(readySteps(['proxy', 'analysis'], new Set(['proxy']), none)).toEqual(['analysis'])
  })

  it('rend deux branches indépendantes prêtes à la fois, dans l’ordre du plan', () => {
    expect(readySteps(['audio', 'proxy', 'transcript'], none, none)).toEqual(['audio', 'proxy'])
  })
})
