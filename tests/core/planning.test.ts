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

  it('un échec suffit, même mélangé à un succès', () => {
    expect(aggregatePublicationStatus({ instagram: 'published', tiktok: 'failed' })).toBe('failed')
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
})
