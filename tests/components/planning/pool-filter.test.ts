/**
 * `filterPool` et `showsInPool`, purs — pas de DOM.
 */

import { describe, expect, it } from 'vitest'

import { filterPool, POOL_FILTER_NONE, showsInPool } from '@/components/planning/pool-filter'
import type { PlanningPoolClip } from '@/lib/api'

function clip(fields: Partial<PlanningPoolClip> = {}): PlanningPoolClip {
  return {
    clipId: 'c1',
    projectId: '2026-06-15-cqlp',
    title: 'Un clip',
    duration: 42,
    thumbnailUrl: null,
    description: '',
    outputs: { mp4Url: null, mp4Due: false, variant9x16Url: null, variant9x16Due: false, textsUrl: null },
    statuses: {},
    ...fields,
  }
}

describe('showsInPool', () => {
  it('rend chaque émission une fois, dans l’ordre où elle apparaît', () => {
    const clips = [
      clip({ clipId: 'a', projectId: 'show-b' }),
      clip({ clipId: 'b', projectId: 'show-a' }),
      clip({ clipId: 'c', projectId: 'show-b' }),
    ]
    expect(showsInPool(clips)).toEqual(['show-b', 'show-a'])
  })
})

describe('filterPool', () => {
  it('ne restreint rien avec le filtre par défaut', () => {
    const clips = [clip({ clipId: 'a' }), clip({ clipId: 'b', projectId: 'autre' })]
    expect(filterPool(clips, POOL_FILTER_NONE)).toHaveLength(2)
  })

  it('restreint par émission', () => {
    const clips = [clip({ clipId: 'a', projectId: 'show-a' }), clip({ clipId: 'b', projectId: 'show-b' })]
    const result = filterPool(clips, { projectId: 'show-a', search: '' })
    expect(result.map((c) => c.clipId)).toEqual(['a'])
  })

  it('la recherche ignore la casse et les accents', () => {
    const clips = [clip({ clipId: 'a', title: 'La Méchante sorcière' })]
    expect(filterPool(clips, { projectId: null, search: 'mechante' })).toHaveLength(1)
    expect(filterPool(clips, { projectId: null, search: 'MECHANTE' })).toHaveLength(1)
    expect(filterPool(clips, { projectId: null, search: 'gentille' })).toHaveLength(0)
  })
})
