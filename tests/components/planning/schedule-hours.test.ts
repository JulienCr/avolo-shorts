import { describe, expect, it } from 'vitest'

import { parseScheduleHours, pushScheduleHour } from '@/components/planning/schedule-hours'

describe('parseScheduleHours', () => {
  it('coupe sur les virgules et ignore les vides', () => {
    expect(parseScheduleHours('19:00,20:30,')).toEqual(['19:00', '20:30'])
  })

  it('une chaîne vide rend une liste vide', () => {
    expect(parseScheduleHours('')).toEqual([])
  })
})

describe('pushScheduleHour', () => {
  it('place la nouvelle heure en tête', () => {
    expect(pushScheduleHour('19:00,20:30', '18:00')).toBe('18:00,19:00,20:30')
  })

  it('ne double pas une heure déjà mémorisée, elle remonte simplement', () => {
    expect(pushScheduleHour('19:00,20:30', '20:30')).toBe('20:30,19:00')
  })

  it('borne à quatre entrées', () => {
    expect(pushScheduleHour('19:00,20:00,21:00,22:00', '18:00')).toBe('18:00,19:00,20:00,21:00')
  })
})
