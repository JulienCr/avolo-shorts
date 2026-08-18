// @vitest-environment jsdom

/**
 * Ce qu'un aller-retour vers un clip doit retrouver, et qui n'a rien à faire
 * dans l'URL : la position de défilement et la carte d'où l'on est parti.
 *
 * La vue active, elle, est dans l'URL — un rechargement doit rendre le même
 * écran. Une position de défilement dans une URL est une URL qu'on ne peut plus
 * partager.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { lireSessionTri, écrireSessionTri } from '@/components/tri/session'

afterEach(() => {
  window.sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('la session de tri', () => {
  it('rend un état neutre pour un projet jamais visité', () => {
    expect(lireSessionTri('inconnu')).toEqual({ carte: null, defilement: 0 })
  })

  it('retrouve la carte et le défilement du projet', () => {
    écrireSessionTri('p1', { carte: 'c7', defilement: 940 })
    expect(lireSessionTri('p1')).toEqual({ carte: 'c7', defilement: 940 })
  })

  it('ne mélange pas deux projets', () => {
    // Le retour depuis un clip vise **sa** grille : reprendre la carte d'une
    // autre émission ferait sauter dans une liste sans que le geste l'explique.
    écrireSessionTri('p1', { carte: 'c7' })
    écrireSessionTri('p2', { carte: 'c9' })
    expect(lireSessionTri('p1').carte).toBe('c7')
    expect(lireSessionTri('p2').carte).toBe('c9')
  })

  it('écrit un champ sans effacer l’autre', () => {
    écrireSessionTri('p1', { carte: 'c7', defilement: 940 })
    écrireSessionTri('p1', { defilement: 12 })
    expect(lireSessionTri('p1')).toEqual({ carte: 'c7', defilement: 12 })
  })

  it('survit à un stockage indisponible', () => {
    // Navigation privée, quota, rendu serveur : perdre une position de
    // défilement est ennuyeux, faire tomber l'écran de tri ne l'est pas.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => écrireSessionTri('p1', { carte: 'c1' })).not.toThrow()
  })

  it('survit à un contenu illisible', () => {
    // Une clé écrite par une version précédente, ou bricolée à la main.
    window.sessionStorage.setItem('avolo-shorts:tri:p1', '{pas du json')
    expect(lireSessionTri('p1')).toEqual({ carte: null, defilement: 0 })
  })

  it('refuse un contenu du bon format mais du mauvais type', () => {
    window.sessionStorage.setItem('avolo-shorts:tri:p1', '{"carte":42,"defilement":"beaucoup"}')
    expect(lireSessionTri('p1')).toEqual({ carte: null, defilement: 0 })
  })
})
