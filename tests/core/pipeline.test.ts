import { describe, expect, it } from 'vitest'

import { avancementWorker, titreProjet } from '@/core/pipeline'

describe('titreProjet', () => {
  it('passe la date derrière et garde ce qui distingue l’émission', () => {
    expect(titreProjet('2025-06-15-cqlp')).toBe('cqlp — 15 juin 2025')
    expect(titreProjet('2026-03-08-caro-mdlm')).toBe('caro mdlm — 8 mars 2026')
  })

  it('rend la date seule quand le nom n’a rien d’autre', () => {
    expect(titreProjet('2026-03-08')).toBe('8 mars 2026')
  })

  it('rend tel quel un nom qui ne suit pas la convention', () => {
    expect(titreProjet('essai-du-soir')).toBe('essai-du-soir')
    expect(titreProjet('2026-13-08-x')).toBe('2026-13-08-x')
  })

  // Une date impossible affirmée en toutes lettres est pire qu'un nom brut : elle
  // se lit comme une information. (relevé par Copilot)
  it('refuse un jour qui n’existe pas dans son mois', () => {
    expect(titreProjet('2026-02-31-x')).toBe('2026-02-31-x')
    expect(titreProjet('2026-06-00-x')).toBe('2026-06-00-x')
    expect(titreProjet('2026-06-31-x')).toBe('2026-06-31-x')
    // 2024 est bissextile, 2026 ne l'est pas.
    expect(titreProjet('2024-02-29-x')).toBe('x — 29 février 2024')
    expect(titreProjet('2026-02-29-x')).toBe('2026-02-29-x')
  })
})

describe('avancementWorker', () => {
  it('rend la fraction des étapes terminées', () => {
    expect(avancementWorker('[1/4] Chargement du modèle large-v3 sur cuda…')).toBe(0)
    expect(avancementWorker('[3/4] Transcription (batch 16, langue fr)…')).toBe(0.5)
    expect(avancementWorker('[4/4] Alignement mot à mot…')).toBe(0.75)
  })

  it('ignore une ligne sans marqueur', () => {
    expect(avancementWorker('      5936.9 s')).toBeNull()
    expect(avancementWorker('')).toBeNull()
  })
})
