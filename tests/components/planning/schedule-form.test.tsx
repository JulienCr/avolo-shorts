// @vitest-environment jsdom

/**
 * `ScheduleForm` seul, pour deux corrections issues de la revue externe :
 * l'heure suit un `scheduleHours` qui arrive après le montage tant que rien
 * n'a été choisi à la main, et la date est bornée au bandeau affiché.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ScheduleForm } from '@/components/planning/schedule-form'

afterEach(cleanup)

const BAND = { minDate: '2026-08-03', maxDate: '2026-09-06' }

function form(props: Partial<ComponentProps<typeof ScheduleForm>> = {}) {
  return (
    <ScheduleForm
      count={1}
      scheduleHours=""
      minDate={BAND.minDate}
      maxDate={BAND.maxDate}
      pending={false}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      {...props}
    />
  )
}

describe('ScheduleForm — heure configurée arrivant après le montage', () => {
  it('adopte l’heure configurée une fois les réglages chargés', () => {
    const { rerender } = render(form())
    expect(screen.getByLabelText('Heure')).toHaveProperty('value', '19:00')

    rerender(form({ scheduleHours: '21:00,20:00' }))
    expect(screen.getByLabelText('Heure')).toHaveProperty('value', '21:00')
  })

  it('ne réécrit plus l’heure une fois qu’elle a été choisie à la main', async () => {
    const user = userEvent.setup()
    const { rerender } = render(form({ scheduleHours: '21:00' }))

    const timeInput = screen.getByLabelText('Heure')
    await user.clear(timeInput)
    await user.type(timeInput, '08:15')
    expect(timeInput).toHaveProperty('value', '08:15')

    rerender(form({ scheduleHours: '20:00' }))
    expect(screen.getByLabelText('Heure')).toHaveProperty('value', '08:15')
  })
})

describe('ScheduleForm — date bornée au bandeau', () => {
  it('pose min/max sur le champ date d’après le bandeau affiché', () => {
    render(form())
    const input = screen.getByLabelText('Date')
    expect(input).toHaveProperty('min', BAND.minDate)
    expect(input).toHaveProperty('max', BAND.maxDate)
  })

  it('désactive la confirmation pour une date hors bandeau', async () => {
    const user = userEvent.setup()
    render(form())

    const dateInput = screen.getByLabelText('Date')
    await user.clear(dateInput)
    await user.type(dateInput, '2026-12-25')
    expect(screen.getByRole('button', { name: /Programmer/ })).toHaveProperty('disabled', true)
  })
})
