import { describe, it, expect } from 'vitest'
import { planSteps, type StepName } from '@/core/graph'

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
  candidates: false,
  renders: false,
}

describe('planSteps', () => {
  it('remonte les dépendances manquantes, dans l’ordre', () => {
    expect(planSteps('candidates', none)).toEqual(['audio', 'transcript', 'candidates'])
  })

  it('ne relance que le repérage si le transcript existe déjà', () => {
    expect(planSteps('candidates', { ...none, audio: true, transcript: true })).toEqual([
      'candidates',
    ])
  })

  it('ne calcule rien si la cible est là', () => {
    expect(planSteps('transcript', { ...none, audio: true, transcript: true })).toEqual([])
  })

  it('ne construit pas le proxy pour atteindre le transcript', () => {
    expect(planSteps('transcript', none)).not.toContain('proxy')
  })

  it('force recalcule l’étape visée et tout ce qui en dépend', () => {
    const all: Record<StepName, boolean> = {
      proxy: true,
      audio: true,
      transcript: true,
      candidates: true,
      renders: true,
    }
    expect(planSteps('renders', all, ['transcript'])).toEqual([
      'transcript',
      'candidates',
      'renders',
    ])
  })
})
