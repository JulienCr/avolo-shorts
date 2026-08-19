import { describe, it, expect } from 'vitest'
import { shotSteps, type StepName } from '@/core/graph'

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
  analysis: false,
  candidates: false,
  renders: false,
}

const all: Record<StepName, boolean> = {
  proxy: true,
  audio: true,
  transcript: true,
  analysis: true,
  candidates: true,
  renders: true,
}

describe('planSteps', () => {
  it('remonte les dépendances manquantes, dans l’ordre', () => {
    expect(shotSteps('candidates', none)).toEqual(['audio', 'transcript', 'candidates'])
  })

  it('ne relance que le repérage si le transcript existe déjà', () => {
    expect(shotSteps('candidates', { ...none, audio: true, transcript: true })).toEqual([
      'candidates',
    ])
  })

  it('ne calcule rien si la cible est là', () => {
    expect(shotSteps('transcript', { ...none, audio: true, transcript: true })).toEqual([])
  })

  it('ne construit pas le proxy pour atteindre le transcript', () => {
    expect(shotSteps('transcript', none)).not.toContain('proxy')
  })

  it('force recalcule l’étape visée et tout ce qui en dépend', () => {
    expect(shotSteps('renders', all, ['transcript'])).toEqual([
      'transcript',
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
    expect(shotSteps('candidates', { ...none, transcript: true })).toEqual(['candidates'])
  })

  it('refait quand même l’audio si le transcript manque aussi', () => {
    expect(shotSteps('candidates', none)).toEqual(['audio', 'transcript', 'candidates'])
  })

  it('force la cible elle-même, artefact présent ou non', () => {
    expect(shotSteps('transcript', all, ['transcript'])).toEqual(['transcript'])
  })

  // Le cas « changer de logo » de la spec §5 : le style n'entre que dans le
  // rendu, donc reforcer les rendus ne doit pas retranscrire deux heures
  // d'audio. C'est la propriété du graphe qui rend ce changement bon marché,
  // et elle mérite d'être prouvée plutôt que supposée. (relevé par Aristarque)
  it('ne remonte pas au-dessus de l’étape forcée', () => {
    expect(shotSteps('renders', all, ['renders'])).toEqual(['renders'])
    expect(shotSteps('candidates', all, ['candidates'])).toEqual(['candidates'])
  })

  // `force` dit *comment* atteindre la cible, il n'ajoute pas de cible.
  it('ignore une étape forcée qui ne mène pas à la cible', () => {
    expect(shotSteps('transcript', all, ['proxy'])).toEqual([])
  })

  it('remonte jusqu’à l’étape forcée, sans dépasser', () => {
    expect(shotSteps('candidates', all, ['audio'])).toEqual([
      'audio',
      'transcript',
      'candidates',
    ])
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
    expect(shotSteps('analysis', none)).toEqual(['proxy', 'analysis'])
  })

  it('ne touche ni à l’audio ni au transcript', () => {
    const shot = shotSteps('analysis', none)
    expect(shot).not.toContain('audio')
    expect(shot).not.toContain('transcript')
  })

  it('ne refait rien quand le proxy et l’analyse sont là', () => {
    expect(shotSteps('analysis', { ...none, proxy: true, analysis: true })).toEqual([])
  })

  // Un proxy refait est un proxy dont les images ont pu changer — cadence,
  // dimensions, encodeur. Les boîtes qui en viennent ne valent plus rien.
  it('reprend l’analyse quand le proxy est forcé', () => {
    expect(shotSteps('analysis', all, ['proxy'])).toEqual(['proxy', 'analysis'])
  })

  // La réciproque n'est pas vraie : l'analyse ne porte rien en aval du graphe,
  // et le rendu se lance par clip, jamais par le graphe.
  it('ne fait pas repartir le repérage des candidats', () => {
    expect(shotSteps('candidates', all, ['analysis'])).toEqual([])
  })
})
