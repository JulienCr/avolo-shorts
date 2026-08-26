// @vitest-environment jsdom

/**
 * `PoolList` seul : la navigation clavier ArrowUp/ArrowDown n'avait aucun
 * test direct — la ligne courante est un état interne (`useState`), invisible
 * depuis `planning-screen.test.tsx`, qui ne l'exerce jamais.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PoolList } from '@/components/planning/pool-list'
import type { PlanningPoolClip } from '@/lib/api'

afterEach(cleanup)

function clip(id: string): PlanningPoolClip {
  return { clipId: id, projectId: '2026-06-15-cqlp', title: `Clip ${id}`, duration: 42 }
}

const CLIPS = [clip('a'), clip('b'), clip('c')]

describe('PoolList — navigation clavier', () => {
  it('atteint chaque ligne depuis la première par ArrowDown, et revient par ArrowUp', async () => {
    const user = userEvent.setup()
    render(<PoolList clips={CLIPS} selected={new Set()} onToggle={vi.fn()} />)

    const rows = CLIPS.map((c) => screen.getByText(c.title).closest('[data-clip]') as HTMLElement)

    rows[0].focus()
    expect(document.activeElement).toBe(rows[0])

    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rows[1])

    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rows[2])

    // Ne dépasse pas la dernière ligne.
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rows[2])

    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(rows[1])

    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(rows[0])

    // Ne remonte pas au-delà de la première ligne.
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(rows[0])
  })
})
