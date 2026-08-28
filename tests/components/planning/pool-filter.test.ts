/**
 * Le filtre du vivier, pur — pas de DOM : les six onglets, leurs
 * recoupements, leurs compteurs, et l'invariant d'union.
 */

import { describe, expect, it } from 'vitest'

import {
  countsByPoolView,
  filterPool,
  matchesPoolView,
  POOL_FILTER_NONE,
  POOL_VIEWS,
  poolViewSinceUrl,
  showsInPool,
  type PoolView,
} from '@/components/planning/pool-filter'
import { PLATFORMS, type Platform, type PublicationStatus } from '@/core/publication'
import type { PlanningPoolClip, PublicationDetail } from '@/lib/api'

function detail(status: PublicationStatus): PublicationDetail {
  return { status, error: null, updatedAt: 1000, remoteUrl: null }
}

/** Les statuts nus, tels que les prend `matchesPoolView`. */
function statuses(...pairs: [Platform, PublicationStatus][]): Partial<Record<Platform, PublicationStatus>> {
  return Object.fromEntries(pairs)
}

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
    stale: false,
    ...fields,
  }
}

/** Un clip dont les quatre plateformes portent le même statut. */
function everywhere(status: PublicationStatus): Partial<Record<Platform, PublicationDetail>> {
  return Object.fromEntries(PLATFORMS.map((platform) => [platform, detail(status)]))
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

describe('poolViewSinceUrl', () => {
  it('rend l’onglet nommé, et retombe sur « à publier » sinon', () => {
    expect(poolViewSinceUrl('published')).toBe('published')
    expect(poolViewSinceUrl('inconnu')).toBe('toPublish')
    expect(poolViewSinceUrl(null)).toBe('toPublish')
  })
})

describe('matchesPoolView', () => {
  it('range un clip vierge dans « à publier », et nulle part ailleurs', () => {
    expect(matchesPoolView({}, 'toPublish')).toBe(true)
    expect(matchesPoolView({}, 'scheduled')).toBe(false)
    expect(matchesPoolView({}, 'published')).toBe(false)
    expect(matchesPoolView({}, 'partial')).toBe(false)
    expect(matchesPoolView({}, 'errors')).toBe(false)
  })

  it('range une échéance posée dans « programmés », pas dans « à publier »', () => {
    const posted = statuses(...PLATFORMS.map((p): [Platform, PublicationStatus] => [p, 'planned']))
    expect(matchesPoolView(posted, 'scheduled')).toBe(true)
    expect(matchesPoolView(posted, 'toPublish')).toBe(false)
  })

  // Sans ce rangement, un clip dont les quatre envois tournent n'appartient à
  // aucun onglet nommé et disparaît le temps de son envoi.
  it('range un envoi en cours dans « programmés »', () => {
    const running = statuses(...PLATFORMS.map((p): [Platform, PublicationStatus] => [p, 'in_progress']))
    expect(matchesPoolView(running, 'scheduled')).toBe(true)
    expect(matchesPoolView(running, 'toPublish')).toBe(false)
  })

  it('« déposé » compte comme abouti : les quatre plateformes le rendent publié', () => {
    const mixed = statuses(
      ['instagram', 'published'],
      ['facebook', 'published'],
      ['tiktok', 'submitted'],
      ['youtube', 'published'],
    )
    expect(matchesPoolView(mixed, 'published')).toBe(true)
    expect(matchesPoolView(mixed, 'partial')).toBe(false)
  })

  it('une plateforme sans ligne suffit à rendre le clip partiel', () => {
    const one = statuses(['instagram', 'published'])
    expect(matchesPoolView(one, 'published')).toBe(false)
    expect(matchesPoolView(one, 'partial')).toBe(true)
    expect(matchesPoolView(one, 'toPublish')).toBe(true)
  })

  it('les onglets se recoupent : publié, en échec et encore programmable à la fois', () => {
    const mixed = statuses(
      ['instagram', 'published'],
      ['facebook', 'published'],
      ['tiktok', 'failed'],
    )
    expect(matchesPoolView(mixed, 'partial')).toBe(true)
    expect(matchesPoolView(mixed, 'errors')).toBe(true)
    expect(matchesPoolView(mixed, 'toPublish')).toBe(true)
    expect(matchesPoolView(mixed, 'published')).toBe(false)
  })

  it('un échec des quatre plateformes ne laisse plus rien à programmer', () => {
    const dead = statuses(...PLATFORMS.map((p): [Platform, PublicationStatus] => [p, 'failed']))
    expect(matchesPoolView(dead, 'errors')).toBe(true)
    expect(matchesPoolView(dead, 'toPublish')).toBe(false)
    expect(matchesPoolView(dead, 'partial')).toBe(false)
  })

  /**
   * **Tout clip appartient à au moins un onglet nommé.** Un clip qui n'en
   * trouve aucun ne disparaît pas avec un message, il disparaît en silence :
   * c'est le défaut que cet exhaustif attrape.
   */
  it('couvre toutes les combinaisons de statuts sur deux plateformes', () => {
    const named = POOL_VIEWS.filter((v) => v.value !== 'all')
    const values: (PublicationStatus | undefined)[] = [
      undefined,
      'planned',
      'in_progress',
      'submitted',
      'published',
      'failed',
    ]
    for (const first of values) {
      for (const second of values) {
        for (const third of values) {
          const map: Partial<Record<Platform, PublicationStatus>> = {}
          if (first !== undefined) map.instagram = first
          if (second !== undefined) map.facebook = second
          if (third !== undefined) map.tiktok = third
          const hit = named.filter(({ value }) => matchesPoolView(map, value))
          expect(hit.length, JSON.stringify(map)).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('filterPool', () => {
  it('ne rend que l’onglet demandé', () => {
    const clips = [
      clip({ clipId: 'vierge' }),
      clip({ clipId: 'parti', statuses: everywhere('published') }),
    ]
    expect(filterPool(clips, POOL_FILTER_NONE).map((c) => c.clipId)).toEqual(['vierge'])
    expect(filterPool(clips, { ...POOL_FILTER_NONE, view: 'published' }).map((c) => c.clipId)).toEqual(['parti'])
    expect(filterPool(clips, { ...POOL_FILTER_NONE, view: 'all' })).toHaveLength(2)
  })

  it('restreint par émission', () => {
    const clips = [clip({ clipId: 'a', projectId: 'show-a' }), clip({ clipId: 'b', projectId: 'show-b' })]
    const result = filterPool(clips, { view: 'toPublish', projectId: 'show-a', search: '' })
    expect(result.map((c) => c.clipId)).toEqual(['a'])
  })

  it('la recherche ignore la casse et les accents', () => {
    const clips = [clip({ clipId: 'a', title: 'La Méchante sorcière' })]
    const base = { view: 'toPublish' as PoolView, projectId: null }
    expect(filterPool(clips, { ...base, search: 'mechante' })).toHaveLength(1)
    expect(filterPool(clips, { ...base, search: 'MECHANTE' })).toHaveLength(1)
    expect(filterPool(clips, { ...base, search: 'gentille' })).toHaveLength(0)
  })
})

describe('countsByPoolView', () => {
  it('compte chaque onglet, recoupements compris', () => {
    const clips = [
      clip({ clipId: 'vierge' }),
      clip({ clipId: 'parti', statuses: everywhere('published') }),
      clip({
        clipId: 'mixte',
        statuses: { instagram: detail('published'), tiktok: detail('failed') },
      }),
    ]
    const counts = countsByPoolView(clips, POOL_FILTER_NONE)
    expect(counts).toEqual({ toPublish: 2, scheduled: 0, published: 1, partial: 1, errors: 1, all: 3 })
  })

  // Un onglet qui annonce 1 et s'ouvre vide parce que la recherche l'exclut
  // est l'écart qu'on ne remarque pas.
  it('compte sous l’émission et la recherche déjà appliquées', () => {
    const clips = [clip({ clipId: 'a', title: 'Alpha' }), clip({ clipId: 'b', title: 'Beta' })]
    const counts = countsByPoolView(clips, { ...POOL_FILTER_NONE, search: 'alpha' })
    expect(counts.toPublish).toBe(1)
    expect(counts.all).toBe(1)
  })
})
