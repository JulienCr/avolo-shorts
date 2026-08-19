import { describe, expect, it } from 'vitest'

import { progressWorker, titleProject } from '@/core/pipeline'

describe('titleProject', () => {
  it('passe la date derrière et garde ce qui distingue l’émission', () => {
    expect(titleProject('2025-06-15-cqlp')).toBe('cqlp — 15 juin 2025')
    expect(titleProject('2026-03-08-caro-mdlm')).toBe('caro mdlm — 8 mars 2026')
  })

  it('rend la date seule quand le nom n’a rien d’autre', () => {
    expect(titleProject('2026-03-08')).toBe('8 mars 2026')
  })

  it('rend tel quel un nom qui ne suit pas la convention', () => {
    expect(titleProject('essai-du-soir')).toBe('essai-du-soir')
    expect(titleProject('2026-13-08-x')).toBe('2026-13-08-x')
  })

  // Une date impossible affirmée en toutes lettres est pire qu'un nom brut : elle
  // se lit comme une information. (relevé par Copilot)
  it('refuse un jour qui n’existe pas dans son mois', () => {
    expect(titleProject('2026-02-31-x')).toBe('2026-02-31-x')
    expect(titleProject('2026-06-00-x')).toBe('2026-06-00-x')
    expect(titleProject('2026-06-31-x')).toBe('2026-06-31-x')
    // 2024 est bissextile, 2026 ne l'est pas.
    expect(titleProject('2024-02-29-x')).toBe('x — 29 février 2024')
    expect(titleProject('2026-02-29-x')).toBe('2026-02-29-x')
  })
})

describe('progressWorker', () => {
  it('rend la fraction des étapes terminées', () => {
    expect(progressWorker('[1/4] Chargement du modèle large-v3 sur cuda…')).toBe(0)
    expect(progressWorker('[3/4] Transcription (batch 16, langue fr)…')).toBe(0.5)
    expect(progressWorker('[4/4] Alignement mot à mot…')).toBe(0.75)
  })

  it('ignore une ligne sans marqueur', () => {
    expect(progressWorker('      5936.9 s')).toBeNull()
    expect(progressWorker('')).toBeNull()
  })

  /**
   * Les deux workers écrivent leurs phases sous la même forme, et le second en
   * écrit aussi l'avancement **à l'intérieur** d'une phase. Cette ligne-là ne
   * doit surtout pas porter de crochets : `[1620/11874]` serait lu comme une
   * étape 1620 sur 11874, donc une progression qui retombe à zéro et y reste
   * pendant les trois minutes de détection.
   */
  it('lit les phases de detect.py sans se laisser prendre par ses compteurs', () => {
    expect(progressWorker('[1/4] Frontières de plans (score de scène ≥ 0.4)…')).toBe(0)
    expect(progressWorker('[3/4] Détection des corps (11874 images à 2.0 im/s…')).toBe(0.5)
    expect(progressWorker('      1620/11874 images (14 %), 124 im/s')).toBeNull()
    expect(progressWorker('      131 plans, 130 frontières retenues sur 1232 candidates')).toBeNull()
  })
})
