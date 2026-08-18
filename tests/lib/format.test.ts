import { describe, expect, it } from 'vitest'

import { formatDuration, formatDurationRange, formatSpan, formatTimecode } from '@/lib/format'

describe('formatDuration', () => {
  it('rend des minutes et des secondes', () => {
    expect(formatDuration(72.4)).toBe('1:12')
    expect(formatDuration(9)).toBe('0:09')
  })

  it('ajoute les heures seulement quand il y en a', () => {
    expect(formatDuration(3_600)).toBe('1:00:00')
    expect(formatDuration(3_599)).toBe('59:59')
  })

  it('n’a pas de plafond : la durée est un résultat', () => {
    expect(formatDuration(4_212)).toBe('1:10:12')
  })

  it('rend 0:00 plutôt que du charabia sur une valeur absente', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(-5)).toBe('0:00')
    expect(formatDuration(Number.NaN)).toBe('0:00')
  })
})

describe('formatSpan', () => {
  it('donne le dixième sous la minute : trois mots ne valent pas « 0:00 »', () => {
    expect(formatSpan(1.24)).toBe('1,2 s')
    expect(formatSpan(0.4)).toBe('0,4 s')
  })

  it('repasse en m:ss au-delà de la minute, où le dixième ne renseigne plus', () => {
    expect(formatSpan(72.4)).toBe('1:12')
  })

  it('rend « 0 s » sur une valeur absente', () => {
    expect(formatSpan(0)).toBe('0 s')
    expect(formatSpan(Number.NaN)).toBe('0 s')
  })
})

describe('formatTimecode', () => {
  it('garde toujours les trois champs, pour que la colonne s’aligne', () => {
    expect(formatTimecode(9)).toBe('0:00:09')
    expect(formatTimecode(2_845.9)).toBe('0:47:25')
  })

  it('tronque au lieu d’arrondir : une position ne dépasse pas son mot', () => {
    expect(formatTimecode(59.9)).toBe('0:00:59')
  })

  it('rend 0:00:00 sur une valeur absente', () => {
    expect(formatTimecode(Number.NaN)).toBe('0:00:00')
  })
})

describe('formatDurationRange', () => {
  it('rend deux bornes en minutes', () => {
    // L'exemple du §4.2 du retour d'usage, mot pour mot.
    expect(formatDurationRange({ lowSec: 135, highSec: 165 })).toBe('environ 2–3 min')
  })

  it('n’affiche rien plutôt qu’une estimation qui n’existe pas', () => {
    expect(formatDurationRange(null)).toBe('')
  })

  it('ne chiffre pas sous la minute', () => {
    // Six secondes d'extraction audio : « environ 0–1 min » serait ridicule et
    // « 4–8 s » promettrait une précision qu'une mesure unique ne porte pas.
    expect(formatDurationRange({ lowSec: 4.5, highSec: 7.5 })).toBe('moins d’une minute')
  })

  it('replie les deux bornes quand elles tombent sur la même minute', () => {
    expect(formatDurationRange({ lowSec: 130, highSec: 140 })).toBe('environ 2 min')
  })

  it('n’élargit pas la fourchette en l’arrondissant', () => {
    // Deux secondes d'écart ne doivent pas ressortir en « environ 1–3 min »,
    // qui annoncerait une incertitude que le calcul n'a pas produite.
    expect(formatDurationRange({ lowSec: 119, highSec: 121 })).toBe('environ 2 min')
  })

  it('ne descend jamais sous une minute pour la borne basse', () => {
    // « environ 0–2 min » promettrait une fin immédiate.
    expect(formatDurationRange({ lowSec: 55, highSec: 90 })).toBe('environ 1–2 min')
  })

  it('rend une chaîne vide sur des valeurs aberrantes', () => {
    expect(formatDurationRange({ lowSec: 0, highSec: 0 })).toBe('')
    expect(formatDurationRange({ lowSec: Number.NaN, highSec: Number.NaN })).toBe('')
    expect(formatDurationRange({ lowSec: -10, highSec: -1 })).toBe('')
  })

  it('supporte une fourchette inversée sans rendre de charabia', () => {
    expect(formatDurationRange({ lowSec: 300, highSec: 120 })).toBe('environ 5 min')
  })
})
