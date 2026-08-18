import { describe, expect, it } from 'vitest'

import { formatDuration, formatSpan, formatTimecode } from '@/lib/format'

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
