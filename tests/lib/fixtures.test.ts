/**
 * Les fixtures ne sont pas du produit, mais elles se cassent en silence : un
 * index de mot hors bornes rendrait un candidat vide, et l'écran de tri
 * afficherait une carte à 0:00 sans que rien ne le signale. Ces tests partent
 * avec elles à la tâche 10.
 */
import { describe, expect, it } from 'vitest'

import { clipDuration } from '@/core/edl'
import {
  fixtureCandidates,
  fixtureClipDetail,
  fixtureProjectStatus,
  patchFixtureClip,
} from '@/lib/fixtures'

const PROJET = '2026-03-08-caro-mdlm'

describe('les candidats', () => {
  it('il y en a une dizaine, comme au sortir d’un vrai repérage', () => {
    expect(fixtureCandidates(PROJET).length).toBeGreaterThanOrEqual(10)
  })

  it('aucun n’est vide, et chacun dure quelque chose', () => {
    for (const c of fixtureCandidates(PROJET)) {
      expect(c.segments.length).toBeGreaterThan(0)
      expect(clipDuration(c.segments)).toBeGreaterThan(3)
    }
  })

  it('les segments sortent normalisés, triés et sans chevauchement', () => {
    for (const c of fixtureCandidates(PROJET)) {
      for (let i = 1; i < c.segments.length; i++) {
        expect(c.segments[i].start).toBeGreaterThan(c.segments[i - 1].end)
      }
    }
  })

  it('certains ont plusieurs segments : le clip est une liste, pas une fenêtre', () => {
    expect(fixtureCandidates(PROJET).some((c) => c.segments.length > 1)).toBe(true)
  })

  it('les quatre ratios sont représentés, y compris auto', () => {
    const ratios = new Set(fixtureCandidates(PROJET).map((c) => c.ratio))
    expect(ratios).toContain('auto')
    expect(ratios.size).toBeGreaterThanOrEqual(4)
  })

  it('un gardé et un écarté existent dès le départ, pour que le filtre se voie', () => {
    const statuts = fixtureCandidates(PROJET).map((c) => c.status)
    expect(statuts).toContain('kept')
    expect(statuts).toContain('discarded')
  })

  it('chaque carte porte ses trois premières phrases', () => {
    for (const c of fixtureCandidates(PROJET)) {
      expect(c.preview.length).toBeGreaterThan(30)
    }
  })
})

describe('le détail d’un clip', () => {
  it('donne assez de mots pour que la virtualisation ait un sens', () => {
    const detail = fixtureClipDetail('c01')
    const mots = detail.lines.flatMap((l) => l.words)
    expect(mots.length).toBeGreaterThan(80)
  })

  it('montre du contexte avant et après, sinon on ne pourrait qu’enlever', () => {
    const detail = fixtureClipDetail('c03')
    const mots = detail.lines.flatMap((l) => l.words)
    const debut = detail.clip.segments[0].start
    const fin = detail.clip.segments[detail.clip.segments.length - 1].end
    expect(mots[0].start).toBeLessThan(debut)
    expect(mots[mots.length - 1].end).toBeGreaterThan(fin)
  })

  it('les mots sont dans l’ordre du temps', () => {
    const mots = fixtureClipDetail('c06').lines.flatMap((l) => l.words)
    for (let i = 1; i < mots.length; i++) {
      expect(mots[i].start).toBeGreaterThanOrEqual(mots[i - 1].start)
    }
  })

  it('les artefacts absents se disent, plutôt que de pointer une URL morte', () => {
    expect(fixtureClipDetail('c01').proxyUrl).toBeNull()
    expect(fixtureCandidates(PROJET)[0].thumbnailUrl).toBeNull()
  })

  it('un clip inconnu lève, il ne rend pas un clip vide', () => {
    expect(() => fixtureClipDetail('néant')).toThrow()
  })

  it('survit à un clip vidé de tous ses segments', () => {
    // Sélectionner tout et retirer laisse une liste vide, ce qui est un état
    // légitime : on reconstruit ensuite en cliquant les mots barrés. La fenêtre
    // de transcript doit donc tenir sans segments — sinon on perd le texte au
    // moment précis où il faut le relire.
    const avant = fixtureClipDetail('c07').lines.length
    patchFixtureClip('c07', { segments: [] })

    const apres = fixtureClipDetail('c07')
    expect(apres.clip.segments).toEqual([])
    expect(apres.lines.length).toBe(avant)
  })
})

describe('patchFixtureClip', () => {
  it('normalise les segments avant écriture, comme le fera la route', () => {
    const clip = patchFixtureClip('c02', {
      segments: [
        { start: 30, end: 40 },
        { start: 10, end: 32 },
      ],
    })
    expect(clip.segments).toEqual([{ start: 10, end: 40 }])
  })

  it('l’état survit à une relecture', () => {
    patchFixtureClip('c05', { status: 'discarded' })
    const relu = fixtureCandidates(PROJET).find((c) => c.id === 'c05')
    expect(relu?.status).toBe('discarded')
  })
})

describe('l’état du projet', () => {
  it('les étapes sont une présence d’artefact, pas une clé de validité', () => {
    const statut = fixtureProjectStatus(PROJET)
    expect(statut.steps.transcript).toBe(true)
    expect(statut.steps.renders).toBe(false)
  })
})
