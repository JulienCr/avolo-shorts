import { describe, it, expect } from 'vitest'
import {
  addDaysToKey,
  aggregatePublicationStatus,
  composeScheduledAt,
  dayKeyFor,
  fiveWeekWindow,
  mondayOfWeekKey,
} from '@/core/planning'

describe('composeScheduledAt', () => {
  it('19:00 en été (CEST, UTC+2)', () => {
    expect(composeScheduledAt('2026-08-04', '19:00')).toBe(Date.UTC(2026, 7, 4, 17, 0))
  })

  it('19:00 en hiver (CET, UTC+1)', () => {
    expect(composeScheduledAt('2026-01-15', '19:00')).toBe(Date.UTC(2026, 0, 15, 18, 0))
  })

  it('01:30 le jour de la bascule de printemps reste avant le changement (CET, UTC+1)', () => {
    // Bascule 2026 : 02:00 CET -> 03:00 CEST, à 01:00 UTC. 01:30 heure de
    // Paris précède ce changement et doit rester en +1, pas glisser en +2.
    expect(composeScheduledAt('2026-03-29', '01:30')).toBe(Date.UTC(2026, 2, 29, 0, 30))
  })
})

describe('dayKeyFor', () => {
  it('lit l’instant dans le fuseau de Paris, pas celui du process', () => {
    // 23:30 UTC le 4 août est déjà le 5 août à Paris (CEST).
    expect(dayKeyFor(Date.UTC(2026, 7, 4, 23, 30))).toBe('2026-08-05')
  })
})

describe('mondayOfWeekKey / addDaysToKey', () => {
  it('recule un mercredi jusqu’à son lundi', () => {
    expect(mondayOfWeekKey('2026-08-05')).toBe('2026-08-03')
  })

  it('un dimanche recule de six jours, pas zéro', () => {
    expect(mondayOfWeekKey('2026-08-09')).toBe('2026-08-03')
  })

  it('additionne des jours civils sans notion de fuseau', () => {
    expect(addDaysToKey('2026-08-03', 34)).toBe('2026-09-06')
  })
})

describe('fiveWeekWindow', () => {
  it('trente-cinq jours, du lundi de la semaine courante', () => {
    const window = fiveWeekWindow(Date.UTC(2026, 7, 5, 10, 0)) // mercredi 5 août
    expect(window.days).toHaveLength(35)
    expect(window.days[0]).toBe('2026-08-03')
    expect(window.days[34]).toBe('2026-09-06')
  })

  it('ne rompt pas entre fin septembre et début octobre', () => {
    const window = fiveWeekWindow(Date.UTC(2026, 8, 28, 10, 0)) // lundi 28 septembre
    expect(window.days).toContain('2026-09-28')
    expect(window.days).toContain('2026-10-01')
  })

  it('from/to bornent le bandeau en Europe/Paris', () => {
    const window = fiveWeekWindow(Date.UTC(2026, 7, 5, 10, 0))
    expect(window.from).toBe(composeScheduledAt('2026-08-03', '00:00'))
    expect(window.to).toBe(composeScheduledAt('2026-09-07', '00:00'))
  })
})

describe('aggregatePublicationStatus', () => {
  it('les quatre en planned rendent programmé', () => {
    expect(
      aggregatePublicationStatus({
        instagram: 'planned',
        facebook: 'planned',
        tiktok: 'planned',
        youtube: 'planned',
      }),
    ).toBe('planned')
  })

  it('un échec mélangé à un succès est un échec partiel, pas « échec » seul', () => {
    expect(aggregatePublicationStatus({ instagram: 'published', tiktok: 'failed' })).toBe('partial_failure')
  })

  it('deux réussites et deux échecs restent un échec partiel', () => {
    expect(
      aggregatePublicationStatus({
        instagram: 'published',
        facebook: 'submitted',
        tiktok: 'failed',
        youtube: 'failed',
      }),
    ).toBe('partial_failure')
  })

  it('les quatre en échec rendent échec, sans partiel', () => {
    expect(
      aggregatePublicationStatus({
        instagram: 'failed',
        facebook: 'failed',
        tiktok: 'failed',
        youtube: 'failed',
      }),
    ).toBe('failed')
  })

  it('tout publié rend publié', () => {
    expect(aggregatePublicationStatus({ instagram: 'published', facebook: 'published' })).toBe('published')
  })

  it('publié et déposé, avec au moins un déposé, rend déposé', () => {
    expect(aggregatePublicationStatus({ instagram: 'published', tiktok: 'submitted' })).toBe('submitted')
  })

  it('un reste en cours rend en cours', () => {
    expect(aggregatePublicationStatus({ instagram: 'in_progress', tiktok: 'planned' })).toBe('in_progress')
  })

  it('un résultat terminal mélangé à du planned n’est pas « en cours », rien n’y tourne : partiel', () => {
    expect(
      aggregatePublicationStatus({
        instagram: 'published',
        facebook: 'planned',
        tiktok: 'planned',
        youtube: 'planned',
      }),
    ).toBe('partial')
  })

  it('in_progress signifie qu’un envoi tourne réellement, rien de moins', () => {
    expect(aggregatePublicationStatus({ instagram: 'published', tiktok: 'in_progress' })).toBe('in_progress')
  })

  it('un envoi en cours l’emporte sur un échec déjà écrit ailleurs', () => {
    expect(aggregatePublicationStatus({ instagram: 'failed', tiktok: 'in_progress' })).toBe('in_progress')
  })
})
